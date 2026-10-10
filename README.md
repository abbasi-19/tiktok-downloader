# TikTok Downloader

HD video (no watermark when TikTok provides it), MP3 audio, and photo slides as PNG / JPG / PDF / ZIP.
Paste a link → preview first → choose a format → download. Neon dark/light theme, mobile friendly.

Made by Muhammad Mughees Abbasi.

## What it needs on the server

| Part | Why |
|---|---|
| Node.js 22.2 or newer | runs `server.js` |
| `sharp` (npm) | converts slides to PNG / JPG |
| `ffmpeg` | converts video to MP3 |
| `yt-dlp` | reads video info and downloads the video |

The **Dockerfile** installs all of this for you, so the easiest way is Docker.

## Run on your computer

```bash
# needs Node 22+, ffmpeg and yt-dlp installed
npm install
npm start          # http://localhost:3000
npm test           # offline self-test (no TikTok access needed)
```

## Put it live (so anyone in the world can use it)

### Option A – Render.com (free, easiest)
1. Upload this folder to a new GitHub repository.
2. Render → **New → Web Service** → connect the repository → it detects the Dockerfile (or use **Blueprint** with `render.yaml`).
3. Deploy. You get `https://your-name.onrender.com`. Add your own domain under **Settings → Custom Domains**.

Free plans sleep after inactivity (first visit takes ~30 s) and have limited CPU/RAM. For real traffic use a paid plan.

### Option B – Any VPS (DigitalOcean, Hetzner, Contabo …)
```bash
docker build -t tiktok-dl .
docker run -d --restart unless-stopped -p 80:3000 --name tiktok-dl tiktok-dl
```
Put **Cloudflare** or **Caddy/Nginx** in front for free HTTPS and your domain.

### Option C – Railway / Fly.io / Koyeb
Create a new service from the repository; they pick up the Dockerfile automatically. The app listens on `$PORT`.

## Settings (environment variables, all optional)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | port to listen on |
| `TRUST_PROXY` | 1 in Docker | use `X-Forwarded-For` for the visitor IP (needed behind Render/Cloudflare/Nginx) |
| `MAX_FILE_MB` | 150 | largest video allowed |
| `TTL_MINUTES` | 20 | temp files are deleted after this long |
| `MAX_ENTRIES` | 60 | how many links are kept at the same time |
| `YTDLP_PROXY` | – | proxy for yt-dlp, e.g. `http://user:pass@host:port` |
| `YTDLP_COOKIES` | – | path to a cookies.txt for yt-dlp |

## Important things to know

* **TikTok may block server (datacenter) IPs.** If many downloads fail with "TikTok is blocking requests", set `YTDLP_PROXY` to a residential/rotating proxy, or host on a different provider.
* **Keep yt-dlp fresh.** TikTok changes often. Redeploy (rebuild the image) every week or two; the Dockerfile installs the newest yt-dlp each build.
* **Nothing is stored.** Files live in the server's temp folder for 20 minutes and are then deleted. There is no database and no tracking.
* **Abuse protection** is built in: only `tiktok.com` links are accepted, private network addresses are blocked, and each visitor is rate limited (12 link lookups and 90 downloads per minute). Add Cloudflare in front for more protection.
* **Legal:** downloading videos can break TikTok's terms of service and creators' copyright. Offer the tool for content people own or have permission to use, and consider adding a Terms / DMCA page before running it publicly with ads.
* Hero artwork uses a generic music-note icon, not TikTok's logo (their logo is trademarked). Add your own logo in `public/index.html` if you like.

## Folder map

```
server.js        backend (API, yt-dlp, ffmpeg, ZIP + PDF builders)
public/          website (index.html, style.css, app.js, favicon.svg)
test/run.js      offline self-test
Dockerfile       one-step deploy image
render.yaml      Render.com blueprint
```
