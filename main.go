package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
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
	ID       string `json:"id"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Modified string `json:"modified"`
}

type playbackSession struct {
	dir    string
	cancel context.CancelFunc
	done   chan struct{}
}

type server struct {
	mediaRoot string
	ffmpeg    string
	mu        sync.Mutex
	sessions  map[string]*playbackSession
}

func main() {
	mediaDir := flag.String("media", "./movies", "folder containing movie files")
	addr := flag.String("addr", "127.0.0.1:8080", "HTTP listen address (use 0.0.0.0 to listen on your LAN)")
	ffmpeg := flag.String("ffmpeg", "ffmpeg", "FFmpeg executable used for compatibility transcoding")
	flag.Parse()

	root, err := filepath.Abs(*mediaDir)
	if err != nil {
		log.Fatal(err)
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		log.Fatalf("media folder %q does not exist or is not a directory", root)
	}

	app := &server{mediaRoot: root, ffmpeg: *ffmpeg, sessions: make(map[string]*playbackSession)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/library", app.library)
	mux.HandleFunc("GET /api/media/{id}", app.media)
	mux.HandleFunc("POST /api/playback/{id}", app.startTranscode)
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

func (s *server) library(w http.ResponseWriter, r *http.Request) {
	items := make([]movie, 0)
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
		items = append(items, movie{
			ID:       base64.RawURLEncoding.EncodeToString([]byte(rel)),
			Name:     strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())),
			Path:     rel,
			Size:     info.Size(),
			Modified: info.ModTime().Format(time.RFC3339),
		})
		return nil
	})
	if err != nil {
		http.Error(w, "could not scan media folder", http.StatusInternalServerError)
		return
	}
	sort.Slice(items, func(i, j int) bool { return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name) })
	writeJSON(w, items)
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

type playbackResponse struct {
	Session string `json:"session"`
	URL     string `json:"url"`
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
	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin", "-re", "-i", path,
		"-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "160k", "-ac", "2",
		"-force_key_frames", "expr:gte(t,n_forced*4)",
		"-f", "hls", "-hls_time", "4", "-hls_list_size", "0", "-hls_playlist_type", "event",
		"-hls_flags", "independent_segments", "-hls_segment_filename", segmentPattern, playlistPath,
	}
	cmd := exec.CommandContext(ctx, s.ffmpeg, args...)
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		cancel()
		_ = os.RemoveAll(dir)
		http.Error(w, "could not start FFmpeg", http.StatusInternalServerError)
		return
	}
	session := &playbackSession{dir: dir, cancel: cancel, done: make(chan struct{})}
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
			writeJSON(w, playbackResponse{Session: id, URL: "/api/playback/" + id + "/index.m3u8"})
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
