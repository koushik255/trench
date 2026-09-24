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

type Movie = { id: string; name: string; path: string; size: number; modified: string; duration: number; isMovie: boolean };
type Library = { movies: Movie[]; other: Movie[] };
type Playback = { session: string; url: string; audioOnly?: boolean; duration?: number };
type TranscodeStatus = { readyDuration: number; duration: number; complete: boolean };
type SubtitleCue = { start: number; end: number; text: string };
type SubtitleSettings = { enabled: boolean; size: number; color: string; background: number; bottom: number; offset: number };

const root = document.querySelector<HTMLDivElement>('#app')!;
root.innerHTML = `
  <table width="100%" cellspacing="0" cellpadding="12">
    <tbody id="layout-body">
    <tr id="layout-row">
      <td id="library-cell" width="280" valign="top">
        <p><label for="search">Search: <input id="search" type="search" placeholder="Title or folder" autocomplete="off" /></label></p>
        <p><label for="category">Show: <select id="category"><option value="movies">Movies</option><option value="other">Other videos</option></select></label></p>
        <p id="movie-count"></p>
        <p id="notice" role="status">Looking for movies…</p>
        <select id="library" size="28" width="100%" aria-label="Movies"></select>
      </td>
      <td id="player-cell" valign="top">
        <p id="empty-state">Select a movie.</p>
        <section id="player-layer" hidden>
          <p><button id="close-player" type="button">Back to library</button></p>
          <h2 id="player-title" tabindex="-1"></h2>
          <div id="player-error" hidden></div>
          <div id="screen" align="center">
            <table width="100%" height="100%" cellspacing="0" cellpadding="0">
              <tr><td align="center" valign="middle">
                <canvas id="video" width="1280" height="720"></canvas>
                <p id="player-loading">Preparing your movie…</p>
                <p><button id="play-pause" type="button" aria-label="Play">Play</button> <span id="elapsed">0:00</span> <input id="seek" type="range" min="0" max="1000" value="0" aria-label="Seek" /> <span id="duration">0:00</span> <button id="fullscreen" type="button" aria-label="Fullscreen">Fullscreen</button></p>
              </td></tr>
            </table>
          </div>
          <p><span id="playback-mode">Direct playback</span> <input id="subtitle-file" type="file" accept=".srt,.vtt,.ass,.ssa,text/vtt" hidden /><button id="open-subtitles" type="button">Import subtitles</button> <button id="transcode" type="button">Transcode for playback</button></p>
          <fieldset id="subtitle-settings" hidden>
            <legend>Subtitle settings</legend>
            <label><input id="subtitle-enabled" type="checkbox" checked /> Show subtitles</label>
            <label>Size <input id="subtitle-size" type="range" min="1" max="10" step="0.5" value="6" /> <output id="subtitle-size-value">6%</output></label>
            <label>Color <input id="subtitle-color" type="color" value="#ffffff" /></label>
            <label>Background <input id="subtitle-background" type="range" min="0" max="90" value="55" /> <output id="subtitle-background-value">55%</output></label>
            <label>Height <input id="subtitle-bottom" type="range" min="5" max="30" value="12" /> <output id="subtitle-bottom-value">12%</output></label>
            <label>Timing <input id="subtitle-offset" type="range" min="-10" max="10" step="0.1" value="0" /> <output id="subtitle-offset-value">0.0s</output></label>
          </fieldset>
          <div id="audio-progress" hidden><span id="audio-progress-label">Preparing audio…</span> <span id="audio-progress-time"></span><progress id="audio-progress-bar" max="100" value="0"></progress></div>
          <p id="subtitle-status" aria-live="polite"></p>
        </section>
      </td>
    </tr>
    </tbody>
  </table>
`;

const layoutBody = document.querySelector<HTMLTableSectionElement>('#layout-body')!;
const layoutRow = document.querySelector<HTMLTableRowElement>('#layout-row')!;
const libraryCell = document.querySelector<HTMLTableCellElement>('#library-cell')!;
const playerCell = document.querySelector<HTMLTableCellElement>('#player-cell')!;
const library = document.querySelector<HTMLSelectElement>('#library')!;
const notice = document.querySelector<HTMLDivElement>('#notice')!;
const emptyState = document.querySelector<HTMLElement>('#empty-state')!;
const search = document.querySelector<HTMLInputElement>('#search')!;
const category = document.querySelector<HTMLSelectElement>('#category')!;
const playerLayer = document.querySelector<HTMLDivElement>('#player-layer')!;
const canvas = document.querySelector<HTMLCanvasElement>('#video')!;
const screen = document.querySelector<HTMLDivElement>('#screen')!;
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
const subtitleFile = document.querySelector<HTMLInputElement>('#subtitle-file')!;
const openSubtitlesButton = document.querySelector<HTMLButtonElement>('#open-subtitles')!;
const subtitleStatus = document.querySelector<HTMLParagraphElement>('#subtitle-status')!;
const subtitleSettingsPanel = document.querySelector<HTMLFieldSetElement>('#subtitle-settings')!;
const subtitleEnabled = document.querySelector<HTMLInputElement>('#subtitle-enabled')!;
const subtitleSize = document.querySelector<HTMLInputElement>('#subtitle-size')!;
const subtitleSizeValue = document.querySelector<HTMLOutputElement>('#subtitle-size-value')!;
const subtitleColor = document.querySelector<HTMLInputElement>('#subtitle-color')!;
const subtitleBackground = document.querySelector<HTMLInputElement>('#subtitle-background')!;
const subtitleBackgroundValue = document.querySelector<HTMLOutputElement>('#subtitle-background-value')!;
const subtitleBottom = document.querySelector<HTMLInputElement>('#subtitle-bottom')!;
const subtitleBottomValue = document.querySelector<HTMLOutputElement>('#subtitle-bottom-value')!;
const subtitleOffset = document.querySelector<HTMLInputElement>('#subtitle-offset')!;
const subtitleOffsetValue = document.querySelector<HTMLOutputElement>('#subtitle-offset-value')!;
const audioProgress = document.querySelector<HTMLDivElement>('#audio-progress')!;
const audioProgressLabel = document.querySelector<HTMLSpanElement>('#audio-progress-label')!;
const audioProgressTime = document.querySelector<HTMLSpanElement>('#audio-progress-time')!;
const audioProgressBar = document.querySelector<HTMLProgressElement>('#audio-progress-bar')!;

let activeInput: Input | undefined;
let activeAudioInput: Input | undefined;
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
let audioStatusTimer: number | undefined;
let sourceVideoWidth = 1280;
let sourceVideoHeight = 720;
let wakeLock: WakeLockSentinel | undefined;
let mobilePlayerRow: HTMLTableRowElement | undefined;
let libraryData: Library = { movies: [], other: [] };
let subtitleCues: SubtitleCue[] = [];
let currentFrame: CanvasImageSource | undefined;
const subtitleSettings: SubtitleSettings = { enabled: true, size: 6, color: '#ffffff', background: 55, bottom: 12, offset: 0 };

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

function resizeCanvas(maxWidth: number, maxHeight: number): void {
  const scale = Math.min(maxWidth / sourceVideoWidth, maxHeight / sourceVideoHeight);
  canvas.width = Math.max(1, Math.round(sourceVideoWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceVideoHeight * scale));
}

function resizeCanvasToAvailableSpace(): void {
  const fullscreen = document.fullscreenElement === screen;
  const maxWidth = fullscreen ? window.innerWidth : Math.max(1, Math.min(window.innerWidth, screen.clientWidth || window.innerWidth));
  const maxHeight = fullscreen ? Math.max(120, window.innerHeight - 100) : Math.max(120, window.innerHeight - 240);
  resizeCanvas(maxWidth, maxHeight);
}

function updateResponsiveLayout(): void {
  const mobile = window.innerWidth < 720;
  if (mobile && playerCell.parentElement === layoutRow) {
    mobilePlayerRow = document.createElement('tr');
    mobilePlayerRow.append(playerCell);
    layoutBody.append(mobilePlayerRow);
  } else if (!mobile && playerCell.parentElement !== layoutRow) {
    layoutRow.append(playerCell);
    mobilePlayerRow?.remove();
    mobilePlayerRow = undefined;
  }
  library.size = mobile ? 10 : 28;
  libraryCell.setAttribute('width', mobile ? '100%' : '280');
  if (mobile) playerCell.setAttribute('width', '100%');
  else playerCell.removeAttribute('width');
}

function setError(message: string): void {
  errorBox.textContent = message;
  errorBox.hidden = false;
  loading.hidden = true;
}

async function requestWakeLock(): Promise<void> {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = undefined; });
  } catch (error) {
    console.warn('Could not keep the screen awake:', error);
  }
}

async function releaseWakeLock(): Promise<void> {
  const lock = wakeLock;
  wakeLock = undefined;
  if (lock) await lock.release().catch(() => undefined);
}

async function loadLibrary(): Promise<void> {
  try {
    const response = await fetch('/api/library');
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    libraryData = await response.json() as Library;
    renderLibrary();
  } catch (error) {
    notice.hidden = false;
    notice.textContent = `Could not load the library: ${String(error)}`;
  }
}

function renderLibrary(): void {
    const all = category.value === 'other' ? libraryData.other : libraryData.movies;
    const query = search.value.trim().toLocaleLowerCase();
    const movies = query ? all.filter((movie) => `${movie.name} ${movie.path}`.toLocaleLowerCase().includes(query)) : all;
    const label = category.value === 'other' ? 'other video' : 'movie';
    notice.hidden = movies.length > 0;
    notice.textContent = movies.length ? '' : query ? `No ${label}s match “${search.value.trim()}”.` : `No ${label}s found yet. Add video files to the configured folder and refresh.`;
    document.querySelector('#movie-count')!.textContent = `${movies.length} ${movies.length === 1 ? label : `${label}s`}`;
    library.innerHTML = movies.map((movie) => `<option value="${movie.id}">${escapeHTML(movie.name)} (${formatTime(movie.duration)})</option>`).join('');
    library.onchange = () => {
      const movie = movies.find((item) => item.id === library.value);
      if (movie) void openMovie(movie);
    };
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function parseSubtitleTime(value: string): number {
  const parts = value.trim().replace(',', '.').split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

function parseSubtitles(source: string): SubtitleCue[] {
  const blocks = source.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n\s*\n/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trimEnd());
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const [startText, endText] = lines[timingIndex].split('-->').map((value) => value.trim().split(/\s+/)[0]);
    const start = parseSubtitleTime(startText);
    const end = parseSubtitleTime(endText);
    const text = lines.slice(timingIndex + 1).join('\n').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && text) cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function updateSubtitles(): void {
  // Subtitle pixels are painted by drawVideoFrame, so they are included in
  // the same canvas as the movie and remain visible in fullscreen/capture.
}

function drawVideoFrame(frame: CanvasImageSource): void {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(frame, 0, 0, canvas.width, canvas.height);
  if (!subtitleSettings.enabled) return;
  const subtitleTime = position - subtitleSettings.offset;
  const cue = subtitleCues.find((item) => subtitleTime >= item.start && subtitleTime <= item.end);
  if (!cue) return;

  const fontSize = Math.max(8, canvas.width * subtitleSettings.size / 100);
  context.font = `600 ${fontSize}px system-ui, sans-serif`;
  const lines = cue.text.split(/\n/).flatMap((line) => {
    const words = line.split(/\s+/).filter(Boolean);
    const wrapped: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (context.measureText(candidate).width > canvas.width * 0.86 && current) {
        wrapped.push(current);
        current = word;
      } else current = candidate;
    }
    if (current) wrapped.push(current);
    return wrapped.length ? wrapped : [''];
  });
  context.save();
  context.textAlign = 'center';
  context.textBaseline = 'bottom';
  context.shadowColor = '#000';
  context.shadowBlur = Math.max(2, fontSize * 0.18);
  const lineHeight = fontSize * 1.25;
  const bottom = canvas.height * subtitleSettings.bottom / 100;
  const firstLine = canvas.height - bottom - (lines.length - 1) * lineHeight;
  for (let index = 0; index < lines.length; index++) {
    const y = firstLine + index * lineHeight;
    const metrics = context.measureText(lines[index]);
    const padding = fontSize * 0.35;
    context.shadowBlur = 0;
    context.fillStyle = `rgba(0, 0, 0, ${subtitleSettings.background / 100})`;
    context.fillRect(canvas.width / 2 - metrics.width / 2 - padding, y - fontSize - padding / 2, metrics.width + padding * 2, fontSize + padding);
    context.fillStyle = subtitleSettings.color;
    context.shadowColor = '#000';
    context.shadowBlur = Math.max(2, fontSize * 0.18);
    context.fillText(lines[index], canvas.width / 2, y);
  }
  context.restore();
}

search.addEventListener('input', renderLibrary);
category.addEventListener('change', renderLibrary);

async function disposePlayer(): Promise<void> {
  generation++;
  if (liveRefreshTimer !== undefined) window.clearInterval(liveRefreshTimer);
  liveRefreshTimer = undefined;
  if (audioStatusTimer !== undefined) window.clearInterval(audioStatusTimer);
  audioStatusTimer = undefined;
  streamIsLive = false;
  playing = false;
  await releaseWakeLock();
  try { await frameIterator?.return(); } catch { /* already closed */ }
  try { await audioIterator?.return(); } catch { /* already closed */ }
  frameIterator = undefined;
  audioIterator = undefined;
  for (const source of queuedAudio) { try { source.stop(); } catch { /* already stopped */ } }
  queuedAudio.clear();
  activeInput?.dispose();
  activeInput = undefined;
  activeAudioInput?.dispose();
  activeAudioInput = undefined;
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
  audioProgress.hidden = true;
}

async function waitForAudioReady(playback: Playback, movieDuration: number): Promise<void> {
  if (!playback.audioOnly) return;
  audioProgress.hidden = false;
  audioProgressLabel.textContent = 'Transcoding audio…';
  const target = Math.min(30, movieDuration || playback.duration || 30);
  const update = async (): Promise<TranscodeStatus> => {
    const response = await fetch(`/api/playback/${playback.session}/status`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not read audio transcode status.');
    const status = await response.json() as TranscodeStatus;
    const total = status.duration || movieDuration || target;
    audioProgressBar.value = Math.min(100, total ? (status.readyDuration / total) * 100 : 0);
    audioProgressTime.textContent = `${formatTime(status.readyDuration)} / ${formatTime(total)}`;
    return status;
  };
  while (true) {
    const status = await update();
    if (status.complete || status.readyDuration >= target) {
      audioProgressLabel.textContent = status.complete ? 'Audio ready' : 'Audio buffered';
      if (!status.complete) {
        audioStatusTimer = window.setInterval(() => { void update().catch(() => undefined); }, 750);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function openMovie(movie: Movie, hls?: Playback): Promise<void> {
  const sameMovie = currentMovie?.id === movie.id;
  await disposePlayer();
  activeSession = hls?.session;
  const thisGeneration = generation;
  currentMovie = movie;
  if (!sameMovie) {
    subtitleCues = [];
    subtitleStatus.textContent = '';
    subtitleSettingsPanel.hidden = true;
  }
  titleLabel.textContent = movie.name;
  playerLayer.hidden = false;
  emptyState.hidden = true;
  if (window.innerWidth < 720) requestAnimationFrame(() => playerLayer.scrollIntoView({ block: 'start' }));
  titleLabel.focus({ preventScroll: true });
  document.body.classList.add('has-player');
  errorBox.hidden = true;
  loading.hidden = false;
  loading.textContent = hls ? 'Starting compatibility stream…' : 'Preparing your movie…';
  modeLabel.textContent = hls ? 'FFmpeg HLS compatibility stream' : 'Direct playback';
  transcodeButton.hidden = Boolean(hls);
  playButton.disabled = true;

  try {
    const input = new Input({ source: new UrlSource(`/api/media/${movie.id}`), formats: ALL_FORMATS });
    activeInput = input;
    const videoTrack = await input.getPrimaryVideoTrack();
    let audioTrack = await input.getPrimaryAudioTrack();
    if (!videoTrack && !audioTrack) throw new Error('This file has no playable audio or video track.');
    if (videoTrack && !(await videoTrack.canDecode())) throw new Error('This browser cannot decode the video track. Try compatibility mode.');
    if (hls?.audioOnly) {
      await waitForAudioReady(hls, movie.duration);
      activeAudioInput = new Input({ source: new UrlSource(hls.url), formats: HLS_FORMATS });
      audioTrack = await activeAudioInput.getPrimaryAudioTrack();
    } else if (audioTrack && !(await audioTrack.canDecode())) {
      throw new Error('This browser cannot decode the audio track.');
    }
    if (!videoTrack && !audioTrack) throw new Error('This file has no playable audio or video track.');
    if (thisGeneration !== generation) return;

    // The audio-only HLS track belongs to a second Input. Keep it out of the
    // original input's metadata/live-duration queries; the library duration is
    // already the authoritative movie timeline.
    const tracks = [videoTrack, hls?.audioOnly ? null : audioTrack].filter((track) => track !== null);
    duration = movie.duration || (await input.getDurationFromMetadata(tracks, { skipLiveWait: true }) ?? await input.computeDuration(tracks, { skipLiveWait: true }));
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
      sourceVideoWidth = await videoTrack.getDisplayWidth();
      sourceVideoHeight = await videoTrack.getDisplayHeight();
      resizeCanvasToAvailableSpace();
    } else {
      sourceVideoWidth = 1280;
      sourceVideoHeight = 240;
      resizeCanvasToAvailableSpace();
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
    if (thisGeneration !== generation) return;
    const message = String(error);
    if (!hls && currentMovie && message.includes('audio track')) {
      // Browsers commonly reject E-AC-3/Atmos. Keep the video and convert only audio.
      await transcodeCurrent(true);
    } else {
      setError(`${message}${hls ? '' : ' You can try compatibility mode.'}`);
    }
  }
}

async function resetFrameIterator(): Promise<void> {
  if (!videoSink) return;
  try { await frameIterator?.return(); } catch { /* already closed */ }
  frameIterator = videoSink.canvases(position);
  const first = (await frameIterator.next()).value;
  if (first) {
    currentFrame = first.canvas;
    drawVideoFrame(first.canvas);
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
  await requestWakeLock();
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
  void releaseWakeLock();
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

async function transcodeCurrent(audioOnly = false): Promise<void> {
  if (!currentMovie) return;
  transcodeButton.disabled = true;
  loading.hidden = false;
  loading.textContent = 'Starting FFmpeg…';
  errorBox.hidden = true;
  try {
    const suffix = audioOnly ? '?audioOnly=1' : '';
    const response = await fetch(`/api/playback/${currentMovie.id}${suffix}`, { method: 'POST' });
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
      currentFrame = nextFrame.canvas;
      drawVideoFrame(nextFrame.canvas);
      nextFrame = undefined;
      const expectedGeneration = generation;
      void frameIterator?.next().then(({ value }) => {
        if (expectedGeneration === generation) nextFrame = value || undefined;
      }).catch((error) => console.warn('Video playback stopped:', error));
    }
  }
  elapsed.textContent = formatTime(position);
  if (duration > 0 && !seek.matches(':active')) seek.value = String(Math.min(1000, Math.round((position / duration) * 1000)));
  updateSubtitles();
  requestAnimationFrame(drawLoop);
}

document.querySelector<HTMLButtonElement>('#close-player')!.addEventListener('click', () => {
  playerLayer.hidden = true;
  emptyState.hidden = false;
  document.body.classList.remove('has-player');
  void disposePlayer();
});
playButton.addEventListener('click', () => void togglePlayback());
transcodeButton.addEventListener('click', () => void transcodeCurrent());
openSubtitlesButton.addEventListener('click', () => subtitleFile.click());
subtitleFile.addEventListener('change', async () => {
  const file = subtitleFile.files?.[0];
  if (!file) return;
  try {
    subtitleCues = parseSubtitles(await file.text());
    subtitleSettingsPanel.hidden = !subtitleCues.length;
    subtitleStatus.textContent = subtitleCues.length ? `${subtitleCues.length} subtitle cues loaded from ${file.name}.` : 'No subtitle cues found in that file.';
    drawCurrentFrame();
  } catch (error) {
    subtitleStatus.textContent = `Could not load subtitles: ${String(error)}`;
  }
});

function drawCurrentFrame(): void {
  // Redraw the current frame so a settings change is reflected immediately.
  if (currentFrame) drawVideoFrame(currentFrame);
}

function updateSubtitleSettings(): void {
  subtitleSettings.enabled = subtitleEnabled.checked;
  subtitleSettings.size = Number(subtitleSize.value);
  subtitleSettings.color = subtitleColor.value;
  subtitleSettings.background = Number(subtitleBackground.value);
  subtitleSettings.bottom = Number(subtitleBottom.value);
  subtitleSettings.offset = Number(subtitleOffset.value);
  subtitleSizeValue.value = `${subtitleSettings.size}%`;
  subtitleBackgroundValue.value = `${subtitleSettings.background}%`;
  subtitleBottomValue.value = `${subtitleSettings.bottom}%`;
  subtitleOffsetValue.value = `${subtitleSettings.offset > 0 ? '+' : ''}${subtitleSettings.offset.toFixed(1)}s`;
  drawCurrentFrame();
}

[subtitleEnabled, subtitleSize, subtitleColor, subtitleBackground, subtitleBottom, subtitleOffset].forEach((control) => {
  control.addEventListener('input', updateSubtitleSettings);
});
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
  if (document.fullscreenElement) void document.exitFullscreen();
  else void screen.requestFullscreen();
});
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement === screen) {
    resizeCanvasToAvailableSpace();
  } else {
    resizeCanvasToAvailableSpace();
  }
  void resetFrameIterator();
});
window.addEventListener('resize', () => {
  updateResponsiveLayout();
  if (!playerLayer.hidden) {
    resizeCanvasToAvailableSpace();
    void resetFrameIterator();
  }
});
document.addEventListener('visibilitychange', () => {
  if (playing && document.visibilityState === 'visible') void requestWakeLock();
});
document.addEventListener('keydown', (event) => {
  if (playerLayer.hidden) return;
  if (event.key === 'Escape') document.querySelector<HTMLButtonElement>('#close-player')!.click();
  else if (event.key === ' ' && (event.target as HTMLElement).tagName !== 'INPUT') {
    event.preventDefault();
    void togglePlayback();
  }
});

updateResponsiveLayout();
void loadLibrary();
drawLoop();
