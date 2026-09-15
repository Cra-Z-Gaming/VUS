// ===== Firebase refs =====
const db = firebase.firestore();
const storage = firebase.storage();

// ===== Config =====
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB
const MIN_ASPECT = 0.4;   // tallest allowed (portrait) ~ 2:5
const MAX_ASPECT = 2.5;   // widest allowed (landscape) ~ 5:2

// Client-side cooldowns to slow down accidental/rapid-fire spam.
// NOTE: this is enforced in the browser only, not on the server — since
// there's no auth, there's no real identity to rate-limit against. A
// determined person could bypass this by editing the JS. It still stops
// normal double-clicks and casual spam, which is what it's for.
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
// double-likes within the same tab session.
function getSessionUid() {
  let uid = sessionStorage.getItem('statik_session_uid');
  if (!uid) {
    uid = 'anon_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
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
let allPosts = [];      // full loaded post list (unfiltered)
let visiblePosts = [];  // after search filter applied
let currentIndex = 0;
let selectedFile = null;
let unsubscribeComments = null;

// ===== Load posts (real-time) =====
db.collection('posts').orderBy('createdAt', 'desc').limit(200)
  .onSnapshot((snapshot) => {
    allPosts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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

// ===== Navigation =====
prevBtn.addEventListener('click', () => goTo(currentIndex - 1));
nextBtn.addEventListener('click', () => goTo(currentIndex + 1));

document.addEventListener('keydown', (e) => {
  // Don't hijack arrow keys while typing in a text field
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.key === 'ArrowUp') { e.preventDefault(); goTo(currentIndex - 1); }
  if (e.key === 'ArrowDown') { e.preventDefault(); goTo(currentIndex + 1); }
});

// Scroll wheel on the viewer also navigates
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
    if (unsubscribeComments) unsubscribeComments();
    return;
  }
  emptyState.classList.add('hidden');

  const post = visiblePosts[currentIndex];
  postCounter.textContent = `${currentIndex + 1} / ${visiblePosts.length}`;
  prevBtn.disabled = currentIndex === 0;
  nextBtn.disabled = currentIndex === visiblePosts.length - 1;

  const card = document.createElement('div');
  card.className = 'post-card';

  const likes = post.likes || [];
  const liked = likes.includes(SESSION_UID);
  const time = post.createdAt ? post.createdAt.toDate().toLocaleString() : 'just now';

  const mediaHtml = post.imageURL
    ? `<img src="${escapeHtml(post.imageURL)}" alt="">
       <button class="expand-btn" id="expand-btn">⛶ Fullscreen</button>`
    : `<div class="no-image-text">
         <div class="np-title">${escapeHtml(post.title)}</div>
         <div class="np-desc">${escapeHtml(post.description || '')}</div>
       </div>`;

  card.innerHTML = `
    <div class="post-media ${post.imageURL ? '' : 'no-image'}">${mediaHtml}</div>
    <div class="post-info">
      <div class="author">${escapeHtml(post.authorName || 'Anonymous')}</div>
      <div class="title">${escapeHtml(post.title)}</div>
      <div class="desc">${escapeHtml(post.description || '')}</div>
      <div class="timestamp">${time}</div>
      <div class="like-row">
        <button class="like-btn ${liked ? 'liked' : ''}" id="post-like-btn">
          ${liked ? '♥' : '♡'} <span id="post-like-count">${likes.length}</span>
        </button>
      </div>
    </div>
  `;
  postStage.appendChild(card);

  if (post.imageURL) {
    card.querySelector('.post-media').addEventListener('click', (e) => {
      // Ignore clicks on the button itself doubling up
      openFullscreen(post.imageURL);
    });
  }

  card.querySelector('#post-like-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePostLike(post.id, likes);
  });

  loadComments(post.id);
}

async function togglePostLike(postId, currentLikes) {
  const ref = db.collection('posts').doc(postId);
  const alreadyLiked = currentLikes.includes(SESSION_UID);
  await ref.update({
    likes: alreadyLiked
      ? firebase.firestore.FieldValue.arrayRemove(SESSION_UID)
      : firebase.firestore.FieldValue.arrayUnion(SESSION_UID)
  });
}

// ===== Fullscreen image view =====
function openFullscreen(url) {
  fullscreenImg.src = url;
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
function loadComments(postId) {
  if (unsubscribeComments) unsubscribeComments();
  unsubscribeComments = db.collection('posts').doc(postId).collection('comments')
    .orderBy('createdAt', 'asc')
    .onSnapshot((snapshot) => {
      commentsList.innerHTML = '';
      commentsCount.textContent = snapshot.size ? `(${snapshot.size})` : '';
      if (snapshot.empty) {
        commentsList.innerHTML = '<p style="color:#9a9a9a;font-size:13px;">No comments yet.</p>';
        return;
      }
      snapshot.forEach(doc => renderComment(postId, doc.id, doc.data()));
    });
}

function renderComment(postId, commentId, comment) {
  const el = document.createElement('div');
  el.className = 'comment';

  const likes = comment.likes || [];
  const liked = likes.includes(SESSION_UID);
  const time = comment.createdAt ? timeAgo(comment.createdAt.toDate()) : 'now';

  el.innerHTML = `
    <div><span class="c-author">${escapeHtml(comment.authorName)}</span><span class="c-text">${escapeHtml(comment.text)}</span></div>
    <div class="c-meta">
      <span class="c-time">${time}</span>
      <button class="c-like-btn ${liked ? 'liked' : ''}" data-type="comment">${liked ? '♥' : '♡'} ${likes.length}</button>
      <button class="c-reply-btn">Reply</button>
    </div>
    <div class="replies" id="replies-${commentId}"></div>
  `;

  el.querySelector('.c-like-btn').addEventListener('click', () => toggleCommentLike(postId, commentId, likes));
  el.querySelector('.c-reply-btn').addEventListener('click', () => showReplyForm(postId, commentId, el));

  commentsList.appendChild(el);

  // Load replies (one level only)
  db.collection('posts').doc(postId).collection('comments').doc(commentId)
    .collection('replies').orderBy('createdAt', 'asc')
    .onSnapshot((snapshot) => {
      const repliesEl = el.querySelector(`#replies-${commentId}`);
      repliesEl.innerHTML = '';
      snapshot.forEach(doc => renderReply(postId, commentId, doc.id, doc.data(), repliesEl));
    });
}

function renderReply(postId, commentId, replyId, reply, container) {
  const el = document.createElement('div');
  el.className = 'comment';
  const likes = reply.likes || [];
  const liked = likes.includes(SESSION_UID);
  const time = reply.createdAt ? timeAgo(reply.createdAt.toDate()) : 'now';

  el.innerHTML = `
    <div><span class="c-author">${escapeHtml(reply.authorName)}</span><span class="c-text">${escapeHtml(reply.text)}</span></div>
    <div class="c-meta">
      <span class="c-time">${time}</span>
      <button class="c-like-btn ${liked ? 'liked' : ''}">${liked ? '♥' : '♡'} ${likes.length}</button>
    </div>
  `;
  el.querySelector('.c-like-btn').addEventListener('click', async () => {
    const ref = db.collection('posts').doc(postId).collection('comments').doc(commentId)
      .collection('replies').doc(replyId);
    const alreadyLiked = likes.includes(SESSION_UID);
    await ref.update({
      likes: alreadyLiked
        ? firebase.firestore.FieldValue.arrayRemove(SESSION_UID)
        : firebase.firestore.FieldValue.arrayUnion(SESSION_UID)
    });
  });
  container.appendChild(el);
}

async function toggleCommentLike(postId, commentId, currentLikes) {
  const ref = db.collection('posts').doc(postId).collection('comments').doc(commentId);
  const alreadyLiked = currentLikes.includes(SESSION_UID);
  await ref.update({
    likes: alreadyLiked
      ? firebase.firestore.FieldValue.arrayRemove(SESSION_UID)
      : firebase.firestore.FieldValue.arrayUnion(SESSION_UID)
  });
}

function showReplyForm(postId, commentId, commentEl) {
  // Remove any existing open reply form first
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

    await db.collection('posts').doc(postId).collection('comments').doc(commentId)
      .collection('replies').add({
        authorName: MY_NAME,
        text,
        likes: [],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
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

  await db.collection('posts').doc(postId).collection('comments').add({
    authorName: MY_NAME,
    text,
    likes: [],
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
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
  selectedFile = null;
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    postStatus.textContent = 'Please choose an image file.';
    fileInput.value = '';
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    postStatus.textContent = `Image too large. Max size is ${MAX_IMAGE_BYTES / (1024*1024)}MB.`;
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
    postStatus.textContent = '';
    selectedFile = file;
    fileLabelText.textContent = file.name;
    previewImg.src = URL.createObjectURL(file);
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
  postStatus.textContent = selectedFile ? 'Uploading image...' : 'Posting...';

  try {
    let imageURL = null;
    if (selectedFile) {
      const path = `posts/${Date.now()}_${Math.random().toString(36).slice(2)}_${selectedFile.name}`;
      const storageRef = storage.ref(path);
      await storageRef.put(selectedFile);
      imageURL = await storageRef.getDownloadURL();
    }

    await db.collection('posts').add({
      authorName: MY_NAME,
      title,
      description,
      imageURL,
      likes: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    lastPostTime = Date.now();
    closePostModal();
    currentIndex = 0; // jump to newest (posts are ordered desc)
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

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
