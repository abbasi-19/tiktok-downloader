'use strict';
// Offline self-test: no TikTok access needed. Injects fake sessions and checks every output path.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sharp = require('sharp');
const app = require('../server');

let passed = 0;
const ok = (name, cond, extra = '') => { assert.ok(cond, `${name} ${extra}`); passed++; console.log('  ✓', name); };

(async () => {
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = (p, opts) => fetch(base + p, opts);
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  console.log('Basics');
  ok('health endpoint', (await (await get('/api/health')).json()).ok === true);
  const home = await get('/');
  ok('home page served', home.status === 200 && (await home.text()).includes('TikTok'));
  ok('css + js served', (await get('/style.css')).status === 200 && (await get('/app.js')).status === 200);
  ok('CSP header present', (await get('/')).headers.get('content-security-policy').includes("default-src 'self'"));
  ok('path traversal blocked', (await get('/..%2fserver.js')).status === 404);

  console.log('Link validation');
  for (const bad of ['https://example.com/a', 'https://tiktok.com.evil.com/a', 'https://evil.com/?u=tiktok.com', '', 'hello', 'http://127.0.0.1/tiktok.com/']) {
    const r = await post('/api/info', { url: bad });
    ok(`rejects "${bad}"`, r.status === 400, String(r.status));
  }
  ok('accepts vm short link', app.normalizeInput('check this https://vm.tiktok.com/ZMabc123/ now') === 'https://vm.tiktok.com/ZMabc123/');
  ok('adds https when missing', app.normalizeInput('www.tiktok.com/@a/video/1') === 'https://www.tiktok.com/@a/video/1');
  ok('private IP detection', app.isPrivateIp('10.0.0.1') && app.isPrivateIp('127.0.0.1') && app.isPrivateIp('::1') && app.isPrivateIp('192.168.1.1') && !app.isPrivateIp('8.8.8.8'));
  const pf = app.pickFormat({ formats: [
    { format_id: 'download', vcodec: 'h264', height: 1080, format_note: 'Download video, watermarked' },
    { format_id: 'h264_540p', vcodec: 'h264', height: 540 },
    { format_id: 'bytevc1_720p', vcodec: 'hevc', height: 720 },
    { format_id: 'h264_720p', vcodec: 'avc1', height: 720 },
  ] });
  ok('format picker skips watermarked, prefers h264 at best height', pf.fmt.format_id === 'h264_720p' && pf.watermarkFree);
  ok('expired session is a clean 404', (await get('/api/thumb/' + 'a'.repeat(24))).status === 404);

  console.log('Photo post (slides)');
  const mk = (w, h, c) => sharp({ create: { width: w, height: h, channels: 4, background: c } }).png().toBuffer();
  const imgs = [await mk(900, 1200, '#ff2d95'), await mk(1080, 1080, '#19d3ff'), await mk(800, 1400, { r: 124, g: 77, b: 255, alpha: 0.5 })];
  const photo = app.newEntry('photo');
  Object.assign(photo, { title: 'Test slides (é)', author: 'tester', images: ['u1', 'u2', 'u3'], headers: {}, audioUrl: null, duration: null });
  photo.imgCache = imgs.map((b) => Promise.resolve(b));
  photo.thumbPromise = Promise.resolve({ buf: await sharp(imgs[0]).jpeg().toBuffer(), mime: 'image/jpeg' });
  const info = app.infoPayload(photo);
  ok('info payload: photo', info.type === 'photo' && info.slides.count === 3 && !info.video && !info.audio);

  const png = Buffer.from(await (await get(`/api/slide/${photo.id}/1?format=png`)).arrayBuffer());
  ok('slide as PNG', png.subarray(1, 4).toString() === 'PNG' && (await sharp(png).metadata()).width === 900);
  const jpgRes = await get(`/api/slide/${photo.id}/3?format=jpg`);
  const jpg = Buffer.from(await jpgRes.arrayBuffer());
  ok('slide as JPG (alpha flattened)', jpg[0] === 0xff && jpg[1] === 0xd8 && (await sharp(jpg).metadata()).channels === 3);
  ok('download headers', /attachment; filename=".*\.jpg"/.test(jpgRes.headers.get('content-disposition')));
  ok('inline preview header', /^inline/.test((await get(`/api/slide/${photo.id}/1?format=jpg&inline=1`)).headers.get('content-disposition')));
  ok('bad slide number → 404', (await get(`/api/slide/${photo.id}/9?format=png`)).status === 404);
  ok('bad format → 400', (await get(`/api/slide/${photo.id}/1?format=gif`)).status === 400);
  ok('thumbnail', (await get(`/api/thumb/${photo.id}`)).headers.get('content-type') === 'image/jpeg');
  ok('video request on photo → 400', (await get(`/api/download/${photo.id}/video`)).status === 400);
  ok('audio missing on photo → 404', (await get(`/api/download/${photo.id}/audio`)).status === 404);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ttt-'));
  const zipBuf = Buffer.from(await (await get(`/api/slides/${photo.id}/zip?format=png`)).arrayBuffer());
  const zipFile = path.join(tmp, 's.zip');
  fs.writeFileSync(zipFile, zipBuf);
  const z = spawnSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(",".join(z.namelist()))', zipFile], { encoding: 'utf8' });
  ok('ZIP is valid and has 3 PNGs', z.status === 0 && z.stdout.trim() === 'slide-1.png,slide-2.png,slide-3.png', z.stderr);
  const pdfBuf = Buffer.from(await (await get(`/api/slides/${photo.id}/pdf`)).arrayBuffer());
  fs.writeFileSync(path.join(tmp, 's.pdf'), pdfBuf);
  ok('PDF structure', pdfBuf.subarray(0, 5).toString() === '%PDF-' && pdfBuf.toString('latin1').includes('%%EOF') && (pdfBuf.toString('latin1').match(/\/Type \/Page /g) || []).length === 3);
  const one = Buffer.from(await (await get(`/api/slide/${photo.id}/2?format=pdf`)).arrayBuffer());
  ok('single-slide PDF', one.subarray(0, 5).toString() === '%PDF-');
  fs.writeFileSync(path.join(tmp, 'one.pdf'), one);

  console.log('Video post');
  const mp4 = path.join(tmp, 'v.mp4');
  const ff = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4]);
  ok('ffmpeg available', ff.status === 0, String(ff.stderr));
  const vid = app.newEntry('video');
  Object.assign(vid, { title: 'Test video', author: 'tester', duration: 2, quality: 720, sizeBytes: fs.statSync(mp4).size, watermarkFree: true, headers: {} });
  vid.filePromise = Promise.resolve(mp4);
  const vinfo = app.infoPayload(vid);
  ok('info payload: video', vinfo.type === 'video' && vinfo.video.quality === 'HD (720p)' && vinfo.audio.format === 'MP3' && !vinfo.slides);
  const full = await get(`/api/download/${vid.id}/video`);
  ok('video download', full.status === 200 && Number(full.headers.get('content-length')) === fs.statSync(mp4).size && full.headers.get('accept-ranges') === 'bytes');
  await full.arrayBuffer();
  const part = await get(`/api/preview/${vid.id}`, { headers: { range: 'bytes=0-99' } });
  ok('video preview supports Range (206)', part.status === 206 && (await part.arrayBuffer()).byteLength === 100 && part.headers.get('content-range').startsWith('bytes 0-99/'));
  const mp3 = Buffer.from(await (await get(`/api/download/${vid.id}/audio`)).arrayBuffer());
  const mp3File = path.join(tmp, 'a.mp3');
  fs.writeFileSync(mp3File, mp3);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'default=nw=1', mp3File], { encoding: 'utf8' });
  ok('MP3 extracted (codec mp3, ~2s)', /codec_name=mp3/.test(probe.stdout) && Math.abs(Number(/duration=([\d.]+)/.exec(probe.stdout)[1]) - 2) < 0.4, probe.stdout);
  ok('slides request on video → 400', (await get(`/api/slides/${vid.id}/pdf`)).status === 400);

  console.log(`\nAll ${passed} checks passed.`);
  console.log('Artifacts kept for inspection in', tmp);
  app.server.close();
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error('\nTEST FAILED:', e.message); process.exit(1); });
