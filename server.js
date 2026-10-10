'use strict';
/**
 * TikTok Downloader - backend
 * Video (HD, no watermark when available) / Audio (MP3) / Photo slides (PNG, JPG, PDF, ZIP)
 * Needs on the server: Node >= 22.2, ffmpeg, yt-dlp, and the npm package "sharp".
 */
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const net = require('net');
const zlib = require('zlib');
const dns = require('dns').promises;
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const sharp = require('sharp');

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT) || 3000;
const WORK_DIR = path.join(os.tmpdir(), 'tt-downloader');
const TTL_MS = (Number(process.env.TTL_MINUTES) || 20) * 60 * 1000;
const MAX_BYTES = (Number(process.env.MAX_FILE_MB) || 150) * 1024 * 1024;
const MAX_ENTRIES = Number(process.env.MAX_ENTRIES) || 60;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

fs.mkdirSync(WORK_DIR, { recursive: true });

class AppError extends Error {
  constructor(message, status = 400, code = 'ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- helpers
const entries = new Map(); // id -> session entry (temp data for one pasted link)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeName = (s) =>
  String(s || 'tiktok')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'tiktok';

function isTikTokHost(host) {
  host = String(host).toLowerCase();
  return host === 'tiktok.com' || host.endsWith('.tiktok.com');
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const l = ip.toLowerCase();
  if (l === '::1' || l === '::') return true;
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

// Only public https hosts may be fetched (SSRF protection).
async function assertPublicHttps(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new AppError('Blocked URL.', 400, 'BLOCKED'); }
  if (url.protocol !== 'https:') throw new AppError('Blocked URL.', 400, 'BLOCKED');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new AppError('Blocked URL.', 400, 'BLOCKED');
    return url;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new AppError('Blocked URL.', 400, 'BLOCKED');
  return url;
}

async function fetchRemote(raw, { headers = {}, timeout = 30000, maxRedirects = 4 } = {}) {
  let url = raw;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicHttps(url);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': UA, ...headers },
      signal: AbortSignal.timeout(timeout),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).toString();
      continue;
    }
    return res;
  }
  throw new AppError('Too many redirects.', 502, 'UPSTREAM');
}

async function readLimited(res, limit) {
  const len = Number(res.headers.get('content-length')) || 0;
  if (len > limit) throw new AppError('File is too large.', 413, 'TOO_LARGE');
  const chunks = [];
  let got = 0;
  for await (const c of res.body) {
    got += c.length;
    if (got > limit) throw new AppError('File is too large.', 413, 'TOO_LARGE');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function downloadToFile(raw, file, headers = {}) {
  const res = await fetchRemote(raw, { headers, timeout: 120000 });
  if (!res.ok || !res.body) throw new AppError('Could not download the file from TikTok.', 502, 'UPSTREAM');
  if ((Number(res.headers.get('content-length')) || 0) > MAX_BYTES) throw new AppError('File is too large.', 413, 'TOO_LARGE');
  let got = 0;
  const limiter = new (require('stream').Transform)({
    transform(chunk, _e, cb) {
      got += chunk.length;
      cb(got > MAX_BYTES ? new AppError('File is too large.', 413, 'TOO_LARGE') : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), limiter, fs.createWriteStream(file));
}

function run(cmd, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new AppError('The request took too long. Please try again.', 504, 'TIMEOUT')); }, timeout);
    p.stdout.on('data', (d) => { if (out.length < 30e6) out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new AppError(`${cmd} is not installed on the server.`, 500, 'MISSING_TOOL') : e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(err.trim().split('\n').pop() || `${cmd} exited with code ${code}`));
    });
  });
}

function friendlyYtdlpError(e) {
  if (e instanceof AppError) return e;
  const m = String(e && e.message);
  console.error('[yt-dlp]', m.slice(0, 400)); // real reason goes to the server logs
  if (/private/i.test(m)) return new AppError('This video is private.', 403, 'PRIVATE');
  if (/unavailable|removed|not exist|404|deleted/i.test(m)) return new AppError('This video is unavailable or was removed.', 404, 'NOT_FOUND');
  if (/blocked|403|rate|captcha|verify/i.test(m)) return new AppError('TikTok is blocking requests right now. Please try again in a moment.', 502, 'UPSTREAM');
  return new AppError('Could not fetch this link. Please check it and try again.', 502, 'UPSTREAM');
}

// ---------------------------------------------------------------- tiktok page / yt-dlp
function normalizeInput(input) {
  let s = String(input || '').trim();
  if (!s || s.length > 500) throw new AppError('Please paste a valid TikTok link.', 400, 'INVALID_URL');
  const m = s.match(/https?:\/\/[^\s]+|(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/[^\s]+/i);
  if (m) s = m[0];
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new AppError('Please paste a valid TikTok link.', 400, 'INVALID_URL'); }
  if (!isTikTokHost(u.hostname)) throw new AppError('Only TikTok links are supported.', 400, 'INVALID_URL');
  u.protocol = 'https:';
  return u.toString();
}

function cookieHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchPage(startUrl) {
  let url = startUrl;
  const jar = new Map();
  for (let i = 0; i < 6; i++) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !isTikTokHost(u.hostname)) throw new AppError('Only TikTok links are supported.', 400, 'INVALID_URL');
    const res = await fetch(url, {
      redirect: 'manual',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        cookie: cookieHeader(jar),
      },
      signal: AbortSignal.timeout(20000),
    });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const kv = c.split(';')[0];
      const idx = kv.indexOf('=');
      if (idx > 0) jar.set(kv.slice(0, idx).trim(), kv.slice(idx + 1));
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).toString();
      continue;
    }
    if (!res.ok) throw new AppError(`TikTok returned an error (${res.status}).`, 502, 'UPSTREAM');
    return { html: await res.text(), finalUrl: url, cookie: cookieHeader(jar) };
  }
  throw new AppError('Too many redirects.', 400, 'INVALID_URL');
}

function parseItem(html) {
  // 1) modern page data: look through every scope (video-detail, reflow, ...) for the post
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const scope = (JSON.parse(m[1]).__DEFAULT_SCOPE__) || {};
      for (const key of Object.keys(scope)) {
        const it = scope[key] && scope[key].itemInfo && scope[key].itemInfo.itemStruct;
        if (it && (it.video || it.imagePost)) return it;
      }
    } catch { /* fall through */ }
  }
  // 2) older page data
  const s2 = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (s2) {
    try {
      const mod = JSON.parse(s2[1]).ItemModule || {};
      const first = Object.values(mod)[0];
      if (first && (first.video || first.imagePost)) return first;
    } catch { /* ignore */ }
  }
  return null;
}

// short description of what TikTok sent back (goes to the server log only)
function pageDiag(html, finalUrl) {
  let scopes = [];
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) { try { scopes = Object.keys(JSON.parse(m[1]).__DEFAULT_SCOPE__ || {}); } catch { scopes = ['unparsable']; } }
  return {
    url: finalUrl.slice(0, 120),
    htmlBytes: html.length,
    hasPageData: !!m,
    scopes: scopes.slice(0, 8),
    looksLikeChallenge: /captcha|verify|waf|challenge|access denied/i.test(html.slice(0, 20000)),
  };
}

function ytdlpArgs(extra) {
  const args = ['--no-playlist', '--no-warnings', '--socket-timeout', '20'];
  if (process.env.YTDLP_PROXY) args.push('--proxy', process.env.YTDLP_PROXY);
  if (process.env.YTDLP_COOKIES) args.push('--cookies', process.env.YTDLP_COOKIES);
  return args.concat(extra);
}

// choose the best format WITHOUT watermark (TikTok exposes the watermarked one as "download")
function pickFormat(info) {
  const vids = (info.formats || []).filter((f) => f.vcodec && f.vcodec !== 'none');
  const clean = vids.filter((f) => f.format_id !== 'download' && !/watermark/i.test(f.format_note || ''));
  const pool = clean.length ? clean : vids;
  pool.sort((a, b) => {
    const h = (b.height || 0) - (a.height || 0);
    if (h) return h;
    const ah = /avc|h264/i.test(a.vcodec) ? 1 : 0;
    const bh = /avc|h264/i.test(b.vcodec) ? 1 : 0;
    if (bh !== ah) return bh - ah;
    return (b.tbr || 0) - (a.tbr || 0);
  });
  const f = pool[0];
  return f ? { fmt: f, watermarkFree: clean.length > 0 } : null;
}

function newEntry(type) {
  if (entries.size >= MAX_ENTRIES) {
    const oldest = [...entries.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) dropEntry(oldest.id);
  }
  const id = crypto.randomBytes(12).toString('hex');
  const dir = path.join(WORK_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const entry = { id, type, dir, createdAt: Date.now(), imgCache: [] };
  entries.set(id, entry);
  return entry;
}

function dropEntry(id) {
  const e = entries.get(id);
  entries.delete(id);
  if (e) fsp.rm(e.dir, { recursive: true, force: true }).catch(() => {});
}

async function buildPhoto(item, page) {
  const images = item.imagePost.images
    .map((im) => im && im.imageURL && im.imageURL.urlList && im.imageURL.urlList[0])
    .filter(Boolean);
  if (!images.length) throw new AppError('No slides were found in this post.', 404, 'NOT_FOUND');
  const entry = newEntry('photo');
  const author = (item.author && (item.author.uniqueId || item.author)) || '';
  Object.assign(entry, {
    title: item.desc || 'TikTok slides',
    author: typeof author === 'string' ? author : '',
    images,
    headers: { referer: 'https://www.tiktok.com/', cookie: page.cookie },
    audioUrl: item.music && item.music.playUrl,
    duration: (item.music && item.music.duration) || null,
    thumbUrl: images[0],
  });
  return entry;
}

async function buildVideo(url, item, page) {
  let info = null;
  let fallback = null;
  try {
    const { stdout } = await run(YTDLP, ytdlpArgs(['-J', url]), { timeout: 60000 });
    info = JSON.parse(stdout);
  } catch (e) {
    // fallback: use the direct address from the page itself
    const direct = item && item.video && (item.video.playAddr || item.video.downloadAddr);
    if (!direct) throw friendlyYtdlpError(e);
    fallback = { direct, item };
  }
  const entry = newEntry('video');
  entry.sourceUrl = url;
  entry.headers = { referer: 'https://www.tiktok.com/', cookie: (page && page.cookie) || '' };
  if (info) {
    const pick = pickFormat(info);
    entry.title = info.description || info.title || 'TikTok video';
    entry.author = info.uploader || info.channel || '';
    entry.duration = info.duration || null;
    entry.thumbUrl = info.thumbnail || (item && item.video && item.video.cover) || null;
    entry.quality = pick && pick.fmt.height ? pick.fmt.height : null;
    entry.sizeBytes = pick ? pick.fmt.filesize || pick.fmt.filesize_approx || null : null;
    entry.watermarkFree = pick ? pick.watermarkFree : false;
    entry.formatSelector = pick ? (pick.fmt.acodec === 'none' ? `${pick.fmt.format_id}+bestaudio` : pick.fmt.format_id) : 'best';
    entry.directUrl = item && item.video && item.video.playAddr;
  } else {
    entry.title = fallback.item.desc || 'TikTok video';
    entry.author = (fallback.item.author && fallback.item.author.uniqueId) || '';
    entry.duration = fallback.item.video.duration || null;
    entry.thumbUrl = fallback.item.video.cover || null;
    entry.quality = fallback.item.video.height || null;
    entry.sizeBytes = null;
    entry.watermarkFree = true;
    entry.directUrl = fallback.direct;
    entry.skipYtdlp = true;
  }
  startVideoDownload(entry);
  return entry;
}

function startVideoDownload(entry) {
  const file = path.join(entry.dir, 'video.mp4');
  entry.filePromise = (async () => {
    if (!entry.skipYtdlp) {
      try {
        await run(
          YTDLP,
          ytdlpArgs(['-f', entry.formatSelector, '--merge-output-format', 'mp4', '--max-filesize', `${Math.floor(MAX_BYTES / 1048576)}M`, '--no-part', '-o', file, entry.sourceUrl]),
          { timeout: 180000 }
        );
        if (fs.existsSync(file)) return file;
      } catch (e) {
        if (!entry.directUrl) throw friendlyYtdlpError(e);
      }
    }
    await downloadToFile(entry.directUrl, file, entry.headers);
    return file;
  })();
  entry.filePromise.catch(() => {}); // surfaced when the user actually requests the file
}

async function resolveContent(rawUrl) {
  const url = normalizeInput(rawUrl);
  let page = null;
  try {
    page = await fetchPage(url);
  } catch (e) {
    if (e instanceof AppError && e.code === 'INVALID_URL') throw e;
  }
  const item = page ? parseItem(page.html) : null;
  if (page && !item) console.warn('[page]', JSON.stringify(pageDiag(page.html, page.finalUrl)));
  console.log(`[link] ${url} -> page:${page ? 'ok' : 'FAILED'} data:${item ? 'ok' : 'none'} photo:${!!(item && item.imagePost)}`);
  if (item && item.imagePost && item.imagePost.images && item.imagePost.images.length) return buildPhoto(item, page);
  if (!item && page && /\/photo\//.test(page.finalUrl)) {
    throw new AppError('Could not read these slides. TikTok may be blocking the server right now, please try again later.', 502, 'UPSTREAM');
  }
  return buildVideo(page ? page.finalUrl : url, item, page);
}

// ---------------------------------------------------------------- media operations
function getEntry(id) {
  const e = /^[a-f0-9]{24}$/.test(id) ? entries.get(id) : null;
  if (!e) throw new AppError('This session expired. Please paste the link again.', 404, 'EXPIRED');
  return e;
}

function baseName(entry) {
  return `${safeName(entry.author || 'tiktok')}-${entry.id.slice(0, 6)}`;
}

function getImage(entry, i) {
  if (!entry.imgCache[i]) {
    entry.imgCache[i] = (async () => {
      const res = await fetchRemote(entry.images[i], { headers: entry.headers });
      if (!res.ok) throw new AppError('Could not load this slide from TikTok.', 502, 'UPSTREAM');
      return readLimited(res, 40 * 1048576);
    })();
    entry.imgCache[i].catch(() => { entry.imgCache[i] = null; });
  }
  return entry.imgCache[i];
}

async function renderSlide(entry, i, format) {
  const buf = await getImage(entry, i);
  if (format === 'png') return { buf: await sharp(buf).rotate().png({ compressionLevel: 6 }).toBuffer(), mime: 'image/png', ext: 'png' };
  return {
    buf: await sharp(buf).rotate().flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: 93, progressive: false }).toBuffer(),
    mime: 'image/jpeg',
    ext: 'jpg',
  };
}

async function getThumb(entry) {
  if (!entry.thumbPromise) {
    entry.thumbPromise = (async () => {
      if (!entry.thumbUrl) throw new AppError('No thumbnail.', 404, 'NOT_FOUND');
      const res = await fetchRemote(entry.thumbUrl, { headers: entry.headers });
      if (!res.ok) throw new AppError('No thumbnail.', 404, 'NOT_FOUND');
      const buf = await readLimited(res, 10 * 1048576);
      return { buf: await sharp(buf).rotate().resize({ width: 960, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(), mime: 'image/jpeg' };
    })();
    entry.thumbPromise.catch(() => { entry.thumbPromise = null; });
  }
  return entry.thumbPromise;
}

async function getVideoFile(entry) {
  if (entry.type !== 'video') throw new AppError('This link is a photo post, not a video.', 400, 'WRONG_TYPE');
  return entry.filePromise;
}

async function getAudioFile(entry) {
  if (!entry.audioPromise) {
    entry.audioPromise = (async () => {
      const out = path.join(entry.dir, 'audio.mp3');
      let input;
      if (entry.type === 'video') input = await entry.filePromise;
      else {
        if (!entry.audioUrl) throw new AppError('No audio was found for this post.', 404, 'NOT_FOUND');
        input = path.join(entry.dir, 'audio-source');
        await downloadToFile(entry.audioUrl, input, entry.headers);
      }
      await run(FFMPEG, ['-y', '-v', 'error', '-i', input, '-vn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', '192k', '-metadata', `title=${String(entry.title).slice(0, 80)}`, out], { timeout: 120000 });
      return out;
    })();
    entry.audioPromise.catch(() => { entry.audioPromise = null; });
  }
  return entry.audioPromise;
}

// ---- minimal ZIP writer (store, no compression: images are already compressed)
function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = zlib.crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---- minimal PDF writer: one JPEG per page, page size = image size
function makePdf(pages, title) {
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); chunks.push(buf); pos += buf.length; };
  const obj = (n, body) => { offsets[n] = pos; push(`${n} 0 obj\n`); push(body); push('\nendobj\n'); };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const pageN = 3 + i * 3, contentN = pageN + 1, imgN = pageN + 2;
    const content = `q ${p.w} 0 0 ${p.h} 0 0 cm /Im0 Do Q`;
    obj(pageN, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /XObject << /Im0 ${imgN} 0 R >> >> /Contents ${contentN} 0 R >>`);
    obj(contentN, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offsets[imgN] = pos;
    push(`${imgN} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.buf.length} >>\nstream\n`);
    push(p.buf);
    push('\nendstream\nendobj\n');
  });
  const infoN = 3 + pages.length * 3;
  obj(infoN, `<< /Title (${String(title).replace(/[^\x20-\x7E]/g, '').replace(/[()\\]/g, '').slice(0, 80)}) /Producer (TikTok Downloader) >>`);
  const xrefPos = pos;
  let xref = `xref\n0 ${infoN + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= infoN; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${infoN + 1} /Root 1 0 R /Info ${infoN} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

async function pdfFor(entry, indices) {
  const pages = [];
  for (const i of indices) {
    const { buf } = await renderSlide(entry, i, 'jpg');
    const meta = await sharp(buf).metadata();
    pages.push({ buf, w: meta.width, h: meta.height });
  }
  return makePdf(pages, entry.title);
}

// ---------------------------------------------------------------- http layer
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function dispo(name, inline) {
  const ascii = safeName(name.replace(/\.[^.]+$/, '')) + path.extname(name);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendBuffer(res, buf, mime, name, inline) {
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Content-Disposition': dispo(name, inline), 'Cache-Control': 'private, max-age=600' });
  res.end(buf);
}

async function sendFile(req, res, file, mime, name, inline) {
  const st = await fsp.stat(file);
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Disposition': dispo(name, inline), 'Cache-Control': 'private, max-age=600' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = st.size - 1, status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
    else { start = Math.max(0, st.size - Number(range[2])); }
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found' });
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error('nf');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

// simple in-memory rate limiter (per IP)
const hits = new Map();
function limited(ip, bucket, max, windowMs) {
  const key = bucket + '|' + ip;
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 120000)) hits.delete(k); }, 60000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || 'unknown';
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new AppError('Request too large.', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new AppError('Invalid request.', 400)); } });
    req.on('error', reject);
  });
}

function infoPayload(e) {
  const dur = e.duration ? Math.round(e.duration) : null;
  const base = {
    id: e.id,
    type: e.type,
    title: String(e.title || '').slice(0, 200),
    author: e.author || '',
    duration: dur,
    thumb: `/api/thumb/${e.id}`,
    baseName: baseName(e),
  };
  if (e.type === 'video') {
    base.video = {
      quality: e.quality ? (e.quality >= 720 ? `HD (${e.quality}p)` : `${e.quality}p`) : 'HD',
      format: 'MP4',
      sizeBytes: e.sizeBytes || null,
      watermarkFree: !!e.watermarkFree,
      previewUrl: `/api/preview/${e.id}`,
    };
  } else {
    base.slides = { count: e.images.length };
  }
  if (e.type === 'video' || e.audioUrl) {
    base.audio = { format: 'MP3', bitrate: 192, sizeBytes: dur ? Math.round((dur * 192000) / 8) : null };
  }
  return base;
}

const FORMATS = new Set(['png', 'jpg']);

// Optional CORS so the website can live on another host (e.g. Netlify) while this server does the work.
// ALLOWED_ORIGIN = comma separated list, e.g. https://my-site.netlify.app,https://mydomain.com  (or * for any)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.length) return false;
  if (!ALLOWED_ORIGINS.includes('*') && !ALLOWED_ORIGINS.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes('*') ? '*' : origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Disposition, Accept-Ranges');
  res.setHeader('Access-Control-Max-Age', '86400');
  return true;
}

async function handle(req, res) {
  setSecurityHeaders(res);
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = clientIp(req);
  let m;

  if (p === '/api/health') return sendJson(res, 200, { ok: true, entries: entries.size });

  if (req.method === 'POST' && p === '/api/info') {
    if (limited(ip, 'info', 12, 60000)) throw new AppError('Too many requests. Please wait a minute and try again.', 429, 'RATE_LIMIT');
    const body = await readJson(req);
    const entry = await resolveContent(body.url);
    return sendJson(res, 200, infoPayload(entry));
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') throw new AppError('Method not allowed.', 405);

  if (p.startsWith('/api/')) {
    if (limited(ip, 'dl', 90, 60000)) throw new AppError('Too many requests. Please wait a minute and try again.', 429, 'RATE_LIMIT');

    if ((m = p.match(/^\/api\/thumb\/([a-f0-9]+)$/))) {
      const t = await getThumb(getEntry(m[1]));
      res.writeHead(200, { 'Content-Type': t.mime, 'Content-Length': t.buf.length, 'Cache-Control': 'private, max-age=600' });
      return res.end(t.buf);
    }
    if ((m = p.match(/^\/api\/preview\/([a-f0-9]+)$/))) {
      const e = getEntry(m[1]);
      return sendFile(req, res, await getVideoFile(e), 'video/mp4', `${baseName(e)}.mp4`, true);
    }
    if ((m = p.match(/^\/api\/download\/([a-f0-9]+)\/video$/))) {
      const e = getEntry(m[1]);
      return sendFile(req, res, await getVideoFile(e), 'video/mp4', `${baseName(e)}.mp4`, false);
    }
    if ((m = p.match(/^\/api\/download\/([a-f0-9]+)\/audio$/))) {
      const e = getEntry(m[1]);
      return sendFile(req, res, await getAudioFile(e), 'audio/mpeg', `${baseName(e)}.mp3`, url.searchParams.get('inline') === '1');
    }
    if ((m = p.match(/^\/api\/slide\/([a-f0-9]+)\/(\d+)$/))) {
      const e = getEntry(m[1]);
      if (e.type !== 'photo') throw new AppError('This link has no slides.', 400, 'WRONG_TYPE');
      const n = Number(m[2]);
      if (n < 1 || n > e.images.length) throw new AppError('Slide not found.', 404);
      const format = (url.searchParams.get('format') || 'jpg').toLowerCase();
      const inline = url.searchParams.get('inline') === '1';
      if (format === 'pdf') return sendBuffer(res, await pdfFor(e, [n - 1]), 'application/pdf', `${baseName(e)}-slide-${n}.pdf`, inline);
      if (!FORMATS.has(format)) throw new AppError('Unsupported format.', 400);
      const r = await renderSlide(e, n - 1, format);
      return sendBuffer(res, r.buf, r.mime, `${baseName(e)}-slide-${n}.${r.ext}`, inline);
    }
    if ((m = p.match(/^\/api\/slides\/([a-f0-9]+)\/(zip|pdf)$/))) {
      const e = getEntry(m[1]);
      if (e.type !== 'photo') throw new AppError('This link has no slides.', 400, 'WRONG_TYPE');
      const all = e.images.map((_, i) => i);
      if (m[2] === 'pdf') return sendBuffer(res, await pdfFor(e, all), 'application/pdf', `${baseName(e)}-slides.pdf`, false);
      const format = (url.searchParams.get('format') || 'jpg').toLowerCase();
      if (!FORMATS.has(format)) throw new AppError('Unsupported format.', 400);
      const files = [];
      for (const i of all) {
        const r = await renderSlide(e, i, format);
        files.push({ name: `slide-${i + 1}.${r.ext}`, data: r.buf });
      }
      return sendBuffer(res, makeZip(files), 'application/zip', `${baseName(e)}-slides-${format}.zip`, false);
    }
    throw new AppError('Not found.', 404);
  }

  return serveStatic(req, res, p);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.status || 500;
    if (status >= 500 || err.code === 'INVALID_URL') console.error('[error]', req.method, req.url, status, err.code || '', err.message);
    if (res.headersSent) return res.destroy();
    sendJson(res, status, { error: err instanceof AppError ? err.message : 'Something went wrong. Please try again.', code: err.code || 'ERROR' });
  });
});
server.requestTimeout = 0;
server.headersTimeout = 30000;

// cleanup of expired sessions + their temp files
const cleaner = setInterval(() => {
  const now = Date.now();
  for (const e of [...entries.values()]) if (now - e.createdAt > TTL_MS) dropEntry(e.id);
}, 60000);
cleaner.unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`TikTok Downloader running on http://localhost:${PORT}`));
  const stop = () => { server.close(); for (const id of [...entries.keys()]) dropEntry(id); setTimeout(() => process.exit(0), 300); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { server, entries, newEntry, parseItem, pageDiag, infoPayload, makeZip, makePdf, AppError, normalizeInput, pickFormat, isPrivateIp };
