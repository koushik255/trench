package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web/dist
var webFiles embed.FS

var videoExtensions = map[string]bool{
	".avi": true, ".m4v": true, ".mkv": true, ".mov": true,
	".mp4": true, ".mpeg": true, ".mpg": true, ".ogv": true,
	".ts": true, ".webm": true, ".wmv": true,
}

type movie struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Path     string  `json:"path"`
	Size     int64   `json:"size"`
	Modified string  `json:"modified"`
	Duration float64 `json:"duration"`
	IsMovie  bool    `json:"isMovie"`
}

type libraryResponse struct {
	Movies []movie `json:"movies"`
	Other  []movie `json:"other"`
}

type durationCacheEntry struct {
	Size       int64   `json:"size"`
	ModifiedNS int64   `json:"modifiedNs"`
	Duration   float64 `json:"duration"`
}

type durationCacheFile struct {
	Entries map[string]durationCacheEntry `json:"entries"`
}

type playbackSession struct {
	dir      string
	duration float64
	cancel   context.CancelFunc
	done     chan struct{}
}

type server struct {
	mediaRoot string
	ffmpeg    string
	mu        sync.Mutex
	sessions  map[string]*playbackSession
	libraryMu sync.Mutex
	cachePath string
	durations map[string]durationCacheEntry
}

func main() {
	configFile := flag.String("config", "config.txt", "configuration file")
	mediaDir := flag.String("media", "", "folder containing movie files (overrides config.txt)")
	addr := flag.String("addr", "127.0.0.1:8080", "HTTP listen address (use 0.0.0.0 to listen on your LAN)")
	ffmpeg := flag.String("ffmpeg", "ffmpeg", "FFmpeg executable used for compatibility transcoding")
	flag.Parse()

	configuredPath, err := readMediaPath(*configFile)
	if err != nil {
		log.Fatal(err)
	}
	mediaPathFromFlag := *mediaDir != ""
	if mediaPathFromFlag {
		configuredPath = *mediaDir
	}
	if configuredPath == "" {
		configuredPath = "./movies"
	}
	if strings.HasPrefix(configuredPath, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			configuredPath = filepath.Join(home, strings.TrimPrefix(configuredPath, "~/"))
		}
	}
	if !filepath.IsAbs(configuredPath) && !mediaPathFromFlag {
		configuredPath = filepath.Join(filepath.Dir(*configFile), configuredPath)
	}
	root, err := filepath.Abs(configuredPath)
	if err != nil {
		log.Fatal(err)
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		log.Fatalf("media folder %q does not exist or is not a directory", root)
	}

	cachePath := durationCachePath(root)
	app := &server{
		mediaRoot: root,
		ffmpeg:    *ffmpeg,
		sessions:  make(map[string]*playbackSession),
		cachePath: cachePath,
		durations: loadDurationCache(cachePath),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/library", app.library)
	mux.HandleFunc("GET /api/thumbnail/{id}", app.thumbnail)
	mux.HandleFunc("GET /api/media/{id}", app.media)
	mux.HandleFunc("POST /api/playback/{id}", app.startTranscode)
	mux.HandleFunc("GET /api/playback/{session}/status", app.transcodeStatus)
	mux.HandleFunc("GET /api/playback/{session}/{file...}", app.transcodeFile)
	mux.HandleFunc("DELETE /api/playback/{session}", app.stopTranscode)
	webRoot, err := fs.Sub(webFiles, "web/dist")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", http.FileServer(http.FS(webRoot)))

	log.Printf("Serving %s at http://%s", root, *addr)
	log.Fatal(http.ListenAndServe(*addr, logRequests(mux)))
}

func readMediaPath(configPath string) (string, error) {
	file, err := os.Open(configPath)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("open config file %q: %w", configPath, err)
	}
	defer file.Close()

	var path string
	scanner := bufio.NewScanner(file)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return "", fmt.Errorf("config file %q line %d: expected key=value", configPath, lineNumber)
		}
		if strings.TrimSpace(key) != "path" {
			return "", fmt.Errorf("config file %q line %d: unknown setting %q", configPath, lineNumber, strings.TrimSpace(key))
		}
		path = strings.TrimSpace(value)
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("read config file %q: %w", configPath, err)
	}
	return path, nil
}

func (s *server) library(w http.ResponseWriter, r *http.Request) {
	s.libraryMu.Lock()
	defer s.libraryMu.Unlock()

	movies := make([]movie, 0)
	other := make([]movie, 0)
	seen := make(map[string]bool)
	dirty := false
	err := filepath.WalkDir(s.mediaRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !videoExtensions[strings.ToLower(filepath.Ext(entry.Name()))] {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(s.mediaRoot, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		seen[rel] = true
		cached, ok := s.durations[rel]
		if !ok || cached.Size != info.Size() || cached.ModifiedNS != info.ModTime().UnixNano() {
			cached = durationCacheEntry{
				Size:       info.Size(),
				ModifiedNS: info.ModTime().UnixNano(),
				Duration:   probeDuration(path, s.ffmpeg),
			}
			s.durations[rel] = cached
			dirty = true
		}
		item := movie{
			ID:       base64.RawURLEncoding.EncodeToString([]byte(rel)),
			Name:     strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())),
			Path:     rel,
			Size:     info.Size(),
			Modified: info.ModTime().Format(time.RFC3339),
			Duration: cached.Duration,
			IsMovie:  cached.Duration >= 30*60,
		}
		if item.IsMovie {
			movies = append(movies, item)
		} else {
			other = append(other, item)
		}
		return nil
	})
	if err != nil {
		http.Error(w, "could not scan media folder", http.StatusInternalServerError)
		return
	}
	for path := range s.durations {
		if !seen[path] {
			delete(s.durations, path)
			dirty = true
		}
	}
	if dirty {
		saveDurationCache(s.cachePath, s.durations)
	}
	sort.Slice(movies, func(i, j int) bool { return strings.ToLower(movies[i].Name) < strings.ToLower(movies[j].Name) })
	sort.Slice(other, func(i, j int) bool { return strings.ToLower(other[i].Name) < strings.ToLower(other[j].Name) })
	writeJSON(w, libraryResponse{Movies: movies, Other: other})
}

func durationCachePath(mediaRoot string) string {
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		return filepath.Join(mediaRoot, ".tissue-duration-cache.json")
	}
	hash := sha256.Sum256([]byte(mediaRoot))
	return filepath.Join(cacheDir, "tissue", fmt.Sprintf("%x.json", hash[:8]))
}

func loadDurationCache(path string) map[string]durationCacheEntry {
	data, err := os.ReadFile(path)
	if err != nil {
		return make(map[string]durationCacheEntry)
	}
	var cache durationCacheFile
	if err := json.Unmarshal(data, &cache); err != nil || cache.Entries == nil {
		log.Printf("ignoring invalid duration cache %q", path)
		return make(map[string]durationCacheEntry)
	}
	return cache.Entries
}

func saveDurationCache(path string, entries map[string]durationCacheEntry) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		log.Printf("could not create duration cache directory: %v", err)
		return
	}
	data, err := json.MarshalIndent(durationCacheFile{Entries: entries}, "", "  ")
	if err != nil {
		log.Printf("could not encode duration cache: %v", err)
		return
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".tissue-duration-cache-*.tmp")
	if err != nil {
		log.Printf("could not create duration cache: %v", err)
		return
	}
	tempName := temp.Name()
	defer func() {
		_ = temp.Close()
		_ = os.Remove(tempName)
	}()
	if _, err := temp.Write(data); err != nil {
		log.Printf("could not write duration cache: %v", err)
		return
	}
	if err := temp.Close(); err != nil {
		log.Printf("could not close duration cache: %v", err)
		return
	}
	if err := os.Rename(tempName, path); err != nil {
		log.Printf("could not save duration cache: %v", err)
	}
}

func probeDuration(path, ffprobe string) float64 {
	probe := ffprobe
	if probe == "ffmpeg" {
		probe = "ffprobe"
	}
	output, err := exec.Command(probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path).Output()
	if err != nil {
		return 0
	}
	duration, err := strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
	if err != nil || duration < 0 {
		return 0
	}
	return duration
}

func (s *server) resolveMovie(id string) (string, error) {
	data, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil || len(data) == 0 {
		return "", errors.New("invalid movie id")
	}
	rel := filepath.FromSlash(string(data))
	if filepath.IsAbs(rel) || rel == "." || strings.HasPrefix(filepath.Clean(rel), ".."+string(filepath.Separator)) || filepath.Clean(rel) == ".." {
		return "", errors.New("invalid movie path")
	}
	path := filepath.Join(s.mediaRoot, rel)
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || !strings.HasPrefix(resolved, s.mediaRoot+string(filepath.Separator)) {
		return "", errors.New("movie not found")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("movie not found")
	}
	return resolved, nil
}

func (s *server) media(w http.ResponseWriter, r *http.Request) {
	path, err := s.resolveMovie(r.PathValue("id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if contentType := mime.TypeByExtension(filepath.Ext(path)); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	http.ServeFile(w, r, path)
}

func (s *server) thumbnail(w http.ResponseWriter, r *http.Request) {
	path, err := s.resolveMovie(r.PathValue("id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	cachePath := thumbnailCachePath(s.mediaRoot, path, info)
	thumbnailMu.Lock()
	defer thumbnailMu.Unlock()
	if _, err := os.Stat(cachePath); err != nil {
		if err := createThumbnail(s.ffmpeg, path, cachePath); err != nil {
			log.Printf("could not create thumbnail for %q: %v", path, err)
			http.Error(w, "could not create thumbnail", http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeFile(w, r, cachePath)
}

var thumbnailMu sync.Mutex

func thumbnailCachePath(mediaRoot, mediaPath string, info os.FileInfo) string {
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		cacheDir = filepath.Dir(mediaRoot)
	}
	hash := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%d", mediaPath, info.Size(), info.ModTime().UnixNano())))
	return filepath.Join(cacheDir, "tissue", "thumbnails", fmt.Sprintf("%x.jpg", hash[:]))
}

func createThumbnail(ffmpeg, mediaPath, cachePath string) error {
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(cachePath), ".tissue-thumbnail-*.jpg")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	defer os.Remove(tempName)

	baseArgs := []string{
		"-hide_banner", "-loglevel", "error", "-ss", "5", "-i", mediaPath,
		"-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "4", "-y", tempName,
	}
	if output, err := exec.Command(ffmpeg, baseArgs...).CombinedOutput(); err != nil {
		// Very short videos may not have a frame five seconds in. Retry from the beginning.
		startArgs := []string{
			"-hide_banner", "-loglevel", "error", "-i", mediaPath,
			"-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "4", "-y", tempName,
		}
		if output, err = exec.Command(ffmpeg, startArgs...).CombinedOutput(); err != nil {
			return fmt.Errorf("ffmpeg: %w (%s)", err, strings.TrimSpace(string(output)))
		}
	}
	return os.Rename(tempName, cachePath)
}

type playbackResponse struct {
	Session   string  `json:"session"`
	URL       string  `json:"url"`
	AudioOnly bool    `json:"audioOnly"`
	Duration  float64 `json:"duration"`
}

func (s *server) startTranscode(w http.ResponseWriter, r *http.Request) {
	path, err := s.resolveMovie(r.PathValue("id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if _, err := exec.LookPath(s.ffmpeg); err != nil {
		http.Error(w, "FFmpeg was not found. Install FFmpeg or pass its path with -ffmpeg.", http.StatusServiceUnavailable)
		return
	}
	id, err := newID()
	if err != nil {
		http.Error(w, "could not create playback session", http.StatusInternalServerError)
		return
	}
	dir, err := os.MkdirTemp("", "tissue-hls-")
	if err != nil {
		http.Error(w, "could not create HLS output folder", http.StatusInternalServerError)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	playlistPath := filepath.Join(dir, "index.m3u8")
	segmentPattern := filepath.Join(dir, "segment_%05d.ts")
	audioOnly := r.URL.Query().Get("audioOnly") == "1"
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin"}
	if !audioOnly {
		args = append(args, "-re")
	}
	args = append(args, "-i", path, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn")
	if audioOnly {
		// The browser keeps decoding video from the original file. This session is
		// only a fast, progressive AAC rendition of the audio track.
		args = append(args, "-vn")
	} else {
		args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p")
	}
	args = append(args,
		"-c:a", "aac", "-b:a", "160k", "-ac", "2",
		"-force_key_frames", "expr:gte(t,n_forced*4)",
		"-f", "hls", "-hls_time", "4", "-hls_list_size", "0", "-hls_playlist_type", "event",
		"-hls_flags", "independent_segments", "-hls_segment_filename", segmentPattern, playlistPath,
	)
	cmd := exec.CommandContext(ctx, s.ffmpeg, args...)
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		cancel()
		_ = os.RemoveAll(dir)
		http.Error(w, "could not start FFmpeg", http.StatusInternalServerError)
		return
	}
	session := &playbackSession{dir: dir, duration: probeDuration(path, s.ffmpeg), cancel: cancel, done: make(chan struct{})}
	s.mu.Lock()
	s.sessions[id] = session
	s.mu.Unlock()
	go func() {
		_ = cmd.Wait()
		close(session.done)
	}()
	// Bound abandoned sessions even if a browser disappears without sending DELETE.
	time.AfterFunc(2*time.Hour, func() { s.removeSession(id) })

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(playlistPath); err == nil {
			writeJSON(w, playbackResponse{Session: id, URL: "/api/playback/" + id + "/index.m3u8", AudioOnly: audioOnly, Duration: probeDuration(path, s.ffmpeg)})
			return
		}
		select {
		case <-session.done:
			_ = os.RemoveAll(dir)
			s.mu.Lock()
			delete(s.sessions, id)
			s.mu.Unlock()
			http.Error(w, "FFmpeg exited before producing a playlist. Check that FFmpeg supports H.264 and AAC encoding.", http.StatusInternalServerError)
			return
		case <-r.Context().Done():
			s.removeSession(id)
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
	s.removeSession(id)
	http.Error(w, "timed out waiting for FFmpeg to start", http.StatusGatewayTimeout)
}

type transcodeStatusResponse struct {
	ReadyDuration float64 `json:"readyDuration"`
	Duration      float64 `json:"duration"`
	Complete      bool    `json:"complete"`
}

func (s *server) transcodeStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("session")
	s.mu.Lock()
	session := s.sessions[id]
	s.mu.Unlock()
	if session == nil {
		http.NotFound(w, r)
		return
	}
	playlist, err := os.ReadFile(filepath.Join(session.dir, "index.m3u8"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ready := 0.0
	for _, line := range strings.Split(string(playlist), "\n") {
		if strings.HasPrefix(line, "#EXTINF:") {
			value := strings.TrimSuffix(strings.TrimPrefix(line, "#EXTINF:"), ",")
			if seconds, err := strconv.ParseFloat(value, 64); err == nil {
				ready += seconds
			}
		}
	}
	complete := strings.Contains(string(playlist), "#EXT-X-ENDLIST")
	writeJSON(w, transcodeStatusResponse{ReadyDuration: ready, Duration: session.duration, Complete: complete})
}

func (s *server) transcodeFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("session")
	name := filepath.Clean(filepath.FromSlash(r.PathValue("file")))
	if name == "." || filepath.IsAbs(name) || strings.HasPrefix(name, "..") {
		http.NotFound(w, r)
		return
	}
	s.mu.Lock()
	session := s.sessions[id]
	s.mu.Unlock()
	if session == nil {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(session.dir, name)
	contentType := mime.TypeByExtension(filepath.Ext(path))
	switch strings.ToLower(filepath.Ext(path)) {
	case ".m3u8":
		contentType = "application/vnd.apple.mpegurl"
	case ".ts":
		contentType = "video/mp2t"
	}
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	http.ServeFile(w, r, path)
}

func (s *server) stopTranscode(w http.ResponseWriter, r *http.Request) {
	s.removeSession(r.PathValue("session"))
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) removeSession(id string) {
	s.mu.Lock()
	session := s.sessions[id]
	delete(s.sessions, id)
	s.mu.Unlock()
	if session == nil {
		return
	}
	session.cancel()
	<-session.done
	_ = os.RemoveAll(session.dir)
}

func newID() (string, error) {
	data := make([]byte, 16)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write JSON response: %v", err)
	}
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}
