import {
  ALL_FORMATS,
  AudioBufferSink,
  CanvasSink,
  HLS_FORMATS,
  Input,
  UrlSource,
  type WrappedAudioBuffer,
  type WrappedCanvas,
} from 'mediabunny';
import './style.css';

type Movie = { id: string; name: string; path: string; size: number; modified: string };
type Playback = { session: string; url: string };

const root = document.querySelector<HTMLDivElement>('#app')!;
root.innerHTML = `
  <header class="topbar">
    <a class="brand" href="#" aria-label="Tissue home"><span class="brand-mark">t</span><span>tissue</span></a>
    <div class="topbar-note"><span class="status-dot"></span> Your home library</div>
  </header>
  <main>
    <section class="hero">
      <p class="eyebrow">A little cinema at home</p>
      <h1>Pick a movie.<br><em>Settle in.</em></h1>
      <p class="intro">Your collection, ready when you are.</p>
    </section>
    <section class="library-section" aria-labelledby="library-title">
      <div class="section-heading"><div><p class="eyebrow">On your server</p><h2 id="library-title">Your library</h2></div><span id="movie-count" class="count"></span></div>
      <div id="notice" class="notice" role="status">Looking for movies…</div>
      <div id="library" class="library-grid"></div>
    </section>
  </main>
  <div id="player-layer" class="player-layer" hidden>
    <div class="player-shell">
      <div class="player-heading"><div><p class="eyebrow">Now playing</p><h2 id="player-title"></h2></div><button id="close-player" class="icon-button" aria-label="Close player">×</button></div>
      <div id="player-error" class="player-error" hidden></div>
      <div class="screen" id="screen">
        <canvas id="video" width="1280" height="720"></canvas>
        <div id="player-loading" class="player-loading">Preparing your movie…</div>
        <div class="controls">
          <button id="play-pause" class="control-button" aria-label="Play">▶</button>
          <span id="elapsed" class="time">0:00</span>
          <input id="seek" class="seek" type="range" min="0" max="1000" value="0" aria-label="Seek" />
          <span id="duration" class="time">0:00</span>
          <button id="fullscreen" class="control-button" aria-label="Fullscreen">⛶</button>
        </div>
      </div>
      <div class="player-footer"><span id="playback-mode">Direct playback</span><button id="transcode" class="text-button">Try compatibility mode</button></div>
    </div>
  </div>
`;

const library = document.querySelector<HTMLDivElement>('#library')!;
const notice = document.querySelector<HTMLDivElement>('#notice')!;
const playerLayer = document.querySelector<HTMLDivElement>('#player-layer')!;
const canvas = document.querySelector<HTMLCanvasElement>('#video')!;
const context = canvas.getContext('2d')!;
const loading = document.querySelector<HTMLDivElement>('#player-loading')!;
const errorBox = document.querySelector<HTMLDivElement>('#player-error')!;
const playButton = document.querySelector<HTMLButtonElement>('#play-pause')!;
const seek = document.querySelector<HTMLInputElement>('#seek')!;
const elapsed = document.querySelector<HTMLSpanElement>('#elapsed')!;
const durationLabel = document.querySelector<HTMLSpanElement>('#duration')!;
const titleLabel = document.querySelector<HTMLHeadingElement>('#player-title')!;
const modeLabel = document.querySelector<HTMLSpanElement>('#playback-mode')!;
const transcodeButton = document.querySelector<HTMLButtonElement>('#transcode')!;

let activeInput: Input | undefined;
let videoSink: CanvasSink | undefined;
let audioSink: AudioBufferSink | undefined;
let audioContext: AudioContext | undefined;
let gain: GainNode | undefined;
let frameIterator: AsyncGenerator<WrappedCanvas, void, unknown> | undefined;
let audioIterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | undefined;
let nextFrame: WrappedCanvas | undefined;
let queuedAudio = new Set<AudioBufferSourceNode>();
let currentMovie: Movie | undefined;
let activeSession: string | undefined;
let playing = false;
let position = 0;
let duration = 0;
let playbackStartedAt = 0;
let positionAtStart = 0;
let generation = 0;
let resumeAfterSeek = false;
let streamIsLive = false;
let liveRefreshTimer: number | undefined;

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const seconds = Math.floor(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function currentTime(): number {
  return playing && audioContext ? positionAtStart + audioContext.currentTime - playbackStartedAt : position;
}

function setError(message: string): void {
  errorBox.textContent = message;
  errorBox.hidden = false;
  loading.hidden = true;
}

async function loadLibrary(): Promise<void> {
  try {
    const response = await fetch('/api/library');
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const movies = await response.json() as Movie[];
    notice.hidden = movies.length > 0;
    notice.textContent = movies.length ? '' : 'No movies found yet. Add video files to the configured folder and refresh.';
    document.querySelector('#movie-count')!.textContent = `${movies.length} ${movies.length === 1 ? 'movie' : 'movies'}`;
    library.innerHTML = movies.map((movie) => `
      <article class="movie-card">
        <button class="poster" data-play="${movie.id}" aria-label="Play ${escapeHTML(movie.name)}">
          <span class="poster-art"><span class="poster-orbit orbit-one"></span><span class="poster-orbit orbit-two"></span><span class="poster-play">▶</span><span class="poster-caption">HOME VIDEO</span></span>
        </button>
        <div class="movie-meta"><div><h3>${escapeHTML(movie.name)}</h3><p>${escapeHTML(movie.path)}</p></div><span class="movie-size">${formatSize(movie.size)}</span></div>
      </article>`).join('');
    library.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((button) => {
      button.addEventListener('click', () => {
        const movie = movies.find((item) => item.id === button.dataset.play);
        if (movie) void openMovie(movie);
      });
    });
  } catch (error) {
    notice.hidden = false;
    notice.textContent = `Could not load the library: ${String(error)}`;
  }
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function formatSize(size: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function disposePlayer(): Promise<void> {
  generation++;
  if (liveRefreshTimer !== undefined) window.clearInterval(liveRefreshTimer);
  liveRefreshTimer = undefined;
  streamIsLive = false;
  playing = false;
  try { await frameIterator?.return(); } catch { /* already closed */ }
  try { await audioIterator?.return(); } catch { /* already closed */ }
  frameIterator = undefined;
  audioIterator = undefined;
  for (const source of queuedAudio) { try { source.stop(); } catch { /* already stopped */ } }
  queuedAudio.clear();
  activeInput?.dispose();
  activeInput = undefined;
  videoSink = undefined;
  audioSink = undefined;
  if (audioContext) await audioContext.close().catch(() => undefined);
  audioContext = undefined;
  gain = undefined;
  if (activeSession) {
    const id = activeSession;
    activeSession = undefined;
    void fetch(`/api/playback/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

async function openMovie(movie: Movie, hls?: Playback): Promise<void> {
  await disposePlayer();
  activeSession = hls?.session;
  const thisGeneration = generation;
  currentMovie = movie;
  titleLabel.textContent = movie.name;
  playerLayer.hidden = false;
  document.body.classList.add('has-player');
  errorBox.hidden = true;
  loading.hidden = false;
  loading.textContent = hls ? 'Starting compatibility stream…' : 'Preparing your movie…';
  modeLabel.textContent = hls ? 'FFmpeg HLS compatibility stream' : 'Direct playback';
  transcodeButton.hidden = Boolean(hls);
  playButton.disabled = true;

  try {
    const url = hls?.url ?? `/api/media/${movie.id}`;
    const formats = hls ? HLS_FORMATS : ALL_FORMATS;
    const input = new Input({ source: new UrlSource(url), formats });
    activeInput = input;
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!videoTrack && !audioTrack) throw new Error('This file has no playable audio or video track.');
    if (videoTrack && !(await videoTrack.canDecode())) throw new Error('This browser cannot decode the video track. Try compatibility mode.');
    if (audioTrack && !(await audioTrack.canDecode())) throw new Error('This browser cannot decode the audio track. Try compatibility mode.');
    if (thisGeneration !== generation) return;

    const tracks = [videoTrack, audioTrack].filter((track) => track !== null);
    duration = await input.getDurationFromMetadata(tracks, { skipLiveWait: true }) ?? await input.computeDuration(tracks, { skipLiveWait: true });
    const liveIntervals = (await Promise.all(tracks.map((track) => track.getLiveRefreshInterval()))).filter((interval): interval is number => interval !== null);
    streamIsLive = liveIntervals.length > 0;
    if (streamIsLive) {
      const refreshMs = Math.max(1000, Math.min(...liveIntervals) * 1000);
      liveRefreshTimer = window.setInterval(() => {
        void (async () => {
          try {
            duration = await input.getDurationFromMetadata(tracks, { skipLiveWait: true }) ?? await input.computeDuration(tracks, { skipLiveWait: true });
            durationLabel.textContent = formatTime(duration);
            const statuses = await Promise.all(tracks.map((track) => track.isLive()));
            if (statuses.every((live) => !live)) {
              streamIsLive = false;
              if (liveRefreshTimer !== undefined) window.clearInterval(liveRefreshTimer);
              liveRefreshTimer = undefined;
            }
          } catch (error) {
            console.warn('Could not refresh live stream duration:', error);
          }
        })();
      }, refreshMs);
    }
    position = Math.max(0, await input.getFirstTimestamp(tracks));
    audioContext = new AudioContext({ sampleRate: await audioTrack?.getSampleRate() });
    gain = audioContext.createGain();
    gain.connect(audioContext.destination);
    videoSink = videoTrack ? new CanvasSink(videoTrack, { fit: 'contain', poolSize: 2 }) : undefined;
    audioSink = audioTrack ? new AudioBufferSink(audioTrack) : undefined;
    if (videoTrack) {
      canvas.width = await videoTrack.getDisplayWidth();
      canvas.height = await videoTrack.getDisplayHeight();
    } else {
      canvas.width = 1280;
      canvas.height = 240;
    }
    seek.value = '0';
    seek.disabled = !Number.isFinite(duration) || duration <= 0;
    durationLabel.textContent = formatTime(duration);
    elapsed.textContent = formatTime(position);
    await resetFrameIterator();
    if (thisGeneration !== generation) return;
    loading.hidden = true;
    playButton.disabled = false;
    playButton.textContent = '▶';
  } catch (error) {
    if (thisGeneration === generation) setError(`${String(error)}${hls ? '' : ' You can try compatibility mode.'}`);
  }
}

async function resetFrameIterator(): Promise<void> {
  if (!videoSink) return;
  try { await frameIterator?.return(); } catch { /* already closed */ }
  frameIterator = videoSink.canvases(position);
  const first = (await frameIterator.next()).value;
  if (first) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(first.canvas, 0, 0);
  }
  nextFrame = (await frameIterator.next()).value || undefined;
}

async function startPlayback(): Promise<void> {
  if (!audioContext) return;
  if (position >= duration && duration > 0) {
    position = 0;
    await resetFrameIterator();
  }
  if (audioContext.state === 'suspended') await audioContext.resume();
  playbackStartedAt = audioContext.currentTime;
  positionAtStart = position;
  playing = true;
  playButton.textContent = 'Ⅱ';
  playButton.setAttribute('aria-label', 'Pause');
  if (audioSink) {
    audioIterator = audioSink.buffers(position);
    void scheduleAudio(audioIterator, generation);
  }
}

async function scheduleAudio(iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown>, thisGeneration: number): Promise<void> {
  if (!audioContext || !gain) return;
  try {
    for await (const item of iterator) {
      if (thisGeneration !== generation || !playing || !audioContext || !gain) return;
      const source = audioContext.createBufferSource();
      source.buffer = item.buffer;
      source.connect(gain);
      const startAt = playbackStartedAt + item.timestamp - positionAtStart;
      source.start(Math.max(audioContext.currentTime, startAt));
      queuedAudio.add(source);
      source.onended = () => queuedAudio.delete(source);
      if (startAt > audioContext.currentTime + 2) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, (startAt - audioContext!.currentTime - 1) * 500)));
      }
    }
  } catch (error) {
    if (thisGeneration === generation) console.warn('Audio playback stopped:', error);
  }
}

function pausePlayback(): void {
  if (!playing) return;
  position = currentTime();
  playing = false;
  void audioIterator?.return();
  audioIterator = undefined;
  for (const source of queuedAudio) { try { source.stop(); } catch { /* already stopped */ } }
  queuedAudio.clear();
  playButton.textContent = '▶';
  playButton.setAttribute('aria-label', 'Play');
}

async function togglePlayback(): Promise<void> {
  if (playing) pausePlayback();
  else await startPlayback();
}

async function transcodeCurrent(): Promise<void> {
  if (!currentMovie) return;
  transcodeButton.disabled = true;
  loading.hidden = false;
  loading.textContent = 'Starting FFmpeg…';
  errorBox.hidden = true;
  try {
    const response = await fetch(`/api/playback/${currentMovie.id}`, { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    const playback = await response.json() as Playback;
    await openMovie(currentMovie, playback);
  } catch (error) {
    setError(String(error));
  } finally {
    transcodeButton.disabled = false;
  }
}

function drawLoop(): void {
  if (playing && videoSink) {
    position = currentTime();
    if (!streamIsLive && duration > 0 && position >= duration) {
      position = duration;
      pausePlayback();
    }
    if (nextFrame && nextFrame.timestamp <= position) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(nextFrame.canvas, 0, 0);
      nextFrame = undefined;
      const expectedGeneration = generation;
      void frameIterator?.next().then(({ value }) => {
        if (expectedGeneration === generation) nextFrame = value || undefined;
      }).catch((error) => console.warn('Video playback stopped:', error));
    }
  }
  elapsed.textContent = formatTime(position);
  if (duration > 0 && !seek.matches(':active')) seek.value = String(Math.min(1000, Math.round((position / duration) * 1000)));
  requestAnimationFrame(drawLoop);
}

document.querySelector<HTMLButtonElement>('#close-player')!.addEventListener('click', () => {
  playerLayer.hidden = true;
  document.body.classList.remove('has-player');
  void disposePlayer();
});
playButton.addEventListener('click', () => void togglePlayback());
transcodeButton.addEventListener('click', () => void transcodeCurrent());
seek.addEventListener('change', async () => {
  if (!duration) return;
  resumeAfterSeek = playing;
  pausePlayback();
  position = (Number(seek.value) / 1000) * duration;
  elapsed.textContent = formatTime(position);
  try { await resetFrameIterator(); } catch (error) { setError(String(error)); }
  if (resumeAfterSeek) await startPlayback();
});
document.querySelector<HTMLButtonElement>('#fullscreen')!.addEventListener('click', () => {
  const screen = document.querySelector<HTMLDivElement>('#screen')!;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void screen.requestFullscreen();
});
document.addEventListener('keydown', (event) => {
  if (playerLayer.hidden) return;
  if (event.key === 'Escape') document.querySelector<HTMLButtonElement>('#close-player')!.click();
  else if (event.key === ' ' && (event.target as HTMLElement).tagName !== 'INPUT') {
    event.preventDefault();
    void togglePlayback();
  }
});

void loadLibrary();
drawLoop();
