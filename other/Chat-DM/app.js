/* ══════════════════════════════════════════════════════════
   FIREBASE CONFIG — same project as before.
   ══════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC60NQgrGpoChAUgHBVpZRIBLM_bTkvi0M",
  authDomain: "vus-chat-dm.firebaseapp.com",
  databaseURL: "https://vus-chat-dm-default-rtdb.firebaseio.com",
  projectId: "vus-chat-dm",
  storageBucket: "vus-chat-dm.firebasestorage.app",
  messagingSenderId: "898140075693",
  appId: "1:898140075693:web:0ad830a523dd12135f3824",
  measurementId: "G-4RNCZJB0E5"
};

const USERNAME_MAX_LENGTH = 24;
const USERNAME_MIN_LENGTH = 3;
const ID_LENGTH = 6;
const ID_MIN = 100000;
const ID_MAX = 999999;
const SESSION_STORAGE_KEY = "dmAppSession";
const GC_MAX_MEMBERS = 20;
const SEND_DELAY_MS = 2000;
const TYPING_TIMEOUT_MS = 4000;

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

function claimPresence(accountKey, username) {
  releasePresence();
  myPresenceRef = presenceRef.child(accountKey);
  myPresenceRef.onDisconnect().remove();
  myPresenceRef.set({ username: username, joinedAt: firebase.database.ServerValue.TIMESTAMP });
}
function releasePresence() {
  if (myPresenceRef) {
    myPresenceRef.onDisconnect().cancel();
    myPresenceRef.remove();
    myPresenceRef = null;
  }
}
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

const AVATAR_MAX_DIMENSION = 64;
const AVATAR_JPEG_QUALITY = 0.55;

function compressAvatarFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
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
  try { await dmsRef.child(threadId).child("reads").child(currentSession.accountKey).set(lastMessageId); } catch (e) {}
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

let threadReadsRef = null;
function watchThreadReads(threadId, onChange) {
  unwatchThreadReads();
  threadReadsRef = dmsRef.child(threadId).child("reads");
  threadReadsRef.on("value", snap => onChange(snap.val() || {}));
}
function unwatchThreadReads() {
  if (threadReadsRef) { threadReadsRef.off("value"); threadReadsRef = null; }
}

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
   UI WIRING
   ══════════════════════════════════════════════════════════ */
const $authFlow = document.getElementById("authFlow");
const $appShell = document.getElementById("appShell");

const $rail = document.getElementById("rail");
const $railAvatarBtn = document.getElementById("railAvatarBtn");
const $railSettingsBtn = document.getElementById("railSettingsBtn");
const $tabChats = document.getElementById("navChats");
const $tabFind = document.getElementById("navFind");
const $tabBlocked = document.getElementById("navBlocked");
const $tabChatRoom = document.getElementById("navChat");
const $chatRoomPane = document.getElementById("chatRoomPane");
const $chatPane = document.getElementById("chatPane");
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

// Declared here, well before init() is called at the bottom of this
// file, because init() calls enterSpectatorPreview() synchronously on
// page load for logged-out visitors, and that function reads
// chatRoomListenersAttached. `let` bindings don't hoist their
// initialization the way function declarations do — if these were
// declared later in the file (e.g. next to initChatRoomUI, where
// they're mostly used), reading them during that synchronous call
// would throw "Cannot access before initialization" and break the
// entire app for anyone who isn't logged in.
let chatRoomListenersAttached = false;
let chatRoomInitialized = false;

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
   RAIL NAV — "chats" | "find" | "blocked" | "chatroom".
   "chatroom" swaps chatPane out for chatRoomPane (the merged VUS
   Chat room). Logged-out visitors land on "chatroom" too, but see
   the read-only spectator preview instead of initChatRoomUI().
   ══════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════
   LAYOUT MODEL: chat is the permanent main view — #chatRoomPane never
   hides. #listPane (the DM sidebar: chats/find/blocked) is a push
   panel toggled via .dm-sidebar-open on #appShell; #chatRoomPane's
   flex:1 makes it reflow to fill whatever width the sidebar isn't
   using (see style.css). The sidebar does NOT close on outside click
   — only its own toggle buttons open/close it, so a stray click while
   reading a DM doesn't lose your spot.
   ══════════════════════════════════════════════════════════ */
let dmSidebarOpen = false;
let dmSidebarView = "chats"; // which of chats/find/blocked is showing inside it

function setDmSidebarView(view) {
  dmSidebarView = view;
  $tabChats.classList.toggle("active", view === "chats");
  $tabFind.classList.toggle("active", view === "find");
  $tabBlocked.classList.toggle("active", view === "blocked");
  $viewChats.classList.toggle("active", view === "chats");
  $viewFind.classList.toggle("active", view === "find");
  $viewBlocked.classList.toggle("active", view === "blocked");
}

function openDmSidebar(view) {
  dmSidebarOpen = true;
  $appShell.classList.add("dm-sidebar-open");
  $tabChatRoom.classList.remove("active");
  setDmSidebarView(view || dmSidebarView);
}

function closeDmSidebar() {
  dmSidebarOpen = false;
  $appShell.classList.remove("dm-sidebar-open");
  $tabChatRoom.classList.add("active");
}

// Kept for compatibility with call sites elsewhere in this file that
// still call setListView("chatroom") (e.g. the login success path,
// enterSpectatorPreview callers) — chat is always showing now, so this
// just makes sure the sidebar is closed and the chat nav button reads
// as active, then boots the chat room backend same as before.
function setListView(view) {
  if (view === "chatroom") {
    closeDmSidebar();
    if (currentSession) initChatRoomUI();
    else enterSpectatorPreview();
    return;
  }
  // "chats" | "find" | "blocked" - clicking these opens/switches the
  // sidebar instead of swapping the main pane out from under chat.
  openDmSidebar(view);
}

$tabChats.addEventListener("click", () => {
  if (dmSidebarOpen && dmSidebarView === "chats") { closeDmSidebar(); return; }
  openDmSidebar("chats");
});
$tabFind.addEventListener("click", () => {
  if (dmSidebarOpen && dmSidebarView === "find") { closeDmSidebar(); return; }
  openDmSidebar("find");
});
$tabBlocked.addEventListener("click", () => {
  if (dmSidebarOpen && dmSidebarView === "blocked") { closeDmSidebar(); return; }
  openDmSidebar("blocked");
});
$tabChatRoom.addEventListener("click", () => closeDmSidebar());

function updateFindRailDot(userData) {
  const incoming = (userData && userData.friendRequestsIncoming) || {};
  const visibleCount = Object.values(incoming).filter(r => !r.hidden).length;
  $findRailDot.classList.toggle("show", visibleCount > 0);
}

let pendingAvatarDataUrl = null;

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
  if (!currentSession) return;
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
$railSettingsBtn.addEventListener("click", () => { if (currentSession) openSettingsModal(); });

async function doLogout() {
  const accountKey = currentSession && currentSession.accountKey;
  releasePresence();
  if (accountKey) await recordLastSeen(accountKey);
  unwatchOwnAccount(accountKey);
  unwatchMyGroupChats();
  unwatchGroupInfo();
  clearPendingImage();
  closeOpenChat();
  closeModal();
  closeProfilePopover();
  if (typeof exitChatRoom === "function") exitChatRoom();
  otherAvatarCache = {};
  currentSession = null;
  clearSession();
  showAuthFlow();
  setMode("login");
  $loginIdentifier.value = "";
  $loginPassword.value = "";
  enterSpectatorPreview();
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

function renderGroupsList(groups) {
  myGroupChats = groups;
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
      exitSpectatorPreview();
      saveSession(result.accountKey, result.username, result.id);
      currentSession = result;
      claimPresence(result.accountKey, result.username);
      watchOwnAccount(result.accountKey, renderAllRelationshipUI);
      watchMyGroupChats(renderGroupsList);
      showLoggedInState(result);
      setListView("chatroom");
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
   DM CHAT THREAD UI
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

function enterMobileChatView() { $appShell.classList.add("thread-open"); }
function exitMobileChatView() { $appShell.classList.remove("thread-open"); }
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
    // Deferred: setListView("chatroom") calls initChatRoomUI(), which
    // reads ROLES/ChatBackend/RoomManager — all declared further down
    // this file, after init() runs. Those are top-level const/let
    // declarations that execute in file order; a setTimeout(0) callback
    // only runs after the whole script (including all of those
    // declarations) has finished executing once, so by the time this
    // fires they're guaranteed to exist. Calling setListView directly
    // here, before they're declared, would throw "Cannot access before
    // initialization" and break login for every returning user.
    setTimeout(() => setListView("chatroom"), 0);
  } else {
    showAuthFlow();
    setMode("login");
    // Same deferral reasoning as above — enterSpectatorPreview() reads
    // ROLES/ChatBackend/roleHolders/spectatorPreviewAction, all declared
    // later in the file than this call site.
    setTimeout(() => enterSpectatorPreview(), 0);
  }

  watchPresenceList(renderOnlineList);

  window.addEventListener("beforeunload", () => {
    releasePresence();
    if (currentSession) recordLastSeen(currentSession.accountKey);
  });
}

init();

/* ══════════════════════════════════════════════════════════
   CHAT ROOM (merged from VUS-Chat) — identity is tied to the
   logged-in DM account. Roles/timeouts/staff menu are unchanged
   from the original chat room; DMs never had these and still don't.
   Booted via initChatRoomUI() for logged-in accounts, or run in a
   read-only spectator mode (see SPECTATOR PREVIEW below) for
   logged-out visitors.
   ══════════════════════════════════════════════════════════ */
const MAIN_ROOM_ID = "vus-hub-main";

const ROOM_DURATION_MS = 15 * 60 * 1000;
const ROOM_WARNING_MS = 60 * 1000;
const ROOM_EXTEND_MS = 10 * 60 * 1000;
const ROOM_CREATE_COOLDOWN_MS = 60 * 1000;
const ROOM_CODE_DEFAULT_LENGTH = 4;
const ROOM_CODE_MAX_LENGTH = 20;
const ROOM_NAME_MAX_LENGTH = 30;
const ROOM_CREATE_COOLDOWN_KEY = "vusChatLastRoomCreate";

const MAX_MESSAGES = 200;
const MAX_CHARS = 500;

const PING_YOU_WEBHOOK_URL = "https://discord.com/api/webhooks/1536853718564216842/VZYgEyf5yEzMs03g-hbWIZRS90oNKrVh_LBN1eHv3ZVplCOUlKeRDTWKIAyolYjIshHa";
const PING_YOU_COOLDOWN_MS = 30 * 1000;
const PING_YOU_STORAGE_KEY = "vusChatLastPingYou";

const AT_PING_COOLDOWN_MS = 30 * 1000;

const PING_SOUND_URL = "https://github.com/Cra-Z-Gaming/VUS/raw/refs/heads/main/ping.mp3";

const ROLE_CODE_LIFESPAN_MS = 30 * 1000;
const ROLE_REQUEST_COOLDOWN_MS = 30 * 1000;

const ROLES = {
  crown: {
    id: "crown",
    label: "Owner",
    icon: "👑",
    dbPath: "crowned",
    metaPath: "crownMeta",
    webhookUrl: "https://discord.com/api/webhooks/1542708447991037953/Ge705Wa_quPVC-2pFhttHYNuA4-FI5ZDRIn5VwjQ059SwT0ZRCrqmVLMofb8oJhsLFFJ",
    cooldownKey: "vusChatLastCrownRequest",
    bubbleClass: "crown-bubble"
  },
  mod: {
    id: "mod",
    label: "Mod",
    icon: "🧩",
    dbPath: "modded",
    metaPath: "modMeta",
    webhookUrl: "https://discord.com/api/webhooks/1545551358118072320/4VUNceTr4bpwspeNKKkP_9Ko64Nc6iknQwN15AY-5iyl9A1SG5JvwZzEHHolXYLY6v1h",
    cooldownKey: "vusChatLastModRequest",
    bubbleClass: "mod-bubble"
  }
};

const COLOR_CHANGE_COOLDOWN_MS = 10 * 1000;
const LEAVE_DEDUPE_WINDOW_MS = 5 * 1000;

const TIMEOUT_MAX_MS = 3 * 60 * 1000;
const MOD_TIMEOUT_MAX_MS = 40 * 1000;
const MOD_TIMEOUT_DEFAULT_MS = 10 * 1000;
const MOD_RETIMEOUT_COOLDOWN_MS = 7 * 1000;

const ChatBackend = {
  _db: null,
  _ref: null,
  _typingRef: null,
  _myTypingRef: null,
  _connectedRef: null,
  _presenceRef: null,
  _myPresenceRef: null,
  _myLeaveEventRef: null,
  _myAccountKey: null,
  _nameColorsRef: null,
  _atPingCooldownRef: null,
  _leaveEventsRef: null,
  _roleRefs: {},
  _roleMetaRefs: {},
  _myRoleRefs: {},
  _rolesHeld: {},
  _recentLeaveNames: {},
  _timeoutsRef: null,
  _modRetimeoutRef: null,
  currentRoomId: null,

  init() {
    this._db = firebase.database();
    this._connectedRef = this._db.ref(".info/connected");
    this.initRoles();
    this.bindToRoom(MAIN_ROOM_ID);
  },

  initRoles() {
    Object.values(ROLES).forEach(role => {
      this._roleRefs[role.id] = this._db.ref(role.dbPath);
      this._roleMetaRefs[role.id] = this._db.ref(role.metaPath);
      this._rolesHeld[role.id] = false;
    });
  },

  async _serverOffset() {
    try {
      const snap = await this._db.ref(".info/serverTimeOffset").once("value");
      return snap.val() || 0;
    } catch (e) {
      return 0;
    }
  },
  async _serverNow() {
    return Date.now() + (await this._serverOffset());
  },

  watchRoleNames(roleId, onChange) {
    this._roleRefs[roleId].on("value", snap => {
      const val = snap.val() || {};
      onChange(new Set(Object.keys(val)));
    });
  },

  _randomRoleCode() {
    const chars = "0123456789";
    let out = "";
    do {
      out = "";
      for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
    } while (out === "0000");
    return out;
  },

  async generateRoleCode(roleId) {
    const role = ROLES[roleId];
    const code = this._randomRoleCode();
    const serverNow = await this._serverNow();
    const expiresAt = serverNow + ROLE_CODE_LIFESPAN_MS;
    await this._roleMetaRefs[roleId].set({ code, expiresAt });
    let webhookOk = false;
    try {
      const res = await fetch(role.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: role.icon + " " + role.label + " code: **" + code + "** (expires in " + Math.round(ROLE_CODE_LIFESPAN_MS / 1000) + "s)" })
      });
      webhookOk = res.ok;
    } catch (e) {
      webhookOk = false;
    }
    return { code, webhookOk };
  },

  async redeemRoleCode(roleId, inputCode) {
    const clean = (inputCode || "").trim().toUpperCase();
    if (!clean || clean === "0000") return { ok: false, reason: "none" };

    let current;
    try {
      const snap = await this._roleMetaRefs[roleId].get();
      current = snap.val();
    } catch (e) {
      return { ok: false, reason: "wrong" };
    }

    if (!current || !current.code || current.code === "0000" || current.code !== clean) {
      return { ok: false, reason: "wrong" };
    }

    const serverNow = await this._serverNow();
    if (!current.expiresAt || serverNow > current.expiresAt) {
      return { ok: false, reason: "expired" };
    }

    if (this._myRoleRefs[roleId]) {
      await this._myRoleRefs[roleId].set(true);
      this._rolesHeld[roleId] = true;
    }
    return { ok: true };
  },

  async getRoleMeta(roleId) {
    try {
      const snap = await this._roleMetaRefs[roleId].get();
      return snap.val();
    } catch (e) {
      return null;
    }
  },

  bindToRoom(roomId) {
    if (this.currentRoomId === roomId) return;

    if (this.currentRoomId) {
      this.releasePresence();
      this.clearTyping();
      this.detachAllListeners();
    }

    this.currentRoomId = roomId;
    this._ref = this._db.ref("rooms/" + roomId + "/messages");
    this._typingRef = this._db.ref("rooms/" + roomId + "/typing");
    this._presenceRef = this._db.ref("rooms/" + roomId + "/presence");
    this._nameColorsRef = this._db.ref("rooms/" + roomId + "/nameColors");
    this._atPingCooldownRef = this._db.ref("rooms/" + roomId + "/atPingCooldowns");
    this._leaveEventsRef = this._db.ref("rooms/" + roomId + "/leaveEvents");
    this._timeoutsRef = this._db.ref("rooms/" + roomId + "/timeouts");
    this._modRetimeoutRef = this._db.ref("rooms/" + roomId + "/modRetimeoutCooldowns");
  },

  detachAllListeners() {
    if (this._ref) this._ref.off();
    if (this._typingRef) this._typingRef.off();
    if (this._presenceRef) this._presenceRef.off();
    if (this._leaveEventsRef) this._leaveEventsRef.off();
  },

  watchConnection(onStatus) {
    this._connectedRef.on("value", snap => onStatus(snap.val() === true));
  },

  watchMessages(onMessage) {
    this._ref.limitToLast(MAX_MESSAGES).on("child_added", snap => {
      onMessage({ id: snap.key, ...snap.val() });
    });
  },

  // fromAccountKey is stamped on every message so a sender can be added
  // as a friend later even after they've gone offline or left — see
  // openChatUserPopover, which looks the account up fresh by this key
  // rather than relying on live presence. Not rendered anywhere in the
  // chat UI itself, purely a data field for that lookup.
  async sendImage(name, dataUrl) {
    const color = await this.getNameColor(name);
    return this._ref.push({
      name: name,
      fromAccountKey: this._myAccountKey || null,
      imageData: dataUrl,
      ts: firebase.database.ServerValue.TIMESTAMP,
      ...(color ? { bubble: color.bubble, textColor: color.text } : {})
    });
  },

  async send(name, text, mention) {
    const color = await this.getNameColor(name);
    return this._ref.push({
      name: name,
      fromAccountKey: this._myAccountKey || null,
      text: text,
      ts: firebase.database.ServerValue.TIMESTAMP,
      ...(mention ? { mention: mention.name } : {}),
      ...(color ? { bubble: color.bubble, textColor: color.text } : {})
    });
  },

  async getNameColor(name) {
    const snap = await this._nameColorsRef.child(this._safeKey(name)).get();
    return snap.exists() ? snap.val() : null;
  },

  async claimColor(name, bubble, text) {
    const key = this._safeKey(name);
    const ref = this._nameColorsRef.child(key);
    const existing = await ref.get();
    if (existing.exists()) {
      const val = existing.val();
      const serverNow = await this._serverNow();
      const changedAt = val && val.changedAt ? val.changedAt : 0;
      const elapsed = serverNow - changedAt;
      if (elapsed < COLOR_CHANGE_COOLDOWN_MS) {
        return { ok: false, reason: "cooldown", remainingMs: COLOR_CHANGE_COOLDOWN_MS - elapsed };
      }
    }
    await ref.set({ bubble, text, changedAt: firebase.database.ServerValue.TIMESTAMP });
    return { ok: true };
  },

  async isNameTaken(name) {
    const snap = await this._presenceRef.get();
    const val = snap.val() || {};
    const key = this._safeKey(name);
    return Object.prototype.hasOwnProperty.call(val, key);
  },

  async claimPresence(accountKey, name, silent) {
    this.releasePresence();
    this._myAccountKey = accountKey;
    this._myPresenceRef = this._presenceRef.child(accountKey);
    this._silentSession = !!silent;

    const leaveEventRef = this._leaveEventsRef.push();
    if (!this._silentSession) {
      leaveEventRef.onDisconnect().set({ name, accountKey, ts: firebase.database.ServerValue.TIMESTAMP });
    }
    this._myLeaveEventRef = leaveEventRef;

    this._myPresenceRef.onDisconnect().remove();
    this._myPresenceRef.set({ name, joinedAt: firebase.database.ServerValue.TIMESTAMP });

    const roleKey = accountKey;
    for (const role of Object.values(ROLES)) {
      const roleRef = this._roleRefs[role.id].child(roleKey);
      const sameRoleTarget = this._myRoleRefs[role.id] && this._myRoleRefs[role.id].key === roleKey;

      if (!sameRoleTarget) {
        const oldRef = this._myRoleRefs[role.id];
        if (oldRef) {
          oldRef.onDisconnect().cancel();
          oldRef.remove();
        }
        this._myRoleRefs[role.id] = roleRef;

        let heldOnServer = false;
        try {
          const snap = await roleRef.get();
          heldOnServer = snap.val() === true;
        } catch (e) {
          heldOnServer = false;
        }

        if (this._rolesHeld[role.id] || heldOnServer) {
          this._rolesHeld[role.id] = true;
          roleRef.set(true);
        } else {
          roleRef.remove();
        }
        roleRef.onDisconnect().remove();
      }
    }

    if (!this._silentSession) {
      this._ref.push({
        system: true,
        text: name + " joined",
        ts: firebase.database.ServerValue.TIMESTAMP
      });
    }
  },

  releasePresenceSilently() {
    if (this._myLeaveEventRef) {
      this._myLeaveEventRef.onDisconnect().cancel();
      this._myLeaveEventRef = null;
    }
    if (this._myPresenceRef) {
      this._myPresenceRef.onDisconnect().cancel();
      this._myPresenceRef.remove();
      this._myPresenceRef = null;
    }
    this.clearAllRoles();
  },

  releasePresence() {
    if (this._myPresenceRef) {
      this._myPresenceRef.remove();
      this._myPresenceRef = null;
    }
    if (this._myLeaveEventRef) {
      this._myLeaveEventRef.onDisconnect().cancel();
      this._myLeaveEventRef = null;
    }
  },

  clearRole(roleId) {
    const ref = this._myRoleRefs[roleId];
    if (ref) {
      ref.onDisconnect().cancel();
      ref.remove();
      this._myRoleRefs[roleId] = null;
    }
    this._rolesHeld[roleId] = false;
  },

  clearAllRoles() {
    Object.keys(ROLES).forEach(roleId => this.clearRole(roleId));
  },

  watchLeaveEvents() {
    this._leaveEventsRef.on("child_added", snap => {
      const val = snap.val();
      if (!val) { snap.ref.remove(); return; }

      const now = Date.now();
      const lastPosted = this._recentLeaveNames[val.name] || 0;
      const isDuplicate = (now - lastPosted) < LEAVE_DEDUPE_WINDOW_MS;

      snap.ref.remove();
      if (isDuplicate) return;

      this._recentLeaveNames[val.name] = now;
      this._ref.push({
        system: true,
        text: val.name + " left",
        ts: firebase.database.ServerValue.TIMESTAMP
      });
    });
  },

  watchPresenceCount(onCount) {
    this._presenceRef.on("value", snap => {
      const val = snap.val() || {};
      onCount(Object.keys(val).length);
    });
  },

  watchPresenceList(onList) {
    this._presenceRef.on("value", snap => {
      const val = snap.val() || {};
      const list = Object.entries(val).map(([accountKey, v]) => ({
        accountKey,
        name: (v && typeof v === "object" && v.name) ? v.name : accountKey,
        joinedAt: (v && typeof v === "object") ? (v.joinedAt || null) : null
      }));
      const byName = {};
      list.forEach(e => { byName[e.name] = e.accountKey; });
      window._chatPresenceByName = byName;
      onList(list);
    });
  },

  setTyping(name) {
    if (!this._myTypingRef) {
      this._myTypingRef = this._typingRef.child(this._safeKey(name));
      this._myTypingRef.onDisconnect().remove();
    }
    this._myTypingRef.set({ name: name, ts: firebase.database.ServerValue.TIMESTAMP });
  },

  clearTyping() {
    if (this._myTypingRef) this._myTypingRef.remove();
    this._myTypingRef = null;
  },

  watchTyping(onChange, excludeNameFn) {
    this._typingRef.on("value", snap => {
      const val = snap.val() || {};
      const currentExclude = excludeNameFn();
      const entries = Object.values(val)
        .filter(e => e && e.name !== currentExclude)
        .sort((a, b) => (a.ts || 0) - (b.ts || 0))
        .map(e => e.name);
      onChange(entries);
    });
  },

  async tryStartAtPingCooldown(targetName) {
    const key = this._safeKey(targetName);
    const ref = this._atPingCooldownRef.child(key);
    const now = Date.now();
    let resultRemainingMs = 0;
    const txResult = await ref.transaction(current => {
      if (current && typeof current === "number" && (now - current) < AT_PING_COOLDOWN_MS) {
        return;
      }
      return now;
    });
    if (!txResult.committed) {
      const snap = await ref.get();
      const existing = snap.val();
      const elapsed = existing ? (now - existing) : AT_PING_COOLDOWN_MS;
      resultRemainingMs = Math.max(0, AT_PING_COOLDOWN_MS - elapsed);
      return { ok: false, remainingMs: resultRemainingMs };
    }
    return { ok: true };
  },

  async setTimeout_(targetName, durationMs, byName) {
    const serverNow = await this._serverNow();
    await this._timeoutsRef.child(this._safeKey(targetName)).set({
      expiresAt: serverNow + durationMs,
      by: byName ? this._safeKey(byName) : null
    });
  },

  async clearTimeout_(targetName) {
    await this._timeoutsRef.child(this._safeKey(targetName)).remove();
  },

  async getTimeoutSetBy(targetName) {
    try {
      const snap = await this._timeoutsRef.child(this._safeKey(targetName)).get();
      const val = snap.val();
      return (val && val.by) ? val.by : null;
    } catch (e) {
      return null;
    }
  },

  async getTimeoutRemainingMs(targetName) {
    try {
      const snap = await this._timeoutsRef.child(this._safeKey(targetName)).get();
      const val = snap.val();
      if (!val || !val.expiresAt) return 0;
      const serverNow = await this._serverNow();
      return Math.max(0, val.expiresAt - serverNow);
    } catch (e) {
      return 0;
    }
  },

  watchTimeout(targetName, onChange) {
    const ref = this._timeoutsRef.child(this._safeKey(targetName));
    ref.on("value", async snap => {
      const val = snap.val();
      if (!val || !val.expiresAt) { onChange(0); return; }
      const serverNow = await this._serverNow();
      onChange(Math.max(0, val.expiresAt - serverNow));
    });
    return () => ref.off("value");
  },

  async startModRetimeoutCooldown(modName, targetName) {
    const key = this._safeKey(modName) + "__" + this._safeKey(targetName);
    const serverNow = await this._serverNow();
    await this._modRetimeoutRef.child(key).set(serverNow);
  },

  async getModRetimeoutRemainingMs(modName, targetName) {
    try {
      const key = this._safeKey(modName) + "__" + this._safeKey(targetName);
      const snap = await this._modRetimeoutRef.child(key).get();
      const startedAt = snap.val();
      if (!startedAt) return 0;
      const serverNow = await this._serverNow();
      const elapsed = serverNow - startedAt;
      return Math.max(0, MOD_RETIMEOUT_COOLDOWN_MS - elapsed);
    } catch (e) {
      return 0;
    }
  },

  _safeKey(name) {
    const found = (window._chatPresenceByName || {})[name];
    if (found) return found;
    return name.replace(/[.#$\[\]/]/g, "_");
  }
};

const RoomManager = {
  _db: null,
  _metaRootRef: null,
  _publicListRef: null,

  init(db) {
    this._db = db;
    this._metaRootRef = db.ref("roomsMeta");
  },

  _safeCode(code) {
    return String(code).replace(/[.#$\[\]/]/g, "_");
  },

  _randomCode(length) {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < length; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  },

  async _isCodeTaken(code) {
    const snap = await this._metaRootRef.child(this._safeCode(code)).get();
    return snap.exists();
  },

  async _generateUniqueCode() {
    for (let attempt = 0; attempt < 12; attempt++) {
      const candidate = this._randomCode(ROOM_CODE_DEFAULT_LENGTH);
      if (!(await this._isCodeTaken(candidate))) return candidate;
    }
    return this._randomCode(ROOM_CODE_DEFAULT_LENGTH + 2);
  },

  async createRoom(ownerName, roomName) {
    const code = await this._generateUniqueCode();
    const now = Date.now();
    const meta = {
      name: (roomName || "").trim().slice(0, ROOM_NAME_MAX_LENGTH) || null,
      ownerName: ownerName,
      isPublic: false,
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      expiresAt: now + ROOM_DURATION_MS,
      kicked: {}
    };
    await this._metaRootRef.child(this._safeCode(code)).set(meta);
    return { code };
  },

  async getRoomMeta(code) {
    const snap = await this._metaRootRef.child(this._safeCode(code)).get();
    return snap.exists() ? { code, ...snap.val() } : null;
  },

  watchRoomMeta(code, callback) {
    const ref = this._metaRootRef.child(this._safeCode(code));
    const unsubscribe = ref.on("value", snap => {
      callback(snap.exists() ? { code, ...snap.val() } : null);
    });
    return () => ref.off("value", unsubscribe);
  },

  watchPublicRooms(callback) {
    const unsubscribe = this._metaRootRef.on("value", snap => {
      const val = snap.val() || {};
      const now = Date.now();
      const list = Object.entries(val)
        .filter(([code, meta]) => meta && meta.isPublic)
        .map(([code, meta]) => ({ code, ...meta }));
      callback(list);
    });
    return () => this._metaRootRef.off("value", unsubscribe);
  },

  async setPublic(code, isPublic) {
    await this._metaRootRef.child(this._safeCode(code)).child("isPublic").set(!!isPublic);
  },

  async extendRoom(code) {
    const ref = this._metaRootRef.child(this._safeCode(code)).child("expiresAt");
    await ref.transaction(current => (current || Date.now()) + ROOM_EXTEND_MS);
  },

  async changeCode(oldCode, newCode, ownerName) {
    const safeNew = this._safeCode(newCode.trim().slice(0, ROOM_CODE_MAX_LENGTH));
    if (!safeNew) return { ok: false, reason: "empty" };
    if (safeNew === this._safeCode(oldCode)) return { ok: false, reason: "same" };

    const taken = await this._isCodeTaken(safeNew);
    if (taken) return { ok: false, reason: "taken" };

    const oldRef = this._metaRootRef.child(this._safeCode(oldCode));
    const snap = await oldRef.get();
    if (!snap.exists()) return { ok: false, reason: "gone" };
    const meta = snap.val();
    if (meta.ownerName !== ownerName) return { ok: false, reason: "not-owner" };

    await this._metaRootRef.child(safeNew).set(meta);
    await oldRef.remove();
    return { ok: true, newCode: safeNew };
  },

  async kickFromRoom(code, targetName) {
    await this._metaRootRef.child(this._safeCode(code)).child("kicked").child(this._safeKeyName(targetName)).set(true);
  },

  _safeKeyName(name) {
    return name.replace(/[.#$\[\]/]/g, "_");
  },

  async offerTransfer(code, fromName, toName) {
    await this._metaRootRef.child(this._safeCode(code)).child("transferOffer").set({ fromName, toName });
  },

  async cancelTransferOffer(code) {
    await this._metaRootRef.child(this._safeCode(code)).child("transferOffer").remove();
  },

  async acceptTransfer(code, newOwnerName) {
    await this._metaRootRef.child(this._safeCode(code)).update({
      ownerName: newOwnerName,
      transferOffer: null
    });
  },

  async declineTransfer(code) {
    await this._metaRootRef.child(this._safeCode(code)).child("transferOffer").remove();
  },

  async forceTransferOwnership(code, newOwnerName) {
    await this._metaRootRef.child(this._safeCode(code)).update({
      ownerName: newOwnerName,
      transferOffer: null
    });
  },

  async deleteRoom(code) {
    const safe = this._safeCode(code);
    await this._metaRootRef.child(safe).remove();
    await this._db.ref("rooms/" + safe).remove();
  }
};

const $chatScreen  = document.getElementById("chatScreen");
const $messages    = document.getElementById("chatRoomMessages");
const $emptyState  = document.getElementById("chatRoomEmptyState");
const $msgInput    = document.getElementById("chatRoomMsgInput");
const $sendBtn     = document.getElementById("chatRoomSendBtn");
const $onlineDot   = document.getElementById("onlineDot");
const $onlineCount = document.getElementById("onlineCount");
const $connError   = document.getElementById("chatRoomConnError");
const $composerNotice = document.getElementById("chatRoomComposerNotice");
const $youAre      = document.getElementById("youAre");
const $typingBar     = document.getElementById("chatRoomTypingBar");
const $autoScrollBtn = document.getElementById("chatRoomAutoScrollBtn");
const $clearChatBtn  = document.getElementById("chatRoomClearChatBtn");
const $chatRoomUploadImageBtn = document.getElementById("chatRoomUploadImageBtn");
const $chatRoomImageFileInput = document.getElementById("chatRoomImageFileInput");
const $jumpToBottomBtn = document.getElementById("chatRoomJumpToBottomBtn");
const $charCounter    = document.getElementById("chatRoomCharCounter");
const $globalClearPanel = document.getElementById("globalClearPanel");
const $onlineListPanel = document.getElementById("onlineListPanel");
const $chatRoomPendingImageBar = document.getElementById("chatRoomPendingImageBar");
const $chatRoomPendingImagePreview = document.getElementById("chatRoomPendingImagePreview");
const $chatRoomCancelPendingImageBtn = document.getElementById("chatRoomCancelPendingImageBtn");
const $pingYouBtn = document.getElementById("pingYouBtn");
const $pingYouPanel = document.getElementById("pingYouPanel");
const $pingYouNote = document.getElementById("pingYouNote");
const $pingYouSend = document.getElementById("pingYouSend");
const $mentionChip = document.getElementById("mentionChip");
const $mentionDropdown = document.getElementById("mentionDropdown");
const $composerInputWrap = document.getElementById("chatRoomComposerInputWrap");
const $pingToast = document.getElementById("pingToast");
const $pingToastTitle = document.getElementById("pingToastTitle");
const $pingToastBody = document.getElementById("pingToastBody");
const $pingSound = document.getElementById("pingSound");

const $rolesMenuOverlay = document.getElementById("rolesMenuOverlay");
const $rolesMenuList = document.getElementById("rolesMenuList");
const $rolesMenuCloseBtn = document.getElementById("rolesMenuCloseBtn");
const $roleClaimOverlay = document.getElementById("roleClaimOverlay");
const $roleClaimTitle = document.getElementById("roleClaimTitle");
const $roleClaimBody = document.getElementById("roleClaimBody");
const $roleClaimBackBtn = document.getElementById("roleClaimBackBtn");
const $roleClaimCloseBtn = document.getElementById("roleClaimCloseBtn");

let myName = "";
let messageCount = 0;
let autoScroll = true;
let isSpectator = false;
let myTimeoutRemainingMs = 0;
let unwatchMyTimeout = null;
let myTimeoutCountdownTimer = null;
let roleHolders = {};

const SEND_COOLDOWN_MS = 3000;
let lastSentAt = 0;
let cooldownTimer = null;

let isCurrentlyTyping = false;
let chatRoomTypingStopTimer = null;

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isNearBottom() {
  return $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 120;
}

function scrollToBottom() {
  requestAnimationFrame(() => { $messages.scrollTop = $messages.scrollHeight; });
  $jumpToBottomBtn.style.display = "none";
}

/* ══════════════════════════════════════════════════════════
   CHAT-SENDER PROFILE MODAL — clicking a name in chat opens this.
   Resolves the sender via the accountKey STAMPED ON THE MESSAGE
   (msg.fromAccountKey), not live presence — this is what lets you
   add someone as a friend even after they've gone offline. Always
   re-fetches /users/{accountKey} fresh so the username/ID shown are
   current, not whatever was true when the message was sent.
   ══════════════════════════════════════════════════════════ */
const $chatUserProfileOverlay = document.getElementById("chatUserProfileOverlay");
const $chatUserProfileName = document.getElementById("chatUserProfileName");
const $chatUserProfileId = document.getElementById("chatUserProfileId");
const $chatUserProfileStatus = document.getElementById("chatUserProfileStatus");
const $chatUserProfileCloseBtn = document.getElementById("chatUserProfileCloseBtn");
const $chatUserProfileAddBtn = document.getElementById("chatUserProfileAddBtn");

function closeChatUserProfile() {
  $chatUserProfileOverlay.style.display = "none";
}
$chatUserProfileCloseBtn.addEventListener("click", closeChatUserProfile);
$chatUserProfileOverlay.addEventListener("click", (e) => {
  if (e.target === $chatUserProfileOverlay) closeChatUserProfile();
});

async function openChatUserPopover(displayNameAtSendTime, accountKey) {
  $chatUserProfileName.textContent = "Loading…";
  $chatUserProfileId.textContent = "";
  $chatUserProfileStatus.textContent = "";
  $chatUserProfileStatus.style.color = "";
  $chatUserProfileAddBtn.style.display = "none";
  $chatUserProfileOverlay.style.display = "flex";

  if (!accountKey) {
    $chatUserProfileName.textContent = displayNameAtSendTime || "Unknown";
    $chatUserProfileStatus.textContent = "This message is too old to look up — no account link stored.";
    return;
  }

  if (currentSession && accountKey === currentSession.accountKey) {
    $chatUserProfileName.textContent = currentSession.username;
    $chatUserProfileId.textContent = "#" + currentSession.id;
    $chatUserProfileStatus.textContent = "That's you.";
    return;
  }

  let account;
  try {
    const snap = await usersRef.child(accountKey).get();
    account = snap.val();
  } catch (e) {
    account = null;
  }

  if (!account) {
    $chatUserProfileName.textContent = displayNameAtSendTime || "Unknown";
    $chatUserProfileStatus.textContent = "This account no longer exists.";
    return;
  }

  $chatUserProfileName.textContent = account.username;
  $chatUserProfileId.textContent = "#" + account.id;

  const status = currentSession ? getRelationshipStatus(accountKey) : "none";
  if (!currentSession) {
    $chatUserProfileStatus.textContent = "Sign up to add friends.";
  } else if (status === "friends") {
    $chatUserProfileStatus.textContent = "Already friends.";
  } else if (status === "outgoing") {
    $chatUserProfileStatus.textContent = "Friend request pending.";
  } else if (status === "incoming") {
    $chatUserProfileStatus.textContent = "They've sent you a request — check Find.";
  } else {
    $chatUserProfileAddBtn.style.display = "inline-block";
    $chatUserProfileAddBtn.disabled = false;
    $chatUserProfileAddBtn.textContent = "Add Friend";
    $chatUserProfileAddBtn.onclick = async () => {
      $chatUserProfileAddBtn.disabled = true;
      $chatUserProfileAddBtn.textContent = "Sending…";
      const result = await sendFriendRequest(accountKey, account.username);
      if (result.ok) {
        $chatUserProfileStatus.style.color = "#4ade80";
        $chatUserProfileStatus.textContent = "Friend request sent.";
        $chatUserProfileAddBtn.style.display = "none";
      } else {
        $chatUserProfileStatus.style.color = "";
        $chatUserProfileStatus.textContent = result.error;
        $chatUserProfileAddBtn.disabled = false;
        $chatUserProfileAddBtn.textContent = "Add Friend";
      }
    };
  }
}

function renderMessage(msg) {
  $emptyState.style.display = "none";

  if (msg.system) {
    const sysEl = document.createElement("div");
    sysEl.className = "msg system";
    const sysBubble = document.createElement("div");
    sysBubble.className = "msg-bubble";
    sysBubble.textContent = msg.text;
    sysEl.appendChild(sysBubble);
    $messages.appendChild(sysEl);
    messageCount++;
    if (autoScroll) scrollToBottom();

    if (myName && msg.text === myName + " left" && $chatScreen.style.display !== "none" && !spectatorPreviewActive) {
      forceReturnToJoinScreen("You were disconnected from the chat.");
    }
    return;
  }

  const mine = msg.name === myName && !spectatorPreviewActive;
  const el = document.createElement("div");
  el.className = "msg" + (mine ? " mine" : "");

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  if (mine) {
    meta.textContent = "You" + (msg.ts ? " · " + formatTime(msg.ts) : "");
  } else {
    const nameSpan = document.createElement("span");
    nameSpan.className = "msg-meta-name";
    nameSpan.textContent = msg.name;
    nameSpan.addEventListener("click", (e) => {
      e.stopPropagation();
      openChatUserPopover(msg.name, msg.fromAccountKey || null);
    });
    meta.appendChild(nameSpan);
    if (msg.ts) meta.appendChild(document.createTextNode(" · " + formatTime(msg.ts)));
  }
  el.appendChild(meta);

  const safeName = ChatBackend._safeKey(msg.name);
  const heldRoles = Object.values(ROLES).filter(role => (roleHolders[role.id] || new Set()).has(safeName));
  if (heldRoles.length > 0) {
    const row = document.createElement("div");
    row.className = "role-bubble-row";
    heldRoles.forEach(role => {
      const bubble = document.createElement("div");
      bubble.className = role.bubbleClass;
      bubble.textContent = role.icon;
      row.appendChild(bubble);
    });
    el.appendChild(row);
  }

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (msg.imageData) {
    const link = document.createElement("a");
    link.href = msg.imageData;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const img = document.createElement("img");
    img.src = msg.imageData;
    img.alt = "Shared image";
    img.style.cssText = "max-width:100%;max-height:280px;border-radius:10px;display:block";
    link.appendChild(img);
    bubble.appendChild(link);
    bubble.style.padding = "6px";
  } else if (msg.mention) {
    const chip = document.createElement("span");
    chip.className = "mention-chip-inline";
    chip.textContent = "@" + msg.mention;
    bubble.appendChild(chip);
    if (msg.text) {
      bubble.appendChild(document.createTextNode(" " + msg.text));
    }
  } else {
    bubble.textContent = msg.text;
  }

  if (!msg.imageData) {
    if (msg.bubble) bubble.style.background = msg.bubble;
    if (msg.textColor) bubble.style.color = msg.textColor;
  }

  el.appendChild(bubble);
  $messages.appendChild(el);

  messageCount++;
  while (messageCount > MAX_MESSAGES) {
    const first = $messages.querySelector(".msg");
    if (!first) break;
    first.remove();
    messageCount--;
  }

  if (autoScroll && (isNearBottom() || mine)) {
    scrollToBottom();
  } else if (!isNearBottom()) {
    $jumpToBottomBtn.style.display = "block";
  }

  if (!spectatorPreviewActive && msg.mention && msg.mention === myName && msg.name !== myName) {
    triggerIncomingPing(msg.name, msg.text);
  }
}

let hadConnectionDrop = false;

function setConnectionStatus(isOnline) {
  $onlineDot.className = "chat-online-dot" + (isOnline ? "" : " offline");
  if (isOnline) {
    $connError.style.display = "none";

    if (hadConnectionDrop && myName && $chatScreen.style.display !== "none" && !spectatorPreviewActive) {
      hadConnectionDrop = false;
      forceReturnToJoinScreen("Connection dropped — you were disconnected from the chat.");
    } else {
      hadConnectionDrop = false;
    }
  } else {
    hadConnectionDrop = true;
    $connError.textContent = "Disconnected — trying to reconnect…";
    $connError.style.display = "block";
  }
}

function forceReturnToJoinScreen(noticeText) {
  stopTyping();
  clearChatRoomPendingImage();
  closeClearPanel();
  closeOnlineListPanel();
  closePingYouPanel();
  closeMentionDropdown();

  ChatBackend._myPresenceRef = null;
  ChatBackend._myLeaveEventRef = null;
  ChatBackend._myTypingRef = null;

  if (noticeText) showChatRoomComposerNotice(noticeText);

  if (currentSession) {
    enterChatRoomAsCurrentAccount();
  }
}

function isSpectatorName(name) {
  return false; // real chat participants are always logged-in DM accounts
}

let myAccountKey = "";

function enterChatRoomAsCurrentAccount() {
  if (!currentSession) return;
  myName = currentSession.username;
  myAccountKey = currentSession.accountKey;
  isSpectator = false;
  ChatBackend.claimPresence(myAccountKey, myName, false);
  watchMyTimeout();
  requestNotificationPermissionIfNeeded();
  $youAre.textContent = "You: " + myName;
  $chatScreen.style.display = "flex";
  updateComposerLockState();
  scrollToBottom();
}

function exitChatRoom() {
  if (!myAccountKey) return;
  stopTyping();
  clearChatRoomPendingImage();
  ChatBackend.clearAllRoles();
  ChatBackend.releasePresence();
  myName = "";
  myAccountKey = "";
  isSpectator = false;
  $youAre.textContent = "";
  $chatScreen.style.display = "none";
}

function updateSendButtonState() {
  const elapsed = Date.now() - lastSentAt;
  const remaining = SEND_COOLDOWN_MS - elapsed;
  if (remaining > 0) {
    $sendBtn.disabled = true;
    $sendBtn.classList.add("cooldown");
    $sendBtn.textContent = Math.ceil(remaining / 1000) + "s";
    clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(updateSendButtonState, 250);
  } else {
    $sendBtn.disabled = false;
    $sendBtn.classList.remove("cooldown");
    $sendBtn.textContent = "Send";
  }
}

function updateComposerLockState() {
  if (spectatorPreviewActive) { updateSpectatorComposerUI(); return; }
  if (isSpectatorName(myName)) {
    $msgInput.disabled = true;
    $msgInput.placeholder = "Rename to chat — you're spectating";
    $sendBtn.disabled = false;
    $sendBtn.classList.remove("cooldown");
    $sendBtn.textContent = "Rename to chat";
  } else if (myTimeoutRemainingMs > 0) {
    $msgInput.disabled = true;
    $msgInput.placeholder = "Timed out — try again in " + formatCountdown(myTimeoutRemainingMs);
    $sendBtn.disabled = true;
    $sendBtn.classList.add("cooldown");
    $sendBtn.textContent = formatCountdown(myTimeoutRemainingMs);
  } else {
    $msgInput.disabled = false;
    $msgInput.placeholder = "Type a message… (@ to mention someone)";
    updateSendButtonState();
  }
}

function watchMyTimeout() {
  if (unwatchMyTimeout) { unwatchMyTimeout(); unwatchMyTimeout = null; }
  clearInterval(myTimeoutCountdownTimer);
  if (!myName || isSpectatorName(myName)) { myTimeoutRemainingMs = 0; return; }

  unwatchMyTimeout = ChatBackend.watchTimeout(myName, (remainingMs) => {
    myTimeoutRemainingMs = remainingMs;
    updateComposerLockState();
    clearInterval(myTimeoutCountdownTimer);
    if (remainingMs > 0) {
      myTimeoutCountdownTimer = setInterval(() => {
        myTimeoutRemainingMs = Math.max(0, myTimeoutRemainingMs - 1000);
        updateComposerLockState();
        if (myTimeoutRemainingMs <= 0) clearInterval(myTimeoutCountdownTimer);
      }, 1000);
    }
  });
}

function sendMessage() {
  if (spectatorPreviewActive) { handleSpectatorComposerClick(); return; }
  if (myTimeoutRemainingMs > 0) {
    showChatRoomComposerNotice("You're timed out for " + formatCountdown(myTimeoutRemainingMs) + " more.");
    return;
  }
  if (Date.now() - lastSentAt < SEND_COOLDOWN_MS) return;

  const text = $msgInput.value.trim();
  const mentionTarget = currentMentionTarget;

  if (chatRoomPendingImageDataUrl) {
    const imageToSend = chatRoomPendingImageDataUrl;
    clearChatRoomPendingImage();

    lastSentAt = Date.now();
    updateSendButtonState();
    stopTyping();

    ChatBackend.sendImage(myName, imageToSend)
      .then(() => {
        if (text) {
          return ChatBackend.send(myName, text);
        }
      })
      .then(() => {
        $msgInput.value = "";
        autosizeInput();
        updateCharCounter();
        autoScroll = true;
        setAutoScrollUI();
      })
      .catch(() => {
        $connError.textContent = "Image failed to send — check your connection.";
        $connError.style.display = "block";
      })
      .finally(() => { $msgInput.focus(); });
    return;
  }

  if (!text && !mentionTarget) return;

  if (mentionTarget) {
    $sendBtn.disabled = true;
    ChatBackend.tryStartAtPingCooldown(mentionTarget).then(result => {
      $sendBtn.disabled = false;
      if (!result.ok) {
        const secs = Math.ceil(result.remainingMs / 1000);
        showChatRoomComposerNotice(mentionTarget + " was just pinged — wait " + secs + "s before pinging them again.");
        return;
      }
      finalizeSend(text, { name: mentionTarget });
    }).catch(() => {
      $sendBtn.disabled = false;
      showChatRoomComposerNotice("Couldn't check ping cooldown — try again.");
    });
    return;
  }

  finalizeSend(text, null);
}

function finalizeSend(text, mention) {
  lastSentAt = Date.now();
  updateSendButtonState();
  stopTyping();

  ChatBackend.send(myName, text, mention)
    .then(() => {
      $msgInput.value = "";
      clearMention();
      autosizeInput();
      updateCharCounter();
      autoScroll = true;
      setAutoScrollUI();
    })
    .catch(() => {
      $connError.textContent = "Message failed to send — check your connection.";
      $connError.style.display = "block";
    })
    .finally(() => { $msgInput.focus(); });
}

let chatRoomComposerNoticeTimer = null;
function showChatRoomComposerNotice(text) {
  $composerNotice.textContent = text;
  $composerNotice.style.display = "block";
  clearTimeout(chatRoomComposerNoticeTimer);
  chatRoomComposerNoticeTimer = setTimeout(() => {
    $composerNotice.style.display = "none";
  }, 4000);
}

function autosizeInput() {
  $msgInput.style.height = "auto";
  $msgInput.style.height = Math.min($msgInput.scrollHeight, 135) + "px";
}

const CHATROOM_MAX_IMAGE_SOURCE_BYTES = 15 * 1024 * 1024;
const CHATROOM_IMAGE_MAX_DIMENSION = 1000;
const CHATROOM_IMAGE_JPEG_QUALITY = 0.7;

function compressChatRoomImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read file"));
    reader.onload = () => {
      img.onerror = () => reject(new Error("Couldn't decode image"));
      img.onload = () => {
        let { width, height } = img;
        if (width > CHATROOM_IMAGE_MAX_DIMENSION || height > CHATROOM_IMAGE_MAX_DIMENSION) {
          const scale = CHATROOM_IMAGE_MAX_DIMENSION / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", CHATROOM_IMAGE_JPEG_QUALITY));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

let chatRoomPendingImageDataUrl = null;

function clearChatRoomPendingImage() {
  chatRoomPendingImageDataUrl = null;
  $chatRoomPendingImageBar.style.display = "none";
  $chatRoomPendingImagePreview.src = "";
}

function stageImageFile(file) {
  if (!modMenuUnlocked || !imagesEnabledForMe) return;

  if (!file) return;
  if (!file.type.startsWith("image/")) {
    $connError.textContent = "That file isn't an image.";
    $connError.style.display = "block";
    return;
  }
  if (file.size > CHATROOM_MAX_IMAGE_SOURCE_BYTES) {
    $connError.textContent = "Image is too large.";
    $connError.style.display = "block";
    return;
  }

  $chatRoomUploadImageBtn.disabled = true;
  $chatRoomUploadImageBtn.textContent = "Processing…";

  compressChatRoomImageFile(file)
    .then(dataUrl => {
      chatRoomPendingImageDataUrl = dataUrl;
      $chatRoomPendingImagePreview.src = dataUrl;
      $chatRoomPendingImageBar.style.display = "flex";
    })
    .catch(() => {
      $connError.textContent = "Couldn't process that image — try another.";
      $connError.style.display = "block";
    })
    .finally(() => {
      $chatRoomUploadImageBtn.disabled = false;
      $chatRoomUploadImageBtn.textContent = "📎 Image";
      $chatRoomImageFileInput.value = "";
    });
}

$chatRoomCancelPendingImageBtn.addEventListener("click", clearChatRoomPendingImage);

$chatRoomUploadImageBtn.addEventListener("click", () => {
  if (!modMenuUnlocked) return;
  $chatRoomImageFileInput.click();
});
$chatRoomImageFileInput.addEventListener("change", () => {
  const file = $chatRoomImageFileInput.files[0];
  stageImageFile(file);
});

function updateCharCounter() {
  const remaining = MAX_CHARS - $msgInput.value.length;
  $charCounter.textContent = remaining;
  $charCounter.classList.toggle("warn", remaining <= 50 && remaining > 10);
  $charCounter.classList.toggle("limit", remaining <= 10);
}

function setAutoScrollUI() {
  $autoScrollBtn.textContent = "Auto Scroll: " + (autoScroll ? "On" : "Off");
  $autoScrollBtn.classList.toggle("active", autoScroll);
  if (autoScroll) scrollToBottom();
}

$autoScrollBtn.addEventListener("click", () => {
  autoScroll = !autoScroll;
  setAutoScrollUI();
});

$messages.addEventListener("scroll", () => {
  if (isNearBottom()) {
    $jumpToBottomBtn.style.display = "none";
  }
});

$jumpToBottomBtn.addEventListener("click", () => {
  scrollToBottom();
});

$clearChatBtn.addEventListener("click", () => {
  $messages.innerHTML = "";
  messageCount = 0;
  $emptyState.style.display = "flex";
  $jumpToBottomBtn.style.display = "none";
});

const modMenuUnlocked = true;
let imagesEnabledForMe = false;

function updateUploadButtonVisibility() {
  const visible = modMenuUnlocked && imagesEnabledForMe;
  $chatRoomUploadImageBtn.style.display = visible ? "inline-block" : "none";
}

async function renderModMenu() {
  $globalClearPanel.innerHTML = "";
  $globalClearPanel.style.width = "260px";
  const title = document.createElement("div");
  title.textContent = "Customize your bubble";
  title.style.cssText = "color:#f1f5f9;font-weight:600;margin-bottom:10px";
  $globalClearPanel.appendChild(title);

  const loading = document.createElement("div");
  loading.textContent = "Loading…";
  loading.style.cssText = "color:#64748b;font-size:14px";
  $globalClearPanel.appendChild(loading);

  let existing = null;
  try {
    existing = myName ? await ChatBackend.getNameColor(myName) : null;
  } catch (e) {}

  loading.remove();

  let pendingBubble = (existing && existing.bubble) || "#14532d";
  let pendingText = (existing && existing.text) || "#f1f5f9";

  const previewWrap = document.createElement("div");
  previewWrap.style.cssText = "margin-bottom:10px";
  const previewLabel = document.createElement("div");
  previewLabel.textContent = "Preview";
  previewLabel.style.cssText = "color:#94a3b8;font-size:13px;margin-bottom:4px";
  const previewBubble = document.createElement("div");
  previewBubble.className = "msg-bubble";
  previewBubble.textContent = "Example message text";
  previewBubble.style.cssText = `background:${pendingBubble};color:${pendingText};font-size:16px;padding:10px 14px;display:inline-block;max-width:100%;`;
  previewWrap.appendChild(previewLabel);
  previewWrap.appendChild(previewBubble);
  $globalClearPanel.appendChild(previewWrap);

  const makeColorRow = (labelText, currentValue, onChange) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:8px";
    const lbl = document.createElement("label");
    lbl.textContent = labelText;
    lbl.style.color = "#94a3b8";
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = currentValue;
    colorInput.style.cssText = "width:36px;height:28px;border:none;background:none;cursor:pointer;padding:0";
    colorInput.addEventListener("input", () => onChange(colorInput.value));
    wrap.appendChild(lbl);
    wrap.appendChild(colorInput);
    return wrap;
  };

  $globalClearPanel.appendChild(
    makeColorRow("Bubble color", pendingBubble, (val) => {
      pendingBubble = val;
      previewBubble.style.background = val;
    })
  );
  $globalClearPanel.appendChild(
    makeColorRow("Text color", pendingText, (val) => {
      pendingText = val;
      previewBubble.style.color = val;
    })
  );

  const note = document.createElement("div");
  note.textContent = "Note: color can be changed again every " + Math.round(COLOR_CHANGE_COOLDOWN_MS / 1000) + " seconds.";
  note.style.cssText = "color:#64748b;font-size:12.5px;margin-bottom:10px;line-height:1.4";
  $globalClearPanel.appendChild(note);

  const confirmErr = document.createElement("div");
  confirmErr.style.cssText = "color:#ef4444;font-size:13px;min-height:16px;margin-bottom:4px";
  $globalClearPanel.appendChild(confirmErr);

  const confirmBtn = document.createElement("button");
  confirmBtn.textContent = "Confirm";
  confirmBtn.className = "toolbar-btn";
  confirmBtn.style.cssText = "width:100%;margin-top:4px";
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Saving…";
    try {
      const result = await ChatBackend.claimColor(myName, pendingBubble, pendingText);
      if (result.ok) {
        renderModMenu();
      } else if (result.reason === "cooldown") {
        const secs = Math.ceil(result.remainingMs / 1000);
        confirmErr.textContent = "Wait " + secs + "s before changing your color again.";
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Confirm";
      } else {
        confirmErr.textContent = "Couldn't save — try again.";
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Confirm";
      }
    } catch (e) {
      confirmErr.textContent = "Couldn't save — try again.";
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm";
    }
  });
  $globalClearPanel.appendChild(confirmBtn);

  const divider = document.createElement("div");
  divider.style.cssText = "height:1px;background:#334155;margin:12px 0";
  $globalClearPanel.appendChild(divider);

  const imgTitle = document.createElement("div");
  imgTitle.textContent = "Images (this session, just you)";
  imgTitle.style.cssText = "color:#f1f5f9;font-weight:600;margin-bottom:8px";
  $globalClearPanel.appendChild(imgTitle);

  const imgRow = document.createElement("div");
  imgRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px";
  const imgLabel = document.createElement("label");
  imgLabel.textContent = "Allow images (me)";
  imgLabel.style.color = "#94a3b8";
  const imgToggle = document.createElement("button");
  imgToggle.className = "toolbar-btn" + (imagesEnabledForMe ? " active" : "");
  imgToggle.textContent = imagesEnabledForMe ? "On" : "Off";
  imgToggle.style.cssText = "padding:4px 14px";
  imgToggle.addEventListener("click", () => {
    imagesEnabledForMe = !imagesEnabledForMe;
    imgToggle.className = "toolbar-btn" + (imagesEnabledForMe ? " active" : "");
    imgToggle.textContent = imagesEnabledForMe ? "On" : "Off";
    updateUploadButtonVisibility();
  });
  imgRow.appendChild(imgLabel);
  imgRow.appendChild(imgToggle);
  $globalClearPanel.appendChild(imgRow);

  const imgNote = document.createElement("div");
  imgNote.textContent = "Only affects you, only this session. No one else ever gets an image button, and this resets to Off next time you open the chat.";
  imgNote.style.cssText = "color:#64748b;font-size:12px;line-height:1.4;margin-bottom:4px";
  $globalClearPanel.appendChild(imgNote);

  const rolesDivider = document.createElement("div");
  rolesDivider.style.cssText = "height:1px;background:#334155;margin:12px 0";
  $globalClearPanel.appendChild(rolesDivider);

  const rolesBtn = document.createElement("button");
  rolesBtn.textContent = "🎖 Claim a role";
  rolesBtn.className = "toolbar-btn";
  rolesBtn.style.cssText = "width:100%;margin-bottom:6px";
  rolesBtn.addEventListener("click", () => {
    closeClearPanel();
    openRolesMenu();
  });
  $globalClearPanel.appendChild(rolesBtn);

  const iAmCrowned = modMenuUnlocked && myName && (roleHolders.crown || new Set()).has(ChatBackend._safeKey(myName));
  if (iAmCrowned) {
    const ownerBtn = document.createElement("button");
    ownerBtn.textContent = "👑 Owner Menu";
    ownerBtn.className = "toolbar-btn";
    ownerBtn.style.cssText = "width:100%;margin-bottom:6px";
    ownerBtn.addEventListener("click", () => {
      closeClearPanel();
      openOwnerMenu();
    });
    $globalClearPanel.appendChild(ownerBtn);
  }

  const iAmModded = modMenuUnlocked && myName && (roleHolders.mod || new Set()).has(ChatBackend._safeKey(myName));
  if (iAmModded) {
    const modMenuBtn = document.createElement("button");
    modMenuBtn.textContent = "🧩 Mod Menu";
    modMenuBtn.className = "toolbar-btn";
    modMenuBtn.style.cssText = "width:100%;margin-bottom:6px";
    modMenuBtn.addEventListener("click", () => {
      closeClearPanel();
      openModMenuStaff();
    });
    $globalClearPanel.appendChild(modMenuBtn);
  }

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.className = "toolbar-btn";
  closeBtn.style.cssText = "width:100%;margin-top:6px";
  closeBtn.addEventListener("click", closeClearPanel);
  $globalClearPanel.appendChild(closeBtn);
}

function closeClearPanel() {
  $globalClearPanel.style.display = "none";
  if (!modMenuUnlocked) $globalClearPanel.innerHTML = "";
}

function openModMenu() {
  if (!currentSession) return;
  closeOnlineListPanel();
  $globalClearPanel.style.display = "block";
  renderModMenu();
}

function openRolesMenu() {
  $rolesMenuList.innerHTML = "";
  Object.values(ROLES).forEach(role => {
    const btn = document.createElement("button");
    btn.className = "role-menu-option";
    btn.innerHTML = `<span><span class="role-menu-icon">${role.icon}</span> ${esc(role.label)}</span><span style="color:#64748b;font-size:12px">Claim →</span>`;
    btn.addEventListener("click", () => {
      $rolesMenuOverlay.style.display = "none";
      openRoleClaimModal(role.id);
    });
    $rolesMenuList.appendChild(btn);
  });
  $rolesMenuOverlay.style.display = "flex";
}

$rolesMenuCloseBtn.addEventListener("click", () => {
  $rolesMenuOverlay.style.display = "none";
});
$rolesMenuOverlay.addEventListener("click", (e) => {
  if (e.target === $rolesMenuOverlay) $rolesMenuOverlay.style.display = "none";
});

let activeRoleClaimId = null;
let roleClaimStatusTimer = null;

function roleRequestCooldownRemainingMs(role) {
  try {
    const last = parseInt(localStorage.getItem(role.cooldownKey) || "0", 10);
    return Math.max(0, ROLE_REQUEST_COOLDOWN_MS - (Date.now() - last));
  } catch (e) { return 0; }
}

function openRoleClaimModal(roleId) {
  activeRoleClaimId = roleId;
  renderRoleClaimModal(roleId);
  $roleClaimOverlay.style.display = "flex";
}

function renderRoleClaimModal(roleId) {
  const role = ROLES[roleId];
  clearInterval(roleClaimStatusTimer);
  $roleClaimTitle.textContent = role.icon + " " + role.label + " role";
  $roleClaimBody.innerHTML = "";

  const reqBtn = document.createElement("button");
  reqBtn.className = "toolbar-btn";
  reqBtn.style.cssText = "width:100%;margin-bottom:10px";

  function updateReqBtnState() {
    const remaining = roleRequestCooldownRemainingMs(role);
    if (remaining > 0) {
      reqBtn.disabled = true;
      reqBtn.textContent = "Wait " + Math.ceil(remaining / 1000) + "s";
      setTimeout(updateReqBtnState, 500);
    } else {
      reqBtn.disabled = false;
      reqBtn.textContent = "Request " + role.label + " Code";
    }
  }
  updateReqBtnState();

  reqBtn.addEventListener("click", async () => {
    if (roleRequestCooldownRemainingMs(role) > 0) return;
    try { localStorage.setItem(role.cooldownKey, String(Date.now())); } catch (e) {}
    updateReqBtnState();
    reqBtn.textContent = "Sending…";
    try {
      const result = await ChatBackend.generateRoleCode(role.id);
      reqBtn.textContent = result.webhookOk ? "Sent to Discord ✓" : "Saved, but Discord post failed";
      refreshRoleClaimStatus(role);
    } catch (e) {
      reqBtn.textContent = "Failed — try again";
    }
  });
  $roleClaimBody.appendChild(reqBtn);

  const statusEl = document.createElement("div");
  statusEl.style.cssText = "font-family:monospace;font-size:13px;color:#94a3b8;margin-bottom:8px;min-height:16px";
  $roleClaimBody.appendChild(statusEl);

  async function refreshRoleClaimStatus(role) {
    clearInterval(roleClaimStatusTimer);
    try {
      const current = await ChatBackend.getRoleMeta(role.id);
      if (!current || !current.code || current.code === "0000") {
        statusEl.textContent = "No active code right now.";
        return;
      }
      const offset = await ChatBackend._serverOffset();
      const tick = () => {
        const remaining = current.expiresAt - (Date.now() + offset);
        if (remaining <= 0) {
          statusEl.textContent = "The last code has expired.";
          clearInterval(roleClaimStatusTimer);
          return;
        }
        statusEl.textContent = "A code is active on Discord — expires in " + Math.ceil(remaining / 1000) + "s";
      };
      tick();
      roleClaimStatusTimer = setInterval(tick, 1000);
    } catch (e) {
      statusEl.textContent = "Couldn't check code status.";
    }
  }
  refreshRoleClaimStatus(role);

  const codeInput = document.createElement("input");
  codeInput.type = "text";
  codeInput.inputMode = "numeric";
  codeInput.pattern = "[0-9]*";
  codeInput.maxLength = 4;
  codeInput.placeholder = "Enter " + role.label.toLowerCase() + " code…";
  codeInput.style.cssText = "width:100%;padding:8px 10px;background:#0f172a;border:1.5px solid #334155;border-radius:8px;color:#f1f5f9;font-size:14px;outline:none;margin-bottom:6px";
  $roleClaimBody.appendChild(codeInput);

  const claimErr = document.createElement("div");
  claimErr.style.cssText = "color:#ef4444;font-size:12.5px;min-height:16px;margin-bottom:4px";
  $roleClaimBody.appendChild(claimErr);

  let submitInFlight = false;

  const submitBtn = document.createElement("button");
  submitBtn.textContent = "Claim " + role.label;
  submitBtn.className = "toolbar-btn";
  submitBtn.style.cssText = "width:100%";
  submitBtn.addEventListener("click", async () => {
    if (submitInFlight) return;
    if (!myName) { claimErr.style.color = "#ef4444"; claimErr.textContent = "Join with a name first."; return; }
    submitInFlight = true;
    submitBtn.disabled = true;
    claimErr.textContent = "";
    try {
      const result = await ChatBackend.redeemRoleCode(role.id, codeInput.value);
      if (result.ok) {
        claimErr.style.color = "#4ade80";
        claimErr.textContent = role.icon + " " + role.label + " claimed!";
        codeInput.value = "";
      } else {
        claimErr.style.color = "#ef4444";
        const reasonText = {
          none: "Enter a code first.",
          wrong: "That's not the current code — check Discord for the latest one.",
          expired: "That code expired — request a new one."
        };
        claimErr.textContent = reasonText[result.reason] || "Invalid code.";
      }
      refreshRoleClaimStatus(role);
    } catch (e) {
      claimErr.style.color = "#ef4444";
      claimErr.textContent = "Couldn't check code — try again.";
    } finally {
      submitBtn.disabled = false;
      submitInFlight = false;
    }
  });
  $roleClaimBody.appendChild(submitBtn);
}

$roleClaimBackBtn.addEventListener("click", () => {
  $roleClaimOverlay.style.display = "none";
  clearInterval(roleClaimStatusTimer);
  openRolesMenu();
});
$roleClaimCloseBtn.addEventListener("click", () => {
  $roleClaimOverlay.style.display = "none";
  clearInterval(roleClaimStatusTimer);
});
$roleClaimOverlay.addEventListener("click", (e) => {
  if (e.target === $roleClaimOverlay) {
    $roleClaimOverlay.style.display = "none";
    clearInterval(roleClaimStatusTimer);
  }
});

const $ownerMenuOverlay = document.getElementById("ownerMenuOverlay");
const $ownerMenuTitle = document.getElementById("ownerMenuTitle");
const $ownerMenuSubtitle = document.getElementById("ownerMenuSubtitle");
const $ownerMenuList = document.getElementById("ownerMenuList");
const $ownerMenuCloseBtn = document.getElementById("ownerMenuCloseBtn");

const $timeoutSetOverlay = document.getElementById("timeoutSetOverlay");
const $timeoutSetTitle = document.getElementById("timeoutSetTitle");
const $timeoutSetNote = document.getElementById("timeoutSetNote");
const $timeoutMinutesInput = document.getElementById("timeoutMinutesInput");
const $timeoutSecondsInput = document.getElementById("timeoutSecondsInput");
const $timeoutSetErr = document.getElementById("timeoutSetErr");
const $timeoutSetCancelBtn = document.getElementById("timeoutSetCancelBtn");
const $timeoutSetConfirmBtn = document.getElementById("timeoutSetConfirmBtn");

const $grantModConfirmOverlay = document.getElementById("grantModConfirmOverlay");
const $grantModConfirmText = document.getElementById("grantModConfirmText");
const $grantModConfirmTitle = document.getElementById("grantModConfirmTitle");
const $grantModCancelBtn = document.getElementById("grantModCancelBtn");
const $grantModConfirmBtn = document.getElementById("grantModConfirmBtn");

let staffMenuMode = "owner";
let ownerMenuRefreshTimer = null;
let pendingTimeoutTarget = null;
let pendingGrantModTarget = null;

function isCrownHolder(name) {
  return !!(name && (roleHolders.crown || new Set()).has(ChatBackend._safeKey(name)));
}
function isModHolder(name) {
  return !!(name && (roleHolders.mod || new Set()).has(ChatBackend._safeKey(name)));
}

function openOwnerMenu() {
  staffMenuMode = "owner";
  closeClearPanel();
  $ownerMenuTitle.textContent = "👑 Owner Menu";
  $ownerMenuSubtitle.textContent = "Online now — refreshes every 5s while this is open.";
  renderOwnerMenuList();
  $ownerMenuOverlay.style.display = "flex";
  clearInterval(ownerMenuRefreshTimer);
  ownerMenuRefreshTimer = setInterval(renderOwnerMenuList, 5000);
}

function openModMenuStaff() {
  staffMenuMode = "mod";
  closeClearPanel();
  $ownerMenuTitle.textContent = "🧩 Mod Menu";
  $ownerMenuSubtitle.textContent = "Online now — refreshes every 5s while this is open. Timeouts only, up to 0:40.";
  renderOwnerMenuList();
  $ownerMenuOverlay.style.display = "flex";
  clearInterval(ownerMenuRefreshTimer);
  ownerMenuRefreshTimer = setInterval(renderOwnerMenuList, 5000);
}

function closeOwnerMenu() {
  $ownerMenuOverlay.style.display = "none";
  clearInterval(ownerMenuRefreshTimer);
}

$ownerMenuCloseBtn.addEventListener("click", closeOwnerMenu);
$ownerMenuOverlay.addEventListener("click", (e) => {
  if (e.target === $ownerMenuOverlay) closeOwnerMenu();
});

async function renderOwnerMenuList() {
  const stillEligible = staffMenuMode === "owner"
    ? (modMenuUnlocked && isCrownHolder(myName))
    : (modMenuUnlocked && isModHolder(myName));
  if (!stillEligible) {
    closeOwnerMenu();
    return;
  }

  $ownerMenuList.innerHTML = "";

  const others = latestPresenceList
    .map(e => e.name)
    .filter(name => name !== myName)
    .sort((a, b) => a.localeCompare(b));

  if (others.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rooms-empty";
    empty.textContent = "No one else online right now.";
    $ownerMenuList.appendChild(empty);
    return;
  }

  for (const name of others) {
    const row = document.createElement("div");
    row.className = "room-member-row";

    const nameEl = document.createElement("span");
    nameEl.className = "room-member-name";
    const badges = (isCrownHolder(name) ? "👑 " : "") + (isModHolder(name) ? "🧩 " : "");
    nameEl.textContent = badges + name;
    row.appendChild(nameEl);

    const actions = document.createElement("div");
    actions.className = "room-member-actions";

    if (staffMenuMode === "owner") {
      const modToggleBtn = document.createElement("button");
      if (isModHolder(name)) {
        modToggleBtn.className = "kick";
        modToggleBtn.textContent = "Remove Mod";
        modToggleBtn.addEventListener("click", () => openRemoveModConfirm(name));
      } else {
        modToggleBtn.textContent = "Grant Mod";
        modToggleBtn.addEventListener("click", () => openGrantModConfirm(name));
      }
      actions.appendChild(modToggleBtn);
    }

    const timeoutBtn = document.createElement("button");
    timeoutBtn.className = "kick";
    let remainingMs = 0;
    let setBy = null;
    try {
      remainingMs = await ChatBackend.getTimeoutRemainingMs(name);
      if (remainingMs > 0) setBy = await ChatBackend.getTimeoutSetBy(name);
    } catch (e) {}

    if (remainingMs > 0) {
      timeoutBtn.textContent = "Timed out (" + formatCountdown(remainingMs) + ")";
      const canClear = staffMenuMode === "owner" || (staffMenuMode === "mod" && setBy === ChatBackend._safeKey(myName));
      if (canClear) {
        timeoutBtn.addEventListener("click", () => {
          ChatBackend.clearTimeout_(name).then(async () => {
            if (staffMenuMode === "mod") {
              await ChatBackend.startModRetimeoutCooldown(myName, name).catch(() => {});
            }
            renderOwnerMenuList();
          }).catch(() => {
            showChatRoomComposerNotice("Couldn't clear timeout — try again.");
          });
        });
        timeoutBtn.title = "Click to clear this timeout early";
      } else {
        timeoutBtn.disabled = true;
        timeoutBtn.title = "Only the mod who set this can clear it early";
      }
    } else {
      let cooldownMs = 0;
      if (staffMenuMode === "mod") {
        try { cooldownMs = await ChatBackend.getModRetimeoutRemainingMs(myName, name); } catch (e) {}
      }
      if (cooldownMs > 0) {
        timeoutBtn.textContent = "Wait " + Math.ceil(cooldownMs / 1000) + "s";
        timeoutBtn.disabled = true;
        timeoutBtn.title = "Re-timeout cooldown for this person";
      } else {
        timeoutBtn.textContent = "Timeout";
        timeoutBtn.addEventListener("click", () => openTimeoutSetModal(name));
      }
    }
    actions.appendChild(timeoutBtn);

    row.appendChild(actions);
    $ownerMenuList.appendChild(row);
  }
}

function openTimeoutSetModal(targetName) {
  pendingTimeoutTarget = targetName;
  $timeoutSetTitle.textContent = "Timeout " + targetName;

  if (staffMenuMode === "mod") {
    const defaultSecs = MOD_TIMEOUT_DEFAULT_MS / 1000;
    $timeoutMinutesInput.value = String(Math.floor(defaultSecs / 60));
    $timeoutSecondsInput.value = String(defaultSecs % 60);
    $timeoutSetNote.textContent = "Max " + Math.round(MOD_TIMEOUT_MAX_MS / 1000) + " seconds.";
  } else {
    $timeoutMinutesInput.value = "";
    $timeoutSecondsInput.value = "";
    $timeoutSetNote.textContent = "Max 3:00.";
  }

  $timeoutSetErr.textContent = "";
  $timeoutSetOverlay.style.display = "flex";
  $timeoutMinutesInput.focus();
}

$timeoutSetCancelBtn.addEventListener("click", () => {
  pendingTimeoutTarget = null;
  $timeoutSetOverlay.style.display = "none";
});
$timeoutSetOverlay.addEventListener("click", (e) => {
  if (e.target === $timeoutSetOverlay) {
    pendingTimeoutTarget = null;
    $timeoutSetOverlay.style.display = "none";
  }
});

$timeoutMinutesInput.addEventListener("input", () => {
  $timeoutMinutesInput.value = $timeoutMinutesInput.value.replace(/[^0-9]/g, "").slice(0, 1);
});
$timeoutSecondsInput.addEventListener("input", () => {
  $timeoutSecondsInput.value = $timeoutSecondsInput.value.replace(/[^0-9]/g, "").slice(0, 2);
});

$timeoutSetConfirmBtn.addEventListener("click", async () => {
  if (!pendingTimeoutTarget) return;
  const mins = parseInt($timeoutMinutesInput.value || "0", 10) || 0;
  const secs = parseInt($timeoutSecondsInput.value || "0", 10) || 0;
  const totalMs = (mins * 60 + secs) * 1000;
  const cap = staffMenuMode === "mod" ? MOD_TIMEOUT_MAX_MS : TIMEOUT_MAX_MS;
  const capLabel = staffMenuMode === "mod" ? "40 seconds" : "3:00";

  if (totalMs <= 0) {
    $timeoutSetErr.textContent = "Enter a duration greater than 0.";
    return;
  }
  if (totalMs > cap) {
    $timeoutSetErr.textContent = "Max timeout is " + capLabel + ".";
    return;
  }

  $timeoutSetConfirmBtn.disabled = true;
  $timeoutSetErr.textContent = "";
  try {
    await ChatBackend.setTimeout_(pendingTimeoutTarget, totalMs, myName);
    if (staffMenuMode === "mod") {
      watchModIssuedTimeoutExpiry(myName, pendingTimeoutTarget);
    }
    $timeoutSetOverlay.style.display = "none";
    pendingTimeoutTarget = null;
    renderOwnerMenuList();
  } catch (e) {
    $timeoutSetErr.textContent = "Couldn't set timeout — try again.";
  } finally {
    $timeoutSetConfirmBtn.disabled = false;
  }
});

function watchModIssuedTimeoutExpiry(modName, targetName) {
  const key = ChatBackend._safeKey(targetName);
  const ref = ChatBackend._timeoutsRef.child(key);
  let expiryTimer = null;
  let done = false;

  const finish = async () => {
    if (done) return;
    done = true;
    clearTimeout(expiryTimer);
    ref.off("value", handler);
    await ChatBackend.startModRetimeoutCooldown(modName, targetName).catch(() => {});
    if ($ownerMenuOverlay.style.display === "flex") renderOwnerMenuList();
  };

  const handler = ref.on("value", async snap => {
    if (done) return;
    const val = snap.val();
    clearTimeout(expiryTimer);
    if (!val || !val.expiresAt) { finish(); return; }
    const serverNow = await ChatBackend._serverNow();
    const remaining = val.expiresAt - serverNow;
    if (remaining <= 0) { finish(); return; }
    expiryTimer = setTimeout(finish, remaining);
  });
}

let pendingModConfirmAction = null;

function openGrantModConfirm(targetName) {
  pendingGrantModTarget = targetName;
  pendingModConfirmAction = "grant";
  $grantModConfirmTitle.textContent = "🧩 Grant Mod?";
  $grantModConfirmText.textContent = "Give " + targetName + " the 🧩 Mod tag? This is a second confirmation step so a misclick can't hand it out by accident.";
  $grantModConfirmBtn.textContent = "Yes, grant Mod";
  $grantModConfirmOverlay.style.display = "flex";
}

function openRemoveModConfirm(targetName) {
  pendingGrantModTarget = targetName;
  pendingModConfirmAction = "remove";
  $grantModConfirmTitle.textContent = "🧩 Remove Mod?";
  $grantModConfirmText.textContent = "Remove the 🧩 Mod tag from " + targetName + "? This is a second confirmation step so a misclick can't take it away by accident.";
  $grantModConfirmBtn.textContent = "Yes, remove Mod";
  $grantModConfirmOverlay.style.display = "flex";
}

$grantModCancelBtn.addEventListener("click", () => {
  pendingGrantModTarget = null;
  pendingModConfirmAction = null;
  $grantModConfirmOverlay.style.display = "none";
});
$grantModConfirmOverlay.addEventListener("click", (e) => {
  if (e.target === $grantModConfirmOverlay) {
    pendingGrantModTarget = null;
    pendingModConfirmAction = null;
    $grantModConfirmOverlay.style.display = "none";
  }
});

$grantModConfirmBtn.addEventListener("click", async () => {
  if (!pendingGrantModTarget || !pendingModConfirmAction) return;
  $grantModConfirmBtn.disabled = true;
  try {
    const modRef = ChatBackend._roleRefs.mod.child(ChatBackend._safeKey(pendingGrantModTarget));
    if (pendingModConfirmAction === "grant") {
      await modRef.set(true);
    } else {
      await modRef.remove();
    }
    $grantModConfirmOverlay.style.display = "none";
    pendingGrantModTarget = null;
    pendingModConfirmAction = null;
    renderOwnerMenuList();
  } catch (e) {
    showChatRoomComposerNotice("Couldn't update Mod status — try again.");
  } finally {
    $grantModConfirmBtn.disabled = false;
  }
});

let latestPresenceList = [];
let onlineListRefreshTimer = null;

function formatElapsed(joinedAt) {
  if (!joinedAt) return "just now";
  const secs = Math.max(0, Math.floor((Date.now() - joinedAt) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + "m";
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return hrs + "h" + (remMins ? " " + remMins + "m" : "");
}

function renderOnlineListPanel() {
  $onlineListPanel.innerHTML = "";

  const title = document.createElement("div");
  title.textContent = "Online now";
  title.style.cssText = "color:#f1f5f9;font-weight:600;margin-bottom:8px";
  $onlineListPanel.appendChild(title);

  if (latestPresenceList.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "No one online.";
    empty.style.cssText = "color:#64748b;font-size:13.5px";
    $onlineListPanel.appendChild(empty);
    return;
  }

  const sorted = [...latestPresenceList].sort((a, b) => (a.joinedAt || Date.now()) - (b.joinedAt || Date.now()));

  sorted.forEach(entry => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid #273549;font-size:13.5px";
    const nameEl = document.createElement("span");
    const safeName = ChatBackend._safeKey(entry.name);
    const icons = Object.values(ROLES).filter(role => (roleHolders[role.id] || new Set()).has(safeName)).map(role => role.icon).join(" ");
    nameEl.textContent = (icons ? icons + " " : "") + entry.name;
    nameEl.style.cssText = "color:#f1f5f9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    const timeEl = document.createElement("span");
    timeEl.textContent = formatElapsed(entry.joinedAt);
    timeEl.style.cssText = "color:#64748b;flex-shrink:0";
    row.appendChild(nameEl);
    row.appendChild(timeEl);
    $onlineListPanel.appendChild(row);
  });
}

function closeOnlineListPanel() {
  $onlineListPanel.style.display = "none";
  clearInterval(onlineListRefreshTimer);
}

function openOnlineListPanel() {
  closeClearPanel();
  $onlineListPanel.style.display = "block";
  renderOnlineListPanel();
  clearInterval(onlineListRefreshTimer);
  onlineListRefreshTimer = setInterval(renderOnlineListPanel, 30000);
}

$onlineCount.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = $onlineListPanel.style.display === "block";
  if (isOpen) {
    closeOnlineListPanel();
  } else {
    openOnlineListPanel();
  }
});

document.addEventListener("click", (e) => {
  if ($onlineListPanel.style.display === "block" && !$onlineListPanel.contains(e.target) && e.target !== $onlineCount) {
    closeOnlineListPanel();
  }
});

$onlineDot.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!currentSession) return;
  const isOpen = $globalClearPanel.style.display === "block";
  if (isOpen) {
    closeClearPanel();
  } else {
    openModMenu();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== ".") return;
  if (!modMenuUnlocked || !currentSession) return;
  const active = document.activeElement;
  const isTypingSomewhere = active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT");
  if (isTypingSomewhere) return;
  const isOpen = $globalClearPanel.style.display === "block";
  if (isOpen) {
    closeClearPanel();
  } else {
    openModMenu();
  }
});

document.addEventListener("click", (e) => {
  if (!modMenuUnlocked && $globalClearPanel.style.display === "block" && !$globalClearPanel.contains(e.target)) {
    closeClearPanel();
  }
});

function handleTypingActivity() {
  const hasText = $msgInput.value.trim().length > 0;
  clearTimeout(chatRoomTypingStopTimer);

  if (hasText) {
    if (!isCurrentlyTyping) {
      isCurrentlyTyping = true;
      ChatBackend.setTyping(myName);
    } else {
      ChatBackend.setTyping(myName);
    }
    chatRoomTypingStopTimer = setTimeout(stopTyping, 2000);
  } else {
    stopTyping();
  }
}

function stopTyping() {
  clearTimeout(chatRoomTypingStopTimer);
  if (isCurrentlyTyping) {
    isCurrentlyTyping = false;
    ChatBackend.clearTyping();
  }
}

function renderTyping(names) {
  if (names.length === 0) {
    $typingBar.style.display = "none";
    return;
  }
  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  let text = shown.map(esc).join(", ");
  if (extra > 0) text += `, +${extra} more`;
  text += (names.length === 1 ? " is typing…" : " are typing…");
  $typingBar.textContent = text;
  $typingBar.style.display = "block";
}

function getPingYouRemainingMs() {
  try {
    const last = parseInt(localStorage.getItem(PING_YOU_STORAGE_KEY) || "0", 10);
    const elapsed = Date.now() - last;
    return Math.max(0, PING_YOU_COOLDOWN_MS - elapsed);
  } catch (e) {
    return 0;
  }
}

function updatePingYouButtonState() {
  const remaining = getPingYouRemainingMs();
  if (remaining > 0) {
    $pingYouBtn.disabled = true;
    $pingYouBtn.textContent = "🔔 " + Math.ceil(remaining / 1000) + "s";
    setTimeout(updatePingYouButtonState, 500);
  } else {
    $pingYouBtn.disabled = false;
    $pingYouBtn.textContent = "🔔 Ping Devs";
  }
}

function closePingYouPanel() {
  $pingYouPanel.style.display = "none";
}

$pingYouBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if ($pingYouBtn.disabled) return;
  const isOpen = $pingYouPanel.style.display === "block";
  if (isOpen) {
    closePingYouPanel();
  } else {
    closeClearPanel();
    closeOnlineListPanel();
    $pingYouPanel.style.display = "block";
    $pingYouNote.value = "";
    $pingYouNote.focus();
  }
});

document.addEventListener("click", (e) => {
  if ($pingYouPanel.style.display === "block" && !$pingYouPanel.contains(e.target) && e.target !== $pingYouBtn) {
    closePingYouPanel();
  }
});

$pingYouSend.addEventListener("click", () => {
  if (getPingYouRemainingMs() > 0) return;

  const note = $pingYouNote.value.trim().slice(0, 200);

  $pingYouSend.disabled = true;
  $pingYouSend.textContent = "Sending…";

  const content = buildPingYouWebhookContent(note);

  fetch(PING_YOU_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  })
    .then(() => {
      try { localStorage.setItem(PING_YOU_STORAGE_KEY, String(Date.now())); } catch (e) {}
      closePingYouPanel();
      updatePingYouButtonState();
    })
    .catch(() => {
      showChatRoomComposerNotice("Ping failed to send — check your connection.");
    })
    .finally(() => {
      $pingYouSend.disabled = false;
      $pingYouSend.textContent = "Send Ping";
    });
});

let currentMentionTarget = null;
let mentionDropdownOpen = false;
let mentionTriggerCharIndex = -1;

function clearMention() {
  currentMentionTarget = null;
  $mentionChip.style.display = "none";
  $mentionChip.textContent = "";
}

function setMention(name) {
  currentMentionTarget = name;
  $mentionChip.textContent = "@" + name;
  $mentionChip.style.display = "inline-flex";
}

function closeMentionDropdown() {
  mentionDropdownOpen = false;
  $mentionDropdown.style.display = "none";
  $mentionDropdown.innerHTML = "";
}

function renderMentionDropdown() {
  $mentionDropdown.innerHTML = "";

  const candidates = latestPresenceList
    .map(e => e.name)
    .filter(name => name !== myName && !isSpectatorName(name))
    .sort((a, b) => a.localeCompare(b));

  if (candidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mention-empty";
    empty.textContent = "No one else online to mention.";
    $mentionDropdown.appendChild(empty);
    return;
  }

  candidates.forEach(name => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mention-option";
    btn.textContent = name;
    btn.addEventListener("click", () => {
      setMention(name);
      if (mentionTriggerCharIndex >= 0) {
        const before = $msgInput.value.slice(0, mentionTriggerCharIndex);
        const after = $msgInput.value.slice($msgInput.selectionStart);
        $msgInput.value = before + after;
        $msgInput.selectionStart = $msgInput.selectionEnd = before.length;
      }
      closeMentionDropdown();
      $msgInput.focus();
      updateCharCounter();
    });
    $mentionDropdown.appendChild(btn);
  });
}

function openMentionDropdown(triggerIndex) {
  mentionTriggerCharIndex = triggerIndex;
  mentionDropdownOpen = true;
  $mentionDropdown.style.display = "block";
  renderMentionDropdown();
}

function refreshMentionDropdownIfOpen() {
  if (mentionDropdownOpen) renderMentionDropdown();
}

$mentionChip.addEventListener("click", (e) => {
  e.stopPropagation();
  openMentionDropdown(-1);
});

document.addEventListener("click", (e) => {
  if (mentionDropdownOpen && !$mentionDropdown.contains(e.target) && e.target !== $mentionChip) {
    closeMentionDropdown();
  }
});

function handleMentionTrigger() {
  const cursor = $msgInput.selectionStart;
  const charBeforeCursor = $msgInput.value.slice(cursor - 1, cursor);
  if (charBeforeCursor === "@") {
    openMentionDropdown(cursor - 1);
  }
}

let pingSoundReady = false;

function preloadPingSound() {
  $pingSound.src = PING_SOUND_URL;

  $pingSound.addEventListener("canplaythrough", () => {
    pingSoundReady = true;
  }, { once: true });

  $pingSound.addEventListener("error", () => {}, { once: true });

  $pingSound.load();
}

function requestNotificationPermissionIfNeeded() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function showPingToast(fromName, note) {
  $pingToastBody.textContent = fromName + (note ? ": " + note : " pinged you.");
  $pingToast.style.display = "block";
  clearTimeout(showPingToast._timer);
  showPingToast._timer = setTimeout(() => {
    $pingToast.style.display = "none";
  }, 5000);
}

function triggerIncomingPing(fromName, note) {
  if (pingSoundReady) {
    try {
      $pingSound.currentTime = 0;
      $pingSound.play().catch(() => {});
    } catch (e) {}
  }

  showPingToast(fromName, note);

  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(fromName + " pinged you in VUS Chat", {
        body: note || "Tap to open the chat.",
        tag: "vus-chat-ping"
      });
    } catch (e) {}
  }
}

const $roomsToggleBtn = document.getElementById("roomsToggleBtn");
const $roomsBadgeDot = document.getElementById("roomsBadgeDot");
const $roomsSidebarOverlay = document.getElementById("roomsSidebarOverlay");
const $roomsSidebar = document.getElementById("roomsSidebar");
const $roomsSidebarClose = document.getElementById("roomsSidebarClose");
const $roomsSidebarBody = document.getElementById("roomsSidebarBody");
const $roomsFooterMsg = document.getElementById("roomsFooterMsg");
const $joinByCodeInput = document.getElementById("joinByCodeInput");
const $joinByCodeBtn = document.getElementById("joinByCodeBtn");
const $createRoomBtn = document.getElementById("createRoomBtn");

const $roomTopBar = document.getElementById("roomTopBar");
const $roomTopBarName = document.getElementById("roomTopBarName");
const $roomTopBarCode = document.getElementById("roomTopBarCode");
const $roomTopBarTimer = document.getElementById("roomTopBarTimer");
const $roomSettingsBtn = document.getElementById("roomSettingsBtn");
const $roomLeaveBtn = document.getElementById("roomLeaveBtn");

const $createRoomOverlay = document.getElementById("createRoomOverlay");
const $createRoomNameInput = document.getElementById("createRoomNameInput");
const $createRoomErr = document.getElementById("createRoomErr");
const $createRoomCancelBtn = document.getElementById("createRoomCancelBtn");
const $createRoomConfirmBtn = document.getElementById("createRoomConfirmBtn");

const $roomSettingsOverlay = document.getElementById("roomSettingsOverlay");
const $roomPublicToggleBtn = document.getElementById("roomPublicToggleBtn");
const $roomCodeInput = document.getElementById("roomCodeInput");
const $roomCodeErr = document.getElementById("roomCodeErr");
const $roomCodeSaveBtn = document.getElementById("roomCodeSaveBtn");
const $roomMembersList = document.getElementById("roomMembersList");
const $roomSettingsCloseBtn = document.getElementById("roomSettingsCloseBtn");

const $extendRoomOverlay = document.getElementById("extendRoomOverlay");
const $extendRoomText = document.getElementById("extendRoomText");
const $extendRoomDismissBtn = document.getElementById("extendRoomDismissBtn");
const $extendRoomConfirmBtn = document.getElementById("extendRoomConfirmBtn");

const $transferOfferOverlay = document.getElementById("transferOfferOverlay");
const $transferOfferText = document.getElementById("transferOfferText");
const $transferDeclineBtn = document.getElementById("transferDeclineBtn");
const $transferAcceptBtn = document.getElementById("transferAcceptBtn");

const $kickConfirmOverlay = document.getElementById("kickConfirmOverlay");
const $kickConfirmText = document.getElementById("kickConfirmText");
const $kickCancelBtn = document.getElementById("kickCancelBtn");
const $kickConfirmBtn = document.getElementById("kickConfirmBtn");

const JOINED_ROOMS_STORAGE_KEY = "vusChatJoinedRooms";
const ROOM_PING_BADGE_KEY = "vusChatRoomPingBadges";

let currentRoomCode = null;
let currentRoomMeta = null;
let unsubscribeRoomMeta = null;
let publicRoomsList = [];
let joinedPrivateRoomCodes = new Set();
let roomPingBadges = new Set();
let extendPromptShownForCode = null;
let pendingKickTarget = null;
let sidebarCountdownTimer = null;
let topBarCountdownTimer = null;

function loadJoinedRoomsFromStorage() {
  try {
    const raw = localStorage.getItem(JOINED_ROOMS_STORAGE_KEY);
    joinedPrivateRoomCodes = new Set(raw ? JSON.parse(raw) : []);
  } catch (e) {
    joinedPrivateRoomCodes = new Set();
  }
}

function saveJoinedRoomsToStorage() {
  try {
    localStorage.setItem(JOINED_ROOMS_STORAGE_KEY, JSON.stringify([...joinedPrivateRoomCodes]));
  } catch (e) {}
}

function loadPingBadgesFromStorage() {
  try {
    const raw = localStorage.getItem(ROOM_PING_BADGE_KEY);
    roomPingBadges = new Set(raw ? JSON.parse(raw) : []);
  } catch (e) {
    roomPingBadges = new Set();
  }
}

function savePingBadgesToStorage() {
  try {
    localStorage.setItem(ROOM_PING_BADGE_KEY, JSON.stringify([...roomPingBadges]));
  } catch (e) {}
}

function updateRoomsHeaderBadge() {
  $roomsBadgeDot.style.display = roomPingBadges.size > 0 ? "block" : "none";
}

function restoreSidebarRoomList() {
  loadJoinedRoomsFromStorage();
  loadPingBadgesFromStorage();
  updateRoomsHeaderBadge();
}

function watchPublicRoomsList() {
  RoomManager.watchPublicRooms(list => {
    publicRoomsList = list;
    if ($roomsSidebar.classList.contains("open")) renderRoomsSidebar();
  });
}

function formatCountdown(msRemaining) {
  const totalSecs = Math.max(0, Math.ceil(msRemaining / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return mins + ":" + String(secs).padStart(2, "0");
}

function openRoomsSidebar() {
  if (!currentSession) return;
  $roomsSidebarOverlay.style.display = "block";
  $roomsSidebar.classList.add("open");
  $roomsSidebarOverlay.style.display = "block";
  renderRoomsSidebar();
  clearInterval(sidebarCountdownTimer);
  sidebarCountdownTimer = setInterval(renderRoomsSidebar, 1000);
}

function closeRoomsSidebar() {
  $roomsSidebarOverlay.style.display = "none";
  $roomsSidebar.classList.remove("open");
  clearInterval(sidebarCountdownTimer);
  $roomsFooterMsg.textContent = "";
  $roomsFooterMsg.classList.remove("err");
}

$roomsToggleBtn.addEventListener("click", () => {
  const isOpen = $roomsSidebar.classList.contains("open");
  if (isOpen) closeRoomsSidebar(); else openRoomsSidebar();
});
$roomsSidebarClose.addEventListener("click", closeRoomsSidebar);
$roomsSidebarOverlay.addEventListener("click", closeRoomsSidebar);

async function renderRoomsSidebar() {
  $roomsSidebarBody.innerHTML = "";

  const mainTitle = document.createElement("div");
  mainTitle.className = "rooms-section-title";
  mainTitle.textContent = "Pinned";
  $roomsSidebarBody.appendChild(mainTitle);
  $roomsSidebarBody.appendChild(buildMainRoomCard());

  const joinedTitle = document.createElement("div");
  joinedTitle.className = "rooms-section-title";
  joinedTitle.textContent = "Joined Rooms";
  $roomsSidebarBody.appendChild(joinedTitle);

  const joinedCodes = [...joinedPrivateRoomCodes];
  if (joinedCodes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rooms-empty";
    empty.textContent = "Rooms you join by code stay here until you remove them.";
    $roomsSidebarBody.appendChild(empty);
  } else {
    for (const code of joinedCodes) {
      const meta = await RoomManager.getRoomMeta(code);
      if (!meta) {
        joinedPrivateRoomCodes.delete(code);
        saveJoinedRoomsToStorage();
        continue;
      }
      if (meta.isPublic) continue;
      $roomsSidebarBody.appendChild(buildRoomCard(meta, true));
    }
  }

  const publicTitle = document.createElement("div");
  publicTitle.className = "rooms-section-title";
  publicTitle.textContent = "Chat Rooms";
  $roomsSidebarBody.appendChild(publicTitle);

  if (publicRoomsList.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rooms-empty";
    empty.textContent = "No public rooms right now.";
    $roomsSidebarBody.appendChild(empty);
  } else {
    publicRoomsList
      .slice()
      .sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0))
      .forEach(meta => {
        $roomsSidebarBody.appendChild(buildRoomCard(meta, false));
      });
  }
}

function buildMainRoomCard() {
  const card = document.createElement("div");
  card.className = "room-card" + (currentRoomCode === null ? " active" : "");
  card.innerHTML = `
    <div class="room-card-top">
      <span class="room-card-name">VUS Chat <span class="room-card-pinned">Main</span></span>
    </div>
  `;
  card.addEventListener("click", () => {
    closeRoomsSidebar();
    switchToMainRoom();
  });
  return card;
}

function buildRoomCard(meta, closable) {
  const card = document.createElement("div");
  card.className = "room-card" + (currentRoomCode === meta.code ? " active" : "");

  const hasPing = roomPingBadges.has(meta.code);
  const remaining = (meta.expiresAt || 0) - Date.now();
  const urgent = remaining < ROOM_WARNING_MS;

  const displayName = meta.name || ("Room " + meta.code);

  card.innerHTML = `
    <div class="room-card-top">
      <span class="room-card-name">${esc(displayName)}${hasPing ? '<span class="room-card-dot"></span>' : ""}</span>
      <span class="room-card-timer${urgent ? " urgent" : ""}">${formatCountdown(remaining)}</span>
    </div>
    <div class="room-card-code">Code: ${esc(meta.code)}${meta.isPublic ? " · Public" : ""}</div>
  `;

  card.addEventListener("click", () => {
    closeRoomsSidebar();
    joinRoomByCode(meta.code);
  });

  if (closable) {
    const closeBtn = document.createElement("button");
    closeBtn.className = "room-card-close";
    closeBtn.textContent = "×";
    closeBtn.title = "Remove from your list";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      joinedPrivateRoomCodes.delete(meta.code);
      saveJoinedRoomsToStorage();
      roomPingBadges.delete(meta.code);
      savePingBadgesToStorage();
      updateRoomsHeaderBadge();
      renderRoomsSidebar();
    });
    card.appendChild(closeBtn);
  }

  return card;
}

function getRoomCreateCooldownRemainingMs() {
  try {
    const last = parseInt(localStorage.getItem(ROOM_CREATE_COOLDOWN_KEY) || "0", 10);
    return Math.max(0, ROOM_CREATE_COOLDOWN_MS - (Date.now() - last));
  } catch (e) {
    return 0;
  }
}

$createRoomBtn.addEventListener("click", () => {
  if (!myName || isSpectatorName(myName)) {
    $roomsFooterMsg.textContent = "Join the chat with a real name first.";
    $roomsFooterMsg.classList.add("err");
    return;
  }
  const remaining = getRoomCreateCooldownRemainingMs();
  if (remaining > 0) {
    $roomsFooterMsg.textContent = "Wait " + Math.ceil(remaining / 1000) + "s before creating another room.";
    $roomsFooterMsg.classList.add("err");
    return;
  }
  $createRoomNameInput.value = "";
  $createRoomErr.textContent = "";
  $createRoomOverlay.style.display = "flex";
  $createRoomNameInput.focus();
});

$createRoomCancelBtn.addEventListener("click", () => {
  $createRoomOverlay.style.display = "none";
});

$createRoomConfirmBtn.addEventListener("click", async () => {
  $createRoomConfirmBtn.disabled = true;
  $createRoomErr.textContent = "";
  try {
    const { code } = await RoomManager.createRoom(myName, $createRoomNameInput.value);
    try { localStorage.setItem(ROOM_CREATE_COOLDOWN_KEY, String(Date.now())); } catch (e) {}
    joinedPrivateRoomCodes.add(code);
    saveJoinedRoomsToStorage();
    $createRoomOverlay.style.display = "none";
    closeRoomsSidebar();
    await joinRoomByCode(code);
  } catch (e) {
    $createRoomErr.textContent = "Couldn't create room — try again.";
  } finally {
    $createRoomConfirmBtn.disabled = false;
  }
});

$joinByCodeBtn.addEventListener("click", async () => {
  const code = $joinByCodeInput.value.trim().toUpperCase();
  if (!code) return;
  $roomsFooterMsg.textContent = "";
  $roomsFooterMsg.classList.remove("err");

  const meta = await RoomManager.getRoomMeta(code);
  if (!meta) {
    $roomsFooterMsg.textContent = "No room found with that code.";
    $roomsFooterMsg.classList.add("err");
    return;
  }

  joinedPrivateRoomCodes.add(code);
  saveJoinedRoomsToStorage();
  $joinByCodeInput.value = "";
  closeRoomsSidebar();
  await joinRoomByCode(code);
});

$joinByCodeInput.addEventListener("keydown", e => {
  if (e.key === "Enter") $joinByCodeBtn.click();
});

async function joinRoomByCode(code) {
  if (!myName) return;
  if (currentRoomCode === code) return;

  const meta = await RoomManager.getRoomMeta(code);
  if (!meta) {
    showChatRoomComposerNotice("That room no longer exists.");
    return;
  }

  if (roomPingBadges.has(code)) {
    roomPingBadges.delete(code);
    savePingBadgesToStorage();
    updateRoomsHeaderBadge();
  }

  teardownCurrentRoomMetaWatch();
  currentRoomCode = code;
  ChatBackend.bindToRoom(code);
  ChatBackend.claimPresence(myAccountKey, myName, false);
  watchMyTimeout();
  attachRoomListeners();

  $messages.innerHTML = "";
  messageCount = 0;
  $emptyState.style.display = "flex";

  $roomTopBar.style.display = "flex";
  unsubscribeRoomMeta = RoomManager.watchRoomMeta(code, onRoomMetaUpdate);
}

function switchToMainRoom() {
  if (currentRoomCode === null) return;

  teardownCurrentRoomMetaWatch();
  currentRoomCode = null;
  currentRoomMeta = null;
  ChatBackend.bindToRoom(MAIN_ROOM_ID);
  if (myName) ChatBackend.claimPresence(myAccountKey, myName, false);
  watchMyTimeout();
  attachRoomListeners();

  $messages.innerHTML = "";
  messageCount = 0;
  $emptyState.style.display = "flex";

  $roomTopBar.style.display = "none";
  clearInterval(topBarCountdownTimer);
  extendPromptShownForCode = null;
}

function teardownCurrentRoomMetaWatch() {
  if (unsubscribeRoomMeta) { unsubscribeRoomMeta(); unsubscribeRoomMeta = null; }
  clearInterval(topBarCountdownTimer);
}

$roomLeaveBtn.addEventListener("click", () => {
  switchToMainRoom();
});

function onRoomMetaUpdate(meta) {
  if (!meta) {
    showChatRoomComposerNotice("This room has closed.");
    switchToMainRoom();
    return;
  }

  currentRoomMeta = meta;

  const myKey = ChatBackend._safeKey(myName);
  if (meta.kicked && meta.kicked[myKey]) {
    showChatRoomComposerNotice("You were removed from this room.");
    switchToMainRoom();
    return;
  }

  const isOwner = meta.ownerName === myName;
  const displayName = meta.name || ("Room " + meta.code);
  $roomTopBarName.innerHTML = (isOwner ? "👑 " : "") + esc(displayName);
  $roomTopBarCode.textContent = "Code: " + meta.code + (meta.isPublic ? " · Public" : " · Private");
  $roomSettingsBtn.style.display = isOwner ? "inline-block" : "none";

  clearInterval(topBarCountdownTimer);
  topBarCountdownTimer = setInterval(() => updateRoomCountdownUI(meta), 1000);
  updateRoomCountdownUI(meta);

  if (meta.transferOffer && meta.transferOffer.toName === myName) {
    showTransferOfferModal(meta);
  } else if ($transferOfferOverlay.style.display === "flex") {
    $transferOfferOverlay.style.display = "none";
  }

  if ($roomSettingsOverlay.style.display === "flex" && isOwner) {
    renderRoomMembersList(meta);
  }

  if ($roomSettingsOverlay.style.display === "flex") {
    $roomPublicToggleBtn.textContent = meta.isPublic ? "On" : "Off";
    $roomPublicToggleBtn.classList.toggle("active", meta.isPublic);
  }
}

function updateRoomCountdownUI(meta) {
  const remaining = (meta.expiresAt || 0) - Date.now();

  if (remaining <= 0) {
    RoomManager.deleteRoom(meta.code).catch(() => {});
    return;
  }

  const urgent = remaining < ROOM_WARNING_MS;
  $roomTopBarTimer.textContent = formatCountdown(remaining);
  $roomTopBarTimer.classList.toggle("urgent", urgent);

  if (urgent && extendPromptShownForCode !== meta.code) {
    extendPromptShownForCode = meta.code;
    showExtendPrompt(meta);
  }
}

function showExtendPrompt(meta) {
  const displayName = meta.name || ("Room " + meta.code);
  $extendRoomText.textContent = "\u201c" + displayName + "\u201d closes in under a minute. Add 10 more minutes?";
  $extendRoomOverlay.style.display = "flex";
}

$extendRoomDismissBtn.addEventListener("click", () => {
  $extendRoomOverlay.style.display = "none";
});

$extendRoomConfirmBtn.addEventListener("click", async () => {
  if (!currentRoomCode) return;
  $extendRoomConfirmBtn.disabled = true;
  try {
    await RoomManager.extendRoom(currentRoomCode);
    extendPromptShownForCode = null;
  } catch (e) {
    showChatRoomComposerNotice("Couldn't extend the room — try again.");
  } finally {
    $extendRoomConfirmBtn.disabled = false;
    $extendRoomOverlay.style.display = "none";
  }
});

$roomSettingsBtn.addEventListener("click", () => {
  if (!currentRoomMeta) return;
  $roomPublicToggleBtn.textContent = currentRoomMeta.isPublic ? "On" : "Off";
  $roomPublicToggleBtn.classList.toggle("active", currentRoomMeta.isPublic);
  $roomCodeInput.value = currentRoomMeta.code;
  $roomCodeErr.textContent = "";
  renderRoomMembersList(currentRoomMeta);
  $roomSettingsOverlay.style.display = "flex";
});

$roomSettingsCloseBtn.addEventListener("click", () => {
  $roomSettingsOverlay.style.display = "none";
});

$roomPublicToggleBtn.addEventListener("click", async () => {
  if (!currentRoomCode || !currentRoomMeta) return;
  const newState = !currentRoomMeta.isPublic;
  $roomPublicToggleBtn.disabled = true;
  try {
    await RoomManager.setPublic(currentRoomCode, newState);
  } finally {
    $roomPublicToggleBtn.disabled = false;
  }
});

$roomCodeSaveBtn.addEventListener("click", async () => {
  if (!currentRoomCode) return;
  const newCode = $roomCodeInput.value.trim().toUpperCase();
  $roomCodeErr.textContent = "";
  $roomCodeSaveBtn.disabled = true;
  try {
    const result = await RoomManager.changeCode(currentRoomCode, newCode, myName);
    if (!result.ok) {
      const messages = {
        empty: "Enter a code.",
        same: "That's already the current code.",
        taken: "That code is already in use.",
        gone: "This room no longer exists.",
        "not-owner": "Only the room owner can change the code."
      };
      $roomCodeErr.textContent = messages[result.reason] || "Couldn't change the code.";
      return;
    }
    joinedPrivateRoomCodes.delete(currentRoomCode);
    joinedPrivateRoomCodes.add(result.newCode);
    saveJoinedRoomsToStorage();
    const targetCode = result.newCode;
    $roomSettingsOverlay.style.display = "none";
    currentRoomCode = null;
    await joinRoomByCode(targetCode);
  } catch (e) {
    $roomCodeErr.textContent = "Couldn't change the code — try again.";
  } finally {
    $roomCodeSaveBtn.disabled = false;
  }
});

function renderRoomMembersList(meta) {
  $roomMembersList.innerHTML = "";
  const names = latestPresenceList.map(e => e.name).sort((a, b) => a.localeCompare(b));

  if (names.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rooms-empty";
    empty.textContent = "No one else here yet.";
    $roomMembersList.appendChild(empty);
    return;
  }

  names.forEach(name => {
    const row = document.createElement("div");
    row.className = "room-member-row";

    const isOwnerRow = name === meta.ownerName;
    const nameEl = document.createElement("span");
    nameEl.className = "room-member-name";
    nameEl.textContent = (isOwnerRow ? "👑 " : "") + name + (name === myName ? " (you)" : "");
    row.appendChild(nameEl);

    if (name !== myName) {
      const actions = document.createElement("div");
      actions.className = "room-member-actions";

      const transferBtn = document.createElement("button");
      transferBtn.textContent = "Make owner";
      transferBtn.addEventListener("click", () => {
        RoomManager.offerTransfer(currentRoomCode, myName, name).catch(() => {
          showChatRoomComposerNotice("Couldn't send transfer offer — try again.");
        });
      });
      actions.appendChild(transferBtn);

      const kickBtn = document.createElement("button");
      kickBtn.className = "kick";
      kickBtn.textContent = "Kick";
      kickBtn.addEventListener("click", () => {
        pendingKickTarget = name;
        $kickConfirmText.textContent = "Remove " + name + " from this room? They can rejoin if they still have access.";
        $kickConfirmOverlay.style.display = "flex";
      });
      actions.appendChild(kickBtn);

      row.appendChild(actions);
    }

    $roomMembersList.appendChild(row);
  });
}

$kickCancelBtn.addEventListener("click", () => {
  pendingKickTarget = null;
  $kickConfirmOverlay.style.display = "none";
});

$kickConfirmBtn.addEventListener("click", async () => {
  if (!pendingKickTarget || !currentRoomCode) return;
  $kickConfirmBtn.disabled = true;
  try {
    await RoomManager.kickFromRoom(currentRoomCode, pendingKickTarget);
  } catch (e) {
    showChatRoomComposerNotice("Couldn't kick — try again.");
  } finally {
    $kickConfirmBtn.disabled = false;
    $kickConfirmOverlay.style.display = "none";
    pendingKickTarget = null;
  }
});

function showTransferOfferModal(meta) {
  $transferOfferText.textContent = meta.transferOffer.fromName + " wants to make you the owner of \u201c" + (meta.name || ("Room " + meta.code)) + "\u201d.";
  $transferOfferOverlay.style.display = "flex";
}

$transferAcceptBtn.addEventListener("click", async () => {
  if (!currentRoomCode) return;
  $transferAcceptBtn.disabled = true;
  try {
    await RoomManager.acceptTransfer(currentRoomCode, myName);
  } finally {
    $transferAcceptBtn.disabled = false;
    $transferOfferOverlay.style.display = "none";
  }
});

$transferDeclineBtn.addEventListener("click", async () => {
  if (!currentRoomCode) return;
  $transferDeclineBtn.disabled = true;
  try {
    await RoomManager.declineTransfer(currentRoomCode);
  } finally {
    $transferDeclineBtn.disabled = false;
    $transferOfferOverlay.style.display = "none";
  }
});

function checkSoleSurvivorAutoOwnership(presenceList) {
  if (!currentRoomCode || !currentRoomMeta) return;
  const namesPresent = presenceList.map(e => e.name);
  const ownerStillPresent = namesPresent.includes(currentRoomMeta.ownerName);
  if (ownerStillPresent) return;
  if (namesPresent.length !== 1) return;
  const soleSurvivor = namesPresent[0];
  if (soleSurvivor !== myName) return;
  RoomManager.forceTransferOwnership(currentRoomCode, myName).catch(() => {});
}

function buildPingYouWebhookContent(note) {
  const senderName = myName || "Someone";
  if (currentRoomCode && currentRoomMeta) {
    const roomLabel = (currentRoomMeta.name || "Room") + " (" + currentRoomCode + ")";
    return "🔔 **" + senderName + "** pinged from **" + roomLabel + "**" + (note ? ": " + note : " (no note)");
  }
  return "🔔 **" + senderName + "** pinged" + (note ? ": " + note : " (no note)");
}

$sendBtn.addEventListener("click", sendMessage);
$msgInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$msgInput.addEventListener("input", () => {
  autosizeInput();
  handleTypingActivity();
  updateCharCounter();
  handleMentionTrigger();
});

$msgInput.addEventListener("paste", (e) => {
  if (!modMenuUnlocked || !imagesEnabledForMe) return;

  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;

  let imageFile = null;
  for (const item of items) {
    if (item.type && item.type.startsWith("image/")) {
      imageFile = item.getAsFile();
      break;
    }
  }
  if (!imageFile) return;

  e.preventDefault();
  stageImageFile(imageFile);
});

function attachRoomListeners() {
  ChatBackend.watchPresenceCount(count => {
    $onlineCount.textContent = count + " online";
  });
  ChatBackend.watchPresenceList(list => {
    latestPresenceList = list;
    if ($onlineListPanel.style.display === "block") renderOnlineListPanel();
    refreshMentionDropdownIfOpen();
    checkSoleSurvivorAutoOwnership(list);
  });
  ChatBackend.watchMessages(renderMessage);
  ChatBackend.watchLeaveEvents();
  ChatBackend.watchTyping(renderTyping, () => myName);
}

// Two separate flags, deliberately not merged into one:
// - chatRoomListenersAttached tracks whether the Firebase listeners
//   (watchMessages/watchPresenceCount/watchRoleNames/watchConnection/
//   watchTyping/watchLeaveEvents, all wired via attachRoomListeners())
//   are already live. These have NO internal de-dupe — calling
//   attachRoomListeners() twice stacks a second "child_added" handler
//   on top of the first, so every message would render twice, presence
//   counts would double, etc. Spectator preview (enterSpectatorPreview)
//   attaches a subset of these same listeners; this flag is shared with
//   it so logging in after spectating reuses them instead of doubling up.
// - chatRoomInitialized tracks the one-time-per-page-load setup (rooms
//   sidebar restore, upload/ping button state, ping sound preload) that
//   only makes sense once a real account exists, separate from whether
//   the underlying Firebase listeners are already running.
function initChatRoomUI() {
  if (chatRoomInitialized) {
    enterChatRoomAsCurrentAccount();
    return;
  }
  chatRoomInitialized = true;

  try {
    if (!chatRoomListenersAttached) ChatBackend.init();
    RoomManager.init(db);
  } catch (e) {
    showChatRoomComposerNotice("Couldn't connect to chat — try again.");
    return;
  }

  if (!chatRoomListenersAttached) {
    chatRoomListenersAttached = true;
    ChatBackend.watchConnection(setConnectionStatus);
    Object.values(ROLES).forEach(role => {
      roleHolders[role.id] = new Set();
      ChatBackend.watchRoleNames(role.id, set => { roleHolders[role.id] = set; });
    });
    attachRoomListeners();
  }
  watchPublicRoomsList();
  restoreSidebarRoomList();

  updateUploadButtonVisibility();
  updatePingYouButtonState();
  preloadPingSound();

  $emptyState.style.display = "flex";
  updateCharCounter();

  enterChatRoomAsCurrentAccount();

  window.addEventListener("beforeunload", () => {
    stopTyping();
    ChatBackend.releasePresence();
    ChatBackend.clearAllRoles();
  });
}

/* ══════════════════════════════════════════════════════════
   SPECTATOR PREVIEW — the chat room is visible read-only to anyone
   who hasn't logged in, so visitors can see what it's about before
   signing up. A spectator:
   - never calls claimPresence, so they never appear in presence,
     roles, or timeouts — nothing in the moderation system can
     target them, because there is no account for it to target.
   - can watch messages exactly like a real participant (reading is
     harmless), including role badges on others' messages.
   - has the composer disabled, replaced with a "Sign up to chat"
     prompt that jumps straight to the signup tab.
   Ends the moment they log in or sign up (exitSpectatorPreview(),
   called from the auth submit handler's success path) — the
   Firebase listeners set up here are reused by initChatRoomUI()
   rather than torn down, since ChatBackend.init() is idempotent
   with respect to already-attached listeners for this session.
   ══════════════════════════════════════════════════════════ */
let spectatorPreviewActive = false;

function enterSpectatorPreview() {
  // Only currentSession gates this — NOT chatRoomInitialized. That flag
  // means "the one-time real-account chat room setup has already run at
  // some point this page load," which stays true forever once a person
  // logs in, even after they log back out. Guarding on it here would
  // make enterSpectatorPreview() a permanent no-op after any login this
  // session — exactly the case doLogout() needs it to work for, so a
  // logged-out visitor sees the read-only preview again instead of the
  // blank pane exitChatRoom() leaves behind.
  if (currentSession) return;
  spectatorPreviewActive = true;

  $chatRoomPane.style.display = "flex";
  // $chatScreen (the inner messages/composer container, nested inside
  // $chatRoomPane) defaults to visible via its own inline style in the
  // HTML, but exitChatRoom() explicitly hides it ($chatScreen.style
  // .display = "none") on logout. That "none" persists until something
  // sets it back — nothing else does, so without this line a
  // post-logout visitor would see the outer chat pane but an empty gap
  // where messages and the composer should be.
  $chatScreen.style.display = "flex";
  $emptyState.style.display = "flex";
  updateSpectatorComposerUI();

  // If listeners are already attached (e.g. re-entering spectator mode
  // after a prior spectator session in this same page load), don't
  // register a second set — just update the UI above and return.
  if (chatRoomListenersAttached) return;

  try {
    ChatBackend.init();
  } catch (e) {
    showChatRoomComposerNotice("Couldn't load chat preview.");
    return;
  }
  chatRoomListenersAttached = true;
  ChatBackend.watchConnection(setConnectionStatus);
  ChatBackend.watchMessages(renderMessage);
  Object.values(ROLES).forEach(role => {
    roleHolders[role.id] = new Set();
    ChatBackend.watchRoleNames(role.id, set => { roleHolders[role.id] = set; });
  });
  ChatBackend.watchPresenceCount(count => {
    $onlineCount.textContent = count + " online";
  });
}

function exitSpectatorPreview() {
  spectatorPreviewActive = false;
}

function updateSpectatorComposerUI() {
  $msgInput.disabled = true;
  $msgInput.placeholder = "Sign up to chat";
  $sendBtn.disabled = false;
  $sendBtn.classList.remove("cooldown");
  $sendBtn.textContent = "Sign up to chat";
  $youAre.textContent = "Spectating";
}

function handleSpectatorComposerClick() {
  showAuthFlow();
  setMode("signup");
  if ($signupUsername) $signupUsername.focus();
}
