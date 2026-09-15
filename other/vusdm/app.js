/* ══════════════════════════════════════════════════════════
   FIREBASE CONFIG — same project as before.
   ══════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC_cxqIYzFcQ8nVTo679JuVEgIZDAyrPEQ",
  authDomain: "vus-dm.firebaseapp.com",
  databaseURL: "https://vus-dm-default-rtdb.firebaseio.com",
  projectId: "vus-dm",
  storageBucket: "vus-dm.firebasestorage.app",
  messagingSenderId: "768508136182",
  appId: "1:768508136182:web:abd44cb531dd2c43dd7ad7",
  measurementId: "G-H8CMTKZWJN"
};

/* Same plain-record auth tradeoff as before — see original project notes.
   Not real cryptographic auth. Security hardening explicitly out of scope
   for this pass. */

const USERNAME_MAX_LENGTH = 24;
const USERNAME_MIN_LENGTH = 3;
const ID_LENGTH = 6;
const ID_MIN = 100000;
const ID_MAX = 999999;
const SESSION_STORAGE_KEY = "dmAppSession";
const GC_MAX_MEMBERS = 20;
const SEND_DELAY_MS = 2000;
const TYPING_TIMEOUT_MS = 4000; // how long a typing flag lives before auto-expiring

let db = null;
let usersRef = null, usernameIndexRef = null, idIndexRef = null;
let presenceRef = null, connectedRef = null, myPresenceRef = null;
let dmsRef = null, groupChatsRef = null;

function initFirebase() {
  firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.database();
  usersRef = db.ref("users");
  usernameIndexRef = db.ref("usernameIndex");
  idIndexRef = db.ref("idIndex");
  presenceRef = db.ref("presence");
  connectedRef = db.ref(".info/connected");
  dmsRef = db.ref("dms");
  groupChatsRef = db.ref("groupChats");
}

function normalizeUsernameKey(username) { return username.trim().toLowerCase(); }
function isValidUsernameFormat(username) {
  return /^[a-zA-Z0-9_]+$/.test(username) && username.length >= USERNAME_MIN_LENGTH && username.length <= USERNAME_MAX_LENGTH;
}
function isLikelyId(identifier) { return /^[0-9]{6}$/.test(identifier.trim()); }
function randomSixDigitId() { return String(Math.floor(Math.random() * (ID_MAX - ID_MIN + 1)) + ID_MIN); }

async function generateUniqueId() {
  for (let attempt = 0; attempt < 15; attempt++) {
    const candidate = randomSixDigitId();
    const snap = await idIndexRef.child(candidate).get();
    if (!snap.exists()) return candidate;
  }
  throw new Error("Couldn't generate a unique ID right now — try again.");
}

async function createAccount(username, password) {
  const cleanUsername = username.trim();
  const usernameKey = normalizeUsernameKey(cleanUsername);
  if (!isValidUsernameFormat(cleanUsername)) {
    return { ok: false, error: "Username must be " + USERNAME_MIN_LENGTH + "-" + USERNAME_MAX_LENGTH + " characters: letters, numbers, or underscores only." };
  }
  if (!password || password.length < 4) return { ok: false, error: "Password must be at least 4 characters." };

  const existing = await usernameIndexRef.child(usernameKey).get();
  if (existing.exists()) return { ok: false, error: "That username is already taken." };

  let newId;
  try { newId = await generateUniqueId(); }
  catch (e) { return { ok: false, error: e.message || "Couldn't generate an ID — try again." }; }

  const accountRef = usersRef.push();
  const accountKey = accountRef.key;
  const accountData = {
    username: cleanUsername, usernameLower: usernameKey, id: newId, password: password,
    createdAt: firebase.database.ServerValue.TIMESTAMP,
    friends: {}, friendRequestsIncoming: {}, friendRequestsOutgoing: {}, blockedUsers: {}
  };

  try {
    const updates = {};
    updates["users/" + accountKey] = accountData;
    updates["usernameIndex/" + usernameKey] = accountKey;
    updates["idIndex/" + newId] = accountKey;
    await db.ref().update(updates);
  } catch (e) { return { ok: false, error: "Couldn't create your account — try again." }; }

  return { ok: true, accountKey, username: cleanUsername, id: newId };
}

async function findAccountKeyByIdentifier(identifier) {
  const clean = identifier.trim();
  if (isLikelyId(clean)) {
    const snap = await idIndexRef.child(clean).get();
    return snap.exists() ? snap.val() : null;
  }
  const usernameKey = normalizeUsernameKey(clean);
  const snap = await usernameIndexRef.child(usernameKey).get();
  return snap.exists() ? snap.val() : null;
}

async function login(identifier, password) {
  if (!identifier.trim() || !password) return { ok: false, error: "Enter your username/ID and password." };
  let accountKey;
  try { accountKey = await findAccountKeyByIdentifier(identifier); }
  catch (e) { return { ok: false, error: "Couldn't reach the server — try again." }; }
  if (!accountKey) return { ok: false, error: "No account found with that username or ID." };

  let accountSnap;
  try { accountSnap = await usersRef.child(accountKey).get(); }
  catch (e) { return { ok: false, error: "Couldn't reach the server — try again." }; }

  const account = accountSnap.val();
  if (!account || account.password !== password) return { ok: false, error: "Incorrect password." };
  return { ok: true, accountKey, username: account.username, id: account.id };
}

function saveSession(accountKey, username, id) {
  try { localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accountKey, username, id })); } catch (e) {}
}
function loadSession() {
  try { const raw = localStorage.getItem(SESSION_STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function clearSession() { try { localStorage.removeItem(SESSION_STORAGE_KEY); } catch (e) {} }

/* ── Presence, now with lastSeen written on release ── */
function claimPresence(accountKey, username) {
  releasePresence();
  myPresenceRef = presenceRef.child(accountKey);
  myPresenceRef.onDisconnect().remove();
  myPresenceRef.onDisconnect().update; // no-op placeholder kept minimal; lastSeen is best-effort (see releasePresence)
  myPresenceRef.set({ username: username, joinedAt: firebase.database.ServerValue.TIMESTAMP });
}
function releasePresence() {
  if (myPresenceRef) {
    myPresenceRef.onDisconnect().cancel();
    myPresenceRef.remove();
    myPresenceRef = null;
  }
}
// Best-effort "last seen" write — only fires on a clean logout, not on tab
// close/crash (a true last-seen-on-disconnect would need a Cloud Function
// or onDisconnect().update() on a *different* node, since onDisconnect
// only supports one terminal action per ref).
async function recordLastSeen(accountKey) {
  try { await usersRef.child(accountKey).child("lastSeen").set(firebase.database.ServerValue.TIMESTAMP); } catch (e) {}
}

function watchPresenceList(onList) {
  presenceRef.on("value", snap => {
    const val = snap.val() || {};
    const list = Object.entries(val).map(([key, v]) => ({
      accountKey: key, username: (v && v.username) || "Unknown", joinedAt: (v && v.joinedAt) || null
    }));
    onList(list);
  });
}

/* ══════════════════════════════════════════════════════════
   SEARCH + FRIEND REQUESTS + BLOCKING (unchanged from original)
   ══════════════════════════════════════════════════════════ */
async function searchByUsernamePrefix(prefix) {
  const lower = prefix.trim().toLowerCase();
  if (!lower) return [];
  const endBound = lower + "\uf8ff";
  const snap = await usernameIndexRef.orderByKey().startAt(lower).endAt(endBound).limitToFirst(20).get();
  const val = snap.val() || {};
  const entries = Object.entries(val);
  const accounts = await Promise.all(entries.map(([, accountKey]) => usersRef.child(accountKey).get()));
  return accounts.map((accSnap, i) => {
    const acc = accSnap.val();
    if (!acc) return null;
    return { accountKey: entries[i][1], username: acc.username, id: acc.id };
  }).filter(Boolean);
}
async function searchByExactId(idStr) {
  const clean = idStr.trim();
  if (!isLikelyId(clean)) return [];
  const snap = await idIndexRef.child(clean).get();
  if (!snap.exists()) return [];
  const accountKey = snap.val();
  const accountSnap = await usersRef.child(accountKey).get();
  const account = accountSnap.val();
  if (!account) return [];
  return [{ accountKey, username: account.username, id: account.id }];
}
async function performSearch(query) {
  const clean = query.trim();
  if (!clean) return [];
  if (isLikelyId(clean)) return searchByExactId(clean);
  return searchByUsernamePrefix(clean);
}

function getRelationshipStatus(otherAccountKey) {
  if (!currentUserData) return "unknown";
  if (currentSession && otherAccountKey === currentSession.accountKey) return "self";
  if (currentUserData.friends && currentUserData.friends[otherAccountKey]) return "friends";
  if (currentUserData.friendRequestsOutgoing && currentUserData.friendRequestsOutgoing[otherAccountKey]) return "outgoing";
  if (currentUserData.friendRequestsIncoming && currentUserData.friendRequestsIncoming[otherAccountKey]) return "incoming";
  return "none";
}

async function sendFriendRequest(toAccountKey, toUsername) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  if (toAccountKey === currentSession.accountKey) return { ok: false, error: "You can't friend yourself." };
  const status = getRelationshipStatus(toAccountKey);
  if (status === "friends") return { ok: false, error: "Already friends." };
  if (status === "outgoing") return { ok: false, error: "Request already pending." };

  let isHiddenForRecipient = false;
  try {
    const blockSnap = await usersRef.child(toAccountKey).child("blockedUsers").child(currentSession.accountKey).get();
    isHiddenForRecipient = blockSnap.exists();
  } catch (e) { isHiddenForRecipient = false; }

  const updates = {};
  updates["users/" + toAccountKey + "/friendRequestsIncoming/" + currentSession.accountKey] = {
    fromUsername: currentSession.username, sentAt: firebase.database.ServerValue.TIMESTAMP, hidden: isHiddenForRecipient
  };
  updates["users/" + currentSession.accountKey + "/friendRequestsOutgoing/" + toAccountKey] = {
    toUsername: toUsername, sentAt: firebase.database.ServerValue.TIMESTAMP
  };
  try { await db.ref().update(updates); return { ok: true }; }
  catch (e) { return { ok: false, error: "Couldn't send request — try again." }; }
}

async function acceptFriendRequest(fromAccountKey, fromUsername) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  const updates = {};
  updates["users/" + currentSession.accountKey + "/friendRequestsIncoming/" + fromAccountKey] = null;
  updates["users/" + fromAccountKey + "/friendRequestsOutgoing/" + currentSession.accountKey] = null;
  updates["users/" + currentSession.accountKey + "/friends/" + fromAccountKey] = { username: fromUsername, since: firebase.database.ServerValue.TIMESTAMP };
  updates["users/" + fromAccountKey + "/friends/" + currentSession.accountKey] = { username: currentSession.username, since: firebase.database.ServerValue.TIMESTAMP };
  try { await db.ref().update(updates); return { ok: true }; }
  catch (e) { return { ok: false, error: "Couldn't accept — try again." }; }
}

async function declineFriendRequest(fromAccountKey) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  const updates = {};
  updates["users/" + currentSession.accountKey + "/friendRequestsIncoming/" + fromAccountKey] = null;
  updates["users/" + fromAccountKey + "/friendRequestsOutgoing/" + currentSession.accountKey] = null;
  try { await db.ref().update(updates); return { ok: true }; }
  catch (e) { return { ok: false, error: "Couldn't decline — try again." }; }
}

async function cancelOutgoingRequest(toAccountKey) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  const updates = {};
  updates["users/" + currentSession.accountKey + "/friendRequestsOutgoing/" + toAccountKey] = null;
  updates["users/" + toAccountKey + "/friendRequestsIncoming/" + currentSession.accountKey] = null;
  try { await db.ref().update(updates); return { ok: true }; }
  catch (e) { return { ok: false, error: "Couldn't cancel — try again." }; }
}

async function unfriend(otherAccountKey) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  const updates = {};
  updates["users/" + currentSession.accountKey + "/friends/" + otherAccountKey] = null;
  updates["users/" + otherAccountKey + "/friends/" + currentSession.accountKey] = null;
  try { await db.ref().update(updates); return { ok: true }; }
  catch (e) { return { ok: false, error: "Couldn't unfriend — try again." }; }
}

async function blockUser(otherAccountKey, otherUsername) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  if (otherAccountKey === currentSession.accountKey) return { ok: false, error: "You can't block yourself." };
  const updates = {};
  updates["users/" + currentSession.accountKey + "/friends/" + otherAccountKey] = null;
  updates["users/" + otherAccountKey + "/friends/" + currentSession.accountKey] = null;
  updates["users/" + currentSession.accountKey + "/friendRequestsIncoming/" + otherAccountKey] = null;
  updates["users/" + otherAccountKey + "/friendRequestsOutgoing/" + currentSession.accountKey] = null;
  updates["users/" + currentSession.accountKey + "/friendRequestsOutgoing/" + otherAccountKey] = null;
  updates["users/" + otherAccountKey + "/friendRequestsIncoming/" + currentSession.accountKey] = null;
  updates["users/" + currentSession.accountKey + "/blockedUsers/" + otherAccountKey] = { username: otherUsername, blockedAt: firebase.database.ServerValue.TIMESTAMP };
  try { await db.ref().update(updates); return { ok: true }; }
  catch (e) { return { ok: false, error: "Couldn't block — try again." }; }
}

async function unblockUser(otherAccountKey) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  try { await usersRef.child(currentSession.accountKey).child("blockedUsers").child(otherAccountKey).remove(); return { ok: true }; }
  catch (e) { return { ok: false, error: "Couldn't unblock — try again." }; }
}

/* ══════════════════════════════════════════════════════════
   PROFILE — display name + small avatar image.
   Avatar is stored the same way message images are (compressed
   JPEG data URL directly on the account record) rather than via
   Firebase Storage, matching this project's existing no-Storage
   constraint. Kept small (64x64, low quality) on purpose — this
   gets fetched far more often than any single message image
   (every friend row, every online-list entry, every message
   header), so it needs to be cheap.
   ══════════════════════════════════════════════════════════ */
const AVATAR_MAX_DIMENSION = 64;
const AVATAR_JPEG_QUALITY = 0.55;

function compressAvatarFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          // Center-crop to a square first so avatars aren't squashed.
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2;
          const sy = (img.height - side) / 2;
          const canvas = document.createElement("canvas");
          canvas.width = AVATAR_MAX_DIMENSION;
          canvas.height = AVATAR_MAX_DIMENSION;
          const ctx = canvas.getContext("2d");
          if (!ctx) { reject(new Error("Couldn't process the image on this device.")); return; }
          ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_MAX_DIMENSION, AVATAR_MAX_DIMENSION);
          resolve(canvas.toDataURL("image/jpeg", AVATAR_JPEG_QUALITY));
        } catch (e) { reject(new Error("Couldn't process that image.")); }
      };
      img.onerror = () => reject(new Error("That file doesn't look like a valid image."));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

async function updateProfile(newUsername, newAvatarDataUrl) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  const updates = {};
  let usernameChanged = false;

  if (newUsername !== undefined && newUsername !== null) {
    const clean = newUsername.trim();
    if (!isValidUsernameFormat(clean)) {
      return { ok: false, error: "Name must be " + USERNAME_MIN_LENGTH + "-" + USERNAME_MAX_LENGTH + " characters: letters, numbers, or underscores only." };
    }
    if (clean !== currentSession.username) {
      const usernameKey = normalizeUsernameKey(clean);
      const existing = await usernameIndexRef.child(usernameKey).get();
      if (existing.exists()) return { ok: false, error: "That username is already taken." };
      updates["users/" + currentSession.accountKey + "/username"] = clean;
      updates["users/" + currentSession.accountKey + "/usernameLower"] = usernameKey;
      updates["usernameIndex/" + usernameKey] = currentSession.accountKey;
      updates["usernameIndex/" + normalizeUsernameKey(currentSession.username)] = null;
      usernameChanged = true;
    }
  }

  if (newAvatarDataUrl !== undefined) {
    updates["users/" + currentSession.accountKey + "/avatar"] = newAvatarDataUrl;
  }

  if (Object.keys(updates).length === 0) return { ok: true, username: currentSession.username };

  try {
    await db.ref().update(updates);
    if (usernameChanged) {
      currentSession.username = newUsername.trim();
      saveSession(currentSession.accountKey, currentSession.username, currentSession.id);
      // Presence and any friends' cached labels read from the account
      // record itself elsewhere, so the display name updates live for
      // them too — only our own local session object needs a manual bump.
      claimPresence(currentSession.accountKey, currentSession.username);
    }
    return { ok: true, username: currentSession.username };
  } catch (e) { return { ok: false, error: "Couldn't save — try again." }; }
}

async function changePassword(currentPassword, newPassword) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  if (!newPassword || newPassword.length < 4) return { ok: false, error: "New password must be at least 4 characters." };
  try {
    const snap = await usersRef.child(currentSession.accountKey).child("password").get();
    if (snap.val() !== currentPassword) return { ok: false, error: "Current password is incorrect." };
    await usersRef.child(currentSession.accountKey).child("password").set(newPassword);
    return { ok: true };
  } catch (e) { return { ok: false, error: "Couldn't change password — try again." }; }
}

let currentUserData = null;
function watchOwnAccount(accountKey, onChange) {
  usersRef.child(accountKey).on("value", snap => { currentUserData = snap.val(); onChange(currentUserData); });
}
function unwatchOwnAccount(accountKey) {
  if (accountKey) usersRef.child(accountKey).off("value");
  currentUserData = null;
}

/* ══════════════════════════════════════════════════════════
   DIRECT MESSAGES — now with reactions, edit, delete, replies,
   read-receipt tracking (lastRead per user per thread).
   ══════════════════════════════════════════════════════════ */
function threadIdFor(accountKeyA, accountKeyB) { return [accountKeyA, accountKeyB].sort().join("_"); }

async function sendDirectMessage(otherAccountKey, text, imageData, replyTo) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  const clean = (text || "").trim();
  if (!clean && !imageData) return { ok: false, error: "Message is empty." };
  const threadId = threadIdFor(currentSession.accountKey, otherAccountKey);
  try {
    const pushRef = dmsRef.child(threadId).child("messages").push();
    await pushRef.set({
      fromAccountKey: currentSession.accountKey,
      ...(clean ? { text: clean } : {}),
      ...(imageData ? { imageData: imageData } : {}),
      ...(replyTo ? { replyTo: replyTo.id, replyToLabel: replyTo.fromLabel, replyToSnippet: replyTo.snippet } : {}),
      ts: firebase.database.ServerValue.TIMESTAMP
    });
    // Mark our own thread as read up to the message we just sent.
    await markThreadRead(threadId, pushRef.key);
    return { ok: true };
  } catch (e) { return { ok: false, error: "Message failed to send — try again." }; }
}

async function editDirectMessage(threadId, messageId, newText) {
  const clean = (newText || "").trim();
  if (!clean) return { ok: false, error: "Message can't be empty." };
  try {
    await dmsRef.child(threadId).child("messages").child(messageId).update({ text: clean, editedAt: firebase.database.ServerValue.TIMESTAMP });
    return { ok: true };
  } catch (e) { return { ok: false, error: "Couldn't edit — try again." }; }
}
async function deleteDirectMessage(threadId, messageId) {
  try {
    await dmsRef.child(threadId).child("messages").child(messageId).update({ deleted: true, text: null, imageData: null });
    return { ok: true };
  } catch (e) { return { ok: false, error: "Couldn't delete — try again." }; }
}
async function toggleReaction(scopeRef, messageId, emoji) {
  if (!currentSession) return;
  const reactionRef = scopeRef.child("messages").child(messageId).child("reactions").child(emoji).child(currentSession.accountKey);
  try {
    const snap = await reactionRef.get();
    if (snap.exists()) await reactionRef.remove();
    else await reactionRef.set(true);
  } catch (e) { showComposerNotice("Couldn't react — try again."); }
}

async function markThreadRead(threadId, lastMessageId) {
  if (!currentSession || !lastMessageId) return;
  try {
    await dmsRef.child(threadId).child("reads").child(currentSession.accountKey).set(lastMessageId);
    unreadThreads.delete(threadId === openThreadId ? openChatAccountKey : threadId);
    if (currentUserData) renderFriendsList(currentUserData);
    if (myGroupChats.length) renderGroupsList(myGroupChats);
  } catch (e) {}
}

let currentThreadMessagesRef = null;
let currentThreadChangedRef = null;
function watchThreadMessages(otherAccountKey, onAdd, onChanged) {
  stopWatchingOpenChat();
  const threadId = threadIdFor(currentSession.accountKey, otherAccountKey);
  currentThreadMessagesRef = dmsRef.child(threadId).child("messages");
  currentThreadMessagesRef.limitToLast(200).on("child_added", snap => onAdd({ id: snap.key, ...snap.val() }));
  currentThreadChangedRef = currentThreadMessagesRef;
  currentThreadChangedRef.on("child_changed", snap => onChanged({ id: snap.key, ...snap.val() }));
  return threadId;
}
function stopWatchingOpenChat() {
  if (currentThreadMessagesRef) {
    currentThreadMessagesRef.off("child_added");
    if (currentThreadChangedRef) currentThreadChangedRef.off("child_changed");
    currentThreadMessagesRef = null;
    currentThreadChangedRef = null;
  }
  if (currentGroupMessagesRef) {
    currentGroupMessagesRef.off("child_added");
    currentGroupMessagesRef.off("child_changed");
    currentGroupMessagesRef = null;
  }
  unwatchTyping();
  unwatchThreadReads();
}

/* ── Typing indicators ──
   /dms/{threadId}/typing/{accountKey} = timestamp, self-expiring by the
   reader ignoring anything older than TYPING_TIMEOUT_MS, and actively
   cleared on blur/send/stop-typing so it doesn't linger. */
let typingRef = null;
let typingTimer = null;
function scopeTypingRef(isGroup, id) {
  return isGroup ? groupChatsRef.child(id).child("typing") : dmsRef.child(threadIdFor(currentSession.accountKey, id)).child("typing");
}
function setTyping(isGroup, id, isTyping) {
  if (!currentSession) return;
  const ref = scopeTypingRef(isGroup, id).child(currentSession.accountKey);
  if (isTyping) ref.set(firebase.database.ServerValue.TIMESTAMP);
  else ref.remove();
}
function watchTyping(isGroup, id, onChange) {
  unwatchTyping();
  typingRef = scopeTypingRef(isGroup, id);
  typingRef.on("value", snap => {
    const val = snap.val() || {};
    const now = Date.now();
    const activeUsernames = [];
    Object.entries(val).forEach(([key, ts]) => {
      if (key === currentSession.accountKey) return;
      if (typeof ts === "number" && now - ts < TYPING_TIMEOUT_MS) {
        const name = isGroup
          ? ((currentGroupInfo && currentGroupInfo.members && currentGroupInfo.members[key] && currentGroupInfo.members[key].username) || "Someone")
          : (openChatUsername || "Someone");
        activeUsernames.push(name);
      }
    });
    onChange(activeUsernames);
  });
}
function unwatchTyping() {
  if (typingRef) { typingRef.off("value"); typingRef = null; }
}

/* ── Read receipts (DM only — "Seen" under your own last message) ── */
let threadReadsRef = null;
function watchThreadReads(threadId, onChange) {
  unwatchThreadReads();
  threadReadsRef = dmsRef.child(threadId).child("reads");
  threadReadsRef.on("value", snap => onChange(snap.val() || {}));
}
function unwatchThreadReads() {
  if (threadReadsRef) { threadReadsRef.off("value"); threadReadsRef = null; }
}

/* ══════════════════════════════════════════════════════════
   GROUP CHATS — unchanged structurally, plus messages support
   the same edit/delete/reaction/reply fields as DMs.
   ══════════════════════════════════════════════════════════ */
async function createGroupChat(name) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Group name can't be empty." };
  if (clean.length > 40) return { ok: false, error: "Group name is too long." };
  const gcRef = groupChatsRef.push();
  const gcData = {
    name: clean, ownerAccountKey: currentSession.accountKey, createdAt: firebase.database.ServerValue.TIMESTAMP,
    members: { [currentSession.accountKey]: { username: currentSession.username, joinedAt: firebase.database.ServerValue.TIMESTAMP } }
  };
  try { await gcRef.set(gcData); return { ok: true, gcId: gcRef.key }; }
  catch (e) { return { ok: false, error: "Couldn't create the group — try again." }; }
}
async function inviteToGroupChat(gcId, friendAccountKey, friendUsername) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  let gcSnap;
  try { gcSnap = await groupChatsRef.child(gcId).get(); }
  catch (e) { return { ok: false, error: "Couldn't reach the server — try again." }; }
  const gc = gcSnap.val();
  if (!gc) return { ok: false, error: "Group no longer exists." };
  if (gc.ownerAccountKey !== currentSession.accountKey) return { ok: false, error: "Only the group owner can invite." };
  const members = gc.members || {};
  if (members[friendAccountKey]) return { ok: false, error: "Already in the group." };
  if (Object.keys(members).length >= GC_MAX_MEMBERS) return { ok: false, error: "Group is full (" + GC_MAX_MEMBERS + " max)." };
  try {
    await groupChatsRef.child(gcId).child("members").child(friendAccountKey).set({ username: friendUsername, joinedAt: firebase.database.ServerValue.TIMESTAMP });
    return { ok: true };
  } catch (e) { return { ok: false, error: "Couldn't invite — try again." }; }
}
async function kickFromGroupChat(gcId, targetAccountKey) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  let gcSnap;
  try { gcSnap = await groupChatsRef.child(gcId).get(); }
  catch (e) { return { ok: false, error: "Couldn't reach the server — try again." }; }
  const gc = gcSnap.val();
  if (!gc) return { ok: false, error: "Group no longer exists." };
  if (gc.ownerAccountKey !== currentSession.accountKey) return { ok: false, error: "Only the group owner can remove members." };
  if (targetAccountKey === currentSession.accountKey) return { ok: false, error: "Use transfer/leave instead of kicking yourself." };
  try { await groupChatsRef.child(gcId).child("members").child(targetAccountKey).remove(); return { ok: true }; }
  catch (e) { return { ok: false, error: "Couldn't remove member — try again." }; }
}
async function transferGroupOwnership(gcId, newOwnerAccountKey) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  let gcSnap;
  try { gcSnap = await groupChatsRef.child(gcId).get(); }
  catch (e) { return { ok: false, error: "Couldn't reach the server — try again." }; }
  const gc = gcSnap.val();
  if (!gc) return { ok: false, error: "Group no longer exists." };
  if (gc.ownerAccountKey !== currentSession.accountKey) return { ok: false, error: "Only the current owner can transfer ownership." };
  const members = gc.members || {};
  if (!members[newOwnerAccountKey]) return { ok: false, error: "That person isn't in the group." };
  try { await groupChatsRef.child(gcId).child("ownerAccountKey").set(newOwnerAccountKey); return { ok: true }; }
  catch (e) { return { ok: false, error: "Couldn't transfer ownership — try again." }; }
}
async function leaveGroupChat(gcId) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  let gcSnap;
  try { gcSnap = await groupChatsRef.child(gcId).get(); }
  catch (e) { return { ok: false, error: "Couldn't reach the server — try again." }; }
  const gc = gcSnap.val();
  if (!gc) return { ok: true };
  const members = gc.members || {};
  const isOwner = gc.ownerAccountKey === currentSession.accountKey;
  const remainingKeys = Object.keys(members).filter(k => k !== currentSession.accountKey);
  try {
    if (remainingKeys.length === 0) { await groupChatsRef.child(gcId).remove(); return { ok: true }; }
    const updates = {};
    updates["members/" + currentSession.accountKey] = null;
    if (isOwner) updates["ownerAccountKey"] = remainingKeys[Math.floor(Math.random() * remainingKeys.length)];
    await groupChatsRef.child(gcId).update(updates);
    return { ok: true };
  } catch (e) { return { ok: false, error: "Couldn't leave the group — try again." }; }
}
async function sendGroupMessage(gcId, text, imageData, replyTo) {
  if (!currentSession) return { ok: false, error: "Not logged in." };
  const clean = (text || "").trim();
  if (!clean && !imageData) return { ok: false, error: "Message is empty." };
  try {
    await groupChatsRef.child(gcId).child("messages").push({
      fromAccountKey: currentSession.accountKey, fromUsername: currentSession.username,
      ...(clean ? { text: clean } : {}), ...(imageData ? { imageData: imageData } : {}),
      ...(replyTo ? { replyTo: replyTo.id, replyToLabel: replyTo.fromLabel, replyToSnippet: replyTo.snippet } : {}),
      ts: firebase.database.ServerValue.TIMESTAMP
    });
    return { ok: true };
  } catch (e) { return { ok: false, error: "Message failed to send — try again." }; }
}
async function editGroupMessage(gcId, messageId, newText) {
  const clean = (newText || "").trim();
  if (!clean) return { ok: false, error: "Message can't be empty." };
  try {
    await groupChatsRef.child(gcId).child("messages").child(messageId).update({ text: clean, editedAt: firebase.database.ServerValue.TIMESTAMP });
    return { ok: true };
  } catch (e) { return { ok: false, error: "Couldn't edit — try again." }; }
}
async function deleteGroupMessage(gcId, messageId) {
  try {
    await groupChatsRef.child(gcId).child("messages").child(messageId).update({ deleted: true, text: null, imageData: null });
    return { ok: true };
  } catch (e) { return { ok: false, error: "Couldn't delete — try again." }; }
}

let currentGroupMessagesRef = null;
function watchGroupMessages(gcId, onAdd, onChanged) {
  stopWatchingOpenChat();
  currentGroupMessagesRef = groupChatsRef.child(gcId).child("messages");
  currentGroupMessagesRef.limitToLast(200).on("child_added", snap => onAdd({ id: snap.key, ...snap.val() }));
  currentGroupMessagesRef.on("child_changed", snap => onChanged({ id: snap.key, ...snap.val() }));
}

let currentGroupInfoRef = null;
let currentGroupInfo = null;
function watchGroupInfo(gcId, onChange) {
  unwatchGroupInfo();
  currentGroupInfoRef = groupChatsRef.child(gcId);
  currentGroupInfoRef.on("value", snap => { currentGroupInfo = snap.val(); onChange(currentGroupInfo); });
}
function unwatchGroupInfo() {
  if (currentGroupInfoRef) currentGroupInfoRef.off("value");
  currentGroupInfoRef = null;
  currentGroupInfo = null;
}

function watchMyGroupChats(onList) {
  groupChatsRef.on("value", snap => {
    const val = snap.val() || {};
    const mine = Object.entries(val)
      .filter(([, gc]) => gc.members && currentSession && gc.members[currentSession.accountKey])
      .map(([gcId, gc]) => ({ gcId, ...gc }));
    onList(mine);
  });
}
function unwatchMyGroupChats() { groupChatsRef.off("value"); }

/* ══════════════════════════════════════════════════════════
   IMAGES — unchanged compression pipeline.
   ══════════════════════════════════════════════════════════ */
const MAX_IMAGE_SOURCE_BYTES = 15 * 1024 * 1024;
const IMAGE_MAX_DIMENSION = 1000;
const IMAGE_JPEG_QUALITY = 0.7;

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(img.width, img.height));
          const width = Math.max(1, Math.round(img.width * scale));
          const height = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) { reject(new Error("Couldn't process the image on this device.")); return; }
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY));
        } catch (e) { reject(new Error("Couldn't process that image.")); }
      };
      img.onerror = () => reject(new Error("That file doesn't look like a valid image."));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

/* ══════════════════════════════════════════════════════════
   SMALL DOM HELPER — cuts down on manual createElement chains.
   h("div", {className:"x", onclick: fn}, "text", childEl, ...)
   ══════════════════════════════════════════════════════════ */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    Object.entries(props).forEach(([k, v]) => {
      if (k === "className") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") el.innerHTML = v;
      else if (v !== undefined && v !== null) el.setAttribute(k, v);
    });
  }
  children.flat().forEach(c => {
    if (c === null || c === undefined || c === false) return;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  });
  return el;
}

function esc(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Turns bare URLs into clickable links. Escapes first, then relinkifies —
// safe because esc() only produces entities, never raw "<"/">" that could
// be reopened by the URL regex.
const URL_RE = /(https?:\/\/[^\s<]+)/g;
function linkify(escapedText) {
  return escapedText.replace(URL_RE, url => {
    const trimmed = url.replace(/[),.]+$/, "");
    const trailing = url.slice(trimmed.length);
    return `<a href="${trimmed}" target="_blank" rel="noopener noreferrer">${trimmed}</a>${trailing}`;
  });
}

const QUICK_EMOJIS = ["😀","😂","😍","😅","😊","🙂","😉","😎","🤔","😢","😭","😡","👍","👎","👏","🙏","🔥","💯","❤️","💀","🎉","✅","❌","👀","😴","🥳","🤯","😬","🫡","🙃"];

function formatTimeShort(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}
function formatDateSeparator(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (isToday) return "Today";
  if (isYesterday) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}
function formatLastSeen(ts) {
  if (!ts) return "Offline";
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Last seen just now";
  if (mins < 60) return "Last seen " + mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return "Last seen " + hrs + "h ago";
  const days = Math.floor(hrs / 24);
  if (days < 7) return "Last seen " + days + "d ago";
  return "Last seen " + new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

/* ══════════════════════════════════════════════════════════
/* ══════════════════════════════════════════════════════════
   UI WIRING
   ══════════════════════════════════════════════════════════ */
const $authFlow = document.getElementById("authFlow");
const $appShell = document.getElementById("appShell");

const $rail = document.getElementById("rail");
const $railAvatarBtn = document.getElementById("railAvatarBtn");
const $railSettingsBtn = document.getElementById("railSettingsBtn");
const $navChats = document.getElementById("navChats");
const $navFind = document.getElementById("navFind");
const $navBlocked = document.getElementById("navBlocked");
const $findRailDot = document.getElementById("findRailDot");

const $profilePopover = document.getElementById("profilePopover");
const $profileAvatarPreviewBtn = document.getElementById("profileAvatarPreviewBtn");
const $profileAvatarFileInput = document.getElementById("profileAvatarFileInput");
const $profileNameInput = document.getElementById("profileNameInput");
const $profileSaveBtn = document.getElementById("profileSaveBtn");
const $profilePopoverError = document.getElementById("profilePopoverError");

const $listPaneYouName = document.getElementById("listPaneYouName");
const $listPaneYouId = document.getElementById("listPaneYouId");
const $viewChats = document.getElementById("viewChats");
const $viewFind = document.getElementById("viewFind");
const $viewBlocked = document.getElementById("viewBlocked");

const $chatEmptyState = document.getElementById("chatEmptyState");
const $chatThread = document.getElementById("chatThread");
const $chatBackBtn = document.getElementById("chatBackBtn");
const $chatThreadAvatar = document.getElementById("chatThreadAvatar");
const $chatThreadPresenceBadge = document.getElementById("chatThreadPresenceBadge");
const $chatThreadHeaderName = document.getElementById("chatThreadHeaderName");
const $chatThreadHeaderStatus = document.getElementById("chatThreadHeaderStatus");
const $chatMessages = document.getElementById("chatMessages");
const $typingIndicatorBar = document.getElementById("typingIndicatorBar");
const $replyPreviewBar = document.getElementById("replyPreviewBar");
const $replyPreviewText = document.getElementById("replyPreviewText");
const $cancelReplyBtn = document.getElementById("cancelReplyBtn");
const $editingBar = document.getElementById("editingBar");
const $cancelEditBtn = document.getElementById("cancelEditBtn");
const $chatMsgInput = document.getElementById("chatMsgInput");
const $chatSendBtn = document.getElementById("chatSendBtn");
const $uploadImageBtn = document.getElementById("uploadImageBtn");
const $imageFileInput = document.getElementById("imageFileInput");
const $pendingImageBar = document.getElementById("pendingImageBar");
const $pendingImagePreview = document.getElementById("pendingImagePreview");
const $cancelPendingImageBtn = document.getElementById("cancelPendingImageBtn");
const $emojiPickerBtn = document.getElementById("emojiPickerBtn");
const $emojiPickerPopover = document.getElementById("emojiPickerPopover");
const $imageLightbox = document.getElementById("imageLightbox");
const $imageLightboxImg = document.getElementById("imageLightboxImg");

const $tabLogin = document.getElementById("tabLogin");
const $tabSignup = document.getElementById("tabSignup");
const $loginFields = document.getElementById("loginFields");
const $signupFields = document.getElementById("signupFields");
const $authForm = document.getElementById("authForm");
const $authSubmitBtn = document.getElementById("authSubmitBtn");
const $authError = document.getElementById("authError");
const $authSuccess = document.getElementById("authSuccess");

const $loginIdentifier = document.getElementById("loginIdentifier");
const $loginPassword = document.getElementById("loginPassword");
const $signupUsername = document.getElementById("signupUsername");
const $signupPassword = document.getElementById("signupPassword");
const $signupPasswordConfirm = document.getElementById("signupPasswordConfirm");

const $newIdReveal = document.getElementById("newIdReveal");
const $revealedId = document.getElementById("revealedId");
const $newIdContinueBtn = document.getElementById("newIdContinueBtn");

const $onlineCountText = document.getElementById("onlineCountText");
const $onlineList = document.getElementById("onlineList");
const $onlineEmpty = document.getElementById("onlineEmpty");

const $searchInput = document.getElementById("searchInput");
const $searchBtn = document.getElementById("searchBtn");
const $searchResults = document.getElementById("searchResults");
const $searchEmpty = document.getElementById("searchEmpty");

const $incomingRequestsList = document.getElementById("incomingRequestsList");
const $incomingRequestsEmpty = document.getElementById("incomingRequestsEmpty");
const $incomingCountBadge = document.getElementById("incomingCountBadge");
const $hiddenRequestsList = document.getElementById("hiddenRequestsList");
const $hiddenRequestsEmpty = document.getElementById("hiddenRequestsEmpty");
const $hiddenCountBadge = document.getElementById("hiddenCountBadge");
const $outgoingRequestsList = document.getElementById("outgoingRequestsList");
const $outgoingRequestsEmpty = document.getElementById("outgoingRequestsEmpty");
const $friendsList = document.getElementById("friendsList");
const $friendsEmpty = document.getElementById("friendsEmpty");
const $blockedList = document.getElementById("blockedList");
const $blockedEmpty = document.getElementById("blockedEmpty");

const $newGroupBtn = document.getElementById("newGroupBtn");
const $groupsList = document.getElementById("groupsList");
const $groupsEmpty = document.getElementById("groupsEmpty");
const $groupInfoBtn = document.getElementById("groupInfoBtn");
const $modalOverlay = document.getElementById("modalOverlay");
const $modalBox = document.getElementById("modalBox");

let mode = "login";
let currentSession = null;

function setMode(newMode) {
  mode = newMode;
  $authError.textContent = "";
  $authSuccess.style.display = "none";
  $newIdReveal.style.display = "none";
  $authForm.style.display = "flex";
  $authForm.style.flexDirection = "column";
  $authForm.style.gap = "12px";
  if (mode === "login") {
    $tabLogin.classList.add("active"); $tabSignup.classList.remove("active");
    $loginFields.style.display = "flex"; $signupFields.style.display = "none";
    $authSubmitBtn.textContent = "Log In";
  } else {
    $tabSignup.classList.add("active"); $tabLogin.classList.remove("active");
    $loginFields.style.display = "none"; $signupFields.style.display = "flex";
    $authSubmitBtn.textContent = "Sign Up";
  }
}
$tabLogin.addEventListener("click", () => setMode("login"));
$tabSignup.addEventListener("click", () => setMode("signup"));

let composerNoticeTimer = null;
function showComposerNotice(text) {
  $authError.textContent = text;
  clearTimeout(composerNoticeTimer);
  composerNoticeTimer = setTimeout(() => { $authError.textContent = ""; }, 4000);
}

/* ── Avatar rendering helper ──
   Renders either an <img> (if the account has an avatar data URL) or a
   plain initials circle, sharing one code path so every surface (rail,
   list rows, thread header, profile popover) stays visually consistent
   without needing to special-case "has avatar or not" at every call site. */
function renderAvatarInto(container, username, avatarDataUrl) {
  container.innerHTML = "";
  if (avatarDataUrl) {
    const img = document.createElement("img");
    img.src = avatarDataUrl;
    img.alt = "";
    container.appendChild(img);
  } else {
    container.textContent = initialsFor(username);
  }
}
function initialsFor(username) { return (username || "?").trim().slice(0, 1).toUpperCase(); }

/* Lazy cache of other accounts' avatars, fetched on demand (friend list
   render, thread open) rather than denormalized onto friend records —
   keeps a changed avatar visible everywhere immediately without needing
   to re-sync every place that ever cached the old one. */
let otherAvatarCache = {};
async function fetchAndCacheAvatar(accountKey, onLoaded) {
  if (accountKey in otherAvatarCache) { onLoaded(otherAvatarCache[accountKey]); return; }
  try {
    const snap = await usersRef.child(accountKey).child("avatar").get();
    otherAvatarCache[accountKey] = snap.val() || null;
  } catch (e) { otherAvatarCache[accountKey] = null; }
  onLoaded(otherAvatarCache[accountKey]);
}

/* ══════════════════════════════════════════════════════════
   RAIL NAV — Chats / Find / Blocked, replaces the old tab bar.
   ══════════════════════════════════════════════════════════ */
function setListView(view) {
  $navChats.classList.toggle("active", view === "chats");
  $navFind.classList.toggle("active", view === "find");
  $navBlocked.classList.toggle("active", view === "blocked");
  $viewChats.classList.toggle("active", view === "chats");
  $viewFind.classList.toggle("active", view === "find");
  $viewBlocked.classList.toggle("active", view === "blocked");
}
$navChats.addEventListener("click", () => setListView("chats"));
$navFind.addEventListener("click", () => setListView("find"));
$navBlocked.addEventListener("click", () => setListView("blocked"));

function updateFindRailDot(userData) {
  const incoming = (userData && userData.friendRequestsIncoming) || {};
  const visibleCount = Object.values(incoming).filter(r => !r.hidden).length;
  $findRailDot.classList.toggle("show", visibleCount > 0);
}

/* ══════════════════════════════════════════════════════════
   PROFILE POPOVER — avatar click: photo + display name only.
   ══════════════════════════════════════════════════════════ */
let pendingAvatarDataUrl = null; // staged new avatar, not yet saved

// Redraws the profile popover's avatar button — used both when opening
// the popover and after staging a newly picked photo. Centralized here
// because renderAvatarInto() clears the button's innerHTML, which would
// otherwise wipe out the little camera badge every time.
function renderProfileAvatarButton(avatarDataUrl) {
  renderAvatarInto($profileAvatarPreviewBtn, currentSession.username, avatarDataUrl);
  const camBadge = document.createElement("span");
  camBadge.className = "avatar-cam-badge";
  camBadge.textContent = "📷";
  $profileAvatarPreviewBtn.appendChild(camBadge);
}

function openProfilePopover() {
  pendingAvatarDataUrl = null;
  $profilePopoverError.textContent = "";
  $profileNameInput.value = currentSession ? currentSession.username : "";
  renderProfileAvatarButton(currentUserData && currentUserData.avatar);
  $profilePopover.classList.add("show");
}
function closeProfilePopover() { $profilePopover.classList.remove("show"); }

$railAvatarBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if ($profilePopover.classList.contains("show")) closeProfilePopover();
  else openProfilePopover();
});
document.addEventListener("click", (e) => {
  if ($profilePopover.classList.contains("show") && !$profilePopover.contains(e.target) && e.target !== $railAvatarBtn) {
    closeProfilePopover();
  }
});
$profileAvatarPreviewBtn.addEventListener("click", () => $profileAvatarFileInput.click());
$profileAvatarFileInput.addEventListener("change", async () => {
  const file = $profileAvatarFileInput.files[0];
  $profileAvatarFileInput.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) { $profilePopoverError.textContent = "That file isn't an image."; return; }
  try {
    pendingAvatarDataUrl = await compressAvatarFile(file);
    renderProfileAvatarButton(pendingAvatarDataUrl);
  } catch (e) { $profilePopoverError.textContent = e.message || "Couldn't process that image."; }
});
$profileSaveBtn.addEventListener("click", async () => {
  $profileSaveBtn.disabled = true;
  $profilePopoverError.textContent = "";
  const result = await updateProfile($profileNameInput.value, pendingAvatarDataUrl !== null ? pendingAvatarDataUrl : undefined);
  $profileSaveBtn.disabled = false;
  if (!result.ok) { $profilePopoverError.textContent = result.error; return; }
  pendingAvatarDataUrl = null;
  closeProfilePopover();
  refreshOwnRailAvatar();
});

function refreshOwnRailAvatar() {
  if (!currentSession) return;
  renderAvatarInto($railAvatarBtn, currentSession.username, currentUserData && currentUserData.avatar);
}

/* ══════════════════════════════════════════════════════════
   SETTINGS MODAL — gear icon: password change + logout.
   ══════════════════════════════════════════════════════════ */
function openSettingsModal() {
  $modalBox.innerHTML = "";
  $modalBox.appendChild(h("h3", {}, "Settings"));

  const pwFields = h("div", { className: "settings-password-fields" },
    h("input", { type: "password", id: "settingsCurrentPw", placeholder: "Current password" }),
    h("input", { type: "password", id: "settingsNewPw", placeholder: "New password" }),
    h("input", { type: "password", id: "settingsNewPwConfirm", placeholder: "Confirm new password" })
  );
  const pwError = h("div", { className: "modal-error" });
  const pwSaveBtn = h("button", { className: "primary-btn", onclick: async () => {
    const curPw = document.getElementById("settingsCurrentPw").value;
    const newPw = document.getElementById("settingsNewPw").value;
    const confirmPw = document.getElementById("settingsNewPwConfirm").value;
    if (newPw !== confirmPw) { pwError.textContent = "New passwords don't match."; return; }
    pwSaveBtn.disabled = true;
    const result = await changePassword(curPw, newPw);
    pwSaveBtn.disabled = false;
    if (!result.ok) { pwError.textContent = result.error; return; }
    pwError.textContent = "";
    pwFields.classList.remove("show");
    pwActionsRow.style.display = "none";
    passwordRow.textContent = "Change password";
    document.getElementById("settingsCurrentPw").value = "";
    document.getElementById("settingsNewPw").value = "";
    document.getElementById("settingsNewPwConfirm").value = "";
  }}, "Save password");
  const pwActionsRow = h("div", { className: "modal-actions", style: "display:none" }, pwSaveBtn);

  const passwordRow = h("div", { className: "settings-row", onclick: () => {
    const opening = !pwFields.classList.contains("show");
    pwFields.classList.toggle("show");
    pwActionsRow.style.display = opening ? "flex" : "none";
    passwordRow.textContent = opening ? "Change password ▾" : "Change password";
  }}, "Change password");

  const logoutRow = h("div", { className: "settings-row danger-row", onclick: doLogout }, "Log out");

  $modalBox.appendChild(passwordRow);
  $modalBox.appendChild(pwFields);
  $modalBox.appendChild(pwError);
  $modalBox.appendChild(pwActionsRow);
  $modalBox.appendChild(logoutRow);
  $modalBox.appendChild(h("div", { className: "modal-actions" }, h("button", { className: "plain-link", onclick: closeModal }, "Close")));

  $modalOverlay.classList.add("show");
}
$railSettingsBtn.addEventListener("click", openSettingsModal);

async function doLogout() {
  const accountKey = currentSession && currentSession.accountKey;
  releasePresence();
  if (accountKey) await recordLastSeen(accountKey);
  stopUnreadWatchers();
  unwatchOwnAccount(accountKey);
  unwatchMyGroupChats();
  unwatchGroupInfo();
  clearPendingImage();
  closeOpenChat();
  closeModal();
  closeProfilePopover();
  otherAvatarCache = {};
  currentSession = null;
  clearSession();
  showAuthFlow();
  setMode("login");
  $loginIdentifier.value = "";
  $loginPassword.value = "";
}

function renderOnlineList(list) {
  latestPresenceAccountKeys = new Set(list.map(e => e.accountKey));
  $onlineCountText.textContent = list.length + " online";
  $onlineList.innerHTML = "";
  const sorted = [...list].sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  if (sorted.length === 0) {
    $onlineEmpty.style.display = "block";
  } else {
    $onlineEmpty.style.display = "none";
    sorted.forEach(entry => {
      const isMe = currentSession && entry.accountKey === currentSession.accountKey;
      $onlineList.appendChild(h("div", { style: "display:flex;align-items:center;gap:8px;font-size:12.5px;padding:3px 0" },
        h("span", { style: "width:6px;height:6px;border-radius:50%;background:#22c55e;flex-shrink:0" }),
        h("span", {}, entry.username),
        isMe ? h("span", { style: "color:#475569;font-size:11px" }, "(you)") : null
      ));
    });
  }
  if (currentUserData) renderFriendsList(currentUserData);
  if (openChatAccountKey) updateChatThreadHeaderStatus();
}

let lastSearchResults = [];
function renderSearchResults(results) {
  lastSearchResults = results;
  $searchResults.innerHTML = "";
  if (results.length === 0) { $searchEmpty.style.display = "block"; return; }
  $searchEmpty.style.display = "none";

  results.forEach(person => {
    const status = getRelationshipStatus(person.accountKey);
    let btn;
    if (status === "self") btn = h("button", { className: "find-action-btn plain", disabled: true }, "You");
    else if (status === "friends") btn = h("button", { className: "find-action-btn plain", disabled: true }, "Friends");
    else if (status === "outgoing") btn = h("button", { className: "find-action-btn plain", disabled: true }, "Pending");
    else if (status === "incoming") btn = h("button", { className: "find-action-btn plain", disabled: true }, "Respond below");
    else {
      btn = h("button", { className: "find-action-btn primary", onclick: async () => {
        btn.disabled = true; btn.textContent = "Sending…";
        const result = await sendFriendRequest(person.accountKey, person.username);
        if (!result.ok) { showComposerNotice(result.error); btn.disabled = false; btn.textContent = "Add friend"; }
      }}, "Add friend");
    }
    $searchResults.appendChild(h("div", { className: "find-person-row" },
      h("div", {},
        h("div", { className: "find-person-name" }, person.username),
        h("div", { className: "find-person-id" }, "#" + person.id)
      ),
      btn
    ));
  });
}

function buildIncomingRequestRow(fromAccountKey, req) {
  let acceptBtn, declineBtn, blockBtn;
  function setRowButtonsDisabled(disabled) { acceptBtn.disabled = disabled; declineBtn.disabled = disabled; blockBtn.disabled = disabled; }

  acceptBtn = h("button", { className: "find-action-btn primary", onclick: async () => {
    setRowButtonsDisabled(true);
    const result = await acceptFriendRequest(fromAccountKey, req.fromUsername);
    if (!result.ok) { showComposerNotice(result.error); setRowButtonsDisabled(false); }
  }}, "Accept");
  declineBtn = h("button", { className: "find-action-btn plain", onclick: async () => {
    setRowButtonsDisabled(true);
    const result = await declineFriendRequest(fromAccountKey);
    if (!result.ok) { showComposerNotice(result.error); setRowButtonsDisabled(false); }
  }}, "Decline");
  blockBtn = h("button", { className: "find-action-btn danger", onclick: async () => {
    setRowButtonsDisabled(true);
    const result = await blockUser(fromAccountKey, req.fromUsername);
    if (!result.ok) { showComposerNotice(result.error); setRowButtonsDisabled(false); }
  }}, "Block");

  return h("div", { className: "find-person-row" },
    h("div", { className: "find-person-name" }, req.fromUsername),
    h("div", { style: "display:flex;gap:8px" }, acceptBtn, declineBtn, blockBtn)
  );
}

function renderIncomingRequests(userData) {
  const incoming = (userData && userData.friendRequestsIncoming) || {};
  const visible = Object.entries(incoming).filter(([, req]) => !req.hidden);
  const hidden = Object.entries(incoming).filter(([, req]) => req.hidden);

  $incomingRequestsList.innerHTML = "";
  if (visible.length === 0) { $incomingRequestsEmpty.style.display = "block"; $incomingCountBadge.style.display = "none"; }
  else { $incomingRequestsEmpty.style.display = "none"; $incomingCountBadge.style.display = "inline-block"; $incomingCountBadge.textContent = visible.length; }
  visible.forEach(([fromAccountKey, req]) => $incomingRequestsList.appendChild(buildIncomingRequestRow(fromAccountKey, req)));

  $hiddenRequestsList.innerHTML = "";
  if (hidden.length === 0) { $hiddenRequestsEmpty.style.display = "block"; $hiddenCountBadge.style.display = "none"; }
  else { $hiddenRequestsEmpty.style.display = "none"; $hiddenCountBadge.style.display = "inline-block"; $hiddenCountBadge.textContent = hidden.length; }
  hidden.forEach(([fromAccountKey, req]) => $hiddenRequestsList.appendChild(buildIncomingRequestRow(fromAccountKey, req)));
}

function renderOutgoingRequests(userData) {
  const outgoing = (userData && userData.friendRequestsOutgoing) || {};
  const entries = Object.entries(outgoing);
  $outgoingRequestsList.innerHTML = "";
  $outgoingRequestsEmpty.style.display = entries.length === 0 ? "block" : "none";

  entries.forEach(([toAccountKey, req]) => {
    const cancelBtn = h("button", { className: "find-action-btn plain", onclick: async () => {
      cancelBtn.disabled = true;
      const result = await cancelOutgoingRequest(toAccountKey);
      if (!result.ok) { showComposerNotice(result.error); cancelBtn.disabled = false; }
    }}, "Cancel");
    $outgoingRequestsList.appendChild(h("div", { className: "find-person-row" },
      h("div", {},
        h("div", { className: "find-person-name" }, req.toUsername),
        h("div", { className: "find-person-id" }, "pending…")
      ),
      cancelBtn
    ));
  });
}

let latestPresenceAccountKeys = new Set();

function buildAvatarWithPresence(username, accountKey, isGroup) {
  const wrap = h("div", { className: "list-row-presence-wrap" });
  const avatar = h("div", { className: "list-row-avatar" + (isGroup ? " group-avatar" : "") });
  if (isGroup) {
    avatar.textContent = "👥";
  } else {
    avatar.textContent = initialsFor(username);
    fetchAndCacheAvatar(accountKey, (avatarUrl) => { if (avatarUrl) renderAvatarInto(avatar, username, avatarUrl); });
  }
  wrap.appendChild(avatar);
  if (!isGroup) {
    const dot = h("div", { className: "list-row-presence-dot" + (latestPresenceAccountKeys.has(accountKey) ? " online" : "") });
    wrap.appendChild(dot);
  }
  return wrap;
}

let myGroupChats = [];
let unreadThreads = new Set();
let threadLastReadState = {};
const unreadWatchers = new Map();

function isThreadOpen(threadKey, isGroup) {
  return isGroup ? openChatGcId === threadKey : openChatAccountKey === threadKey;
}

function updateUnreadThread(threadKey, isGroup) {
  const watcher = unreadWatchers.get(threadKey);
  const latest = watcher && watcher.latest;
  const isUnread = !!latest
    && latest.fromAccountKey !== currentSession.accountKey
    && (!watcher.lastReadId || latest.id > watcher.lastReadId)
    && !isThreadOpen(threadKey, isGroup);
  if (isUnread) unreadThreads.add(threadKey);
  else unreadThreads.delete(threadKey);
  if (currentUserData) renderFriendsList(currentUserData);
  if (myGroupChats.length) renderGroupsList(myGroupChats);
}

function syncUnreadWatchers() {
  if (!currentSession) return;
  const desired = new Map();
  const friends = (currentUserData && currentUserData.friends) || {};
  Object.keys(friends).forEach(accountKey => desired.set(accountKey, { isGroup: false }));
  myGroupChats.forEach(group => desired.set(group.gcId, { isGroup: true }));

  unreadWatchers.forEach((watcher, threadKey) => {
    if (desired.has(threadKey)) return;
    watcher.messagesRef.off("value", watcher.onMessages);
    watcher.readRef.off("value", watcher.onRead);
    unreadWatchers.delete(threadKey);
    unreadThreads.delete(threadKey);
  });

  desired.forEach(({ isGroup }, threadKey) => {
    if (unreadWatchers.has(threadKey)) return;
    const root = isGroup ? groupChatsRef.child(threadKey) : dmsRef.child(threadIdFor(currentSession.accountKey, threadKey));
    const watcher = {
      latest: null,
      lastReadId: null,
      messagesRef: root.child("messages").limitToLast(1),
      readRef: root.child("reads").child(currentSession.accountKey)
    };
    watcher.onMessages = snap => {
      let latest = null;
      snap.forEach(child => { latest = { id: child.key, ...child.val() }; });
      watcher.latest = latest;
      updateUnreadThread(threadKey, isGroup);
    };
    watcher.onRead = snap => {
      watcher.lastReadId = snap.val() || null;
      updateUnreadThread(threadKey, isGroup);
    };
    unreadWatchers.set(threadKey, watcher);
    watcher.messagesRef.on("value", watcher.onMessages);
    watcher.readRef.on("value", watcher.onRead);
  });
}

function stopUnreadWatchers() {
  unreadWatchers.forEach(watcher => {
    watcher.messagesRef.off("value", watcher.onMessages);
    watcher.readRef.off("value", watcher.onRead);
  });
  unreadWatchers.clear();
  unreadThreads.clear();
}

function renderGroupsList(groups) {
  myGroupChats = groups;
  syncUnreadWatchers();
  $groupsList.innerHTML = "";
  $groupsEmpty.style.display = groups.length === 0 ? "block" : "none";

  groups.forEach(gc => {
    const count = Object.keys(gc.members || {}).length;
    const isUnread = unreadThreads.has(gc.gcId);
    const row = h("div", { className: "list-row" + (openChatGcId === gc.gcId ? " selected" : "") + (isUnread ? " has-unread" : ""), onclick: () => openGroupChat(gc.gcId) },
      buildAvatarWithPresence(gc.name, gc.gcId, true),
      h("div", { className: "list-row-info" },
        h("div", { className: "list-row-name" }, gc.name),
        h("div", { className: "list-row-sub" }, count + " member" + (count === 1 ? "" : "s")),
        h("div", { className: "list-row-unread-dot" })
      )
    );
    $groupsList.appendChild(row);
    if (openChatGcId === gc.gcId) currentGroupInfo = gc;
  });

  if (openChatGcId && !groups.some(g => g.gcId === openChatGcId)) closeOpenChat();
}

function renderFriendsList(userData) {
  currentUserData = userData;
  syncUnreadWatchers();
  const friends = (userData && userData.friends) || {};
  const entries = Object.entries(friends);
  $friendsList.innerHTML = "";
  $friendsEmpty.style.display = entries.length === 0 ? "block" : "none";

  entries.forEach(([friendAccountKey, friendData]) => {
    const isUnread = unreadThreads.has(friendAccountKey);
    const isOnline = latestPresenceAccountKeys.has(friendAccountKey);
    const row = h("div", { className: "list-row" + (openChatAccountKey === friendAccountKey ? " selected" : "") + (isUnread ? " has-unread" : ""), onclick: () => openChatWith(friendAccountKey, friendData.username) },
      buildAvatarWithPresence(friendData.username, friendAccountKey, false),
      h("div", { className: "list-row-info" },
        h("div", { className: "list-row-name" }, friendData.username),
        h("div", { className: "list-row-sub" }, isOnline ? "online" : "offline")
      ),
      h("div", { className: "list-row-unread-dot" })
    );

    const actionsRow = h("div", { className: "list-row-actions-row" });
    const unfriendLink = h("span", { className: "unfriend-link", onclick: async (e) => {
      e.stopPropagation();
      const result = await unfriend(friendAccountKey);
      if (!result.ok) showComposerNotice(result.error);
    }}, "Unfriend");
    const blockLink = h("span", { className: "block-link", onclick: async (e) => {
      e.stopPropagation();
      const result = await blockUser(friendAccountKey, friendData.username);
      if (!result.ok) showComposerNotice(result.error);
    }}, "Block");
    actionsRow.appendChild(unfriendLink);
    actionsRow.appendChild(blockLink);

    const menuBtn = h("button", { className: "list-row-menu-btn", onclick: (e) => {
      e.stopPropagation();
      actionsRow.classList.toggle("show");
    }}, "⋮");
    row.appendChild(menuBtn);

    $friendsList.appendChild(h("div", {}, row, actionsRow));
  });
}

function renderBlockedList(userData) {
  const blocked = (userData && userData.blockedUsers) || {};
  const entries = Object.entries(blocked);
  $blockedList.innerHTML = "";
  $blockedEmpty.style.display = entries.length === 0 ? "block" : "none";

  entries.forEach(([blockedAccountKey, blockedData]) => {
    const unblockBtn = h("button", { className: "find-action-btn plain", onclick: async () => {
      unblockBtn.disabled = true;
      const result = await unblockUser(blockedAccountKey);
      if (!result.ok) { showComposerNotice(result.error); unblockBtn.disabled = false; }
    }}, "Unblock");
    $blockedList.appendChild(h("div", { className: "find-person-row" },
      h("div", { className: "find-person-name" }, blockedData.username),
      unblockBtn
    ));
  });
}

function renderAllRelationshipUI(userData) {
  renderIncomingRequests(userData);
  renderOutgoingRequests(userData);
  renderFriendsList(userData);
  renderBlockedList(userData);
  updateFindRailDot(userData);
  refreshOwnRailAvatar();
  if ($listPaneYouName) { $listPaneYouName.textContent = currentSession ? currentSession.username : ""; }
  if (lastSearchResults.length > 0) renderSearchResults(lastSearchResults);
}

/* ══════════════════════════════════════════════════════════
   MODALS (new group / invite / manage group) — settings modal
   defined above, shares the same overlay.
   ══════════════════════════════════════════════════════════ */
function closeModal() { $modalOverlay.classList.remove("show"); $modalBox.innerHTML = ""; }
$modalOverlay.addEventListener("click", (e) => { if (e.target === $modalOverlay) closeModal(); });

function openNewGroupModal() {
  $modalBox.innerHTML = "";
  const input = h("input", { type: "text", placeholder: "Group name", maxlength: "40" });
  const errorEl = h("div", { className: "modal-error" });
  const createBtn = h("button", { className: "primary-btn", onclick: async () => {
    createBtn.disabled = true;
    const result = await createGroupChat(input.value);
    if (!result.ok) { errorEl.textContent = result.error; createBtn.disabled = false; return; }
    closeModal(); openGroupChat(result.gcId);
  }}, "Create");
  $modalBox.appendChild(h("h3", {}, "New group"));
  $modalBox.appendChild(h("div", { className: "modal-note" }, "You can invite friends after creating it. Max " + GC_MAX_MEMBERS + " members."));
  $modalBox.appendChild(input);
  $modalBox.appendChild(errorEl);
  $modalBox.appendChild(h("div", { className: "modal-actions" }, h("button", { className: "plain-link", onclick: closeModal }, "Cancel"), createBtn));
  $modalOverlay.classList.add("show");
  input.focus();
}
$newGroupBtn.addEventListener("click", openNewGroupModal);

function openInviteModal(gcId) {
  $modalBox.innerHTML = "";
  $modalBox.appendChild(h("h3", {}, "Invite friends"));
  const errorEl = h("div", { className: "modal-error" });
  const friends = (currentUserData && currentUserData.friends) || {};
  const gc = myGroupChats.find(g => g.gcId === gcId);
  const existingMembers = (gc && gc.members) || {};
  const invitable = Object.entries(friends).filter(([key]) => !existingMembers[key]);

  if (invitable.length === 0) {
    $modalBox.appendChild(h("div", { className: "list-empty" }, "All your friends are already in this group."));
  } else {
    invitable.forEach(([friendKey, friendData]) => {
      const row = h("div", { className: "modal-invite-row" });
      const nameEl = h("span", { style: "font-size:13px" }, friendData.username);
      const btn = h("button", { className: "find-action-btn primary", onclick: async () => {
        btn.disabled = true; btn.textContent = "Inviting…";
        const result = await inviteToGroupChat(gcId, friendKey, friendData.username);
        if (!result.ok) { errorEl.textContent = result.error; btn.disabled = false; btn.textContent = "Invite"; }
        else row.remove();
      }}, "Invite");
      row.appendChild(nameEl);
      row.appendChild(btn);
      $modalBox.appendChild(row);
    });
  }
  $modalBox.appendChild(errorEl);
  $modalBox.appendChild(h("div", { className: "modal-actions" }, h("button", { className: "plain-link", onclick: closeModal }, "Done")));
  $modalOverlay.classList.add("show");
}

function openManageGroupModal(gcId) {
  const gc = myGroupChats.find(g => g.gcId === gcId) || currentGroupInfo;
  if (!gc) return;
  $modalBox.innerHTML = "";
  const isOwner = currentSession && gc.ownerAccountKey === currentSession.accountKey;
  $modalBox.appendChild(h("h3", {}, gc.name));
  const errorEl = h("div", { className: "modal-error" });

  if (isOwner) {
    $modalBox.appendChild(h("div", { className: "list-new-group-row", style: "padding-left:0", onclick: () => openInviteModal(gcId) }, "+ Invite friends"));
  }

  $modalBox.appendChild(h("div", { className: "modal-note" }, "Members (" + Object.keys(gc.members || {}).length + "/" + GC_MAX_MEMBERS + ")"));

  Object.entries(gc.members || {}).forEach(([memberKey, memberData]) => {
    const isMe = currentSession && memberKey === currentSession.accountKey;
    const ownerTag = memberKey === gc.ownerAccountKey ? " 👑" : "";
    const actions = h("div", { style: "display:flex;gap:10px" });

    if (isOwner && !isMe) {
      const transferBtn = h("button", { className: "find-action-btn plain", onclick: async () => {
        transferBtn.disabled = true;
        const result = await transferGroupOwnership(gcId, memberKey);
        if (!result.ok) { errorEl.textContent = result.error; transferBtn.disabled = false; }
        else { closeModal(); openManageGroupModal(gcId); }
      }}, "Make owner");
      const kickBtn = h("button", { className: "find-action-btn danger", onclick: async () => {
        kickBtn.disabled = true;
        const result = await kickFromGroupChat(gcId, memberKey);
        if (!result.ok) { errorEl.textContent = result.error; kickBtn.disabled = false; }
      }}, "Kick");
      actions.appendChild(transferBtn);
      actions.appendChild(kickBtn);
    }

    $modalBox.appendChild(h("div", { className: "modal-invite-row" },
      h("span", { style: "font-size:13px" }, memberData.username + ownerTag),
      actions
    ));
  });

  $modalBox.appendChild(errorEl);
  const leaveBtn = h("button", { className: "danger-link", onclick: async () => {
    if (isOwner && Object.keys(gc.members || {}).length > 1) {
      errorEl.textContent = "Tip: use \"Make owner\" above first if you want to choose who takes over — otherwise it'll be random.";
    }
    leaveBtn.disabled = true;
    const result = await leaveGroupChat(gcId);
    if (!result.ok) { errorEl.textContent = result.error; leaveBtn.disabled = false; } else closeModal();
  }}, isOwner ? "Transfer & leave" : "Leave group");
  $modalBox.appendChild(h("div", { className: "modal-actions" }, h("button", { className: "plain-link", onclick: closeModal }, "Close"), leaveBtn));
  $modalOverlay.classList.add("show");
}
$groupInfoBtn.addEventListener("click", () => { if (openChatGcId) openManageGroupModal(openChatGcId); });

$searchBtn.addEventListener("click", async () => {
  const query = $searchInput.value;
  $searchBtn.disabled = true;
  try { renderSearchResults(await performSearch(query)); }
  catch (e) { showComposerNotice("Search failed — try again."); }
  finally { $searchBtn.disabled = false; }
});
$searchInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $searchBtn.click(); } });

function showLoggedInState(session) {
  document.body.classList.add("app-mode");
  $listPaneYouName.textContent = session.username;
  $listPaneYouId.textContent = "#" + session.id;
  refreshOwnRailAvatar();
}
function showAuthFlow() {
  document.body.classList.remove("app-mode");
  $authFlow.style.display = "block";
}

$newIdContinueBtn.addEventListener("click", () => {
  $newIdReveal.style.display = "none";
  $authForm.style.display = "flex";
  $authForm.style.flexDirection = "column";
  $authForm.style.gap = "12px";
  setMode("login");
});

$authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  $authError.textContent = "";
  $authSuccess.style.display = "none";
  $authSubmitBtn.disabled = true;
  try {
    if (mode === "login") {
      const result = await login($loginIdentifier.value, $loginPassword.value);
      if (!result.ok) { $authError.textContent = result.error; return; }
      saveSession(result.accountKey, result.username, result.id);
      currentSession = result;
      claimPresence(result.accountKey, result.username);
      watchOwnAccount(result.accountKey, renderAllRelationshipUI);
      watchMyGroupChats(renderGroupsList);
      showLoggedInState(result);
    } else {
      const username = $signupUsername.value, password = $signupPassword.value, confirm = $signupPasswordConfirm.value;
      if (password !== confirm) { $authError.textContent = "Passwords don't match."; return; }
      const result = await createAccount(username, password);
      if (!result.ok) { $authError.textContent = result.error; return; }
      $authForm.style.display = "none";
      $revealedId.textContent = result.id;
      $newIdReveal.style.display = "block";
      $loginIdentifier.value = result.username;
      $loginPassword.value = "";
      $signupUsername.value = ""; $signupPassword.value = ""; $signupPasswordConfirm.value = "";
    }
  } catch (e) {
    console.error("Auth error:", e);
    $authError.textContent = "Error: " + (e && e.message ? e.message : String(e));
  } finally {
    $authSubmitBtn.disabled = false;
  }
});

/* ══════════════════════════════════════════════════════════
   CHAT THREAD UI
   ══════════════════════════════════════════════════════════ */
let openChatAccountKey = null;
let openChatUsername = null;
let openChatGcId = null;
let openThreadId = null;
let chatMessageCount = 0;
let lastRenderedDateKey = null;
let replyingTo = null;
let editingMessageId = null;
let threadReadsState = {};

function updateChatThreadHeaderStatus() {
  if (openChatGcId) {
    const count = currentGroupInfo ? Object.keys(currentGroupInfo.members || {}).length : 0;
    $chatThreadHeaderStatus.textContent = count + " member" + (count === 1 ? "" : "s");
    $chatThreadHeaderStatus.classList.remove("online");
    return;
  }
  if (!openChatAccountKey) return;
  const isOnline = latestPresenceAccountKeys.has(openChatAccountKey);
  if (isOnline) {
    $chatThreadHeaderStatus.textContent = "online";
    $chatThreadHeaderStatus.classList.add("online");
  } else {
    const otherLastSeen = otherUserLastSeenCache[openChatAccountKey];
    $chatThreadHeaderStatus.textContent = formatLastSeen(otherLastSeen).toLowerCase();
    $chatThreadHeaderStatus.classList.remove("online");
  }
  $chatThreadPresenceBadge.classList.toggle("online", isOnline);
}

let otherUserLastSeenCache = {};
async function fetchOtherLastSeen(accountKey) {
  try {
    const snap = await usersRef.child(accountKey).child("lastSeen").get();
    otherUserLastSeenCache[accountKey] = snap.val() || null;
    if (openChatAccountKey === accountKey) updateChatThreadHeaderStatus();
  } catch (e) {}
}

function maybeInsertDateSeparator(ts) {
  if (!ts) return;
  const dayKey = new Date(ts).toDateString();
  if (dayKey === lastRenderedDateKey) return;
  lastRenderedDateKey = dayKey;
  $chatMessages.appendChild(h("div", { className: "chat-date-sep" }, formatDateSeparator(ts).toLowerCase()));
}

function findRenderedMessageEl(messageId) {
  return $chatMessages.querySelector('[data-msg-id="' + CSS.escape(messageId) + '"]');
}

function scopeRefForOpenChat() {
  return openChatGcId ? groupChatsRef.child(openChatGcId) : dmsRef.child(openThreadId);
}

function renderReactions(msg, msgEl) {
  const existing = msgEl.querySelector(".chat-msg-reactions");
  if (existing) existing.remove();
  const reactions = msg.reactions || {};
  const entries = Object.entries(reactions).filter(([, users]) => users && Object.keys(users).length > 0);
  if (entries.length === 0) return;

  const wrap = h("div", { className: "chat-msg-reactions" });
  entries.forEach(([emoji, users]) => {
    const count = Object.keys(users).length;
    const isMine = currentSession && users[currentSession.accountKey];
    wrap.appendChild(h("div", { className: "reaction-pill" + (isMine ? " mine-reaction" : ""), onclick: () => {
      toggleReaction(scopeRefForOpenChat(), msg.id, emoji);
    }}, emoji + " " + count));
  });
  const bubbleRow = msgEl.querySelector(".chat-msg-bubble-row");
  bubbleRow.insertAdjacentElement("afterend", wrap);
}

function openReactionPicker(msg, anchorBtn) {
  document.querySelectorAll(".reaction-picker-popover.show").forEach(p => p.classList.remove("show"));
  let popover = anchorBtn.nextElementSibling;
  if (!popover || !popover.classList.contains("reaction-picker-popover")) {
    popover = h("div", { className: "reaction-picker-popover" });
    ["👍","❤️","😂","😮","😢","🔥"].forEach(emoji => {
      popover.appendChild(h("button", { onclick: () => {
        toggleReaction(scopeRefForOpenChat(), msg.id, emoji);
        popover.classList.remove("show");
      }}, emoji));
    });
    anchorBtn.insertAdjacentElement("afterend", popover);
  }
  popover.classList.toggle("show");
  const closeOnOutside = (e) => {
    if (!popover.contains(e.target) && e.target !== anchorBtn) {
      popover.classList.remove("show");
      document.removeEventListener("click", closeOnOutside);
    }
  };
  setTimeout(() => document.addEventListener("click", closeOnOutside), 0);
}

function startReply(msg) {
  const fromLabel = msg.fromAccountKey === currentSession.accountKey ? "You" : (msg.fromUsername || openChatUsername || "them");
  const previewText = msg.deleted ? "[deleted message]" : (msg.imageData ? "📷 Image" : (msg.text || ""));
  replyingTo = { id: msg.id, text: previewText, fromLabel: fromLabel };
  $replyPreviewText.innerHTML = `<b>${esc(fromLabel)}:</b> ${esc(previewText).slice(0, 80)}`;
  $replyPreviewBar.style.display = "flex";
  cancelEditing();
  $chatMsgInput.focus();
}
function cancelReply() { replyingTo = null; $replyPreviewBar.style.display = "none"; }
$cancelReplyBtn.addEventListener("click", cancelReply);

function startEditing(msg) {
  editingMessageId = msg.id;
  $chatMsgInput.value = msg.text || "";
  autosizeChatInput();
  $editingBar.style.display = "flex";
  cancelReply();
  $chatMsgInput.focus();
}
function cancelEditing() { editingMessageId = null; $editingBar.style.display = "none"; }
$cancelEditBtn.addEventListener("click", () => { cancelEditing(); $chatMsgInput.value = ""; autosizeChatInput(); });

function renderChatMessage(msg) {
  maybeInsertDateSeparator(msg.ts);
  const mine = msg.fromAccountKey === currentSession.accountKey;
  const el = h("div", { className: "chat-msg " + (mine ? "mine" : "theirs") });
  el.dataset.msgId = msg.id;

  if (openChatGcId && !mine && msg.fromUsername) {
    el.appendChild(h("div", { className: "chat-msg-meta" }, msg.fromUsername));
  }

  if (msg.replyTo) {
    const label = msg.replyToLabel || "them";
    const snippet = msg.replyToSnippet || "message";
    const preview = h("div", { className: "chat-msg-reply-preview", onclick: () => {
      const repliedEl = findRenderedMessageEl(msg.replyTo);
      if (repliedEl) repliedEl.scrollIntoView({ behavior: "smooth", block: "center" });
      else showComposerNotice("Original message isn't loaded — scroll up to find it.");
    }},
      h("b", {}, label + ": "), snippet
    );
    el.appendChild(preview);
  }

  const bubble = h("div", { className: "chat-msg-bubble" });
  if (msg.deleted) {
    bubble.style.fontStyle = "italic";
    bubble.style.opacity = "0.6";
    bubble.textContent = "This message was deleted";
  } else if (msg.imageData) {
    const img = h("img", { className: "chat-msg-image", alt: "Image", onclick: () => {
      $imageLightboxImg.src = msg.imageData;
      $imageLightbox.classList.add("show");
    }});
    img.src = msg.imageData;
    bubble.appendChild(img);
    if (msg.text) bubble.appendChild(h("div", { style: "margin-top:6px;white-space:pre-wrap", html: linkify(esc(msg.text)) }));
  } else {
    bubble.innerHTML = linkify(esc(msg.text || ""));
  }

  const hoverActions = h("div", { className: "msg-hover-actions" });
  const reactBtn = h("button", { title: "React", onclick: () => openReactionPicker(msg, reactBtn) }, "😊");
  const replyBtn = h("button", { title: "Reply", onclick: () => startReply(msg) }, "↩");
  hoverActions.appendChild(reactBtn);
  hoverActions.appendChild(replyBtn);
  if (mine && !msg.deleted && !msg.imageData) {
    hoverActions.appendChild(h("button", { title: "Edit", onclick: () => startEditing(msg) }, "✎"));
  }
  if (mine && !msg.deleted) {
    hoverActions.appendChild(h("button", { title: "Delete", onclick: () => {
      const fn = openChatGcId ? deleteGroupMessage(openChatGcId, msg.id) : deleteDirectMessage(openThreadId, msg.id);
      Promise.resolve(fn).then(res => { if (res && !res.ok) showComposerNotice(res.error); });
    }}, "🗑") );
  }

  const bubbleRow = h("div", { className: "chat-msg-bubble-row" }, bubble, hoverActions);
  el.appendChild(bubbleRow);

  const metaBits = [formatTimeShort(msg.ts)];
  if (msg.editedAt) metaBits.push(h("span", { className: "chat-msg-edited-tag" }, "(edited)"));
  const meta = h("div", { className: "chat-msg-meta" });
  meta.appendChild(document.createTextNode(metaBits[0]));
  if (metaBits[1]) { meta.appendChild(document.createTextNode(" ")); meta.appendChild(metaBits[1]); }
  el.appendChild(meta);

  $chatMessages.appendChild(el);
  renderReactions(msg, el);
  chatMessageCount++;

  const nearBottom = $chatMessages.scrollHeight - $chatMessages.scrollTop - $chatMessages.clientHeight < 200;
  if (nearBottom || mine) {
    requestAnimationFrame(() => { $chatMessages.scrollTop = $chatMessages.scrollHeight; });
  }

  if (!openChatGcId && !mine && openThreadId) markThreadRead(openThreadId, msg.id);
}

function updateRenderedMessage(msg) {
  const el = findRenderedMessageEl(msg.id);
  if (!el) return;
  const bubble = el.querySelector(".chat-msg-bubble");
  if (msg.deleted) {
    bubble.style.fontStyle = "italic"; bubble.style.opacity = "0.6";
    bubble.textContent = "This message was deleted";
    const editBtn = el.querySelector('button[title="Edit"]');
    if (editBtn) editBtn.remove();
  } else if (!msg.imageData) {
    bubble.innerHTML = linkify(esc(msg.text || ""));
  }
  if (msg.editedAt && !el.querySelector(".chat-msg-edited-tag")) {
    const meta = el.querySelector(".chat-msg-meta:last-child");
    if (meta) { meta.appendChild(document.createTextNode(" ")); meta.appendChild(h("span", { className: "chat-msg-edited-tag" }, "(edited)")); }
  }
  renderReactions(msg, el);
}

function renderTypingIndicator(activeUsernames) {
  if (activeUsernames.length === 0) { $typingIndicatorBar.textContent = ""; return; }
  if (activeUsernames.length === 1) $typingIndicatorBar.textContent = activeUsernames[0].toLowerCase() + " is typing···";
  else $typingIndicatorBar.textContent = activeUsernames.join(", ").toLowerCase() + " are typing···";
}

function openChatWith(accountKey, username) {
  unwatchGroupInfo();
  clearPendingImage();
  cancelReply();
  cancelEditing();
  openChatAccountKey = accountKey;
  openChatUsername = username;
  openChatGcId = null;
  chatMessageCount = 0;
  lastRenderedDateKey = null;

  $chatEmptyState.style.display = "none";
  $chatThread.style.display = "flex";
  renderAvatarInto($chatThreadAvatar, username, null);
  fetchAndCacheAvatar(accountKey, (avatarUrl) => { if (avatarUrl) renderAvatarInto($chatThreadAvatar, username, avatarUrl); });
  $chatThreadHeaderName.textContent = username;
  $groupInfoBtn.style.display = "none";
  updateChatThreadHeaderStatus();
  fetchOtherLastSeen(accountKey);

  $chatMessages.innerHTML = "";
  openThreadId = watchThreadMessages(accountKey, renderChatMessage, updateRenderedMessage);
  watchTyping(false, accountKey, renderTypingIndicator);
  watchThreadReads(openThreadId, (reads) => { threadReadsState = reads; refreshReadReceiptDisplay(); });

  if (currentUserData) renderFriendsList(currentUserData);
  if (myGroupChats.length) renderGroupsList(myGroupChats);

  enterMobileChatView();
  if (window.innerWidth > 720) $chatMsgInput.focus();
}

function refreshReadReceiptDisplay() {
  if (openChatGcId || !currentSession) return;
  const otherKey = openChatAccountKey;
  const otherLastRead = threadReadsState[otherKey];
  if (!otherLastRead) return;
  const mineBubbles = [...$chatMessages.querySelectorAll(".chat-msg.mine")];
  mineBubbles.forEach(el => { const tag = el.querySelector(".seen-tag"); if (tag) tag.remove(); });
  for (let i = mineBubbles.length - 1; i >= 0; i--) {
    const el = mineBubbles[i];
    if (el.dataset.msgId <= otherLastRead) {
      const meta = el.querySelector(".chat-msg-meta:last-child");
      if (meta && !meta.querySelector(".seen-tag")) meta.appendChild(h("span", { className: "seen-tag" }, " ✓✓"));
      break;
    }
  }
}

function openGroupChat(gcId) {
  clearPendingImage();
  cancelReply();
  cancelEditing();
  openChatAccountKey = null;
  openChatUsername = null;
  openChatGcId = gcId;
  openThreadId = null;
  chatMessageCount = 0;
  lastRenderedDateKey = null;

  const gc = myGroupChats.find(g => g.gcId === gcId);
  $chatEmptyState.style.display = "none";
  $chatThread.style.display = "flex";
  $chatThreadAvatar.innerHTML = "";
  $chatThreadAvatar.textContent = "👥";
  $chatThreadAvatar.classList.add("group-avatar");
  $chatThreadHeaderName.textContent = gc ? gc.name : "Group";
  $groupInfoBtn.style.display = "inline-block";
  watchGroupInfo(gcId, () => updateChatThreadHeaderStatus());
  updateChatThreadHeaderStatus();

  $chatMessages.innerHTML = "";
  watchGroupMessages(gcId, renderChatMessage, updateRenderedMessage);
  watchTyping(true, gcId, renderTypingIndicator);

  if (currentUserData) renderFriendsList(currentUserData);
  renderGroupsList(myGroupChats);

  enterMobileChatView();
  if (window.innerWidth > 720) $chatMsgInput.focus();
}

function closeOpenChat() {
  unwatchGroupInfo();
  stopWatchingOpenChat();
  setTyping(!!openChatGcId, openChatGcId || openChatAccountKey, false);
  openChatAccountKey = null;
  openChatUsername = null;
  openChatGcId = null;
  openThreadId = null;
  $chatThreadAvatar.classList.remove("group-avatar");
  $chatThread.style.display = "none";
  $chatEmptyState.style.display = "flex";
  $groupInfoBtn.style.display = "none";
  exitMobileChatView();
}

function enterMobileChatView() { $appShell.classList.add("mobile-chat-open"); }
function exitMobileChatView() { $appShell.classList.remove("mobile-chat-open"); }
$chatBackBtn.addEventListener("click", closeOpenChat);

let pendingImageDataUrl = null;
async function stageImageFile(file) {
  if (!file) return;
  if (!openChatAccountKey && !openChatGcId) return;
  if (!file.type.startsWith("image/")) { showComposerNotice("That file isn't an image."); $imageFileInput.value = ""; return; }
  if (file.size > MAX_IMAGE_SOURCE_BYTES) { showComposerNotice("Image is too large (max 15 MB)."); $imageFileInput.value = ""; return; }
  $uploadImageBtn.disabled = true;
  try {
    const dataUrl = await compressImageFile(file);
    pendingImageDataUrl = dataUrl;
    $pendingImagePreview.src = dataUrl;
    $pendingImageBar.style.display = "flex";
  } catch (e) { showComposerNotice(e.message || "Couldn't process that image."); }
  finally { $uploadImageBtn.disabled = false; $imageFileInput.value = ""; }
}
function clearPendingImage() {
  pendingImageDataUrl = null;
  $pendingImagePreview.src = "";
  $pendingImageBar.style.display = "none";
  $imageFileInput.value = "";
}
$uploadImageBtn.addEventListener("click", () => $imageFileInput.click());
$imageFileInput.addEventListener("change", () => stageImageFile($imageFileInput.files[0]));
$cancelPendingImageBtn.addEventListener("click", clearPendingImage);

function buildEmojiPicker() {
  $emojiPickerPopover.innerHTML = "";
  QUICK_EMOJIS.forEach(emoji => {
    $emojiPickerPopover.appendChild(h("button", { onclick: () => {
      insertAtCursor($chatMsgInput, emoji);
      $emojiPickerPopover.classList.remove("show");
      $chatMsgInput.focus();
    }}, emoji));
  });
}
function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart, end = textarea.selectionEnd;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  autosizeChatInput();
}
buildEmojiPicker();
$emojiPickerBtn.addEventListener("click", () => $emojiPickerPopover.classList.toggle("show"));
document.addEventListener("click", (e) => {
  if (!$emojiPickerPopover.contains(e.target) && e.target !== $emojiPickerBtn) $emojiPickerPopover.classList.remove("show");
});

$imageLightbox.addEventListener("click", () => $imageLightbox.classList.remove("show"));

function sendChatMessage() {
  if (!openChatAccountKey && !openChatGcId) return;
  const text = $chatMsgInput.value;
  const imageToSend = pendingImageDataUrl;

  if (editingMessageId) {
    if (!text.trim()) return;
    const id = editingMessageId;
    $chatSendBtn.disabled = true;
    const fn = openChatGcId ? editGroupMessage(openChatGcId, id, text) : editDirectMessage(openThreadId, id, text);
    Promise.resolve(fn).then(res => {
      $chatSendBtn.disabled = false;
      if (!res.ok) { showComposerNotice(res.error); return; }
      cancelEditing();
      $chatMsgInput.value = ""; autosizeChatInput();
    });
    return;
  }

  if (!text.trim() && !imageToSend) return;
  if (sendCooldownActive) return;

  const REPLY_SNIPPET_MAX = 20;
  const replySnapshot = replyingTo ? {
    id: replyingTo.id,
    fromLabel: replyingTo.fromLabel,
    snippet: replyingTo.text.length > REPLY_SNIPPET_MAX ? replyingTo.text.slice(0, REPLY_SNIPPET_MAX) + "…" : replyingTo.text
  } : null;
  cancelReply();
  setTyping(!!openChatGcId, openChatGcId || openChatAccountKey, false);

  $chatMsgInput.value = "";
  autosizeChatInput();
  clearPendingImage();
  beginSendCooldown();

  const sendOne = (msgText, withImage, replyTo) => openChatGcId
    ? sendGroupMessage(openChatGcId, msgText, withImage, replyTo)
    : sendDirectMessage(openChatAccountKey, msgText, withImage, replyTo);

  if (imageToSend) {
    sendOne(null, imageToSend, replySnapshot).then(result => {
      if (!result.ok) { showComposerNotice(result.error); return; }
      if (text.trim()) {
        return sendOne(text, null, null).then(textResult => {
          if (!textResult.ok) showComposerNotice(textResult.error);
        });
      }
    }).catch(() => showComposerNotice("Message failed to send — try again."));
  } else {
    sendOne(text, null, replySnapshot).then(result => {
      if (!result.ok) showComposerNotice(result.error);
    }).catch(() => showComposerNotice("Message failed to send — try again."));
  }
}

let sendCooldownActive = false;
let sendCooldownTimer = null;
function beginSendCooldown() {
  sendCooldownActive = true;
  $chatSendBtn.disabled = true;
  $uploadImageBtn.disabled = true;
  clearTimeout(sendCooldownTimer);
  sendCooldownTimer = setTimeout(endSendCooldown, SEND_DELAY_MS);
}
function endSendCooldown() {
  sendCooldownActive = false;
  clearTimeout(sendCooldownTimer);
  $chatSendBtn.disabled = false;
  $uploadImageBtn.disabled = false;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && sendCooldownActive) endSendCooldown();
});

function autosizeChatInput() {
  $chatMsgInput.style.height = "auto";
  $chatMsgInput.style.height = Math.min($chatMsgInput.scrollHeight, 120) + "px";
}

$chatSendBtn.addEventListener("click", sendChatMessage);
$chatMsgInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  if (e.key === "Escape") { if (editingMessageId) { cancelEditing(); $chatMsgInput.value = ""; autosizeChatInput(); } else if (replyingTo) cancelReply(); }
});

let lastTypingBroadcast = 0;
let typingStopTimer = null;
$chatMsgInput.addEventListener("input", () => {
  autosizeChatInput();
  if (!openChatAccountKey && !openChatGcId) return;
  const now = Date.now();
  if (now - lastTypingBroadcast > 1500) {
    lastTypingBroadcast = now;
    setTyping(!!openChatGcId, openChatGcId || openChatAccountKey, true);
  }
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => setTyping(!!openChatGcId, openChatGcId || openChatAccountKey, false), TYPING_TIMEOUT_MS);
});

function init() {
  const usingPlaceholderConfig = FIREBASE_CONFIG.apiKey === "PASTE_YOUR_API_KEY_HERE";
  if (usingPlaceholderConfig) {
    document.getElementById("authCard").innerHTML = `
      <h2>Not set up yet</h2>
      <p style="color:#94a3b8;font-size:14px;line-height:1.5;margin-top:8px">
        Fill in FIREBASE_CONFIG near the top of the script with your own
        Firebase project's values before this will work.
      </p>
    `;
    return;
  }

  try { initFirebase(); }
  catch (e) {
    document.getElementById("authCard").innerHTML = `<h2>Couldn't connect</h2><p style="color:#94a3b8;font-size:14px">${(e.message || "Unknown error")}</p>`;
    return;
  }

  const session = loadSession();
  if (session && session.accountKey) {
    currentSession = session;
    claimPresence(session.accountKey, session.username);
    watchOwnAccount(session.accountKey, renderAllRelationshipUI);
    watchMyGroupChats(renderGroupsList);
    showLoggedInState(session);
  } else {
    showAuthFlow();
    setMode("login");
  }

  watchPresenceList(renderOnlineList);

  window.addEventListener("beforeunload", () => {
    releasePresence();
    if (currentSession) recordLastSeen(currentSession.accountKey);
  });
}

init();
