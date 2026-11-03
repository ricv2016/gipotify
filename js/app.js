import * as db from './db.js';
import { readTags } from './tags.js';
import { icon } from './icons.js';

// ================= utilidades =================
const $ = (s) => document.querySelector(s);
const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
const cmp = (a, b) => collator.compare(a || '', b || '');
const norm = (s) => (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const UNKNOWN_ARTIST = 'Artista desconocido';
const UNKNOWN_ALBUM = 'Álbum desconocido';
const AUDIO_RE = /\.(mp3|wav|wave|m4a|aac|mp4|flac|ogg|oga|opus|webm)$/i;
const IMAGE_RE = /\.(jpe?g|png|webp)$/i;
const enc = encodeURIComponent;

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
  return n;
}

function btn(name, onClick, label, cls = 'icon-btn') {
  return el('button', {
    class: cls, type: 'button', 'aria-label': label || name, title: label || null,
    onclick: (e) => { e.stopPropagation(); onClick(e); },
  }, icon(name));
}

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(sec) {
  if (!sec || !isFinite(sec)) return '';
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
function fmtTotal(sec) {
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.round(b / 1e3) + ' KB';
}
const plural = (n, s, p) => `${n.toLocaleString('es')} ${n === 1 ? s : p}`;
function hue(str) {
  let h = 0;
  for (const c of str || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
const sumDur = (list) => list.reduce((a, t) => a + (t.duration || 0), 0);

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ================= estado =================
const state = {
  tracks: new Map(),
  playlists: [],
  sources: new Map(), // carpetas enlazadas (tarjeta SD o memoria del celular)
  queue: [],      // orden de reproducción (ids)
  original: [],   // orden antes de mezclar
  index: -1,
  shuffle: false,
  repeat: 'off',  // off | all | one
  sort: localStorage.getItem('gipotify.sort') || 'title',
  query: '',
};
let libVersion = 0;
const touch = () => { libVersion++; };

const artistOf = (t) => t.artist || UNKNOWN_ARTIST;
const albumOf = (t) => t.album || UNKNOWN_ALBUM;
function albumKey(t) {
  const album = albumOf(t).toLowerCase();
  if (t.albumArtist) return `${t.albumArtist.toLowerCase()}|${album}`;
  if (t.album && t.dir) return `dir:${t.dir.toLowerCase()}|${album}`;
  return `${artistOf(t).toLowerCase()}|${album}`;
}
const byTrackNo = (a, b) => (a.disc || 0) - (b.disc || 0) || (a.track || 0) - (b.track || 0) || cmp(a.title, b.title);

let libCache = { v: -1 };
function lib() {
  if (libCache.v === libVersion) return libCache;
  const albums = new Map(), artists = new Map(), search = new Map();
  for (const t of state.tracks.values()) {
    const k = albumKey(t);
    let a = albums.get(k);
    if (!a) albums.set(k, (a = { key: k, name: albumOf(t), tracks: [], artists: new Set(), year: '', coverId: null, albumArtist: t.albumArtist }));
    a.tracks.push(t);
    a.artists.add(artistOf(t));
    if (!a.coverId && t.coverId) a.coverId = t.coverId;
    if (!a.year && t.year) a.year = t.year;

    const an = artistOf(t);
    let ar = artists.get(an);
    if (!ar) artists.set(an, (ar = { name: an, tracks: [], albums: new Set(), coverId: null }));
    ar.tracks.push(t);
    ar.albums.add(k);
    if (!ar.coverId && t.coverId) ar.coverId = t.coverId;

    search.set(t.id, norm(`${t.title} ${t.artist} ${t.album} ${t.albumArtist || ''}`));
  }
  for (const a of albums.values()) {
    a.artist = a.albumArtist || (a.artists.size === 1 ? [...a.artists][0] : 'Varios artistas');
    a.tracks.sort(byTrackNo);
  }
  libCache = { v: libVersion, albums, artists, search };
  return libCache;
}

const currentId = () => state.queue[state.index];

// ================= carátulas =================
const coverUrls = new Map();
function coverUrl(id) {
  if (!id) return Promise.resolve(null);
  if (!coverUrls.has(id)) coverUrls.set(id, db.get('covers', id).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null));
  return coverUrls.get(id);
}
async function paintCover(node, id) {
  const url = await coverUrl(id);
  if (url && node.dataset.cover === id) {
    node.style.backgroundImage = `url("${url}")`;
    node.classList.add('has-img');
  }
}
const coverIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    coverIO.unobserve(e.target);
    paintCover(e.target, e.target.dataset.cover);
  }
}, { rootMargin: '300px' });

function coverBox(coverId, size, seed, lazy = true) {
  const d = el('div', { class: `cover ${size}`, style: { '--h': hue(seed) } }, icon('note'));
  if (coverId) {
    d.dataset.cover = coverId;
    if (lazy) coverIO.observe(d); else paintCover(d, coverId);
  }
  return d;
}
function setCover(node, coverId, seed) {
  node.style.backgroundImage = '';
  node.classList.remove('has-img');
  node.style.setProperty('--h', hue(seed));
  node.dataset.cover = coverId || '';
  if (coverId) paintCover(node, coverId);
}

async function resizeCover(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s));
    c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  } catch {
    return null;
  }
}

// ================= capas (hojas y diálogos) =================
// Cada capa agrega una entrada al historial: el botón "atrás" de Android la cierra.
let layer = null;
let closeWaiter = null;
function openLayer(node, onDismiss) {
  const root = $('#layers');
  if (layer) {
    layer.node.remove();
    layer = { node, onDismiss };
    root.append(node);
    return;
  }
  layer = { node, onDismiss };
  root.append(node);
  history.pushState({ layer: true }, '');
}
function closeLayer() {
  if (!layer) return Promise.resolve();
  if (!closeWaiter) {
    closeWaiter = {};
    closeWaiter.promise = new Promise((r) => { closeWaiter.resolve = r; });
    history.back();
  }
  return closeWaiter.promise;
}
addEventListener('popstate', () => {
  if (!layer) return;
  const l = layer;
  layer = null;
  l.node.remove();
  l.onDismiss?.();
  if (closeWaiter) { closeWaiter.resolve(); closeWaiter = null; }
});

function sheet(title, items, subtitle) {
  const node = el('div', { class: 'layer', onclick: (e) => { if (e.target === node) closeLayer(); } },
    el('div', { class: 'sheet' },
      el('div', { class: 'grip' }),
      title && el('div', { class: 'sheet-title' }, title),
      subtitle && el('div', { class: 'sheet-sub' }, subtitle),
      ...items.filter(Boolean).map((it) => el('button', {
        class: 'sheet-item' + (it.danger ? ' danger' : ''), type: 'button',
        onclick: async () => {
          if (it.now) { it.action(); closeLayer(); return; } // p. ej. abrir el selector de archivos
          await closeLayer();
          it.action();
        },
      }, icon(it.icon), el('span', {}, it.label)))));
  openLayer(node);
}

function dialog({ title, message, body, fields = [], ok = 'Aceptar', cancel = 'Cancelar', danger = false, noCancel = false }) {
  return new Promise((resolve) => {
    let answer = null;
    const inputs = fields.map((f) => el('input', {
      name: f.name, value: f.value ?? '', placeholder: f.placeholder || '', type: f.type || 'text',
      inputmode: f.inputmode, autocomplete: 'off', autocapitalize: f.autocapitalize || 'sentences',
    }));
    const form = el('form', {
      class: 'dialog', novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        const bad = fields.findIndex((f, i) => f.required && !inputs[i].value.trim());
        if (bad >= 0) { inputs[bad].focus(); return; }
        const v = {};
        inputs.forEach((i) => { v[i.name] = i.value.trim(); });
        if (fields.some((f, i) => f.validate && !f.validate(inputs[i].value.trim()))) { toast('Revisa los datos'); return; }
        answer = v; // al cerrar la capa, onDismiss entrega esta respuesta
        closeLayer();
      },
    },
    el('h2', {}, title),
    message && el('p', {}, message),
    body,
    ...fields.map((f, i) => el('label', {}, el('span', {}, f.label), inputs[i])),
    el('div', { class: 'dialog-actions' },
      !noCancel && el('button', { type: 'button', class: 'btn ghost', onclick: () => closeLayer() }, cancel),
      el('button', { type: 'submit', class: 'btn ' + (danger ? 'danger' : 'primary') }, ok)));
    const node = el('div', { class: 'layer center', onclick: (e) => { if (e.target === node) closeLayer(); } }, form);
    // Se resuelve cuando la capa ya se cerró (historial incluido): así quien llama puede abrir otra sin choques.
    openLayer(node, () => resolve(answer));
    if (inputs[0]) setTimeout(() => inputs[0].focus(), 60);
  });
}

// ================= navegación =================
const navStack = [];
function parseHash(h) {
  const [view, ...rest] = (h || '#/songs').replace(/^#\/?/, '').split('/');
  return { view: view || 'songs', arg: rest.length ? decodeURIComponent(rest.join('/')) : null };
}
function onHash() {
  const h = location.hash || '#/songs';
  if (navStack.length > 1 && navStack[navStack.length - 2] === h) navStack.pop();
  else if (navStack[navStack.length - 1] !== h) navStack.push(h);
  render();
}
function go(h) { location.hash = h; }
function goTab(h) {
  if (location.hash === h) { scrollTo({ top: 0, behavior: 'smooth' }); return; }
  navStack.pop();
  location.replace(h);
}
function goBack(fallback = '#/songs') {
  if (navStack.length > 1) history.back();
  else { navStack.pop(); location.replace(fallback); }
}

// ================= reproductor =================
const audio = new Audio();
audio.preload = 'auto';
let currentUrl = null;
let loadToken = 0;
let errorStreak = 0;
let dragging = false;

async function loadTrack(i, autoplay = true, startAt = 0) {
  if (i < 0 || i >= state.queue.length) return;
  const tok = ++loadToken;
  state.index = i;
  const id = state.queue[i];
  const t = state.tracks.get(id);
  updateNowPlaying();
  if (!t) return;
  let blob = null;
  try {
    blob = await getTrackFile(t, autoplay);
  } catch (e) {
    if (tok !== loadToken) return;
    dirCache.clear();
    if (e.name === 'NeedPermission') {
      updateReconnect();
      if (autoplay) toast('Toca el aviso “Reconectar” para leer tu carpeta de música');
    } else if (autoplay) {
      toast(t.src ? 'Ese archivo ya no está en la carpeta (¿se sacó la tarjeta?). Prueba “Volver a escanear”.' : 'No se encontró el archivo');
    }
    return;
  }
  if (tok !== loadToken) return;
  if (!blob) { toast('No se encontró el archivo'); return; }
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(blob);
  audio.src = currentUrl;
  if (startAt > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
  if (autoplay) audio.play().catch(() => {});
  saveSession();
}

function playList(ids, start = 0, { shuffle } = {}) {
  if (!ids.length) return;
  if (shuffle !== undefined) state.shuffle = shuffle;
  state.original = ids.slice();
  if (state.shuffle) {
    const first = ids[start];
    const rest = ids.filter((_, i) => i !== start);
    shuffleArray(rest);
    state.queue = [first, ...rest];
    state.index = 0;
  } else {
    state.queue = ids.slice();
    state.index = start;
  }
  errorStreak = 0;
  loadTrack(state.index);
  updateModes();
}
function shufflePlay(ids) {
  if (!ids.length) return;
  playList(ids, Math.floor(Math.random() * ids.length), { shuffle: true });
}
function shuffleArray(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function togglePlay() {
  if (!state.queue.length) return;
  if (!audio.src) { loadTrack(Math.max(0, state.index)); return; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
function next(auto = false) {
  if (!state.queue.length) return;
  if (auto && state.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  let i = state.index + 1;
  if (i >= state.queue.length) {
    if (state.repeat === 'all' || !auto) i = 0;
    else { loadTrack(0, false); return; } // fin de la cola: se detiene en la primera
  }
  loadTrack(i);
}
function prev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  let i = state.index - 1;
  if (i < 0) i = state.repeat === 'all' ? state.queue.length - 1 : 0;
  loadTrack(i);
}
function toggleShuffle() {
  const cur = currentId();
  state.shuffle = !state.shuffle;
  if (state.shuffle) {
    const rest = shuffleArray(state.queue.filter((id) => id !== cur));
    state.queue = cur ? [cur, ...rest] : rest;
    state.index = cur ? 0 : -1;
  } else {
    state.queue = state.original.slice();
    state.index = Math.max(0, state.queue.indexOf(cur));
  }
  toast(state.shuffle ? 'Aleatorio activado' : 'Aleatorio desactivado');
  updateModes(); renderQueue(); saveSession();
}
function cycleRepeat() {
  state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
  toast({ off: 'Repetir desactivado', all: 'Repetir todo', one: 'Repetir una canción' }[state.repeat]);
  updateModes(); saveSession();
}
function playNext(ids) {
  if (!state.queue.length) { playList(ids); return; }
  const cur = currentId();
  state.queue.splice(state.index + 1, 0, ...ids);
  const oi = state.original.indexOf(cur);
  state.original.splice(oi + 1, 0, ...ids);
  toast(ids.length === 1 ? 'Sonará a continuación' : `${ids.length} canciones a continuación`);
  renderQueue(); saveSession();
}
function addToQueue(ids) {
  if (!state.queue.length) { playList(ids); return; }
  state.queue.push(...ids);
  state.original.push(...ids);
  toast(ids.length === 1 ? 'Agregada a la cola' : `${ids.length} canciones agregadas a la cola`);
  renderQueue(); saveSession();
}
function removeFromQueue(i) {
  const id = state.queue[i];
  state.queue.splice(i, 1);
  const oi = state.original.indexOf(id);
  if (oi >= 0) state.original.splice(oi, 1);
  if (i < state.index) state.index--;
  renderQueue(); saveSession();
}

audio.addEventListener('play', () => { errorStreak = 0; updatePlayState(); });
audio.addEventListener('pause', updatePlayState);
audio.addEventListener('ended', () => next(true));
audio.addEventListener('loadedmetadata', () => {
  const t = state.tracks.get(currentId());
  if (t && isFinite(audio.duration) && Math.abs((t.duration || 0) - audio.duration) > 1) {
    t.duration = audio.duration;
    db.put('tracks', t).catch(() => {});
    document.querySelectorAll(`[data-dur="${t.id}"]`).forEach((n) => { n.textContent = fmtTime(t.duration); });
  }
  updateProgress(); updatePosition();
});
audio.addEventListener('seeked', updatePosition);
let lastSave = 0;
audio.addEventListener('timeupdate', () => {
  updateProgress();
  if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveSession(); }
});
audio.addEventListener('error', () => {
  if (!audio.getAttribute('src')) return;
  const t = state.tracks.get(currentId());
  toast(`No se pudo reproducir “${t?.title || 'la canción'}”`);
  if (++errorStreak < 3 && state.queue.length > 1) setTimeout(() => next(true), 800);
});

// ----- Media Session: pantalla bloqueada, notificación y botones de los audífonos -----
const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
if (ms) {
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* no soportado */ } };
  set('play', () => audio.play().catch(() => {}));
  set('pause', () => audio.pause());
  set('stop', () => audio.pause());
  set('previoustrack', prev);
  set('nexttrack', () => next());
  set('seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
  set('seekforward', (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); });
  set('seekto', (d) => { audio.currentTime = d.seekTime; });
}
async function blobToDataUrl(blob) {
  return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(blob); });
}
async function updateMediaMetadata(t) {
  if (!ms || !t) return;
  let artwork = [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }];
  if (t.coverId) {
    const b = await db.get('covers', t.coverId).catch(() => null);
    const url = b && (await blobToDataUrl(b));
    if (url) artwork = [{ src: url, sizes: '512x512', type: b.type || 'image/jpeg' }];
  }
  if (currentId() !== t.id) return;
  ms.metadata = new MediaMetadata({ title: t.title, artist: artistOf(t), album: albumOf(t), artwork });
}
function updatePosition() {
  if (!ms?.setPositionState || !isFinite(audio.duration) || !audio.duration) return;
  try { ms.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch { /* ignorar */ }
}

// ----- sesión: al volver a abrir, sigue donde quedó -----
function saveSession() {
  try {
    localStorage.setItem('gipotify.session', JSON.stringify({
      queue: state.queue, original: state.original, index: state.index,
      shuffle: state.shuffle, repeat: state.repeat, pos: audio.currentTime || 0,
    }));
  } catch { /* sin espacio para la sesión: no es grave */ }
}
function restoreSession() {
  try {
    const s = JSON.parse(localStorage.getItem('gipotify.session') || 'null');
    if (!s) return;
    state.shuffle = !!s.shuffle;
    state.repeat = ['off', 'all', 'one'].includes(s.repeat) ? s.repeat : 'off';
    const cur = s.queue?.[s.index];
    state.queue = (s.queue || []).filter((id) => state.tracks.has(id));
    state.original = (s.original || []).filter((id) => state.tracks.has(id));
    if (!state.original.length) state.original = state.queue.slice();
    if (!state.queue.length) { state.index = -1; return; }
    const i = state.queue.indexOf(cur);
    loadTrack(i >= 0 ? i : 0, false, i >= 0 ? s.pos : 0);
  } catch { /* sesión dañada: se ignora */ }
}
addEventListener('pagehide', saveSession);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveSession(); });

// ================= interfaz del reproductor =================
const ui = {};
function buildPlayerUI() {
  ui.miniBar = el('div', { class: 'mini-bar' });
  ui.miniCover = coverBox(null, 'sm', '');
  ui.miniT1 = el('div', { class: 't1' });
  ui.miniT2 = el('div', { class: 't2' });
  ui.miniPlay = btn('play', togglePlay, 'Reproducir');
  ui.mini = el('div', { class: 'mini', hidden: true, onclick: () => go('#/now') },
    el('div', { class: 'mini-prog' }, ui.miniBar),
    ui.miniCover, el('div', { class: 'meta' }, ui.miniT1, ui.miniT2),
    ui.miniPlay, btn('next', () => next(), 'Siguiente'));

  const tabs = [['songs', 'note', 'Canciones'], ['albums', 'album', 'Álbumes'], ['artists', 'person', 'Artistas'], ['playlists', 'playlist', 'Listas']];
  ui.tabs = el('nav', { class: 'tabs' }, ...tabs.map(([v, ic, label]) =>
    el('button', { type: 'button', class: 'tab', dataset: { tab: v }, onclick: () => goTab('#/' + v) }, icon(ic), el('span', {}, label))));
  ui.reconnect = el('button', { type: 'button', class: 'reconnect', hidden: true, onclick: reconnectAll },
    icon('folder'), el('span', {}, el('b', {}, 'Reconectar: '), 'toca aquí para volver a leer tu carpeta de música'));
  $('#dock').append(ui.reconnect, ui.mini, ui.tabs);

  ui.pCover = coverBox(null, 'xl', '');
  ui.pTitle = el('div', { class: 'p-title' });
  ui.pArtist = el('button', { type: 'button', class: 'p-artist', onclick: () => { const t = state.tracks.get(currentId()); if (t) go('#/artist/' + enc(artistOf(t))); } });
  ui.pAlbum = el('button', { type: 'button', class: 'p-album', onclick: () => { const t = state.tracks.get(currentId()); if (t) go('#/album/' + enc(albumKey(t))); } });
  ui.pFav = btn('heartOutline', () => { const t = state.tracks.get(currentId()); if (t) toggleFav(t); }, 'Favorita', 'icon-btn fav');
  ui.pSeek = el('input', { type: 'range', min: 0, max: 1, step: 0.1, value: 0, class: 'seek', 'aria-label': 'Posición' });
  ui.pSeek.addEventListener('input', () => { dragging = true; ui.pCur.textContent = fmtTime(+ui.pSeek.value) || '0:00'; paintSeek(); });
  ui.pSeek.addEventListener('change', () => { audio.currentTime = +ui.pSeek.value; dragging = false; });
  ui.pCur = el('span', {}, '0:00');
  ui.pDur = el('span', {}, '0:00');
  ui.pPlay = btn('play', togglePlay, 'Reproducir / pausar', 'play-big');
  ui.pShuffle = btn('shuffle', toggleShuffle, 'Aleatorio', 'icon-btn mode');
  ui.pRepeat = btn('repeat', cycleRepeat, 'Repetir', 'icon-btn mode');
  ui.pQueue = el('div', { class: 'queue' });
  ui.player = el('div', { class: 'player', hidden: true },
    el('div', { class: 'p-top' },
      btn('down', () => goBack(), 'Cerrar'),
      el('div', { class: 'p-top-title' }, 'Reproduciendo'),
      btn('more', () => { const t = state.tracks.get(currentId()); if (t) trackMenu(t, {}); }, 'Opciones')),
    el('div', { class: 'p-art' }, ui.pCover),
    el('div', { class: 'p-info' }, el('div', { class: 'p-text' }, ui.pTitle, ui.pArtist, ui.pAlbum), ui.pFav),
    ui.pSeek,
    el('div', { class: 'p-times' }, ui.pCur, ui.pDur),
    el('div', { class: 'p-controls' }, ui.pShuffle, btn('prev', prev, 'Anterior', 'icon-btn big'), ui.pPlay, btn('next', () => next(), 'Siguiente', 'icon-btn big'), ui.pRepeat),
    el('h3', { class: 'q-title' }, 'A continuación'),
    ui.pQueue);
  $('#player-root').append(ui.player);
}

function setIcon(button, name) { button.replaceChildren(icon(name)); }
function updatePlayState() {
  const playing = !audio.paused;
  setIcon(ui.miniPlay, playing ? 'pause' : 'play');
  setIcon(ui.pPlay, playing ? 'pause' : 'play');
  document.body.classList.toggle('is-playing', playing);
  if (ms) ms.playbackState = playing ? 'playing' : 'paused';
  updatePosition();
}
function paintSeek() {
  const max = +ui.pSeek.max || 1;
  ui.pSeek.style.setProperty('--p', `${(100 * +ui.pSeek.value) / max}%`);
}
function updateProgress() {
  const d = audio.duration || state.tracks.get(currentId())?.duration || 0;
  const c = audio.currentTime || 0;
  ui.miniBar.style.width = d ? `${(100 * c) / d}%` : '0';
  if (!dragging) {
    ui.pSeek.max = d || 1;
    ui.pSeek.value = c;
    ui.pCur.textContent = fmtTime(c) || '0:00';
    paintSeek();
  }
  ui.pDur.textContent = fmtTime(d) || '0:00';
}
function updateModes() {
  ui.pShuffle.classList.toggle('on', state.shuffle);
  ui.pRepeat.classList.toggle('on', state.repeat !== 'off');
  setIcon(ui.pRepeat, state.repeat === 'one' ? 'repeatOne' : 'repeat');
}
function updateNowPlaying() {
  const t = state.tracks.get(currentId());
  ui.mini.hidden = !t;
  document.body.classList.toggle('has-mini', !!t);
  if (!t) return;
  ui.miniT1.textContent = t.title;
  ui.miniT2.textContent = artistOf(t);
  ui.pTitle.textContent = t.title;
  ui.pArtist.textContent = artistOf(t);
  ui.pAlbum.textContent = albumOf(t);
  setCover(ui.miniCover, t.coverId, t.album || t.title);
  setCover(ui.pCover, t.coverId, t.album || t.title);
  updateFav();
  updateProgress(); updatePlayState(); updateModes();
  markPlaying();
  renderQueue();
  updateMediaMetadata(t);
  document.title = `${t.title} · ${artistOf(t)}`;
}
function updateFav() {
  const t = state.tracks.get(currentId());
  const on = !!t?.fav;
  setIcon(ui.pFav, on ? 'heart' : 'heartOutline');
  ui.pFav.classList.toggle('on', on);
}
function markPlaying() {
  const id = currentId();
  document.querySelectorAll('.row.playing').forEach((r) => r.classList.remove('playing'));
  if (id) document.querySelectorAll(`.row[data-id="${id}"]`).forEach((r) => r.classList.add('playing'));
}
function renderQueue() {
  if (!ui.player || ui.player.hidden) return;
  const upcoming = state.queue.slice(state.index + 1, state.index + 51);
  const restCount = state.queue.length - state.index - 1 - upcoming.length;
  ui.pQueue.replaceChildren(
    ...upcoming.map((id, k) => {
      const t = state.tracks.get(id);
      if (!t) return null;
      const qi = state.index + 1 + k;
      return el('div', { class: 'row', onclick: () => loadTrack(qi) },
        coverBox(t.coverId, 'sm', t.album || t.title),
        el('div', { class: 'meta' }, el('div', { class: 't1' }, t.title), el('div', { class: 't2' }, artistOf(t))),
        btn('close', () => removeFromQueue(qi), 'Quitar de la cola'));
    }),
    !upcoming.length ? el('div', { class: 'empty small' }, state.repeat === 'all' ? 'Al terminar vuelve a empezar.' : 'No hay más canciones en la cola.') : null,
    restCount > 0 ? el('div', { class: 'empty small' }, `y ${plural(restCount, 'canción más', 'canciones más')}`) : null);
}

// ================= acciones sobre canciones =================
async function toggleFav(t) {
  t.fav = t.fav ? 0 : Date.now();
  await db.put('tracks', t);
  touch();
  if (currentId() === t.id) updateFav();
  toast(t.fav ? 'Agregada a Favoritas' : 'Quitada de Favoritas');
  if (parseHash(location.hash).arg === 'fav') render(true);
}

function trackMenu(t, ctx) {
  const pl = ctx.playlistId && ctx.playlistId !== 'fav' ? state.playlists.find((p) => p.id === ctx.playlistId) : null;
  sheet(t.title, [
    { icon: 'playNext', label: 'Reproducir a continuación', action: () => playNext([t.id]) },
    { icon: 'queue', label: 'Agregar a la cola', action: () => addToQueue([t.id]) },
    { icon: 'playlist', label: 'Agregar a una lista…', action: () => addToPlaylistSheet([t.id]) },
    { icon: t.fav ? 'heart' : 'heartOutline', label: t.fav ? 'Quitar de Favoritas' : 'Agregar a Favoritas', action: () => toggleFav(t) },
    { icon: 'album', label: 'Ir al álbum', action: () => go('#/album/' + enc(albumKey(t))) },
    { icon: 'person', label: 'Ir al artista', action: () => go('#/artist/' + enc(artistOf(t))) },
    pl && ctx.index > 0 && { icon: 'up', label: 'Mover arriba', action: () => movePlaylistItem(pl, ctx.index, -1) },
    pl && ctx.index < pl.ids.length - 1 && { icon: 'downSmall', label: 'Mover abajo', action: () => movePlaylistItem(pl, ctx.index, 1) },
    pl && { icon: 'close', label: 'Quitar de esta lista', action: () => removeFromPlaylist(pl, ctx.index) },
    { icon: 'edit', label: 'Editar datos', action: () => editTrack(t) },
    { icon: 'info', label: 'Detalles del archivo', action: () => trackInfo(t) },
    { icon: 'delete', label: 'Eliminar del celular', danger: true, action: () => confirmDelete([t.id], `“${t.title}”`) },
  ], `${artistOf(t)} · ${albumOf(t)}`);
}

function collectionMenu(title, ids, extra = []) {
  sheet(title, [
    { icon: 'playNext', label: 'Reproducir a continuación', action: () => playNext(ids) },
    { icon: 'queue', label: 'Agregar a la cola', action: () => addToQueue(ids) },
    { icon: 'playlist', label: 'Agregar a una lista…', action: () => addToPlaylistSheet(ids) },
    ...extra,
  ], plural(ids.length, 'canción', 'canciones'));
}

async function editTrack(t) {
  const v = await dialog({
    title: 'Editar datos',
    fields: [
      { name: 'title', label: 'Título', value: t.title, required: true },
      { name: 'artist', label: 'Artista', value: t.artist },
      { name: 'album', label: 'Álbum', value: t.album },
      { name: 'albumArtist', label: 'Artista del álbum (opcional)', value: t.albumArtist },
      { name: 'track', label: 'N.º de pista', value: t.track || '', inputmode: 'numeric' },
      { name: 'year', label: 'Año', value: t.year || '', inputmode: 'numeric' },
    ],
    ok: 'Guardar',
  });
  if (!v) return;
  Object.assign(t, { title: v.title, artist: v.artist, album: v.album, albumArtist: v.albumArtist, track: parseInt(v.track, 10) || 0, year: v.year });
  await db.put('tracks', t);
  touch();
  if (currentId() === t.id) updateNowPlaying();
  render(true);
  toast('Datos guardados');
}

function trackInfo(t) {
  const s = t.src && state.sources.get(t.src);
  const rows = [
    ['Archivo', t.fileName],
    ['Ubicación', s ? `Carpeta enlazada: ${s.name}/${t.path}` : `Copiada en la app${t.dir ? ` (de ${t.dir})` : ''}`],
    ['Tamaño', fmtBytes(t.size)],
    ['Duración', fmtTime(t.duration) || '—'], ['Género', t.genre || '—'],
    ['Agregada', new Date(t.addedAt).toLocaleDateString('es')],
  ];
  dialog({ title: t.title, body: el('dl', { class: 'info' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])), ok: 'Cerrar', noCancel: true });
}

async function confirmDelete(ids, what) {
  const ok = await dialog({
    title: 'Quitar de Gipotify',
    message: `Se quitará ${what} de Gipotify (${plural(ids.length, 'canción', 'canciones')}). Tus archivos originales (en la tarjeta o donde estén) no se tocan.`,
    ok: 'Quitar', danger: true,
  });
  if (ok) deleteTracks(ids);
}

// Quitar a pedido del usuario: las enlazadas quedan excluidas para que el próximo escaneo no las vuelva a traer.
async function deleteTracks(ids) {
  const touched = new Set();
  for (const id of ids) {
    const t = state.tracks.get(id);
    const s = t?.src && state.sources.get(t.src);
    if (!s) continue;
    s.excluded = [...new Set([...(s.excluded || []), t.path])];
    touched.add(s);
  }
  for (const s of touched) await db.put('sources', s);
  await purgeTracks(ids);
  render(true);
  toast(ids.length === 1 ? 'Canción quitada' : `${ids.length} canciones quitadas`);
}

// Borra canciones de la biblioteca (y su copia, si la tienen), carátulas huérfanas, listas y cola.
async function purgeTracks(ids) {
  const gone = new Set(ids);
  const cur = currentId();
  const covers = new Set();
  for (const id of ids) {
    const t = state.tracks.get(id);
    if (t?.coverId) covers.add(t.coverId);
    await db.removeTrack(id);
    state.tracks.delete(id);
  }
  for (const t of state.tracks.values()) covers.delete(t.coverId);
  for (const c of covers) {
    await db.del('covers', c).catch(() => {});
    const u = await coverUrls.get(c);
    if (u) URL.revokeObjectURL(u);
    coverUrls.delete(c);
  }
  for (const p of state.playlists) {
    const before = p.ids.length;
    p.ids = p.ids.filter((id) => !gone.has(id));
    if (p.ids.length !== before) await db.put('playlists', p);
  }
  state.original = state.original.filter((id) => !gone.has(id));
  const oldIndex = state.index;
  state.queue = state.queue.filter((id) => !gone.has(id));
  if (cur && gone.has(cur)) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    state.index = Math.min(oldIndex, state.queue.length - 1);
    if (state.queue.length) loadTrack(state.index, false); else updateNowPlaying();
  } else {
    state.index = state.queue.indexOf(cur);
  }
  touch();
  saveSession();
}

// ================= listas =================
const savePlaylist = (p) => db.put('playlists', p);
async function createPlaylist(initialIds = []) {
  const v = await dialog({ title: 'Nueva lista', fields: [{ name: 'name', label: 'Nombre', required: true, placeholder: 'Ej. Para el avión' }], ok: 'Crear' });
  if (!v) return null;
  const p = { id: crypto.randomUUID(), name: v.name, ids: [...new Set(initialIds)], created: Date.now() };
  await savePlaylist(p);
  state.playlists.push(p);
  toast(initialIds.length ? `Lista “${p.name}” creada con ${plural(p.ids.length, 'canción', 'canciones')}` : `Lista “${p.name}” creada`);
  if (parseHash(location.hash).view === 'playlists') render(true);
  return p;
}
function addToPlaylistSheet(ids) {
  sheet('Agregar a una lista', [
    { icon: 'plus', label: 'Nueva lista…', action: () => createPlaylist(ids) },
    ...state.playlists.map((p) => ({ icon: 'playlist', label: p.name, action: () => addToPlaylist(p, ids) })),
  ]);
}
async function addToPlaylist(p, ids) {
  const have = new Set(p.ids);
  const add = ids.filter((id) => !have.has(id));
  if (!add.length) { toast(`Ya está en “${p.name}”`); return; }
  p.ids.push(...add);
  await savePlaylist(p);
  toast(`${plural(add.length, 'canción agregada', 'canciones agregadas')} a “${p.name}”`);
}
async function removeFromPlaylist(p, index) {
  p.ids.splice(index, 1);
  await savePlaylist(p);
  render(true);
}
async function movePlaylistItem(p, index, delta) {
  const j = index + delta;
  [p.ids[index], p.ids[j]] = [p.ids[j], p.ids[index]];
  await savePlaylist(p);
  render(true);
}
async function renamePlaylist(p) {
  const v = await dialog({ title: 'Renombrar lista', fields: [{ name: 'name', label: 'Nombre', value: p.name, required: true }], ok: 'Guardar' });
  if (!v) return;
  p.name = v.name;
  await savePlaylist(p);
  render(true);
}
async function deletePlaylist(p) {
  const ok = await dialog({ title: 'Eliminar lista', message: `¿Eliminar “${p.name}”? Las canciones siguen en tu biblioteca.`, ok: 'Eliminar', danger: true });
  if (!ok) return;
  await db.del('playlists', p.id);
  state.playlists = state.playlists.filter((x) => x !== p);
  goBack('#/playlists');
  toast('Lista eliminada');
}

// ================= importación =================
let importing = false;

function parseFileName(base) {
  let s = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  let track = 0;
  const m = s.match(/^(\d{1,3})\s*[-._)]?\s+(.+)$/);
  if (m) { track = parseInt(m[1], 10); s = m[2]; }
  const parts = s.split(' - ');
  if (parts.length >= 2) return { track, artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { track, artist: '', title: s };
}

// rel = ruta relativa "Carpeta/Sub/archivo.mp3" (sirve para deducir álbum y artista de las carpetas).
function makeTrack(f, tags, rel) {
  const parts = (rel || '').split('/');
  parts.pop();
  const dir = parts.join('/');
  const fromName = parseFileName(f.name.replace(/\.[^.]+$/, ''));
  return {
    id: crypto.randomUUID(),
    title: tags.title || fromName.title || f.name,
    artist: tags.artist || fromName.artist || (parts.length >= 3 ? parts[parts.length - 2] : ''),
    album: tags.album || (parts.length >= 2 ? parts[parts.length - 1] : ''),
    albumArtist: tags.albumArtist || '',
    track: parseInt(tags.track, 10) || fromName.track || 0,
    disc: parseInt(tags.disc, 10) || 0,
    year: tags.year || '',
    genre: tags.genre || '',
    duration: tags.duration || 0,
    size: f.size,
    type: f.type || '',
    fileName: f.name,
    dir,
    coverId: null,
    fav: 0,
    addedAt: Date.now(),
  };
}

const dirOf = (rel) => rel.split('/').slice(0, -1).join('/');

// Imágenes sueltas en la carpeta (cover.jpg, folder.jpg…) como carátula del álbum.
// value puede ser un File (copiar) o un FileSystemFileHandle (enlazar).
const imageRank = (n) => (/^(cover|folder|front)\./i.test(n) ? 0 : /^album/i.test(n) ? 1 : /back|inside|cd/i.test(n) ? 9 : 5);
function addImage(map, dir, name, value) {
  const cur = map.get(dir);
  if (!cur || imageRank(name) < imageRank(cur.name)) map.set(dir, { name, value });
}

async function requestPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* ignorar */ }
}

function startProgress() {
  const prog = $('#progress');
  const text = el('div', { class: 'pg-text' });
  const name = el('div', { class: 'pg-name' });
  const bar = el('div', { class: 'pg-bar' });
  prog.replaceChildren(text, name, el('div', { class: 'pg-track' }, bar));
  prog.hidden = false;
  return {
    set(t, n = '', frac = null) {
      text.textContent = t;
      name.textContent = n;
      if (frac != null) bar.style.width = `${100 * frac}%`;
    },
    end() { prog.hidden = true; },
  };
}

// Importaciones y escaneos: uno a la vez, con la pantalla encendida.
async function beginJob() {
  if (importing) { toast('Ya hay una importación en curso'); return null; }
  importing = true;
  await requestPersist();
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch { /* sin wake lock */ }
  const p = startProgress();
  return {
    p,
    async end() {
      p.end();
      try { await lock?.release(); } catch { /* ignorar */ }
      importing = false;
    },
  };
}

function newCtx(images) {
  return {
    images,
    sigs: new Set([...state.tracks.values()].map((t) => `${t.fileName}|${t.size}`)),
    knownCovers: new Set([...state.tracks.values()].map((t) => t.coverId).filter(Boolean)),
  };
}

// Lee etiquetas y carátula y guarda la canción. Con extra.src es enlazada: no se copia el audio.
async function ingest(file, rel, ctx, extra = {}) {
  const tags = await readTags(file);
  const t = Object.assign(makeTrack(file, tags, rel), extra);
  const cid = t.album ? 'cv:' + albumKey(t) : 'cv:' + t.id;
  let cover = null;
  if (!ctx.knownCovers.has(cid)) {
    let src = tags.picture;
    const img = !src && ctx.images.get(t.dir);
    if (img) src = img.value.getFile ? await img.value.getFile() : img.value;
    const blob = src && (await resizeCover(src));
    if (blob) { cover = { id: cid, blob }; ctx.knownCovers.add(cid); }
  }
  if (ctx.knownCovers.has(cid)) t.coverId = cid;
  await db.addTrack(t, t.src ? null : file, cover);
  state.tracks.set(t.id, t);
  ctx.sigs.add(`${t.fileName}|${t.size}`);
  if (state.tracks.size % 25 === 0) touch();
  return t;
}

function ingestError(e, name, r) {
  console.error('Error importando', name, e);
  r.failed++;
  if (e?.name === 'QuotaExceededError') { r.stopped = true; return true; }
  return false;
}

function finishImport(r) {
  touch();
  render(true);
  const msg = [plural(r.added, 'canción nueva', 'canciones nuevas')];
  if (r.updated) msg.push(`${r.updated} actualizadas`);
  if (r.removed) msg.push(`${r.removed} ya no estaban`);
  if (r.skipped) msg.push(`${r.skipped} sin cambios`);
  if (r.failed) msg.push(`${r.failed} con error`);
  if (r.stopped) {
    dialog({ title: 'Sin espacio', message: `Se agregaron ${r.added} canciones, pero el celular se quedó sin espacio para Gipotify. Libera espacio y vuelve a intentar: las que ya están no se duplican.`, ok: 'Entendido', noCancel: true });
  } else toast(msg.join(' · '));
  fillDurations();
}

// ----- Copiar: el audio se guarda dentro de la app -----
async function importFiles(fileList) {
  const all = [...fileList];
  const files = all.filter((f) => AUDIO_RE.test(f.name) || (f.type || '').startsWith('audio/'));
  if (!files.length) { toast('No se encontraron archivos de audio'); return; }
  const job = await beginJob();
  if (!job) return;
  const images = new Map();
  for (const f of all) if (IMAGE_RE.test(f.name) && f.webkitRelativePath) addImage(images, dirOf(f.webkitRelativePath), f.name, f);
  const ctx = newCtx(images);
  const r = { added: 0, updated: 0, removed: 0, skipped: 0, failed: 0, stopped: false };
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    job.p.set(`Copiando ${i + 1} de ${files.length}…`, f.name, i / files.length);
    if (ctx.sigs.has(`${f.name}|${f.size}`)) { r.skipped++; continue; }
    try {
      await ingest(f, f.webkitRelativePath || f.name, ctx);
      r.added++;
    } catch (e) {
      if (ingestError(e, f.name, r)) break;
    }
  }
  await job.end();
  finishImport(r);
}

// ----- Enlazar: se lee directo de la carpeta (tarjeta SD o memoria), sin ocupar espacio extra -----
const canLink = typeof window.showDirectoryPicker === 'function';
const dirCache = new Map(); // "srcId/dir/sub" -> FileSystemDirectoryHandle

async function hasPermission(s) {
  try { return (await s.handle.queryPermission({ mode: 'read' })) === 'granted'; } catch { return false; }
}
async function askPermission(s) {
  try { return (await s.handle.requestPermission({ mode: 'read' })) === 'granted'; } catch { return false; }
}

async function getTrackFile(t, interactive = false) {
  if (!t.src) return db.get('files', t.id);
  const s = state.sources.get(t.src);
  if (!s) throw new Error('La carpeta de esta canción ya no está enlazada');
  if (!(await hasPermission(s))) {
    if (!(interactive && (await askPermission(s)))) {
      const e = new Error('Sin permiso para leer la carpeta');
      e.name = 'NeedPermission';
      throw e;
    }
    updateReconnect();
  }
  const parts = t.path.split('/');
  const name = parts.pop();
  let key = t.src;
  let dir = s.handle;
  for (const p of parts) {
    key += '/' + p;
    let h = dirCache.get(key);
    if (!h) { h = await dir.getDirectoryHandle(p); dirCache.set(key, h); }
    dir = h;
  }
  return (await dir.getFileHandle(name)).getFile();
}

// Aviso "Reconectar": Chrome a veces pide de nuevo el permiso al reabrir la app.
async function updateReconnect() {
  let missing = 0;
  for (const s of state.sources.values()) if (!(await hasPermission(s))) missing++;
  ui.reconnect.hidden = !missing;
}
async function reconnectAll() {
  for (const s of state.sources.values()) if (!(await hasPermission(s))) await askPermission(s);
  await updateReconnect();
  if (ui.reconnect.hidden) {
    toast('Carpeta de música conectada');
    if (!audio.getAttribute('src') && state.queue.length) loadTrack(Math.max(0, state.index), false);
  }
}

async function linkFolder() {
  if (!canLink) { toast('Este navegador no permite enlazar carpetas. Usa “Copiar una carpeta”.'); return; }
  if (importing) { toast('Ya hay una importación en curso'); return; }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (e) {
    if (e?.name !== 'AbortError') { console.error(e); toast('No se pudo abrir esa carpeta. Prueba con una subcarpeta (p. ej. Música).'); }
    return;
  }
  for (const s of state.sources.values()) {
    if (await s.handle.isSameEntry(handle).catch(() => false)) {
      toast('Esa carpeta ya estaba enlazada: la vuelvo a escanear');
      scanSource(s);
      return;
    }
  }
  const s = { id: crypto.randomUUID(), name: handle.name, handle, addedAt: Date.now(), excluded: [] };
  await db.put('sources', s);
  state.sources.set(s.id, s);
  scanSource(s);
}

async function scanSource(s) {
  if (!(await hasPermission(s)) && !(await askPermission(s))) {
    toast(`Sin permiso para leer “${s.name}”`);
    updateReconnect();
    return;
  }
  const job = await beginJob();
  if (!job) return;
  dirCache.clear();
  const found = [];
  const images = new Map();
  let seen = 0;
  const walk = async (dir, path) => {
    for await (const [name, h] of dir.entries()) {
      if (++seen % 100 === 0) {
        job.p.set('Buscando música…', `${plural(found.length, 'canción encontrada', 'canciones encontradas')} · ${path || s.name}`);
        await new Promise((r) => setTimeout(r));
      }
      if (name.startsWith('.')) continue;
      const rel = path ? `${path}/${name}` : name;
      if (h.kind === 'directory') await walk(h, rel);
      else if (AUDIO_RE.test(name)) found.push({ h, rel });
      else if (IMAGE_RE.test(name)) addImage(images, dirOf(`${s.name}/${rel}`), name, h);
    }
  };
  job.p.set('Buscando música…', s.name);
  try {
    await walk(s.handle, '');
  } catch (e) {
    console.error(e);
    await job.end();
    toast('No se pudo leer la carpeta. ¿Está puesta la tarjeta de memoria?');
    return;
  }

  const mine = new Map([...state.tracks.values()].filter((t) => t.src === s.id).map((t) => [t.path, t]));
  const excluded = new Set(s.excluded || []);
  const present = new Set();
  const ctx = newCtx(images);
  const r = { added: 0, updated: 0, removed: 0, skipped: 0, failed: 0, stopped: false };
  for (let i = 0; i < found.length; i++) {
    const { h, rel } = found[i];
    if (excluded.has(rel)) continue;
    present.add(rel);
    job.p.set(`Revisando ${i + 1} de ${found.length}…`, rel, i / found.length);
    try {
      const file = await h.getFile();
      const old = mine.get(rel);
      if (old && old.size === file.size) { r.skipped++; continue; }
      if (!old && ctx.sigs.has(`${file.name}|${file.size}`)) { r.skipped++; continue; } // ya está (copiada o repetida)
      const extra = { src: s.id, path: rel };
      if (old) Object.assign(extra, { id: old.id, fav: old.fav, addedAt: old.addedAt });
      await ingest(file, `${s.name}/${rel}`, ctx, extra);
      if (old) r.updated++; else r.added++;
    } catch (e) {
      if (ingestError(e, rel, r)) break;
    }
  }
  // Las que ya no están en la carpeta se quitan de la biblioteca (solo si el escaneo terminó completo).
  if (!r.stopped) {
    const gone = [...mine.values()].filter((t) => !present.has(t.path)).map((t) => t.id);
    if (gone.length) { await purgeTracks(gone); r.removed = gone.length; }
  }
  s.lastScan = Date.now();
  await db.put('sources', s);
  await job.end();
  finishImport(r);
}

async function removeSource(s) {
  const ids = [...state.tracks.values()].filter((t) => t.src === s.id).map((t) => t.id);
  const ok = await dialog({
    title: 'Quitar carpeta',
    message: `Se quitan de Gipotify las ${plural(ids.length, 'canción', 'canciones')} de “${s.name}”. Los archivos de la carpeta no se tocan.`,
    ok: 'Quitar', danger: true,
  });
  if (!ok) return;
  await purgeTracks(ids);
  await db.del('sources', s.id);
  state.sources.delete(s.id);
  dirCache.clear();
  updateReconnect();
  render(true);
  toast('Carpeta quitada');
}

function sourcesMenu() {
  sheet('Carpetas enlazadas', [
    canLink && { icon: 'plus', label: 'Enlazar otra carpeta…', now: true, action: linkFolder },
    ...[...state.sources.values()].map((s) => ({ icon: 'folder', label: s.name, action: () => sourceMenu(s) })),
  ], 'Se leen directo de la tarjeta o la memoria, sin copiar');
}
function sourceMenu(s) {
  const count = [...state.tracks.values()].filter((t) => t.src === s.id).length;
  const when = s.lastScan ? `escaneada el ${new Date(s.lastScan).toLocaleDateString('es')}` : 'sin escanear';
  sheet(s.name, [
    { icon: 'search', label: 'Volver a escanear (buscar canciones nuevas)', now: true, action: () => scanSource(s) },
    { icon: 'delete', label: 'Quitar esta carpeta', danger: true, action: () => removeSource(s) },
  ], `${plural(count, 'canción', 'canciones')} · ${when}`);
}

// Calcula duraciones faltantes en segundo plano (para totales de álbum y listas).
let filling = false;
async function fillDurations() {
  if (filling) return;
  filling = true;
  const probe = new Audio();
  probe.preload = 'metadata';
  probe.muted = true;
  for (const t of [...state.tracks.values()]) {
    if (t.duration || !state.tracks.has(t.id)) continue;
    const blob = await getTrackFile(t, false).catch(() => null);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    const d = await new Promise((res) => {
      let settled = false;
      const end = (v) => { if (settled) return; settled = true; probe.onloadedmetadata = probe.onerror = null; res(v); };
      probe.onloadedmetadata = () => end(probe.duration);
      probe.onerror = () => end(0);
      setTimeout(() => end(0), 8000);
      probe.src = url;
    });
    URL.revokeObjectURL(url);
    if (isFinite(d) && d > 0 && state.tracks.has(t.id)) {
      t.duration = d;
      await db.put('tracks', t).catch(() => {});
      document.querySelectorAll(`[data-dur="${t.id}"]`).forEach((n) => { n.textContent = fmtTime(d); });
    }
  }
  probe.removeAttribute('src');
  filling = false;
  touch();
}

// ================= menú principal y almacenamiento =================
function pickFiles() { $('#pick-files').click(); }
function pickFolder() { $('#pick-folder').click(); }

function appMenu() {
  sheet('Gipotify', [
    canLink && { icon: 'search', label: 'Buscar música en la tarjeta SD o el celular', now: true, action: linkFolder },
    state.sources.size > 0 && { icon: 'folder', label: `Carpetas enlazadas (${state.sources.size})`, action: sourcesMenu },
    { icon: 'folder', label: 'Copiar una carpeta a la app', now: true, action: pickFolder },
    { icon: 'fileAdd', label: 'Copiar canciones a la app', now: true, action: pickFiles },
    { icon: 'storage', label: 'Almacenamiento', action: storageInfo },
    { icon: 'info', label: 'Cómo usar sin internet', action: helpDialog },
    state.tracks.size > 0 && { icon: 'delete', label: 'Borrar toda la biblioteca', danger: true, action: wipeLibrary },
  ]);
}

async function storageInfo() {
  const est = (await navigator.storage?.estimate?.().catch(() => null)) || {};
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const all = [...state.tracks.values()];
  const linked = all.filter((t) => t.src);
  const copied = all.filter((t) => !t.src);
  const bytes = (list) => fmtBytes(list.reduce((a, t) => a + (t.size || 0), 0));
  const rows = [
    ['Canciones', state.tracks.size.toLocaleString('es')],
    ['Enlazadas (leídas de la tarjeta / carpeta)', `${linked.length.toLocaleString('es')} · ${bytes(linked)}`],
    ['Copiadas dentro de la app', `${copied.length.toLocaleString('es')} · ${bytes(copied)}`],
    ['Usado por Gipotify', est.usage != null ? fmtBytes(est.usage) : '—'],
    ['Disponible para Gipotify', est.quota != null ? fmtBytes(Math.max(0, est.quota - (est.usage || 0))) : '—'],
    ['Protegido contra borrado', persisted ? 'Sí' : 'No (instala la app para protegerlo)'],
  ];
  const body = el('dl', { class: 'info' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
  const r = await dialog({ title: 'Almacenamiento', body, ok: persisted ? 'Cerrar' : 'Proteger ahora', cancel: 'Cerrar', noCancel: !!persisted });
  if (r && !persisted) {
    const ok = await navigator.storage?.persist?.().catch(() => false);
    toast(ok ? 'Tu música quedó protegida' : 'Chrome no lo permitió aún: instala la app y vuelve a intentar');
  }
}

function helpDialog() {
  dialog({
    title: 'Cómo usar sin internet',
    body: el('ol', { class: 'help' },
      el('li', {}, 'Instala la app: menú de Chrome (⋮) → “Agregar a la pantalla principal” o “Instalar app”.'),
      el('li', {}, '“Buscar música en la tarjeta SD”: elige tu carpeta de música (por ejemplo Música en la tarjeta; Android no deja elegir la raíz de la tarjeta). Se lee directo de ahí, sin ocupar espacio extra.'),
      el('li', {}, 'Si agregas canciones a la tarjeta, entra a “Carpetas enlazadas” → “Volver a escanear”.'),
      el('li', {}, 'Si Chrome vuelve a pedir permiso al abrir la app, toca el aviso “Reconectar”.'),
      el('li', {}, 'Listo: abre Gipotify desde su ícono, incluso en modo avión.'),
      el('li', {}, 'Batería: la música suena con la pantalla apagada. Solo al cargar o escanear canciones la pantalla se mantiene encendida, y se libera al terminar.'),
      el('li', {}, 'Los botones de tus audífonos Bluetooth y la pantalla bloqueada controlan la música.'),
      el('li', {}, 'No borres los “datos del sitio” de Gipotify en Chrome: ahí están tu biblioteca y las canciones copiadas.')),
    ok: 'Entendido', noCancel: true,
  });
}

async function wipeLibrary() {
  const v = await dialog({
    title: 'Borrar toda la biblioteca',
    message: 'Se borran todas las canciones, carátulas y listas guardadas en Gipotify. Escribe BORRAR para confirmar.',
    fields: [{ name: 'c', label: 'Confirmación', placeholder: 'BORRAR', autocapitalize: 'characters' }],
    ok: 'Borrar todo', danger: true,
  });
  if (!v) return;
  if (v.c.toUpperCase() !== 'BORRAR') { toast('No se borró nada'); return; }
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  await db.clearAll();
  for (const p of coverUrls.values()) { const u = await p; if (u) URL.revokeObjectURL(u); }
  coverUrls.clear();
  Object.assign(state, { queue: [], original: [], index: -1 });
  state.tracks.clear();
  state.playlists = [];
  state.sources.clear();
  dirCache.clear();
  updateReconnect();
  localStorage.removeItem('gipotify.session');
  touch();
  updateNowPlaying();
  render(true);
  toast('Biblioteca borrada');
}

// ================= vistas =================
const main = () => $('#main');
const mount = (...kids) => main().append(...kids.flat().filter((k) => k != null && k !== false));
let searchWrap, searchInput;

function buildSearch() {
  searchInput = el('input', { type: 'search', placeholder: 'Buscar canción, artista o álbum', 'aria-label': 'Buscar', enterkeyhint: 'search' });
  let timer;
  searchInput.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = searchInput.value; render(true); }, 160);
  });
  const clear = btn('close', () => { searchInput.value = ''; state.query = ''; render(true); searchInput.focus(); }, 'Limpiar');
  searchWrap = el('div', { class: 'search' }, icon('search'), searchInput, clear);
}

function setHeader({ back, title, menu, search }) {
  const top = $('#top');
  top.replaceChildren(el('div', { class: 'bar' },
    back
      ? btn('back', () => goBack(back), 'Atrás')
      : el('div', { class: 'brand' }, el('img', { src: 'icons/favicon.svg', alt: '', width: 28, height: 28 }), 'gipotify'),
    title ? el('div', { class: 'bar-title' }, title) : el('div', { class: 'spacer' }),
    menu ? btn('more', menu, 'Menú') : null));
  if (search) {
    top.append(searchWrap);
    searchWrap.classList.toggle('filled', !!state.query);
  }
}

function matches(t) {
  const q = norm(state.query).split(/\s+/).filter(Boolean);
  if (!q.length) return true;
  const s = lib().search.get(t.id) || '';
  return q.every((w) => s.includes(w));
}
const matchText = (text) => {
  const q = norm(state.query).split(/\s+/).filter(Boolean);
  const s = norm(text);
  return q.every((w) => s.includes(w));
};

function trackRow(t, ctx) {
  const sub = ctx.album ? artistOf(t) : `${artistOf(t)} · ${albumOf(t)}`;
  return el('div', { class: 'row', dataset: { id: t.id }, onclick: () => playList(ctx.ids, ctx.index) },
    ctx.number ? el('div', { class: 'num' }, t.track || '·') : coverBox(t.coverId, 'sm', t.album || t.title),
    el('div', { class: 'meta' }, el('div', { class: 't1' }, t.title), el('div', { class: 't2' }, sub)),
    el('div', { class: 'dur', dataset: { dur: t.id } }, fmtTime(t.duration)),
    btn('more', () => trackMenu(t, ctx), 'Opciones'));
}
function trackList(list, ctx = {}) {
  const ids = list.map((t) => t.id);
  return el('div', { class: 'list' }, ...list.map((t, i) => trackRow(t, { ...ctx, ids, index: i })));
}
function actions(ids, menu) {
  return el('div', { class: 'actions' },
    el('button', { type: 'button', class: 'btn primary', onclick: () => playList(ids, 0, { shuffle: false }) }, icon('play'), 'Reproducir'),
    el('button', { type: 'button', class: 'btn ghost', onclick: () => shufflePlay(ids) }, icon('shuffle'), 'Aleatorio'),
    menu ? btn('more', menu, 'Más opciones') : null);
}
function hero(cover, kicker, title, subtitle, meta) {
  return el('section', { class: 'hero' }, cover,
    el('div', { class: 'hero-text' },
      kicker && el('div', { class: 'kicker' }, kicker),
      el('h1', {}, title),
      subtitle,
      meta && el('div', { class: 'hero-meta' }, meta)));
}
const empty = (text, ...extra) => el('div', { class: 'empty' }, el('p', {}, text), ...extra);

function welcome() {
  return el('div', { class: 'welcome' },
    el('img', { src: 'icons/icon-192.png', alt: '', width: 96, height: 96 }),
    el('h1', {}, 'Tu música, sin internet'),
    el('p', {}, 'Tus MP3 y WAV, en tu celular o tu tarjeta de memoria. Suenan aunque estés en modo avión.'),
    el('div', { class: 'welcome-actions' },
      canLink && el('button', { type: 'button', class: 'btn primary', onclick: linkFolder }, icon('search'), 'Buscar en la tarjeta SD o el celular'),
      el('button', { type: 'button', class: 'btn ' + (canLink ? 'ghost' : 'primary'), onclick: pickFolder }, icon('folder'), 'Copiar una carpeta a la app'),
      el('button', { type: 'button', class: 'btn ghost', onclick: pickFiles }, icon('fileAdd'), 'Copiar archivos a la app')),
    canLink && el('p', { class: 'hint' }, '“Buscar” lee la música directo de la carpeta que elijas (por ejemplo Música en la tarjeta SD) y no ocupa espacio extra. Android no deja elegir la raíz de la tarjeta: elige la carpeta donde está tu música.'),
    el('p', { class: 'hint' }, 'Si tu música está en carpetas Artista/Álbum, se ordena sola. También usa cover.jpg o folder.jpg como carátula.'));
}

const SORTS = { title: 'Título', artist: 'Artista', album: 'Álbum', recent: 'Recientes' };
function sortTracks(list) {
  const s = state.sort;
  if (s === 'artist') list.sort((a, b) => cmp(artistOf(a), artistOf(b)) || cmp(albumOf(a), albumOf(b)) || byTrackNo(a, b));
  else if (s === 'album') list.sort((a, b) => cmp(albumOf(a), albumOf(b)) || byTrackNo(a, b));
  else if (s === 'recent') list.sort((a, b) => b.addedAt - a.addedAt || cmp(a.title, b.title));
  else list.sort((a, b) => cmp(a.title, b.title) || cmp(artistOf(a), artistOf(b)));
  return list;
}

const views = {
  songs() {
    setHeader({ menu: appMenu, search: true });
    if (!state.tracks.size) { mount(welcome()); return; }
    const list = sortTracks([...state.tracks.values()].filter(matches));
    const ids = list.map((t) => t.id);
    const select = el('select', { 'aria-label': 'Ordenar', onchange: (e) => { state.sort = e.target.value; localStorage.setItem('gipotify.sort', state.sort); render(true); } },
      ...Object.entries(SORTS).map(([v, l]) => el('option', { value: v, selected: state.sort === v }, l)));
    mount(
      el('div', { class: 'toolbar' },
        el('span', { class: 'count' }, plural(list.length, 'canción', 'canciones')),
        select,
        el('button', { type: 'button', class: 'btn small', onclick: () => shufflePlay(ids) }, icon('shuffle'), 'Aleatorio')),
      list.length ? trackList(list) : empty('Nada coincide con tu búsqueda.'));
  },

  albums() {
    setHeader({ menu: appMenu, search: true });
    if (!state.tracks.size) { mount(welcome()); return; }
    const albums = [...lib().albums.values()].filter((a) => matchText(`${a.name} ${a.artist}`)).sort((a, b) => cmp(a.name, b.name) || cmp(a.artist, b.artist));
    mount(
      el('div', { class: 'toolbar' }, el('span', { class: 'count' }, plural(albums.length, 'álbum', 'álbumes'))),
      albums.length ? el('div', { class: 'grid' }, ...albums.map(albumCard)) : empty('Nada coincide con tu búsqueda.'));
  },

  album(key) {
    const a = lib().albums.get(key);
    setHeader({ back: '#/albums', title: '' });
    if (!a) { mount(empty('Este álbum ya no existe.')); return; }
    const ids = a.tracks.map((t) => t.id);
    const artistLink = el('button', { type: 'button', class: 'link', onclick: () => go('#/artist/' + enc(a.artist)) }, a.artist);
    mount(
      hero(coverBox(a.coverId, 'hero', a.name, false), 'Álbum', a.name, artistLink,
        [a.year, plural(a.tracks.length, 'canción', 'canciones'), sumDur(a.tracks) ? fmtTotal(sumDur(a.tracks)) : ''].filter(Boolean).join(' · ')),
      actions(ids, () => collectionMenu(a.name, ids, [
        { icon: 'delete', label: 'Eliminar álbum del celular', danger: true, action: () => confirmDelete(ids, `el álbum “${a.name}”`) },
      ])),
      trackList(a.tracks, { number: true, album: true }));
  },

  artists() {
    setHeader({ menu: appMenu, search: true });
    if (!state.tracks.size) { mount(welcome()); return; }
    const artists = [...lib().artists.values()].filter((a) => matchText(a.name)).sort((a, b) => cmp(a.name, b.name));
    mount(
      el('div', { class: 'toolbar' }, el('span', { class: 'count' }, plural(artists.length, 'artista', 'artistas'))),
      artists.length
        ? el('div', { class: 'list' }, ...artists.map((ar) => el('a', { class: 'row', href: '#/artist/' + enc(ar.name) },
          coverBox(ar.coverId, 'sm round', ar.name),
          el('div', { class: 'meta' }, el('div', { class: 't1' }, ar.name),
            el('div', { class: 't2' }, `${plural(ar.albums.size, 'álbum', 'álbumes')} · ${plural(ar.tracks.length, 'canción', 'canciones')}`)))))
        : empty('Nada coincide con tu búsqueda.'));
  },

  artist(name) {
    const L = lib();
    const ar = L.artists.get(name);
    setHeader({ back: '#/artists', title: '' });
    if (!ar) { mount(empty('Este artista ya no existe.')); return; }
    const tracks = ar.tracks.slice().sort((a, b) => cmp(albumOf(a), albumOf(b)) || byTrackNo(a, b));
    const ids = tracks.map((t) => t.id);
    const albums = [...ar.albums].map((k) => L.albums.get(k)).filter(Boolean).sort((a, b) => cmp(a.year, b.year) || cmp(a.name, b.name));
    mount(
      hero(coverBox(ar.coverId, 'hero round', ar.name, false), 'Artista', ar.name, null,
        `${plural(albums.length, 'álbum', 'álbumes')} · ${plural(tracks.length, 'canción', 'canciones')}`),
      actions(ids, () => collectionMenu(ar.name, ids)),
      el('h2', { class: 'section' }, 'Álbumes'),
      el('div', { class: 'grid' }, ...albums.map(albumCard)),
      el('h2', { class: 'section' }, 'Canciones'),
      trackList(tracks));
  },

  playlists() {
    setHeader({ menu: appMenu });
    const favCount = [...state.tracks.values()].filter((t) => t.fav).length;
    const item = (href, cover, title, sub) => el('a', { class: 'row', href }, cover, el('div', { class: 'meta' }, el('div', { class: 't1' }, title), el('div', { class: 't2' }, sub)));
    const favCover = el('div', { class: 'cover sm fav-cover' }, icon('heart'));
    mount(
      el('div', { class: 'toolbar' },
        el('span', { class: 'count' }, plural(state.playlists.length, 'lista', 'listas')),
        el('button', { type: 'button', class: 'btn small', onclick: () => createPlaylist() }, icon('plus'), 'Nueva lista')),
      el('div', { class: 'list' },
        item('#/playlist/fav', favCover, 'Favoritas', plural(favCount, 'canción', 'canciones')),
        ...state.playlists.slice().sort((a, b) => cmp(a.name, b.name)).map((p) => {
          const first = state.tracks.get(p.ids.find((id) => state.tracks.get(id)?.coverId));
          return item('#/playlist/' + enc(p.id), coverBox(first?.coverId, 'sm', p.name), p.name, plural(p.ids.length, 'canción', 'canciones'));
        })),
      !state.playlists.length ? el('p', { class: 'hint pad' }, 'Crea listas para el viaje, para entrenar o para dormir. Desde cualquier canción: ⋮ → “Agregar a una lista”.') : null);
  },

  playlist(id) {
    setHeader({ back: '#/playlists', title: '' });
    if (id === 'fav') {
      const list = [...state.tracks.values()].filter((t) => t.fav).sort((a, b) => b.fav - a.fav);
      const ids = list.map((t) => t.id);
      mount(
        hero(el('div', { class: 'cover hero fav-cover' }, icon('heart')), 'Lista', 'Favoritas', null,
          [plural(list.length, 'canción', 'canciones'), sumDur(list) ? fmtTotal(sumDur(list)) : ''].filter(Boolean).join(' · ')),
        list.length ? actions(ids, () => collectionMenu('Favoritas', ids)) : null,
        list.length ? trackList(list, { playlistId: 'fav' }) : empty('Toca ♥ en el reproductor o en el menú ⋮ de una canción para agregarla aquí.'));
      return;
    }
    const p = state.playlists.find((x) => x.id === id);
    if (!p) { mount(empty('Esta lista ya no existe.')); return; }
    const list = p.ids.map((x) => state.tracks.get(x)).filter(Boolean);
    const ids = list.map((t) => t.id);
    const first = list.find((t) => t.coverId);
    mount(
      hero(coverBox(first?.coverId, 'hero', p.name, false), 'Lista', p.name, null,
        [plural(list.length, 'canción', 'canciones'), sumDur(list) ? fmtTotal(sumDur(list)) : ''].filter(Boolean).join(' · ')),
      actions(ids, () => sheet(p.name, [
        list.length && { icon: 'playNext', label: 'Reproducir a continuación', action: () => playNext(ids) },
        list.length && { icon: 'queue', label: 'Agregar a la cola', action: () => addToQueue(ids) },
        { icon: 'edit', label: 'Renombrar', action: () => renamePlaylist(p) },
        { icon: 'delete', label: 'Eliminar lista', danger: true, action: () => deletePlaylist(p) },
      ])),
      list.length ? trackList(list, { playlistId: p.id }) : empty('Lista vacía. Desde cualquier canción: ⋮ → “Agregar a una lista”.'));
  },
};

function albumCard(a) {
  return el('a', { class: 'card', href: '#/album/' + enc(a.key) },
    coverBox(a.coverId, 'lg', a.name),
    el('div', { class: 't1' }, a.name),
    el('div', { class: 't2' }, a.artist));
}

// ================= render =================
let lastMain = null;
const scrollMem = new Map();
function render(force = false) {
  const h = location.hash || '#/songs';
  const { view } = parseHash(h);
  if (view === 'now') {
    if (!state.queue.length) { goBack(); return; }
    showPlayer(true);
    if (lastMain == null) renderMain('#/songs');
    return;
  }
  showPlayer(false);
  if (!force && h === lastMain) return;
  renderMain(h);
}
function renderMain(h) {
  if (lastMain) scrollMem.set(lastMain, scrollY);
  lastMain = h;
  const { view, arg } = parseHash(h);
  const tab = { album: 'albums', artist: 'artists', playlist: 'playlists' }[view] || view;
  ui.tabs.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  main().replaceChildren();
  (views[view] || views.songs)(arg);
  markPlaying();
  const y = scrollMem.get(h) || 0;
  requestAnimationFrame(() => scrollTo(0, y));
}
function showPlayer(on) {
  if (ui.player.hidden === !on) return;
  ui.player.hidden = !on;
  document.body.classList.toggle('player-open', on);
  if (on) { ui.player.scrollTop = 0; renderQueue(); }
}

// ================= arranque =================
async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  buildSearch();
  buildPlayerUI();
  $('#pick-files').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
  $('#pick-folder').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
  addEventListener('hashchange', onHash);
  addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  });

  try {
    const [tracks, playlists, sources] = await Promise.all([db.getAll('tracks'), db.getAll('playlists'), db.getAll('sources')]);
    tracks.forEach((t) => state.tracks.set(t.id, t));
    sources.forEach((s) => state.sources.set(s.id, s));
    state.playlists = playlists.sort((a, b) => a.created - b.created);
  } catch (e) {
    console.error(e);
    toast('No se pudo abrir la biblioteca');
  }
  touch();
  navStack.push(location.hash || '#/songs');
  await updateReconnect();
  restoreSession();
  updateNowPlaying();
  render(true);
  if (state.tracks.size) requestPersist();
  setTimeout(fillDurations, 3000);
}
init();
