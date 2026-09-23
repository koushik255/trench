# Tissue

A small, self-hosted movie browser. Tissue scans a folder, serves the files over HTTP, and plays them in a custom Mediabunny canvas player. If the browser cannot decode a movie directly, compatibility mode starts FFmpeg and streams an HLS playlist back to the player.

## Run it

Set the movie folder in [`config.txt`](config.txt):

```txt
path=/path/to/movies
```

Relative paths are resolved from the config file's folder. The repository includes the built-in web UI, so running the server does not require Node.js:

```sh
go run .
```

Then open <http://localhost:8080>. The server scans the configured folder recursively. The default listen address is `127.0.0.1:8080`. You can override the folder with `go run . -media /another/folder`.

For access from other devices on your tailnet, keep the app on localhost and use Tailscale Serve as the HTTPS front door:

```sh
tailscale serve localhost:8080
```

Open the HTTPS address printed by Tailscale on another tailnet device. HTTPS matters because the custom player uses WebCodecs, which browsers restrict to secure contexts. [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) provides HTTPS for tailnet access.

## Compatibility mode

Direct playback works when the browser can decode the movie's tracks. Select **Try compatibility mode** in the player to start a per-viewer FFmpeg process. It transcodes video to H.264 and audio to AAC, then writes an HLS playlist and segments in a temporary folder. Tissue serves those files to Mediabunny and deletes them when the player closes or the session expires.

Install FFmpeg and make sure it is on `PATH` to use compatibility mode. Pass `-ffmpeg /path/to/ffmpeg` if it is installed somewhere else. Transcoding runs in real time and uses CPU while playing; it is optional for files that play directly.

## Build

To rebuild the web UI after changing files in `web/`:

```sh
cd web
npm ci
npm run build
cd ..
go build -o tissue .
```

`web/dist` is embedded in the Go binary. Rebuild the web UI before building Go if you change the frontend.

## Current scope

- Scans common video files: AVI, M4V, MKV, MOV, MP4, MPEG, OGV, TS, WebM, and WMV.
- Supports direct playback and manual FFmpeg HLS compatibility mode.
- Compatibility mode uses the first video and audio tracks and does not yet provide subtitle or audio-track selection.
- Playback sessions are stored in temporary directories and automatically expire after two hours.
# trench
