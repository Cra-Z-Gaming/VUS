// ===== Statik viewer (read-only + like / comment / report) =====
// Posting lives in submit.html; approval lives in admin.html.
const db = firebase.database();
const auth = firebase.auth();

const COOLDOWNS = { comment: 5000, reply: 5000 };
const lastAction = {};
function cooldownLeft(k) {
  const w = (lastAction[k] || 0) + COOLDOWNS[k] - Date.now();
  return w > 0 ? Math.ceil(w / 1000) : 0;
}

// ===== Identity =====
const MY_NAME = (() => {
  let n = sessionStorage.getItem('statik_anon_id');
  if (!n) {
    n = String(Math.floor(Math.random() * 9999) + 1).padStart(4, '0');
    sessionStorage.setItem('statik_anon_id', n);
  }
  return `Anonymous #${n}`;
})();
let MY_UID = null;

// ===== Viewed tracking =====
const VIEWED_KEY = 'statik_viewed_posts';
const RESET_GEN_KEY = 'statik_last_reset_gen';
const getViewedSet = () => { try { return JSON.parse(localStorage.getItem(VIEWED_KEY) || '{}'); } catch (e) { return {}; } };
function markViewed(id) {
  const v = getViewedSet();
  if (v[id]) return;
  v[id] = true;
  localStorage.setItem(VIEWED_KEY, JSON.stringify(v));
}
db.ref('meta/resetGen').on('value', (s) => {
  const gen = s.val();
  if (gen == null) return;
  if (gen > parseInt(localStorage.getItem(RESET_GEN_KEY) || '0', 10)) {
    localStorage.removeItem(VIEWED_KEY);
    localStorage.setItem(RESET_GEN_KEY, String(gen));
  }
});

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const searchInput = $('search-input'), postStage = $('post-stage'), loadingState = $('loading-state');
const emptyState = $('empty-state'), endPage = $('end-page'), refreshBtn = $('refresh-btn');
const sortSelect = $('sort-select'), skipViewedCheckbox = $('skip-viewed-checkbox');
const prevBtn = $('prev-btn'), nextBtn = $('next-btn'), postCounter = $('post-counter');
const resetTimerEl = $('reset-timer'), totalCountEl = $('total-count'), toastEl = $('toast');
const commentsList = $('comments-list'), commentsCount = $('comments-count');
const commentForm = $('comment-form'), commentInput = $('comment-input'), commentCounter = $('comment-counter');
const fullscreenOverlay = $('fullscreen-overlay'), fullscreenImg = $('fullscreen-img');

// ===== UI fixes (injected here so style.css doesn't need touching) =====
const fixStyle = document.createElement('style');
fixStyle.textContent = `
:root{color-scheme:dark}
*{scrollbar-width:thin;scrollbar-color:#3a3a3a transparent}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#new-post-btn{display:inline-block;text-decoration:none;white-space:nowrap}
#dev-panel-btn,#dev-panel-modal,#post-modal{display:none!important}
#review-btn{display:inline-block;text-decoration:none;white-space:nowrap;background:#1f1f1f;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:9px 16px;font-weight:700;font-size:14px}
#review-btn:hover{border-color:var(--accent)}
.comments-panel{top:var(--topbar-h,53px)}
.post-media img{position:absolute;inset:0;width:100%;height:100%;max-width:none;max-height:none;object-fit:contain;z-index:1}
.post-media img.bg{object-fit:cover;filter:blur(28px) brightness(.4);transform:scale(1.15);z-index:0}
.post-media .no-image-text{position:relative;z-index:1;color:var(--text-dim)}
.expand-btn{z-index:2}
.post-card.text-only .post-media{display:none}
.post-card.text-only .post-info{max-width:680px;margin:0 auto;justify-content:center}
.post-card.text-only .title{font-size:32px;line-height:1.2}
.post-card.text-only .desc{flex:0 1 auto;max-height:50vh;font-size:17px;line-height:1.55}
.post-info .title,.post-info .desc,.comment .c-text{overflow-wrap:anywhere}
.chip{position:relative;display:inline-flex;align-items:center;cursor:pointer;user-select:none;flex-shrink:0}
.chip input{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
.chip>span,button.chip{padding:8px 14px;border-radius:999px;border:1px solid var(--border);background:#1f1f1f;color:var(--text-dim);font-family:inherit;font-size:13px;font-weight:600;line-height:1;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.chip:hover>span,button.chip:hover{border-color:var(--accent);color:var(--text)}
.chip input:checked+span,button.chip.on{background:var(--accent);border-color:var(--accent);color:#06172b}
.chip input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
.sort-select{appearance:none;-webkit-appearance:none;padding:8px 32px 8px 14px;border-radius:999px;font-weight:600;line-height:1;background:#1f1f1f url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%239a9a9a' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 13px center}
.sort-select:hover{border-color:var(--accent)}
.post-media video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:1;background:#000}
.submit-note{background:rgba(77,163,255,.12);border:1px solid var(--accent);color:#cfe6ff;border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.4}
@media (max-width:1200px) and (min-width:901px){.post-stage{padding:24px 20px 24px 70px}.post-card{gap:18px}.post-media{flex-basis:55%}}
@media (max-width:900px){
.topbar{padding:8px 10px;gap:8px}
.search-wrap{order:10;flex:1 1 100%;max-width:none}
.reset-timer,.total-count{font-size:11px}
.viewer{margin-bottom:36vh}
.comments-panel{top:auto;height:36vh}
.post-stage{padding:12px 12px 12px 56px}
.post-card{gap:12px}
.post-info .title{font-size:20px}
.post-card.text-only .title{font-size:24px}
input,select,textarea{font-size:16px!important}
}`;
document.head.appendChild(fixStyle);
emptyState.querySelector('p').textContent = 'No posts yet. Submit one with ＋ New Post.';

const topbarEl = document.querySelector('.topbar');
const syncTopbar = () => document.documentElement.style.setProperty('--topbar-h', topbarEl.offsetHeight + 'px');
syncTopbar();
if (window.ResizeObserver) new ResizeObserver(syncTopbar).observe(topbarEl); else window.addEventListener('resize', syncTopbar);

// ===== Type filters (Video / Image), mute, nicer toggles =====
// Video is on by default, Image is off. Both off = show everything (including text-only posts).
function makeChip(id, label, checked) {
  const l = document.createElement('label'), i = document.createElement('input'), t = document.createElement('span');
  l.className = 'chip'; i.type = 'checkbox'; i.id = id; i.checked = checked; t.textContent = label;
  l.append(i, t);
  return { label: l, input: i };
}
const vChip = makeChip('filter-video', '🎬 Video', true);
const iChip = makeChip('filter-image', '🖼️ Image', false);
const filterVideoEl = vChip.input, filterImageEl = iChip.input;
const skipLabel = skipViewedCheckbox.closest('label');
const skipText = document.createElement('span');
skipText.textContent = 'Skip viewed';
skipLabel.className = 'chip';
skipLabel.textContent = '';
skipLabel.append(skipViewedCheckbox, skipText);
sortSelect.after(vChip.label, iChip.label);

const typeOk = (p) => {
  const wv = filterVideoEl.checked, wi = filterImageEl.checked;
  if (!wv && !wi) return true;
  return (wv && !!p.hasVideo) || (wi && !!(p.hasImage || p.imageData));
};
// Auto-fallback: if there are no videos at all, also show images. It waits until posts have loaded
// plus a grace period (re-checked on every update), and never fires once the visitor has touched a filter.
const GRACE_MS = 3000;
let postsLoaded = false, fallbackPending = false, fallbackTimer = null, filtersTouched = false;
const noVideosYet = () => postsLoaded && allPosts.length > 0 && !allPosts.some((p) => p.hasVideo);
function cancelFallback() { clearTimeout(fallbackTimer); fallbackPending = false; }
function checkFallback() {
  clearTimeout(fallbackTimer);
  const armed = !filtersTouched && filterVideoEl.checked && !filterImageEl.checked;
  if (!armed || !noVideosYet()) { fallbackPending = false; return; }
  fallbackPending = true;
  fallbackTimer = setTimeout(() => {
    fallbackPending = false;
    if (filtersTouched || !noVideosYet() || filterImageEl.checked) { renderCurrentPost(); return; }
    filterImageEl.checked = true;
    showToast('No videos yet, so images are showing too.');
    rebuildVisiblePosts({ resetIndex: true, forceReshuffle: true });
  }, GRACE_MS);
}
const onTypeFilter = () => { filtersTouched = true; cancelFallback(); rebuildVisiblePosts({ resetIndex: true, forceReshuffle: true }); };
filterVideoEl.addEventListener('change', onTypeFilter);
filterImageEl.addEventListener('change', onTypeFilter);

const typeState = document.createElement('div');
typeState.className = 'empty-state hidden';
typeState.innerHTML = '<div class="state-icon">◌</div><p></p>';
emptyState.after(typeState);

// Mute: every visit starts muted, nothing is remembered.
let isMuted = true;
const muteBtn = document.createElement('button');
muteBtn.type = 'button'; muteBtn.id = 'mute-btn'; muteBtn.className = 'chip';
function setMuted(m, apply = true) {
  isMuted = m;
  muteBtn.classList.toggle('on', m);
  muteBtn.textContent = m ? '🔇 Muted' : '🔊 Sound on';
  muteBtn.setAttribute('aria-pressed', String(m));
  if (apply) { const v = postStage.querySelector('video'); if (v) v.muted = m; }
}
setMuted(true, false);
muteBtn.addEventListener('click', () => setMuted(!isMuted));
skipLabel.after(muteBtn);

// Videos live in the database as base64 chunks (videos/<postId>); rebuild them into a playable file.
const videoCache = new Map();
let videoTimer = null;

// ===== Preloading: fetch the next few posts quietly so they open instantly =====
const PRELOAD_VIDEOS = 2, PRELOAD_IMAGES = 4, PRELOAD_WINDOW = 5; // window matches the shuffle's 5-post cycle
const videoInflight = new Map(), imageInflight = new Map();
let preloadToken = 0;
const warmImage = (d) => { if (d) { const im = new Image(); im.src = d; } };
const saveDataOn = () => !!(navigator.connection && navigator.connection.saveData);
// Drop the oldest cached items, but never the current post or the ones about to be shown.
function trimCache(cache, max, onDrop) {
  const keep = new Set(visiblePosts.slice(currentIndex, currentIndex + PRELOAD_WINDOW + 1).map((p) => p.id));
  for (const k of cache.keys()) {
    if (cache.size <= max) break;
    if (keep.has(k)) continue;
    if (onDrop) onDrop(cache.get(k));
    cache.delete(k);
  }
}
// Runs only after the current post has finished loading, one download at a time, and stops if you move on.
async function preloadAhead() {
  const token = preloadToken;
  if (saveDataOn() || bgPosting) return;
  const jobs = [];
  let v = 0, i = 0;
  visiblePosts.slice(currentIndex + 1, currentIndex + 1 + PRELOAD_WINDOW).forEach((p) => {
    if (p.hasVideo) { if (v++ < PRELOAD_VIDEOS) jobs.push(() => getVideoUrl(p.id)); }
    else if (p.hasImage || p.imageData) { if (i++ < PRELOAD_IMAGES) jobs.push(() => getImage(p).then(warmImage)); }
  });
  for (const job of jobs) {
    if (token !== preloadToken || bgPosting) return;
    try { await job(); } catch (e) {}
  }
}
function getVideoUrl(id) {
  if (videoCache.has(id)) return Promise.resolve(videoCache.get(id));
  if (videoInflight.has(id)) return videoInflight.get(id);
  const pr = db.ref('videos/' + id).once('value').then((snap) => {
    const v = snap.val();
    if (!v || !v.chunks) throw new Error('Video not found');
    const parts = [];
    for (let i = 0; i < v.n; i++) {
      const c = v.chunks[i];
      if (typeof c !== 'string') throw new Error('Video is incomplete');
      const bin = atob(c), arr = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
      parts.push(arr);
    }
    const url = URL.createObjectURL(new Blob(parts, { type: v.mime || 'video/webm' }));
    videoCache.set(id, url);
    trimCache(videoCache, 6, (u) => URL.revokeObjectURL(u));
    return url;
  });
  videoInflight.set(id, pr);
  const done = () => videoInflight.delete(id);
  pr.then(done, done);
  return pr;
}
function showVideo(post, media) {
  const msg = media.querySelector('.no-image-text');
  media.classList.add('no-image');
  msg.textContent = 'Loading video…';
  // Tiny delay so flicking quickly past a post doesn't download its whole video.
  videoTimer = setTimeout(() => {
    getVideoUrl(post.id).then((url) => {
      if (currentId !== post.id) return;
      const v = document.createElement('video');
      v.controls = true; v.loop = true; v.autoplay = true; v.playsInline = true;
      v.muted = isMuted; v.src = url;
      v.addEventListener('volumechange', () => { if (v.muted !== isMuted) setMuted(v.muted, false); });
      media.textContent = '';
      media.append(v);
      preloadAhead();
      const pr = v.play();
      if (pr && pr.catch) pr.catch(() => { v.muted = true; setMuted(true, false); v.play().catch(() => {}); });
    }).catch(() => { if (currentId === post.id) msg.textContent = 'Could not load this video.'; });
  }, videoCache.has(post.id) ? 0 : 400);
}

// ===== Background posting: the form keeps working while hidden, a small pill shows progress =====
// Browsers can't split bandwidth 50/50, so instead we pause our own preloading while a post is uploading.
let bgPosting = false, pillEl = null;
function showPill(label, frac, done) {
  if (!pillEl) {
    pillEl = document.createElement('div');
    pillEl.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:250;width:min(300px,calc(100vw - 32px));background:#161616;border:1px solid var(--border);border-radius:12px;padding:10px 14px;font-size:13px;color:var(--text);box-shadow:0 8px 24px rgba(0,0,0,.5)';
    pillEl.innerHTML = '<div></div><div style="height:6px;border-radius:99px;background:#2a2a2a;overflow:hidden;margin-top:8px"><i style="display:block;height:100%;width:0;background:var(--accent);transition:width .2s"></i></div>';
    document.body.appendChild(pillEl);
  }
  clearTimeout(pillEl._t);
  pillEl.style.borderColor = done ? '#4dff9a' : 'var(--border)';
  pillEl.firstChild.textContent = (done ? '' : '⬆ ') + (label || 'Posting…');
  if (done) { pillEl.style.cursor = 'pointer'; pillEl.onclick = hidePill; pillEl._t = setTimeout(hidePill, 12000); }
  pillEl.querySelector('i').style.width = Math.round(Math.max(0, Math.min(1, frac || 0)) * 100) + '%';
}
function hidePill() { if (pillEl) { clearTimeout(pillEl._t); pillEl.remove(); pillEl = null; } }
window.addEventListener('beforeunload', (e) => { if (bgPosting) { e.preventDefault(); e.returnValue = ''; } });

const newPostEl = $('new-post-btn');
// New Post opens the submit form in an overlay on this same page: submit.html is fetched
// from GitHub (same trick as the loader) and shown in an iframe, so no new tab or hosting needed.
const SUBMIT_SRC = 'https://raw.githubusercontent.com/Cra-Z-Gaming/VUS/refs/heads/main/Statik/submit.html';
function openSubmitWindow(e) {
  if (e) e.preventDefault();
  if (bgPosting) { showToast('Still posting your last video, one moment.'); return; }
  if (document.getElementById('submit-overlay')) return;
  const ov = document.createElement('div');
  ov.id = 'submit-overlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:150;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;padding:16px';
  const close = document.createElement('button');
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close');
  close.style.cssText = 'position:fixed;top:14px;right:18px;z-index:151;width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;font-size:18px;cursor:pointer';
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:100%;height:min(82vh,700px);border:0;border-radius:12px;background:#0e0e0e';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:min(520px,100%);display:flex;flex-direction:column;gap:10px';
  const note = document.createElement('div');
  note.className = 'submit-note';
  note.textContent = 'ℹ️ Heads up: posts are reviewed by admins and can take up to 3 days to be published.';
  wrap.append(note, frame);
  ov.append(wrap, close);
  document.body.appendChild(ov);
  const ovCss = ov.style.cssText;
  let formBusy = false;
  const forceShut = () => { window.removeEventListener('message', onMsg); hidePill(); bgPosting = false; ov.remove(); };
  const shut = () => {
    if (formBusy && !bgPosting && !confirm('Your video has not been posted yet. Close and lose it?')) return;
    forceShut();
  };
  const onMsg = (ev) => {
    const d = ev.data;
    if (ev.source !== frame.contentWindow || !d || typeof d !== 'object') return;
    if (d.type === 'statik-busy') formBusy = !!d.busy;
    else if (d.type === 'statik-background') {
      bgPosting = true; ov.id = 'submit-overlay-bg';
      ov.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1';
      close.style.display = 'none';
      showPill('Getting your video ready…', 0);
    } else if (d.type === 'statik-progress' && bgPosting) showPill(d.label, d.frac);
    else if (d.type === 'statik-done') { forceShut(); showPill('✅ Submitted! Your post is waiting for admin review. This can take up to 3 days, no need to do anything else. (tap to close)', 1, true); }
    else if (d.type === 'statik-error') {
      bgPosting = false; hidePill(); ov.id = 'submit-overlay'; ov.style.cssText = ovCss; close.style.display = '';
      showToast(d.message || 'Posting failed. Your video is still in the form, try again.');
    }
  };
  window.addEventListener('message', onMsg);
  close.onclick = shut;
  ov.addEventListener('click', (ev) => { if (ev.target === ov) shut(); });
  fetch(SUBMIT_SRC, { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then((html) => { frame.srcdoc = html; })
    .catch((err) => { shut(); showToast('Could not load the post form: ' + err.message); });
}
if (newPostEl) newPostEl.addEventListener('click', openSubmitWindow);

// "Review" button: opens the admin page in a new tab. Anyone can click it, but only
// Google accounts listed under /admins in the database can do anything there.
const ADMIN_URL = 'https://cra-z-gaming.github.io/VUS/Statik/admin.html'; // swap for your Vercel link if you prefer
if (newPostEl) {
  const reviewEl = document.createElement('a');
  reviewEl.id = 'review-btn';
  reviewEl.textContent = 'Review';
  reviewEl.href = ADMIN_URL;
  reviewEl.target = '_blank';
  reviewEl.rel = 'noopener';
  newPostEl.after(reviewEl);
}

// ===== State =====
let allPosts = [], visiblePosts = [], currentIndex = 0, currentId = null;
let shuffleOrder = [], advancedSinceShuffle = 0;
let listeners = [];
let cData = { comments: {}, replies: {}, clikes: {}, likes: {} };
const imageCache = new Map();

// ===== Helpers =====
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add('hidden'), 2500);
}
function shuffleArray(a) {
  const c = a.slice();
  for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
  return c;
}

// ===== Auth (silent anonymous — no user-facing sign-in) =====
let started = false;
auth.onAuthStateChanged((u) => {
  if (!u) {
    auth.signInAnonymously().catch((e) => {
      console.error(e);
      loadingState.querySelector('p').textContent = 'Could not connect.';
    });
    return;
  }
  const changed = MY_UID && MY_UID !== u.uid;
  MY_UID = u.uid;
  if (!started) { started = true; startPosts(); } else if (changed) renderCurrentPost();
});

// ===== Posts (metadata only; images load one at a time) =====
function startPosts() {
  db.ref('posts').orderByChild('createdAt').limitToLast(200).on('value', (snap) => {
    const val = snap.val() || {};
    allPosts = Object.keys(val).map(id => ({ id, ...val[id] })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    loadingState.classList.add('hidden');
    totalCountEl.textContent = allPosts.length === 1 ? '1 post' : `${allPosts.length} posts`;
    postsLoaded = true;
    checkFallback();
    rebuildVisiblePosts();
  }, (err) => {
    console.error(err);
    loadingState.classList.add('hidden');
    emptyState.classList.remove('hidden');
    emptyState.querySelector('p').textContent = 'Could not load posts.';
  });
}

function rebuildVisiblePosts({ resetIndex = false, forceReshuffle = false } = {}) {
  const q = searchInput.value.trim().toLowerCase();
  const viewed = getViewedSet();
  const skip = skipViewedCheckbox.checked;
  // The post you're looking at is never filtered out from under you.
  let base = allPosts.filter(p =>
    (!q || (p.title || '').toLowerCase().includes(q)) &&
    typeOk(p) &&
    (!skip || !viewed[p.id] || p.id === currentId));

  const mode = sortSelect.value;
  if (mode === 'newest') base.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  else if (mode === 'oldest') base.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  else {
    if (forceReshuffle || shuffleOrder.length === 0 || advancedSinceShuffle >= 5) {
      shuffleOrder = shuffleArray(base.map(p => p.id));
      advancedSinceShuffle = 0;
      const at = shuffleOrder.indexOf(currentId);
      if (!resetIndex && at > 0) { shuffleOrder.splice(at, 1); shuffleOrder.unshift(currentId); }
    } else {
      const known = new Set(shuffleOrder);
      shuffleOrder = shuffleOrder.concat(base.map(p => p.id).filter(id => !known.has(id)));
    }
    const byId = {};
    base.forEach(p => { byId[p.id] = p; });
    base = shuffleOrder.map(id => byId[id]).filter(Boolean);
  }
  visiblePosts = base;

  if (resetIndex) currentIndex = 0;
  else {
    const i = visiblePosts.findIndex(p => p.id === currentId);
    currentIndex = i >= 0 ? i : Math.min(currentIndex, Math.max(visiblePosts.length - 1, 0));
  }
  currentId = visiblePosts[currentIndex] ? visiblePosts[currentIndex].id : null;
  renderCurrentPost();
}

searchInput.addEventListener('input', () => rebuildVisiblePosts({ resetIndex: true }));
sortSelect.addEventListener('change', () => rebuildVisiblePosts({ resetIndex: true, forceReshuffle: true }));
skipViewedCheckbox.addEventListener('change', () => rebuildVisiblePosts({ resetIndex: true }));
function doRefresh() {
  refreshBtn.classList.add('spinning');
  setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
  rebuildVisiblePosts({ resetIndex: true, forceReshuffle: true });
}
refreshBtn.addEventListener('click', doRefresh);
$('end-page-refresh-btn').addEventListener('click', doRefresh);

// ===== Reset timer =====
let nextResetTime = null;
db.ref('meta/nextReset').on('value', (s) => { nextResetTime = s.val(); updateResetTimer(); });
function updateResetTimer() {
  if (!nextResetTime) { resetTimerEl.textContent = ''; return; }
  const rem = nextResetTime - Date.now();
  if (rem <= 0) { resetTimerEl.textContent = 'Reset due — 0d 0h'; resetTimerEl.classList.add('due'); return; }
  resetTimerEl.classList.remove('due');
  const th = Math.floor(rem / 3600000);
  resetTimerEl.textContent = `Next reset: ${Math.floor(th / 24)}d ${th % 24}h`;
}
setInterval(updateResetTimer, 60000);

// ===== Navigation =====
let navLock = false;
function goTo(index) {
  if (index < 0 || index >= visiblePosts.length) return;
  currentIndex = index;
  currentId = visiblePosts[index].id;
  if (sortSelect.value === 'shuffle' && ++advancedSinceShuffle >= 5) {
    rebuildVisiblePosts({ forceReshuffle: true });
    return;
  }
  renderCurrentPost();
}
prevBtn.addEventListener('click', () => goTo(currentIndex - 1));
nextBtn.addEventListener('click', () => goTo(currentIndex + 1));
document.addEventListener('keydown', (e) => {
  if (!fullscreenOverlay.classList.contains('hidden')) { if (e.key === 'Escape') closeFullscreen(); return; }
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'ArrowUp') { e.preventDefault(); goTo(currentIndex - 1); }
  if (e.key === 'ArrowDown') { e.preventDefault(); goTo(currentIndex + 1); }
});
$('viewer').addEventListener('wheel', (e) => {
  if (e.ctrlKey) return; // browser zoom
  const d = e.target.closest && e.target.closest('.desc');
  if (d && d.scrollHeight > d.clientHeight) return; // long description scrolls instead of navigating
  e.preventDefault();
  if (navLock || Math.abs(e.deltaY) < 20) return;
  navLock = true;
  setTimeout(() => { navLock = false; }, 400);
  goTo(currentIndex + (e.deltaY > 0 ? 1 : -1));
}, { passive: false });

let touchY = null;
postStage.addEventListener('touchstart', (e) => { touchY = e.target.closest('.desc') ? null : e.touches[0].clientY; }, { passive: true });
postStage.addEventListener('touchend', (e) => {
  if (touchY == null) return;
  const d = touchY - e.changedTouches[0].clientY;
  touchY = null;
  if (Math.abs(d) > 60) goTo(currentIndex + (d > 0 ? 1 : -1));
}, { passive: true });

// ===== Render post =====
function getImage(post) {
  if (post.imageData) return Promise.resolve(post.imageData); // old-style posts keep the image inline
  const id = post.id;
  if (imageCache.has(id)) return Promise.resolve(imageCache.get(id));
  if (imageInflight.has(id)) return imageInflight.get(id);
  const pr = db.ref(`images/${id}`).once('value').then((s) => {
    imageCache.set(id, s.val());
    trimCache(imageCache, 12); // keep memory bounded
    return s.val();
  }).catch((err) => { console.warn('Could not load image for', id, err); return null; });
  imageInflight.set(id, pr);
  const done = () => imageInflight.delete(id);
  pr.then(done, done);
  return pr;
}

function renderCurrentPost() {
  detachLive();
  clearTimeout(videoTimer);
  preloadToken++;
  const old = postStage.querySelector('.post-card');
  if (old) old.remove();
  endPage.classList.add('hidden');
  emptyState.classList.add('hidden');
  typeState.classList.add('hidden');
  if (postsLoaded && !fallbackPending) loadingState.classList.add('hidden');

  if (visiblePosts.length === 0) {
    const typeBlocked = allPosts.length > 0 && !allPosts.some(typeOk);
    if (typeBlocked) {
      const wv = filterVideoEl.checked, wi = filterImageEl.checked;
      typeState.querySelector('p').textContent = wv && !wi ? 'No video posts yet. Turn on Image to see image posts.'
        : wi && !wv ? 'No image posts yet. Turn on Video to see video posts.'
        : 'No video or image posts yet. Turn both off to see text posts.';
    }
    if (typeBlocked && fallbackPending) {
      loadingState.querySelector('p').textContent = 'Looking for videos…';
      loadingState.classList.remove('hidden');
    } else {
      (allPosts.length === 0 ? emptyState : typeBlocked ? typeState : endPage).classList.remove('hidden');
    }
    postCounter.textContent = '';
    prevBtn.disabled = nextBtn.disabled = true;
    commentsList.innerHTML = '';
    commentsCount.textContent = '';
    return;
  }

  const post = visiblePosts[currentIndex];
  const hasImg = !!(post.hasImage || post.imageData);
  const hasVid = !!post.hasVideo;
  markViewed(post.id);
  postCounter.textContent = `${currentIndex + 1} / ${visiblePosts.length}`;
  prevBtn.disabled = currentIndex === 0;
  nextBtn.disabled = currentIndex === visiblePosts.length - 1;

  const card = document.createElement('div');
  card.className = `post-card${(hasImg || hasVid) ? '' : ' text-only'}`;
  card.innerHTML = `
    ${(hasImg || hasVid) ? '<div class="post-media"><div class="no-image-text">Loading…</div></div>' : ''}
    <div class="post-info">
      <div class="author">${escapeHtml(post.authorName || 'Anonymous')}</div>
      <div class="title">${escapeHtml(post.title)}</div>
      <div class="desc">${escapeHtml(post.description)}</div>
      <div class="timestamp">${post.createdAt ? new Date(post.createdAt).toLocaleString() : ''}</div>
      <div class="like-row">
        <button class="like-btn" id="post-like-btn">♡ <span id="post-like-count">0</span></button>
        <button class="report-btn" id="post-report-btn">🚩 Report</button>
      </div>
    </div>`;
  postStage.appendChild(card);

  if (hasVid) showVideo(post, card.querySelector('.post-media'));
  if (hasImg && !hasVid) {
    const media = card.querySelector('.post-media');
    getImage(post).then((data) => {
      if (currentId !== post.id) return;
      if (!data) { media.remove(); card.classList.add('text-only'); preloadAhead(); return; }
      // Built via DOM properties (never innerHTML) so image data can't inject markup.
      const bg = new Image(), fg = new Image(), btn = document.createElement('button');
      bg.className = 'bg'; fg.className = 'fg'; bg.alt = fg.alt = '';
      bg.src = fg.src = data;
      btn.className = 'expand-btn'; btn.textContent = '⛶ Fullscreen';
      media.textContent = '';
      media.append(bg, fg, btn);
      media.onclick = () => openFullscreen(data);
      preloadAhead();
    });
  }

  card.querySelector('#post-like-btn').addEventListener('click', () => {
    const ref = db.ref(`likes/${post.id}/${MY_UID}`);
    (cData.likes[MY_UID] ? ref.remove() : ref.set(true)).catch(() => showToast('Could not like.'));
  });

  const reportBtn = card.querySelector('#post-report-btn');
  const markReported = () => { reportBtn.disabled = true; reportBtn.classList.add('reported'); reportBtn.textContent = '🚩 Reported'; };
  db.ref(`reports/${post.id}/${MY_UID}`).once('value').then(s => { if (s.val() && currentId === post.id) markReported(); }).catch(() => {});
  reportBtn.addEventListener('click', () => {
    db.ref(`reports/${post.id}/${MY_UID}`).set(true)
      .then(() => { markReported(); showToast('Reported. Thanks for flagging it.'); })
      .catch(() => showToast('Could not report.'));
  });

  attachLive(post.id);
  if (!hasImg && !hasVid) preloadAhead();
}

// ===== Live per-post data: likes, comments, replies, comment likes =====
function detachLive() {
  listeners.forEach(([ref, h]) => ref.off('value', h));
  listeners = [];
}
function attachLive(postId) {
  cData = { comments: {}, replies: {}, clikes: {}, likes: {} };
  const on = (path, key) => {
    const ref = db.ref(path);
    const h = ref.on('value', (s) => {
      cData[key] = s.val() || {};
      if (key === 'likes') updateLikeUI(); else renderComments();
    }, () => {});
    listeners.push([ref, h]);
  };
  on(`likes/${postId}`, 'likes');
  on(`comments/${postId}`, 'comments');
  on(`replies/${postId}`, 'replies');
  on(`commentLikes/${postId}`, 'clikes');
  replyTo = null;
  commentsList.innerHTML = '';
  commentsCount.textContent = '';
}
function updateLikeUI() {
  const btn = $('post-like-btn');
  if (!btn) return;
  const liked = !!cData.likes[MY_UID];
  btn.classList.toggle('liked', liked);
  btn.innerHTML = `${liked ? '♥' : '♡'} <span id="post-like-count">${Object.keys(cData.likes).length}</span>`;
}

let replyTo = null; // id of the comment whose reply box is open

function itemHtml(x, id, isTop) {
  const likes = cData.clikes[id] || {};
  const liked = !!likes[MY_UID];
  const sid = escapeHtml(id);
  return `<div><span class="c-author">${escapeHtml(x.authorName)}</span><span class="c-text">${escapeHtml(x.text)}</span></div>
    <div class="c-meta"><span class="c-time">${x.createdAt ? timeAgo(x.createdAt) : 'now'}</span>
      <button class="c-like-btn ${liked ? 'liked' : ''}" data-like="${sid}">${liked ? '♥' : '♡'} ${Object.keys(likes).length}</button>
      ${isTop ? `<button class="c-reply-btn" data-reply="${sid}">Reply</button>` : ''}</div>`;
}

function renderComments() {
  // Keep an in-progress reply (text + focus) across live re-renders.
  const old = commentsList.querySelector('.reply-form input');
  const draft = old && old.form.dataset.cid === replyTo ? { v: old.value, focus: document.activeElement === old } : null;

  const list = Object.entries(cData.comments).map(([id, c]) => ({ id, ...c })).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  commentsCount.textContent = list.length ? `(${list.length})` : '';
  if (!list.length) { commentsList.innerHTML = '<p style="color:#9a9a9a;font-size:13px;">No comments yet.</p>'; return; }
  commentsList.innerHTML = list.map((c) => {
    const reps = Object.entries(cData.replies[c.id] || {}).map(([id, r]) => ({ id, ...r })).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
    const form = replyTo === c.id
      ? `<form class="reply-form" data-cid="${escapeHtml(c.id)}"><input type="text" placeholder="Reply as ${MY_NAME}..." maxlength="500" required><button type="submit">Send</button></form>` : '';
    return `<div class="comment">${itemHtml(c, c.id, true)}
      <div class="replies">${reps.map(r => `<div class="comment">${itemHtml(r, r.id, false)}</div>`).join('')}</div>${form}</div>`;
  }).join('');

  const inp = commentsList.querySelector('.reply-form input');
  if (inp && draft) { inp.value = draft.v; if (draft.focus) { inp.focus(); inp.setSelectionRange(draft.v.length, draft.v.length); } }
}

commentsList.addEventListener('click', (e) => {
  const like = e.target.closest('[data-like]');
  if (like) {
    const tid = like.dataset.like;
    const ref = db.ref(`commentLikes/${currentId}/${tid}/${MY_UID}`);
    ((cData.clikes[tid] || {})[MY_UID] ? ref.remove() : ref.set(true)).catch(() => showToast('Could not like.'));
    return;
  }
  const reply = e.target.closest('[data-reply]');
  if (reply) {
    replyTo = replyTo === reply.dataset.reply ? null : reply.dataset.reply;
    renderComments();
    const inp = commentsList.querySelector('.reply-form input');
    if (inp) inp.focus();
  }
});

commentsList.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target, text = form.querySelector('input').value.trim();
  if (!text) return;
  const wait = cooldownLeft('reply');
  if (wait) { showToast(`Please wait ${wait}s before replying again.`); return; }
  try {
    await db.ref(`replies/${currentId}/${form.dataset.cid}`).push({
      authorName: MY_NAME, text, uid: MY_UID, createdAt: firebase.database.ServerValue.TIMESTAMP
    });
    lastAction.reply = Date.now();
    replyTo = null;
    renderComments();
  } catch (err) { showToast('Could not reply.'); }
});

commentForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = commentInput.value.trim();
  if (!text || !currentId) return;
  const wait = cooldownLeft('comment');
  if (wait) { showToast(`Please wait ${wait}s before commenting again.`); return; }
  try {
    await db.ref(`comments/${currentId}`).push({
      authorName: MY_NAME, text, uid: MY_UID, createdAt: firebase.database.ServerValue.TIMESTAMP
    });
    lastAction.comment = Date.now();
    commentInput.value = '';
    commentCounter.textContent = '0/500';
  } catch (err) { showToast('Could not comment.'); }
});
commentInput.addEventListener('input', () => { commentCounter.textContent = `${commentInput.value.length}/500`; });

// ===== Fullscreen =====
function openFullscreen(src) { fullscreenImg.src = src; fullscreenOverlay.classList.remove('hidden'); }
function closeFullscreen() { fullscreenOverlay.classList.add('hidden'); fullscreenImg.src = ''; }
$('fullscreen-close-btn').addEventListener('click', closeFullscreen);
fullscreenOverlay.addEventListener('click', closeFullscreen);
