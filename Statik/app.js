// ===== Firebase refs (Realtime Database) =====
const db = firebase.database();

// ===== Config =====
const MIN_ASPECT = 0.4;   // tallest allowed (portrait) ~ 2:5
const MAX_ASPECT = 2.5;   // widest allowed (landscape) ~ 5:2
const MAX_IMAGE_DIMENSION = 1280; // images get resized to fit within this, longest side
const IMAGE_JPEG_QUALITY = 0.72;  // compression quality for stored base64 images

const RESET_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Client-side cooldowns to slow down accidental/rapid-fire spam.
// NOTE: enforced in the browser only, not on the server — since there's no
// auth, there's no real identity to rate-limit against. A determined person
// could bypass this by editing the JS. It still stops normal double-clicks
// and casual spam, which is what it's for.
const POST_COOLDOWN_MS = 15000;
const COMMENT_COOLDOWN_MS = 5000;
const REPLY_COOLDOWN_MS = 5000;

let lastPostTime = 0;
let lastCommentTime = 0;
let lastReplyTime = 0;

// ===== Anonymous session identity =====
// One random Anonymous #0001-9999 per browser session (sessionStorage),
// so it's consistent while you're on the site but resets on a new session.
function getSessionIdentity() {
  let stored = sessionStorage.getItem('statik_anon_id');
  if (!stored) {
    const num = Math.floor(Math.random() * 9999) + 1;
    stored = String(num).padStart(4, '0');
    sessionStorage.setItem('statik_anon_id', stored);
  }
  return `Anonymous #${stored}`;
}
const MY_NAME = getSessionIdentity();

// A per-browser-tab-session random id, used only to track "did I like this"
// client-side. Not identity, not security — just prevents obvious double-click
// double-likes within the same tab session. Also used as the Realtime
// Database key for a like entry (DB keys can't contain most special chars,
// so this is kept alphanumeric).
function getSessionUid() {
  let uid = sessionStorage.getItem('statik_session_uid');
  if (!uid) {
    uid = 'anon' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('statik_session_uid', uid);
  }
  return uid;
}
const SESSION_UID = getSessionUid();

// ===== DOM refs =====
const searchInput = document.getElementById('search-input');
const newPostBtn = document.getElementById('new-post-btn');
const postStage = document.getElementById('post-stage');
const emptyState = document.getElementById('empty-state');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const postCounter = document.getElementById('post-counter');
const resetTimerEl = document.getElementById('reset-timer');

const commentsList = document.getElementById('comments-list');
const commentsCount = document.getElementById('comments-count');
const commentForm = document.getElementById('comment-form');
const commentInput = document.getElementById('comment-input');

const postModal = document.getElementById('post-modal');
const titleInput = document.getElementById('title-input');
const descInput = document.getElementById('desc-input');
const fileInput = document.getElementById('file-input');
const fileLabelText = document.getElementById('file-label-text');
const previewImg = document.getElementById('preview-img');
const cancelPostBtn = document.getElementById('cancel-post-btn');
const submitPostBtn = document.getElementById('submit-post-btn');
const postStatus = document.getElementById('post-status');

const fullscreenOverlay = document.getElementById('fullscreen-overlay');
const fullscreenImg = document.getElementById('fullscreen-img');
const fullscreenCloseBtn = document.getElementById('fullscreen-close-btn');

// ===== State =====
let allPosts = [];      // full loaded post list (unfiltered), newest first
let visiblePosts = [];  // after search filter applied
let currentIndex = 0;
let selectedImageDataUrl = null; // base64 data URL, after compression
let commentsRef = null;
let commentsHandler = null;
let repliesUnsubs = []; // list of {ref, handler} to detach when switching posts

// ===== Load posts (real-time) =====
// Stored at /posts/{postId} = { authorName, title, description, imageData, likes: {uid: true}, createdAt }
db.ref('posts').orderByChild('createdAt').limitToLast(200)
  .on('value', (snapshot) => {
    const val = snapshot.val() || {};
    allPosts = Object.keys(val)
      .map(id => ({ id, ...val[id] }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); // newest first
    applySearchFilter();
  }, (err) => {
    console.error(err);
    emptyState.textContent = 'Could not load posts.';
    emptyState.classList.remove('hidden');
  });

function applySearchFilter() {
  const q = searchInput.value.trim().toLowerCase();
  visiblePosts = q
    ? allPosts.filter(p => (p.title || '').toLowerCase().includes(q))
    : allPosts;

  if (currentIndex >= visiblePosts.length) currentIndex = Math.max(0, visiblePosts.length - 1);
  renderCurrentPost();
}

searchInput.addEventListener('input', () => {
  currentIndex = 0;
  applySearchFilter();
});

// ===== Reset countdown timer =====
// Stored at /meta/nextReset = timestamp (ms). Shared across everyone.
// Days/hours only (no minutes) per design — sits at "0d 0h" once passed,
// since reset is manual (see admin-reset.html), not automatic.
let nextResetTime = null;
db.ref('meta/nextReset').on('value', (snapshot) => {
  nextResetTime = snapshot.val();
  updateResetTimerDisplay();
});

function updateResetTimerDisplay() {
  if (!nextResetTime) {
    resetTimerEl.textContent = '';
    return;
  }
  const remaining = nextResetTime - Date.now();
  if (remaining <= 0) {
    resetTimerEl.textContent = 'Reset due — 0d 0h';
    resetTimerEl.classList.add('due');
    return;
  }
  resetTimerEl.classList.remove('due');
  const totalHours = Math.floor(remaining / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  resetTimerEl.textContent = `Next reset: ${days}d ${hours}h`;
}
setInterval(updateResetTimerDisplay, 60 * 1000); // refresh display every minute

// ===== Navigation =====
prevBtn.addEventListener('click', () => goTo(currentIndex - 1));
nextBtn.addEventListener('click', () => goTo(currentIndex + 1));

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't hijack while typing

  if (e.key === 'ArrowUp') { e.preventDefault(); goTo(currentIndex - 1); }
  if (e.key === 'ArrowDown') { e.preventDefault(); goTo(currentIndex + 1); }
});

document.getElementById('viewer').addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.deltaY > 20) goTo(currentIndex + 1);
  else if (e.deltaY < -20) goTo(currentIndex - 1);
}, { passive: false });

function goTo(index) {
  if (index < 0 || index >= visiblePosts.length) return;
  currentIndex = index;
  renderCurrentPost();
}

// ===== Render the current post =====
function renderCurrentPost() {
  postStage.innerHTML = '';

  if (visiblePosts.length === 0) {
    emptyState.classList.remove('hidden');
    postCounter.textContent = '';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    commentsList.innerHTML = '';
    commentsCount.textContent = '';
    detachComments();
    return;
  }
  emptyState.classList.add('hidden');

  const post = visiblePosts[currentIndex];
  postCounter.textContent = `${currentIndex + 1} / ${visiblePosts.length}`;
  prevBtn.disabled = currentIndex === 0;
  nextBtn.disabled = currentIndex === visiblePosts.length - 1;

  const card = document.createElement('div');
  card.className = 'post-card';

  const likesObj = post.likes || {};
  const likeCount = Object.keys(likesObj).length;
  const liked = !!likesObj[SESSION_UID];
  const time = post.createdAt ? new Date(post.createdAt).toLocaleString() : 'just now';

  const mediaHtml = post.imageData
    ? `<img src="${post.imageData}" alt="">
       <button class="expand-btn" id="expand-btn">⛶ Fullscreen</button>`
    : `<div class="no-image-text">
         <div class="np-title">${escapeHtml(post.title)}</div>
         <div class="np-desc">${escapeHtml(post.description || '')}</div>
       </div>`;

  card.innerHTML = `
    <div class="post-media ${post.imageData ? '' : 'no-image'}">${mediaHtml}</div>
    <div class="post-info">
      <div class="author">${escapeHtml(post.authorName || 'Anonymous')}</div>
      <div class="title">${escapeHtml(post.title)}</div>
      <div class="desc">${escapeHtml(post.description || '')}</div>
      <div class="timestamp">${time}</div>
      <div class="like-row">
        <button class="like-btn ${liked ? 'liked' : ''}" id="post-like-btn">
          ${liked ? '♥' : '♡'} <span id="post-like-count">${likeCount}</span>
        </button>
      </div>
    </div>
  `;
  postStage.appendChild(card);

  if (post.imageData) {
    card.querySelector('.post-media').addEventListener('click', () => openFullscreen(post.imageData));
  }

  card.querySelector('#post-like-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePostLike(post.id, liked);
  });

  loadComments(post.id);
}

async function togglePostLike(postId, currentlyLiked) {
  const ref = db.ref(`posts/${postId}/likes/${SESSION_UID}`);
  if (currentlyLiked) await ref.remove();
  else await ref.set(true);
}

// ===== Fullscreen image view =====
function openFullscreen(dataUrl) {
  fullscreenImg.src = dataUrl;
  fullscreenOverlay.classList.remove('hidden');
}
function closeFullscreen() {
  fullscreenOverlay.classList.add('hidden');
  fullscreenImg.src = '';
}
fullscreenCloseBtn.addEventListener('click', closeFullscreen);
fullscreenOverlay.addEventListener('click', (e) => {
  if (e.target === fullscreenOverlay) closeFullscreen();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !fullscreenOverlay.classList.contains('hidden')) closeFullscreen();
});

// ===== Comments =====
// Stored at /posts/{postId}/comments/{commentId} = { authorName, text, likes: {uid:true}, createdAt }
// Replies at /posts/{postId}/comments/{commentId}/replies/{replyId} = same shape

function detachComments() {
  if (commentsRef && commentsHandler) commentsRef.off('value', commentsHandler);
  commentsRef = null;
  commentsHandler = null;
  repliesUnsubs.forEach(({ ref, handler }) => ref.off('value', handler));
  repliesUnsubs = [];
}

function loadComments(postId) {
  detachComments();
  commentsRef = db.ref(`posts/${postId}/comments`).orderByChild('createdAt');
  commentsHandler = commentsRef.on('value', (snapshot) => {
    const val = snapshot.val() || {};
    const comments = Object.keys(val)
      .map(id => ({ id, ...val[id] }))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    commentsList.innerHTML = '';
    commentsCount.textContent = comments.length ? `(${comments.length})` : '';
    if (comments.length === 0) {
      commentsList.innerHTML = '<p style="color:#9a9a9a;font-size:13px;">No comments yet.</p>';
      return;
    }
    comments.forEach(c => renderComment(postId, c.id, c));
  });
}

function renderComment(postId, commentId, comment) {
  const el = document.createElement('div');
  el.className = 'comment';

  const likesObj = comment.likes || {};
  const likeCount = Object.keys(likesObj).length;
  const liked = !!likesObj[SESSION_UID];
  const time = comment.createdAt ? timeAgo(comment.createdAt) : 'now';

  el.innerHTML = `
    <div><span class="c-author">${escapeHtml(comment.authorName)}</span><span class="c-text">${escapeHtml(comment.text)}</span></div>
    <div class="c-meta">
      <span class="c-time">${time}</span>
      <button class="c-like-btn ${liked ? 'liked' : ''}">${liked ? '♥' : '♡'} ${likeCount}</button>
      <button class="c-reply-btn">Reply</button>
    </div>
    <div class="replies" id="replies-${commentId}"></div>
  `;

  el.querySelector('.c-like-btn').addEventListener('click', () => toggleCommentLike(postId, commentId, liked));
  el.querySelector('.c-reply-btn').addEventListener('click', () => showReplyForm(postId, commentId, el));

  commentsList.appendChild(el);

  // Load replies (one level only)
  const repliesRef = db.ref(`posts/${postId}/comments/${commentId}/replies`).orderByChild('createdAt');
  const repliesHandler = repliesRef.on('value', (snapshot) => {
    const val = snapshot.val() || {};
    const replies = Object.keys(val)
      .map(id => ({ id, ...val[id] }))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    const repliesEl = el.querySelector(`#replies-${commentId}`);
    if (!repliesEl) return; // comment element may have been re-rendered
    repliesEl.innerHTML = '';
    replies.forEach(r => renderReply(postId, commentId, r.id, r, repliesEl));
  });
  repliesUnsubs.push({ ref: repliesRef, handler: repliesHandler });
}

function renderReply(postId, commentId, replyId, reply, container) {
  const el = document.createElement('div');
  el.className = 'comment';
  const likesObj = reply.likes || {};
  const likeCount = Object.keys(likesObj).length;
  const liked = !!likesObj[SESSION_UID];
  const time = reply.createdAt ? timeAgo(reply.createdAt) : 'now';

  el.innerHTML = `
    <div><span class="c-author">${escapeHtml(reply.authorName)}</span><span class="c-text">${escapeHtml(reply.text)}</span></div>
    <div class="c-meta">
      <span class="c-time">${time}</span>
      <button class="c-like-btn ${liked ? 'liked' : ''}">${liked ? '♥' : '♡'} ${likeCount}</button>
    </div>
  `;
  el.querySelector('.c-like-btn').addEventListener('click', async () => {
    const ref = db.ref(`posts/${postId}/comments/${commentId}/replies/${replyId}/likes/${SESSION_UID}`);
    if (liked) await ref.remove();
    else await ref.set(true);
  });
  container.appendChild(el);
}

async function toggleCommentLike(postId, commentId, currentlyLiked) {
  const ref = db.ref(`posts/${postId}/comments/${commentId}/likes/${SESSION_UID}`);
  if (currentlyLiked) await ref.remove();
  else await ref.set(true);
}

function showReplyForm(postId, commentId, commentEl) {
  const existing = commentEl.querySelector('.reply-form');
  if (existing) { existing.remove(); return; }

  const form = document.createElement('form');
  form.className = 'reply-form';
  form.innerHTML = `
    <input type="text" placeholder="Reply as ${MY_NAME}..." maxlength="500" required>
    <button type="submit">Send</button>
  `;
  const replyStatusEl = document.createElement('div');
  replyStatusEl.style.cssText = 'color:#ff8a8a;font-size:11px;margin-left:16px;margin-top:4px;';
  form.after(replyStatusEl);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('input');
    const text = input.value.trim();
    if (!text) return;

    const wait = checkCooldown(lastReplyTime, REPLY_COOLDOWN_MS);
    if (wait !== null) {
      replyStatusEl.textContent = `Please wait ${wait}s before replying again.`;
      return;
    }

    await db.ref(`posts/${postId}/comments/${commentId}/replies`).push({
      authorName: MY_NAME,
      text,
      likes: {},
      createdAt: firebase.database.ServerValue.TIMESTAMP
    });
    lastReplyTime = Date.now();
    form.remove();
    replyStatusEl.remove();
  });
  commentEl.appendChild(form);
  form.querySelector('input').focus();
}

commentForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = commentInput.value.trim();
  if (!text || visiblePosts.length === 0) return;

  const wait = checkCooldown(lastCommentTime, COMMENT_COOLDOWN_MS);
  if (wait !== null) {
    showCommentCooldownMessage(wait);
    return;
  }

  const postId = visiblePosts[currentIndex].id;

  await db.ref(`posts/${postId}/comments`).push({
    authorName: MY_NAME,
    text,
    likes: {},
    createdAt: firebase.database.ServerValue.TIMESTAMP
  });
  lastCommentTime = Date.now();
  commentInput.value = '';
});

let commentCooldownMsgEl = null;
function showCommentCooldownMessage(seconds) {
  if (commentCooldownMsgEl) commentCooldownMsgEl.remove();
  commentCooldownMsgEl = document.createElement('div');
  commentCooldownMsgEl.style.cssText = 'color:#ff8a8a;font-size:12px;padding:0 16px 8px;';
  commentCooldownMsgEl.textContent = `Please wait ${seconds}s before commenting again.`;
  commentForm.parentElement.insertBefore(commentCooldownMsgEl, commentForm);
  setTimeout(() => { if (commentCooldownMsgEl) { commentCooldownMsgEl.remove(); commentCooldownMsgEl = null; } }, seconds * 1000);
}

// ===== New Post modal =====
newPostBtn.addEventListener('click', () => postModal.classList.remove('hidden'));
cancelPostBtn.addEventListener('click', closePostModal);

function closePostModal() {
  postModal.classList.add('hidden');
  titleInput.value = '';
  descInput.value = '';
  fileInput.value = '';
  fileLabelText.textContent = 'Attach image (optional)';
  previewImg.classList.add('hidden');
  postStatus.textContent = '';
  selectedImageDataUrl = null;
}

// Resize + compress the image client-side, then convert to a JPEG data URL.
// This keeps what we store in Realtime Database (base64, no Storage/Blaze
// needed) reasonably small — full camera photos would otherwise burn
// through the 1GB free quota fast.
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    postStatus.textContent = 'Please choose an image file.';
    fileInput.value = '';
    return;
  }

  const img = new Image();
  img.onload = () => {
    const ratio = img.width / img.height;
    if (ratio < MIN_ASPECT || ratio > MAX_ASPECT) {
      postStatus.textContent = `Image aspect ratio too extreme. Please crop it closer to square/standard proportions.`;
      fileInput.value = '';
      previewImg.classList.add('hidden');
      return;
    }

    // Resize down to MAX_IMAGE_DIMENSION on the longest side
    let { width, height } = img;
    if (width > height && width > MAX_IMAGE_DIMENSION) {
      height = Math.round(height * (MAX_IMAGE_DIMENSION / width));
      width = MAX_IMAGE_DIMENSION;
    } else if (height >= width && height > MAX_IMAGE_DIMENSION) {
      width = Math.round(width * (MAX_IMAGE_DIMENSION / height));
      height = MAX_IMAGE_DIMENSION;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);

    // Realtime Database has a 16MB per-node hard cap and this app has no
    // Storage fallback, so keep a sane ceiling on the stored size too.
    const approxBytes = Math.round((dataUrl.length * 3) / 4);
    if (approxBytes > 2 * 1024 * 1024) {
      postStatus.textContent = 'Image is still too large after compression — try a smaller or simpler image.';
      fileInput.value = '';
      previewImg.classList.add('hidden');
      return;
    }

    postStatus.textContent = '';
    selectedImageDataUrl = dataUrl;
    fileLabelText.textContent = file.name;
    previewImg.src = dataUrl;
    previewImg.classList.remove('hidden');
  };
  img.onerror = () => {
    postStatus.textContent = 'Could not read that image.';
    fileInput.value = '';
  };
  img.src = URL.createObjectURL(file);
});

submitPostBtn.addEventListener('click', async () => {
  const title = titleInput.value.trim();
  const description = descInput.value.trim();

  if (!title) {
    postStatus.textContent = 'Title is required.';
    return;
  }

  const wait = checkCooldown(lastPostTime, POST_COOLDOWN_MS);
  if (wait !== null) {
    postStatus.textContent = `Please wait ${wait}s before posting again.`;
    return;
  }

  submitPostBtn.disabled = true;
  postStatus.textContent = 'Posting...';

  try {
    await db.ref('posts').push({
      authorName: MY_NAME,
      title,
      description,
      imageData: selectedImageDataUrl || null,
      likes: {},
      createdAt: firebase.database.ServerValue.TIMESTAMP
    });

    lastPostTime = Date.now();
    closePostModal();
    currentIndex = 0; // jump to newest
  } catch (err) {
    console.error(err);
    postStatus.textContent = 'Post failed. Try again.';
  } finally {
    submitPostBtn.disabled = false;
  }
});

// ===== Helpers =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// Returns null if allowed, or the number of seconds remaining if still on cooldown.
function checkCooldown(lastTime, cooldownMs) {
  const elapsed = Date.now() - lastTime;
  if (elapsed >= cooldownMs) return null;
  return Math.ceil((cooldownMs - elapsed) / 1000);
}

function timeAgo(ms) {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
