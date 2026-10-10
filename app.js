(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const el = {
    form: $('#form'), url: $('#url'), go: $('#goBtn'), clear: $('#clearBtn'), status: $('#status'),
    loading: $('#loading'), fmts: $$('.fmt'),
    pVideo: $('#panel-video'), pAudio: $('#panel-audio'), pSlides: $('#panel-slides'), pEmpty: $('#panel-empty'),
    player: $('#player'), playerWait: $('#playerWait'),
    overlay: $('#overlay'), viewer: $('#viewer'), toast: $('#toast'),
  };

  const state = { info: null, url: '', fmt: 'video', busy: false, videoSrcSet: false, vIndex: 0, vFmt: 'png', blob: null, abort: null };

  /* ------------------------------------------------------------ helpers */
  const fmtBytes = (n) => {
    if (!n && n !== 0) return '–';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  };
  const fmtDur = (s) => {
    if (!s && s !== 0) return '–';
    if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min`;
  };
  const fmtTime = (s) => (!isFinite(s) ? '–' : s < 60 ? `${Math.max(1, Math.round(s))} sec` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);

  function extractUrl(text) {
    const m = String(text || '').match(/(?:https?:\/\/)?(?:[\w-]+\.)*tiktok\.com\/[^\s]*/i);
    if (!m) return null;
    return /^https?:\/\//i.test(m[0]) ? m[0] : 'https://' + m[0];
  }

  let toastTimer;
  function toast(msg, good) {
    el.toast.textContent = msg;
    el.toast.className = 'toast' + (good ? ' good' : '');
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), 3800);
  }

  function setStatus(kind, msg) {
    if (!msg) { el.status.hidden = true; return; }
    const icon = kind === 'ok' ? '✓' : kind === 'err' ? '!' : '…';
    el.status.className = `status ${kind}`;
    el.status.textContent = `${icon}  ${msg}`;
    el.status.hidden = false;
  }

  /* ------------------------------------------------------------ theme */
  const root = document.documentElement;
  function applyTheme(t) {
    root.setAttribute('data-theme', t);
    $('#themeLabel').textContent = t === 'dark' ? 'Dark Mode' : 'Light Mode';
    $('meta[name="theme-color"]').setAttribute('content', t === 'dark' ? '#060818' : '#f2f3ff');
  }
  try { const t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') applyTheme(t); } catch (_) {}
  $('#themeBtn').addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('theme', next); } catch (_) {}
  });

  /* ------------------------------------------------------------ link input */
  el.url.addEventListener('input', () => (el.clear.hidden = !el.url.value));
  el.clear.addEventListener('click', () => { el.url.value = ''; el.clear.hidden = true; el.url.focus(); });
  el.url.addEventListener('paste', () => {
    setTimeout(() => { if (extractUrl(el.url.value) && !state.busy) el.form.requestSubmit(); }, 60);
  });
  el.form.addEventListener('submit', (e) => { e.preventDefault(); fetchInfo(el.url.value); });

  function hideResults() {
    [el.pVideo, el.pAudio, el.pSlides, el.pEmpty].forEach((p) => (p.hidden = true));
    try { el.player.pause(); } catch (_) {}
  }

  async function fetchInfo(raw) {
    if (state.busy) return;
    const u = extractUrl(raw);
    if (!u) { setStatus('err', 'Please paste a valid TikTok link.'); return; }
    el.url.value = u; el.clear.hidden = false;
    state.busy = true; el.go.disabled = true;
    state.info = null; state.videoSrcSet = false;
    hideResults();
    setStatus('ok', 'Link is valid! Fetching content…');
    el.loading.hidden = false;
    try {
      const res = await fetch('/api/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      state.info = data; state.url = u;
      setStatus('ok', data.type === 'photo' ? 'Slides detected!' : 'Video link is valid!');
      renderInfo(data);
    } catch (err) {
      const offline = err instanceof TypeError;
      setStatus('err', offline ? 'Network error. Check your connection and try again.' : err.message);
    } finally {
      el.loading.hidden = true; state.busy = false; el.go.disabled = false;
    }
  }

  /* ------------------------------------------------------------ format tabs */
  el.fmts.forEach((b) => b.addEventListener('click', () => {
    if (!state.info) { selectFormat(b.dataset.fmt); toast('Paste a TikTok link first.'); el.url.focus(); return; }
    selectFormat(b.dataset.fmt);
    const target = { video: el.pVideo, audio: el.pAudio, slides: el.pSlides }[b.dataset.fmt];
    (target && !target.hidden ? target : el.pEmpty).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  function selectFormat(f) {
    state.fmt = f;
    el.fmts.forEach((b) => {
      const on = b.dataset.fmt === f;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', String(on));
    });
    hideResults();
    const info = state.info;
    if (!info) return;
    if (f === 'video') {
      if (info.video) showVideo(); else showEmpty('This is a photo post', 'There is no video in this link. You can download its slides or audio instead.', 'Open Slides', 'slides');
    } else if (f === 'audio') {
      if (info.audio) showAudio(); else showEmpty('No audio found', 'We could not find a separate audio track for this post.', info.video ? 'Open Video' : 'Open Slides', info.video ? 'video' : 'slides');
    } else {
      if (info.slides) showSlides(); else showEmpty('This link has no slides', 'This is a video post. Use the HD Video or Audio downloader instead.', 'Open Video', 'video');
    }
  }

  function showEmpty(title, text, btn, target) {
    $('#emptyTitle').textContent = title;
    $('#emptyText').textContent = text;
    const b = $('#emptyBtn');
    b.textContent = btn;
    b.onclick = () => selectFormat(target);
    el.pEmpty.hidden = false;
  }

  /* ------------------------------------------------------------ render */
  function renderInfo(info) {
    const caption = info.title ? (info.author ? `@${info.author} · ${info.title}` : info.title) : '';
    $('#chipVideo').textContent = state.url.replace(/^https?:\/\//, '');
    $('#vCaption').textContent = caption;
    $('#aCaption').textContent = caption;
    if (info.video) {
      $('#vDur').textContent = fmtDur(info.duration);
      $('#vQual').textContent = info.video.quality;
      $('#vFmt').textContent = info.video.format;
      $('#vSize').textContent = info.video.sizeBytes ? '≈ ' + fmtBytes(info.video.sizeBytes) : 'Calculating…';
      $('#vNote').hidden = info.video.watermarkFree;
      el.player.poster = info.thumb;
    }
    if (info.audio) {
      $('#aDur').textContent = fmtDur(info.duration);
      $('#aSize').textContent = info.audio.sizeBytes ? '≈ ' + fmtBytes(info.audio.sizeBytes) : '–';
      $('#aThumb').src = info.thumb;
      $('#audioPlayer').src = `/api/download/${info.id}/audio?inline=1`;
      buildWave();
    }
    if (info.slides) buildThumbs(info);
    selectFormat(info.type === 'photo' ? 'slides' : 'video');
    $('#panel-' + (info.type === 'photo' ? 'slides' : 'video')).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showVideo() {
    el.pVideo.hidden = false;
    if (!state.videoSrcSet) {
      state.videoSrcSet = true;
      el.playerWait.classList.remove('gone');
      const done = () => el.playerWait.classList.add('gone');
      el.player.addEventListener('loadedmetadata', done, { once: true });
      el.player.addEventListener('error', () => { done(); toast('Preview could not be loaded, but you can still try downloading.'); }, { once: true });
      el.player.src = state.info.video.previewUrl;
    }
  }

  function showAudio() { el.pAudio.hidden = false; }

  function buildWave() {
    const w = $('#wave');
    if (w.childElementCount) return;
    for (let i = 0; i < 44; i++) {
      const b = document.createElement('i');
      b.style.height = `${18 + Math.abs(Math.sin(i * 1.7) * 70)}%`;
      b.style.animationDelay = `${(i % 11) * -0.13}s`;
      w.appendChild(b);
    }
  }

  function slideUrl(i, format, inline) {
    return `/api/slide/${state.info.id}/${i + 1}?format=${format}${inline ? '&inline=1' : ''}`;
  }

  function buildThumbs(info) {
    const box = $('#thumbs');
    box.textContent = '';
    for (let i = 0; i < info.slides.count; i++) {
      const t = document.createElement('div');
      t.className = 'thumb'; t.tabIndex = 0; t.setAttribute('role', 'button'); t.setAttribute('aria-label', `Open slide ${i + 1}`);
      const img = document.createElement('img');
      img.loading = 'lazy'; img.alt = `Slide ${i + 1}`; img.src = slideUrl(i, 'jpg', true);
      const num = document.createElement('span'); num.className = 'num'; num.textContent = i + 1;
      const dl = document.createElement('span'); dl.className = 'dl'; dl.textContent = '⬇ Download';
      dl.addEventListener('click', (e) => { e.stopPropagation(); startDownload(slideUrl(i, 'png'), `${info.baseName}-slide-${i + 1}.png`, `Slide ${i + 1}`); });
      t.append(img, num, dl);
      t.addEventListener('click', () => openViewer(i));
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewer(i); } });
      box.appendChild(t);
    }
    $('#slideBadge').textContent = `${info.slides.count} slide${info.slides.count === 1 ? '' : 's'} found`;
  }
  function showSlides() { el.pSlides.hidden = false; }

  /* ------------------------------------------------------------ download buttons */
  $('#dlVideo').addEventListener('click', () => startDownload(`/api/download/${state.info.id}/video`, `${state.info.baseName}.mp4`, 'Video'));
  $('#dlAudio').addEventListener('click', () => startDownload(`/api/download/${state.info.id}/audio`, `${state.info.baseName}.mp3`, 'Audio'));
  $('#dlZipPng').addEventListener('click', () => startDownload(`/api/slides/${state.info.id}/zip?format=png`, `${state.info.baseName}-slides-png.zip`, 'PNG slides'));
  $('#dlZipJpg').addEventListener('click', () => startDownload(`/api/slides/${state.info.id}/zip?format=jpg`, `${state.info.baseName}-slides-jpg.zip`, 'JPG slides'));
  $('#dlPdf').addEventListener('click', () => startDownload(`/api/slides/${state.info.id}/pdf`, `${state.info.baseName}-slides.pdf`, 'PDF'));
  const copy = async () => {
    try { await navigator.clipboard.writeText(state.url); toast('Link copied!', true); }
    catch (_) { el.url.select(); document.execCommand && document.execCommand('copy'); toast('Link copied!', true); }
  };
  $('#copyVideo').addEventListener('click', copy);
  $('#copyAudio').addEventListener('click', copy);

  /* ------------------------------------------------------------ download with progress */
  const CIRC = 326.7;
  function showOverlay(mode) {
    el.overlay.hidden = false;
    $('#ovProgress').hidden = mode !== 'progress';
    $('#ovDone').hidden = mode !== 'done';
  }

  async function startDownload(url, filename, label) {
    if (state.abort) return;
    const ctrl = new AbortController();
    state.abort = ctrl;
    $('#ovTitle').textContent = `Downloading ${label}…`;
    $('#ovSub').textContent = 'Preparing your file — please don’t close this page.';
    $('#pring').classList.add('indet');
    $('#pbar').style.strokeDashoffset = CIRC;
    $('#ppct').textContent = '…';
    ['#stGot', '#stSpeed', '#stLeft'].forEach((s) => ($(s).textContent = '–'));
    showOverlay('progress');
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Download failed. Please try again.');
      }
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      const t0 = performance.now();
      $('#ovSub').textContent = 'Please don’t close this page.';
      if (total) $('#pring').classList.remove('indet');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        const secs = (performance.now() - t0) / 1000 || 0.001;
        const speed = got / secs;
        $('#stGot').textContent = fmtBytes(got);
        $('#stSpeed').textContent = fmtBytes(speed) + '/s';
        if (total) {
          const f = got / total;
          $('#pbar').style.strokeDashoffset = CIRC * (1 - f);
          $('#ppct').textContent = Math.floor(f * 100) + '%';
          $('#stLeft').textContent = fmtTime((total - got) / speed);
        } else {
          $('#ppct').textContent = fmtBytes(got);
        }
      }
      const blob = new Blob(chunks, { type: res.headers.get('content-type') || 'application/octet-stream' });
      state.blob = { blob, filename };
      saveBlob(blob, filename);
      $('#doneTitle').textContent = `${label} downloaded successfully!`;
      $('#doneSub').textContent = 'Your file has been saved to your device.';
      showOverlay('done');
    } catch (err) {
      el.overlay.hidden = true;
      if (err.name !== 'AbortError') toast(err instanceof TypeError ? 'Network error. Please try again.' : err.message);
    } finally {
      state.abort = null;
    }
  }

  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    const u = URL.createObjectURL(blob);
    a.href = u; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  }

  $('#ovCancel').addEventListener('click', () => { if (state.abort) state.abort.abort(); el.overlay.hidden = true; });
  $('#doneClose').addEventListener('click', () => (el.overlay.hidden = true));
  $('#doneAgain').addEventListener('click', () => { if (state.blob) saveBlob(state.blob.blob, state.blob.filename); });
  $('#doneView').addEventListener('click', () => {
    if (!state.blob) return;
    const u = URL.createObjectURL(state.blob.blob);
    window.open(u, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(u), 120000);
  });

  /* ------------------------------------------------------------ slide viewer */
  function openViewer(i) {
    state.vIndex = i;
    el.viewer.hidden = false;
    updateViewer();
  }
  function updateViewer() {
    const n = state.info.slides.count;
    $('#vImg').src = slideUrl(state.vIndex, 'jpg', true);
    $('#vCount').textContent = `${state.vIndex + 1} / ${n}`;
    $('#vPrev').hidden = $('#vNext').hidden = n < 2;
    $$('.chip').forEach((c) => c.classList.toggle('on', c.dataset.f === state.vFmt));
  }
  const step = (d) => { const n = state.info.slides.count; state.vIndex = (state.vIndex + d + n) % n; updateViewer(); };
  $('#vPrev').addEventListener('click', () => step(-1));
  $('#vNext').addEventListener('click', () => step(1));
  $('#vClose').addEventListener('click', () => (el.viewer.hidden = true));
  $('#vBack').addEventListener('click', () => (el.viewer.hidden = true));
  el.viewer.addEventListener('click', (e) => { if (e.target === el.viewer) el.viewer.hidden = true; });
  $$('.chip').forEach((c) => c.addEventListener('click', () => { state.vFmt = c.dataset.f; updateViewer(); }));
  $('#vDownload').addEventListener('click', () => {
    const f = state.vFmt, n = state.vIndex + 1;
    startDownload(slideUrl(state.vIndex, f), `${state.info.baseName}-slide-${n}.${f}`, `Slide ${n}`);
  });
  document.addEventListener('keydown', (e) => {
    if (!el.viewer.hidden) {
      if (e.key === 'Escape') el.viewer.hidden = true;
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    } else if (e.key === 'Escape' && !$('#ovDone').hidden) el.overlay.hidden = true;
  });
  // swipe on the slide viewer (mobile)
  let sx = null;
  $('.viewer-img').addEventListener('touchstart', (e) => (sx = e.touches[0].clientX), { passive: true });
  $('.viewer-img').addEventListener('touchend', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx; sx = null;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  });

  // allow ?url=… prefill (handy for sharing / bookmarklets)
  try {
    const q = new URLSearchParams(location.search).get('url');
    if (q && extractUrl(q)) { el.url.value = q; el.clear.hidden = false; fetchInfo(q); }
  } catch (_) {}
})();
