(function () {
"use strict";
/* ══════════════════════════════════════════════════════════
   CHAT DATABASE  (Firebase project: vus-chat)
   Rooms, messages, presence, roles (roleIds), bans, timeouts, profiles.
   Accounts live in a SEPARATE database (vus-dm) owned by dm.js; this file
   only reads it (login lookups for /ban etc.) through window.VUS_DM_DB.
   Login itself is shared: dm.js signs the person in, then fires
   "vus:session", which starts the chat under their account username.
   ══════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDxMfGQ_xk-au8YgOvaFO2R9LxAe-pa9Rg",
  authDomain: "vus-chat.firebaseapp.com",
  databaseURL: "https://vus-chat-default-rtdb.firebaseio.com",
  projectId: "vus-chat",
  storageBucket: "vus-chat.firebasestorage.app",
  messagingSenderId: "134456894391",
  appId: "1:134456894391:web:bdf28487bf2b2eae593e32"
};
const FIREBASE_APP_NAME = "vusChat";

let dmAuthDb = null; // accounts database (vus-dm), shared with dm.js

const MAIN_ROOM_ID = "vus-hub-main";
const VIDEO_MAX_SECONDS = 180;
const VIDEO_MAX_BYTES = 48 * 1024 * 1024;        // the chat database caps what one clip can be
const VIDEO_TTL_MS = 4 * 60 * 1000;               // a clip disappears 4 minutes after it is posted
const VIDEO_UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const VIDEO_CHUNK_BYTES = 786432;                 // 768 KB -> 1 MB of base64 per database value
const localVideoUrls = new Map();                 // clip id -> blob URL (the sender's own copy, or one already loaded)
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

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

/* ══════════════════════════════════════════════════════════
   ROLES
   Ranks, low to high:  🌱 Unranked  🔰 Normie  🧩 Mod  🛡️ Admin  💎 Co-owner  👑 Owner
   Roles are tied to the person's VUS account ID (roleIds/{role}/{loginId} in
   the database), NOT their display name and NOT their connection. Leaving,
   disconnecting, renaming, logging out and back in never removes a role.
   Only an explicit removal (/remove, or a temporary grant expiring) does.

   THERE IS NO WAY TO CLAIM A ROLE. No codes, no Discord. A role can only be
   given by someone ranked ABOVE it (/grant), or added by hand in the database:
       roleIds/crown/<loginId>   = true      (Owner)
       roleIds/coowner/<loginId> = true      (Co-owner)   ...and so on.
   ROLES is the single place to add ranks -- badges, delays, permissions and
   the command list all read from it.
   ══════════════════════════════════════════════════════════ */

/* Rank order, lowest to highest. `rank` drives permissions, message delay
   and image delay. `implicit` = everybody starts here, it is never stored. */
const ROLES = {
  unranked: { id: "unranked", rank: 0, label: "Unranked", icon: "🌱", bubbleClass: "unranked-bubble", implicit: true },
  normie:   { id: "normie",   rank: 1, label: "Normie",   icon: "🔰", bubbleClass: "normie-bubble" },
  mod:      { id: "mod",      rank: 2, label: "Mod",      icon: "🧩", bubbleClass: "mod-bubble" },
  admin:    { id: "admin",    rank: 3, label: "Admin",    icon: "🛡️", bubbleClass: "admin-bubble" },
  coowner:  { id: "coowner",  rank: 4, label: "Co-owner", icon: "💎", bubbleClass: "coowner-bubble" },
  crown:    { id: "crown",    rank: 5, label: "Owner",    icon: "👑", bubbleClass: "crown-bubble" }
};

/* Highest-ranked role a person holds is their "effective" role. */
const ROLE_ORDER = Object.values(ROLES).sort((a, b) => a.rank - b.rank).map(r => r.id);

/* Bubble color: was write-once, now changeable every 10s. */
const COLOR_CHANGE_COOLDOWN_MS = 10 * 1000;

/* How close together two leave-events for the same name must be to be
   treated as one stray burst instead of two genuine separate leaves —
   fixes repeated "X left / X left / X left" spam caused by duplicate
   onDisconnect writes (multiple tabs under the same name, or reconnect
   churn on a flaky connection). */

/* ── Timeouts (Owner Menu / Mod Menu) ── */
/* ══════════════════════════════════════════════════════════
   LEAVE MESSAGES
   When a leave event shows up, everyone starts a LEAVE_BATCH_QUIET_MS timer.
   Another leave restarts it. When it finally runs out, exactly ONE client
   (elected with a database lock) posts a single message naming everyone who
   left, e.g. "Ali, Bo and Cy left". Without this every open browser posted
   its own copy, which is why people saw 10 identical messages.
   ══════════════════════════════════════════════════════════ */
const LEAVE_BATCH_QUIET_MS = 5 * 1000;   // quiet time after the LAST leave before announcing
const LEAVE_LOCK_TTL_MS = 15 * 1000;     // a poster that vanishes mid-post is replaced after this
const LEAVE_RETRY_MS = 4 * 1000;         // how often losers re-check that the winner really posted
const LEAVE_MAX_AGE_MS = 2 * 60 * 1000;  // stale leave events are cleaned up silently
function formatLeaveText(names) {
  if (names.length === 1) return names[0] + " left";
  if (names.length === 2) return names[0] + " and " + names[1] + " left";
  if (names.length <= 6) return names.slice(0, -1).join(", ") + " and " + names[names.length - 1] + " left";
  return names.slice(0, 5).join(", ") + " and " + (names.length - 5) + " others left";
}

const TIMEOUT_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30-day cap for owners
const MOD_TIMEOUT_MAX_MS = 24 * 60 * 60 * 1000; // mods can mute 1m - 1d
const ADMIN_MUTE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // admins: up to 1 week (mute and ban)
const MOD_TIMEOUT_DEFAULT_MS = 10 * 60 * 1000; // prefilled duration when a mod opens the timeout modal
const MOD_RETIMEOUT_COOLDOWN_MS = 7 * 1000; // a mod must wait this long after setting OR clearing a timeout before re-timing-out the SAME target

/* ══════════════════════════════════════════════════════════
   TIME LIMITS -- the ONE place every typed duration is bounded. The same
   numbers are shown wherever a time can be entered (the "/" list, notices,
   and the timeout / temp-role dialogs), so what you see is what is enforced.
   ══════════════════════════════════════════════════════════ */
const TIME_LIMITS = {
  timeout:    { min: 1000,  max: TIMEOUT_MAX_MS },      // Co-owner and Owner: 30 days
  adminMute:  { min: 1000,  max: ADMIN_MUTE_MAX_MS },   // Admin: 1 week
  modTimeout: { min: 60000, max: MOD_TIMEOUT_MAX_MS },  // Mod: 1 minute to 1 day
  tempban:    { min: 60000, max: TIMEOUT_MAX_MS },      // Co-owner and Owner: 30 days
  adminTempban: { min: 60000, max: 3 * 24 * 60 * 60 * 1000 }, // Admin: up to 3 days
  modTempban:   { min: 60000, max: 6 * 60 * 60 * 1000 }, // Mod: up to 6 hours
  tempGrant:  { min: 60000, max: TIMEOUT_MAX_MS }       // temporary ranks (/grant rank <time> name)
};
const TIME_INPUT_HINT = "Try 30s, 10m, 2h, 3d or 1w (a bare number means minutes).";
const PERMANENT_WORDS = new Set(["perm", "permanent"]);

function formatDurationShort(ms) {
  for (const [unit, size] of [["d", 86400000], ["h", 3600000], ["m", 60000], ["s", 1000]]) {
    if (ms >= size && ms % size === 0) return (ms / size) + unit;
  }
  return Math.max(1, Math.round(ms / 1000)) + "s";
}
function limitsText(limits) {
  return "min " + formatDurationShort(limits.min) + ", max " + formatDurationShort(limits.max);
}
function timeoutLimitsForRank(rank) {
  return rank >= ROLES.coowner.rank ? TIME_LIMITS.timeout : rank >= ROLES.admin.rank ? TIME_LIMITS.adminMute : TIME_LIMITS.modTimeout;
}
function banLimitsForRank(rank) {
  return rank >= ROLES.coowner.rank ? TIME_LIMITS.tempban : rank >= ROLES.admin.rank ? TIME_LIMITS.adminTempban : TIME_LIMITS.modTempban;
}
// What a rank may hand out / take away with /grant and /remove: Mods only Normie, Admins and up Mod and below.
function canGrantRole(rank, roleId) {
  const r = ROLES[roleId];
  if (!r || r.implicit || roleId === "crown") return false;
  if (r.rank >= rank) return false;
  return rank >= ROLES.admin.rank || (rank >= ROLES.mod.rank && roleId === "normie");
}
// Returns "" when ms is fine, otherwise a message telling the person exactly why not.
function checkDurationLimits(ms, limits) {
  if (!ms || ms <= 0) return "Couldn't read that time. " + TIME_INPUT_HINT;
  if (ms < limits.min) return "Too short: minimum is " + formatDurationShort(limits.min) + " (" + limitsText(limits) + ").";
  if (ms > limits.max) return "Too long: maximum is " + formatDurationShort(limits.max) + " (" + limitsText(limits) + ").";
  return "";
}
/* Per-role send delays. Owner and Co-owner are both 1s.
   Images share the same delay per role. Normie and below can't post images
   at all unless a higher-up grants image access (see setImageAccess). */
const ROLE_MESSAGE_COOLDOWNS_MS = { unranked: 10000, normie: 5000, mod: 3000, admin: 2000, coowner: 1000, crown: 1000 };
const ROLE_IMAGE_COOLDOWNS_MS   = { unranked: 10000, normie: 5000, mod: 3000, admin: 2000, coowner: 1000, crown: 1000 };
/* Roles at or below this rank need an explicit image grant. */
const IMAGE_GATED_MAX_RANK = ROLES.normie.rank;

/* ══════════════════════════════════════════════════════════
   NAME IMPERSONATION GUARD
   Names used to be compared as exact text, and the one check that existed was
   skipped for the person's own username -- while claimPresence (the code that
   actually writes the name) never checked at all and simply overwrote whoever
   was using it. So a second account could join "over" someone, and "yurt",
   "YURT", "Yurt" + an invisible character, or a Cyrillic "у" all counted as
   different names. Now names are compared by what they LOOK like.
   ══════════════════════════════════════════════════════════ */
// Characters that show as nothing (or flip text direction): never legitimate in a name.
// (Emoji joiners U+200D / U+FE0F are deliberately allowed, or family/flag emoji would break.)
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\u3164\ufeff\uffa0\ufff9-\ufffb]/;
function hasHiddenChars(name) { return HIDDEN_CHARS.test(String(name || "")); }

// Letters from other alphabets that are drawn like Latin letters.
const LOOKALIKES = {
  "\u0430":"a","\u0435":"e","\u043e":"o","\u0440":"p","\u0441":"c","\u0443":"y","\u0445":"x","\u0456":"i","\u0458":"j","\u0455":"s",
  "\u04bb":"h","\u043a":"k","\u043c":"m","\u0442":"t","\u0432":"b","\u043d":"h","\u0501":"d","\u051b":"q","\u0261":"g","\u04cf":"l",
  "\u03bf":"o","\u03bd":"v","\u03b9":"i","\u03b1":"a","\u03c1":"p","\u03c5":"u","\u03ba":"k","\u03c4":"t","\u03c7":"x","\u04af":"y"
};
// Two names with the same skeleton look the same to a person reading the chat.
function nameSkeleton(name) {
  let t = String(name || "").normalize("NFKC").replace(new RegExp(HIDDEN_CHARS.source + "|[\\u200d\\ufe00-\\ufe0f]", "g"), "");
  t = t.toLowerCase();
  t = Array.from(t).map(ch => LOOKALIKES[ch] || ch).join("");
  return t.replace(/\s+/g, " ").trim();
}

const ChatBackend = {
  _db: null,
  _ref: null,
  _typingRef: null,
  _myTypingRef: null,
  _connectedRef: null,
  _presenceRef: null,
  _myPresenceRef: null,
  _mySessionLockRef: null,
  _myLeaveEventRef: null,
  _atPingCooldownRef: null,
  _leaveEventsRef: null,
  _roleIdRefs: {},
  _leaveTimer: null,
  _leaveAttempts: 0,
  _clientId: Math.random().toString(36).slice(2) + Date.now().toString(36),
  _timeoutsRef: null,
  _modRetimeoutRef: null,
  _commandHistoryRef: null,
  _mediaMetaRef: null,
  _mediaDataRef: null,
  _bansRef: null,
  _imageAccessRef: null,
  _temporaryRoleTimers: {},
  _temporaryRoleWatchRefs: {},
  _chatStateRef: null,
  _profilesRef: null,
  currentRoomId: null,

  init() {
    const app = firebase.apps.find(a => a.name === FIREBASE_APP_NAME) || firebase.initializeApp(FIREBASE_CONFIG, FIREBASE_APP_NAME);
    this._db = app.database();
    this._connectedRef = this._db.ref(".info/connected");
    // Firebase keeps this value current (serverTime - this device's clock).
    this._db.ref(".info/serverTimeOffset").on("value", snap => {
      const v = Number(snap.val());
      if (Number.isFinite(v)) this._offsetCache = v;
    });
    this._bansRef = this._db.ref("rooms/" + MAIN_ROOM_ID + "/bannedUsers");
    this._imageAccessRef = this._db.ref("rooms/" + MAIN_ROOM_ID + "/imageAccess");
    this._chatStateRef = this._db.ref("chatState");
    // Banned-word list lives in the database (chatFilter/<word> = 1 or 0), never in the source files.
    this._db.ref("chatFilter").on("value", s => { try { setFilterWords(filterListFromDb(s.val())); } catch (e) {} }, () => {});
    this._profilesRef = this._db.ref("userProfiles");
    this.initRoles();
    this.bindToRoom(MAIN_ROOM_ID);
  },

  initRoles() {
    Object.values(ROLES).forEach(role => {
      // ID-keyed holders: roleIds/{roleId}/{loginId} = true | {temporary,...}
      this._roleIdRefs[role.id] = this._db.ref("roleIds/" + role.id);
    });
  },

  // Everything that has to AGREE between devices -- ban expiry, temporary-rank
  // expiry, private-room timers -- is measured against SERVER time, never the raw
  // device clock. Before this, a slow admin phone made a short ban expire the
  // moment it arrived (the ban screen never showed and the record got deleted),
  // a fast one turned 5 minutes into a day, and a banned player could end their
  // own ban just by setting their clock forward.
  _offsetCache: 0,
  async _serverOffset() {
    try {
      const snap = await this._db.ref(".info/serverTimeOffset").once("value");
      const value = Number(snap.val());
      if (Number.isFinite(value)) this._offsetCache = value;
    } catch (e) {}
    return this._offsetCache;
  },
  async _serverNow() {
    return Date.now() + (await this._serverOffset());
  },
  // The same thing without waiting, for countdowns and filters that run every second.
  serverNowSync() {
    return Date.now() + this._offsetCache;
  },

  // Live set of login IDs currently holding roleId. Temporary grants that
  // have expired are filtered out here (and swept by the timers below).
  watchRoleIds(roleId, onChange) {
    this._roleIdRefs[roleId].on("value", snap => {
      const val = snap.val() || {};
      const now = this.serverNowSync();
      const ids = Object.keys(val).filter(id => {
        const v = val[id];
        if (v === true) return true;
        return !!(v && v.temporary && Number(v.expiresAt) > now);
      });
      onChange(new Set(ids), val);
    });
  },

  // ── Inventory items. inventory/<loginId>/<item> = quantity, added by hand in the
  // Firebase console only (the rules refuse writes from the browser). ──
  watchInventory(onChange) {
    this._db.ref("inventory").on("value", snap => onChange(snap.val() || {}));
  },
  async hasItem(loginId, itemId) {
    if (!loginId) return false;
    try {
      const snap = await this._db.ref("inventory/" + this._pid(loginId) + "/" + itemId).get();
      return Number(snap.val()) > 0;
    } catch (e) { return false; }
  },

  async hasRoleId(roleId, loginId) {
    if (!roleId || !loginId || !this._roleIdRefs[roleId]) return false;
    try {
      const snap = await this._roleIdRefs[roleId].child(this._pid(loginId)).get();
      const value = snap.val();
      if (value === true) return true;
      return !!(value && value.temporary && Number(value.expiresAt) > this.serverNowSync());
    } catch (e) { return false; }
  },

  // Highest rank a login ID holds across every role, or "unranked".
  async getEffectiveRole(loginId) {
    if (!loginId) return "unranked";
    let best = ROLES.unranked;
    for (const role of Object.values(ROLES)) {
      if (role.implicit) continue;
      if (role.rank > best.rank && await this.hasRoleId(role.id, loginId)) best = role;
    }
    return best.id;
  },

  logCommand(text) {
    if (!this._commandHistoryRef || !text) return;
    this._commandHistoryRef.push({
      command: String(text).slice(0, 200),
      actorName: myName || "Unknown",
      actorLoginId: myLoginId ? String(myLoginId) : null,
      ts: firebase.database.ServerValue.TIMESTAMP
    }).catch(() => {});
  },

  async getCommandHistory(limit = 30) {
    if (!this._commandHistoryRef) return [];
    const snap = await this._commandHistoryRef.limitToLast(limit).get();
    return Object.values(snap.val() || {}).reverse();
  },

  // ══════════════════════════════════════════════════════════
  // ID-KEYED PROFILES  (userProfiles/{loginId})
  // Everything that should follow a person -- rank, image access, bubble
  // color, last-used chat name -- lives here keyed by their VUS account ID,
  // never by display name. Renaming, leaving, rejoining or logging out and
  // back in as a different name all keep the same profile.
  //   { role, imageAccess, color:{bubble,text,changedAt}, lastName, updatedAt }
  // `role` is the highest persistent rank the ID holds. Absent = "unranked".
  // ══════════════════════════════════════════════════════════
  _pid(loginId) { return this._safeKey(String(loginId)); },

  async getProfile(loginId) {
    if (!loginId || !this._profilesRef) return null;
    try {
      const snap = await this._profilesRef.child(this._pid(loginId)).get();
      return snap.exists() ? snap.val() : null;
    } catch (e) { return null; }
  },

  async updateProfile(loginId, patch) {
    if (!loginId || !this._profilesRef) throw new Error("Missing login ID");
    await this._profilesRef.child(this._pid(loginId)).update({
      ...patch,
      updatedAt: firebase.database.ServerValue.TIMESTAMP
    });
  },

  watchProfile(loginId, onChange) {
    if (!loginId || !this._profilesRef) return () => {};
    const ref = this._profilesRef.child(this._pid(loginId));
    const handler = snap => onChange(snap.exists() ? snap.val() : null);
    ref.on("value", handler);
    return () => ref.off("value", handler);
  },

  async setRoleForId(loginId, roleId) {
    if (!ROLES[roleId]) throw new Error("Unknown role");
    await this.updateProfile(loginId, { role: roleId });
  },

  async getImageAccess(loginId) {
    if (!loginId) return false;
    const profile = await this.getProfile(loginId);
    return !!(profile && profile.imageAccess === true);
  },

  async setImageAccess(loginId, enabled) {
    if (!loginId) throw new Error("Missing login ID");
    await this.issue("grants", { k: "image", t: loginId, v: enabled ? "on" : "off" });
    await this.updateProfile(loginId, { imageAccess: !!enabled });
  },

  async setChatClosed(closed) {
    await this._chatStateRef.child("closed").set(!!closed);
  },

  // ── Peer verification records (see PEER VERIFICATION) ──
  async issue(node, rec) {
    if (!myLoginId) return null;
    try {
      const ref = this._db.ref("rooms/" + MAIN_ROOM_ID + "/" + node).push();
      rememberIssued(ref.key);
      await ref.set({
        k: rec.k, t: String(rec.t), b: String(myLoginId),
        ...(rec.d ? { d: Math.round(rec.d) } : {}), ...(rec.v ? { v: String(rec.v) } : {}),
        ts: firebase.database.ServerValue.TIMESTAMP
      });
      return ref.key;
    } catch (e) { return null; }   // rules not updated yet: the action still goes ahead, it just can't be verified
  },
  castVeto(node, id) { return this._db.ref("rooms/" + MAIN_ROOM_ID + "/" + node + "/" + id + "/veto").set(true); },
  watchVerify(cb) { this._db.ref("rooms/" + MAIN_ROOM_ID + "/verify/on").on("value", s => cb(s.val() === true)); },
  setVerify() { return this._db.ref("rooms/" + MAIN_ROOM_ID + "/verify/on").set(true); },
  watchRecs(node, cb) {
    const base = this._db.ref("rooms/" + MAIN_ROOM_ID + "/" + node);
    const ref = node === "actions" ? base.limitToLast(150) : base;
    ref.on("child_added", s => cb(node, s.key, s.val()));
    ref.on("child_changed", s => cb(node, s.key, s.val()));
    ref.on("child_removed", s => cb(node, s.key, null));
  },
  watchAllTimeouts(cb) {
    this._timeoutsRef.on("child_added", s => cb(s.key, s.val()));
    this._timeoutsRef.on("child_changed", s => cb(s.key, s.val()));
    this._timeoutsRef.on("child_removed", s => cb(s.key, null));
  },
  watchAllBans(cb) {
    this._bansRef.on("child_added", s => cb(s.key, s.val()));
    this._bansRef.on("child_changed", s => cb(s.key, s.val()));
    this._bansRef.on("child_removed", s => cb(s.key, null));
  },

  watchChatClosed(onChange) {
    const handler = snap => onChange(snap.val() === true);
    this._chatStateRef.child("closed").on("value", handler);
    return () => this._chatStateRef.child("closed").off("value", handler);
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
    this._atPingCooldownRef = this._db.ref("rooms/" + roomId + "/atPingCooldowns");
    this._leaveEventsRef = this._db.ref("rooms/" + roomId + "/leaveEvents");
    // Channels (ch-*) share the main room's mutes and staff-command log, so a mute can't be dodged by switching channel.
    const modRoom = /^ch-/.test(roomId) ? MAIN_ROOM_ID : roomId;
    this._timeoutsRef = this._db.ref("rooms/" + modRoom + "/timeouts");
    this._modRetimeoutRef = this._db.ref("rooms/" + modRoom + "/modRetimeoutCooldowns");
    this._commandHistoryRef = this._db.ref("rooms/" + modRoom + "/commandHistory");
    this._mediaMetaRef = this._db.ref("rooms/" + roomId + "/mediaMeta");
    this._mediaDataRef = this._db.ref("rooms/" + roomId + "/mediaData");
    this._editsRef = this._db.ref("rooms/" + roomId + "/edits");
    this._reactionsRef = this._db.ref("rooms/" + roomId + "/reactions");
    this._pollsRef = this._db.ref("rooms/" + roomId + "/polls");
    this._pollVotesRef = this._db.ref("rooms/" + roomId + "/pollVotes");
  },

  // ── Polls: polls/<id> = end time (write-once; the vote rules read it), pollVotes/<id>/<loginId> = option (write-once) ──
  async createPoll(q, opts, ownId, color) {
    const id = Math.random().toString(36).slice(2, 10).padEnd(8, "x");
    const exp = this.serverNowSync() + POLL_MS;
    const sig = id + ":" + annHash(q + "|" + opts.join("|"));
    const key = await this.issue("actions", { k: "poll", t: "000000", v: sig });
    if (!key && verifyActive()) throw new Error("approval");
    await this._pollsRef.child(id).set(exp);
    const data = {
      name: myName, loginId: String(ownId), text: "📊 Poll: " + q,
      poll: { id, q, o: opts, exp }, ts: firebase.database.ServerValue.TIMESTAMP,
      ...(color ? { bubble: color.bubble, textColor: color.text } : {})
    };
    return this._ref.push(data);
  },
  vote(pid, loginId, idx) { return this._pollVotesRef.child(pid).child(String(loginId)).set(idx); },
  watchPollVotes(pid, cb) {
    const ref = this._pollVotesRef.child(pid);
    const h = ref.on("value", s => cb(s.val() || {}));
    return () => { try { ref.off("value", h); } catch (e) {} };
  },
  getPollVotes(pid) { return this._pollVotesRef.child(pid).get().then(s => s.val() || {}); },

  detachAllListeners() {
    if (this._ref) this._ref.off();
    if (this._typingRef) this._typingRef.off();
    if (this._presenceRef) this._presenceRef.off();
    if (this._leaveEventsRef) this._leaveEventsRef.off();
    if (this._editsRef) this._editsRef.off();
    if (this._mediaMetaRef) this._mediaMetaRef.off();
    if (this._timeoutsRef) this._timeoutsRef.off();
    if (this._reactionsRef) this._reactionsRef.off();
  },

  // ── Videos: mediaMeta/<id> = expiry time (ms); mediaData/<id>/<n> = base64 chunks. Anyone who sees the expiry pass deletes both. ──
  watchMedia(cb) {
    this._mediaMetaRef.on("child_added", s => cb(s.key, s.val()));
    this._mediaMetaRef.on("child_changed", s => cb(s.key, s.val()));
    this._mediaMetaRef.on("child_removed", s => cb(s.key, null));
  },
  async deleteMedia(id) {
    try { await this._mediaDataRef.child(id).remove(); } catch (e) {}
    try { await this._mediaMetaRef.child(id).remove(); } catch (e) {}
  },
  async sendVideo(name, file, dur, loginId, onProgress, caption, replyTo) {
    const id = this._mediaDataRef.push().key;
    const n = Math.ceil(file.size / VIDEO_CHUNK_BYTES);
    // The expiry goes up FIRST (generous upload window) so a dead upload is still swept away.
    await this._mediaMetaRef.child(id).set((await this._serverNow()) + VIDEO_UPLOAD_WINDOW_MS);
    let next = 0, done = 0;
    const worker = async () => {
      for (;;) {
        const i = next++; if (i >= n) return;
        const b64 = await blobToBase64(file.slice(i * VIDEO_CHUNK_BYTES, (i + 1) * VIDEO_CHUNK_BYTES));
        await this._mediaDataRef.child(id).child(String(i)).set(b64);
        done++; if (onProgress) onProgress(done / n);
      }
    };
    try { await Promise.all([worker(), worker(), worker()]); }
    catch (e) { await this.deleteMedia(id); throw e; }
    const exp = (await this._serverNow()) + VIDEO_TTL_MS;
    await this._mediaMetaRef.child(id).set(exp);
    const prof = await this.getProfile(loginId);
    const color = prof && prof.color ? prof.color : null, cos = cosmFields(prof && prof.cosm);
    delete cos.fx;
    localVideoUrls.set(id, URL.createObjectURL(file));
    await this._ref.push({
      name: name,
      ...(loginId ? { loginId: String(loginId) } : {}),
      ...(caption ? { text: caption } : {}),
      ts: firebase.database.ServerValue.TIMESTAMP,
      video: { id, n, size: file.size, mime: file.type, dur: Math.round(dur * 10) / 10, exp },
      ...(color && color.ring ? { ring: color.ring } : {}),
      ...cos,
      ...(replyTo ? { replyTo } : {})
    });
    return id;
  },
  async fetchVideo(id, n, mime, onProgress) {
    const parts = new Array(n); let next = 0, done = 0;
    const worker = async () => {
      for (;;) {
        const i = next++; if (i >= n) return;
        const snap = await this._mediaDataRef.child(id).child(String(i)).get();
        const b64 = snap.val(); if (typeof b64 !== "string") throw new Error("gone");
        const bin = atob(b64); const u8 = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
        parts[i] = u8; done++; if (onProgress) onProgress(done / n);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return new Blob(parts, { type: mime });
  },

  // ── Edits: edits/<messageId> = { text, by, ts }. Readers only apply an edit whose `by` is the message's author. ──
  watchEdits(cb) {
    const h = snap => cb(snap.key, snap.val());
    this._editsRef.on("child_added", h);
    this._editsRef.on("child_changed", h);
  },
  async editMessage(msgId, text, loginId) {
    await this._editsRef.child(msgId).set({ text, by: String(loginId), ts: firebase.database.ServerValue.TIMESTAMP });
  },
  // ── Reactions: reactions/<messageId>/<emoji>/<loginId> = true ──
  watchReactions(cb) {
    this._reactionsRef.on("child_added", s => cb(s.key, s.val()));
    this._reactionsRef.on("child_changed", s => cb(s.key, s.val()));
    this._reactionsRef.on("child_removed", s => cb(s.key, null));
  },
  async setReaction(msgId, emoji, loginId, on) {
    const ref = this._reactionsRef.child(msgId).child(emoji).child(String(loginId));
    if (on) await ref.set(true); else await ref.remove();
  },

  watchConnection(onStatus) {
    this._connectedRef.on("value", snap => onStatus(snap.val() === true));
  },

  watchMessages(onMessage) {
    this._ref.limitToLast(MAX_MESSAGES).on("child_added", snap => {
      onMessage({ id: snap.key, ...snap.val() });
    });
  },

  async sendImage(name, dataUrl, loginId, caption, replyTo) {
    const prof = await this.getProfile(loginId);
    const color = prof && prof.color ? prof.color : null, cos = cosmFields(prof && prof.cosm);
    delete cos.fx;
    const data = {
      name: name,
      ...(loginId ? { loginId: String(loginId) } : {}),
      imageData: dataUrl,
      ...(caption ? { text: caption } : {}),
      ts: firebase.database.ServerValue.TIMESTAMP,
      ...(color ? { bubble: color.bubble, textColor: color.text, ...(color.ring ? { ring: color.ring } : {}) } : {}),
      ...cos,
      ...(replyTo ? { replyTo } : {})
    };
    try { return await this._ref.push(data); }
    catch (e) {
      if ((replyTo || data.ring || data.rfx || data.tag) && isPermissionDenied(e)) { delete data.replyTo; delete data.ring; delete data.rfx; delete data.tag; return this._ref.push(data); }
      throw e;
    }
  },

  async send(name, text, mention, loginId, replyTo) {
    const prof = await this.getProfile(loginId);
    const color = prof && prof.color ? prof.color : null, cos = cosmFields(prof && prof.cosm);
    const data = {
      name: name,
      ...(loginId ? { loginId: String(loginId) } : {}),
      text: text,
      ts: firebase.database.ServerValue.TIMESTAMP,
      ...(mention ? { mention: mention.name + (mention.silent ? SILENT_MENTION_MARK : "") } : {}),
      ...(color ? { bubble: color.bubble, textColor: color.text, ...(color.ring ? { ring: color.ring } : {}) } : {}),
      ...cos,
      ...(replyTo ? { replyTo } : {})
    };
    try { return await this._ref.push(data); }
    catch (e) {
      // The database rules may not know about replies yet: still deliver the message.
      if ((replyTo || data.ring || data.rfx || data.tag || data.fx) && isPermissionDenied(e)) {
        // Old rules don't know about the ring/tag/effect: drop just those and try again.
        if (data.ring || data.rfx || data.tag || data.fx) {
          delete data.ring; delete data.rfx; delete data.tag; delete data.fx;
          try { return await this._ref.push(data); } catch (e2) { if (!(replyTo && isPermissionDenied(e2))) throw e2; }
        }
        delete data.replyTo;
        const r = await this._ref.push(data);
        showComposerNotice("Sent without the reply link: the database rules need the update that allows replies.");
        return r;
      }
      throw e;
    }
  },

  // ── Per-name bubble color ──
  // Was write-once; now changeable every COLOR_CHANGE_COOLDOWN_MS, enforced
  // against a server-timestamped `changedAt` so a wrong local clock can't
  // be used to bypass the cooldown.
  // Colors are stored on the ID profile (see userProfiles above), not by
  // name, so they follow the account through renames and logouts.
  async getNameColor(loginId) {
    const profile = await this.getProfile(loginId);
    return profile && profile.color ? profile.color : null;
  },

  async claimColor(loginId, bubble, text, ring) {
    const existing = await this.getNameColor(loginId);
    if (existing) {
      const serverNow = await this._serverNow();
      const changedAt = existing.changedAt || 0;
      const elapsed = serverNow - changedAt;
      if (elapsed < COLOR_CHANGE_COOLDOWN_MS) {
        return { ok: false, reason: "cooldown", remainingMs: COLOR_CHANGE_COOLDOWN_MS - elapsed };
      }
    }
    await this.updateProfile(loginId, {
      color: { bubble, text, ...(ring ? { ring } : {}), changedAt: firebase.database.ServerValue.TIMESTAMP }
    });
    return { ok: true };
  },

  async isAccountOnline(loginId) {
    try {
      const snap = await this._presenceRef.get();
      return Object.values(snap.val() || {}).some(e => e && String(e.loginId || "") === String(loginId));
    } catch (e) { return false; }
  },

  // "Join from this tab": clear every entry this account has in the current room so the
  // claim that follows can't hit "already-online". Removing is always allowed by the rules.
  // The tab that was displaced notices (joinedAt changes) and steps aside -- see _startPresenceHeal.
  async removeAccountPresence(loginId) {
    const snap = await this._presenceRef.get();
    const val = snap.val() || {};
    const jobs = Object.entries(val)
      .filter(([, e]) => e && String(e.loginId || "") === String(loginId))
      .map(([key]) => this._presenceRef.child(key).remove());
    await Promise.all(jobs);
    return jobs.length;
  },

  // Called by the displaced tab: forget my presence WITHOUT deleting it (it now belongs to the new tab).
  abandonPresence() {
    this._stopPresenceHeal();
    try { if (this._myLeaveEventRef) this._myLeaveEventRef.onDisconnect().cancel(); } catch (e) {}
    try { if (this._myPresenceRef) this._myPresenceRef.onDisconnect().cancel(); } catch (e) {}
    this._myLeaveEventRef = null;
    this._myPresenceRef = null;
  },

  async isNameTaken(name, ownLoginId) {
    const snap = await this._presenceRef.get();
    const val = snap.val() || {};
    const wanted = nameSkeleton(name);
    return Object.entries(val).some(([key, entry]) => {
      if (!entry) return false;
      if (ownLoginId && String(entry.loginId || "") === String(ownLoginId)) return false;   // an older session of MY account
      return nameSkeleton(key) === wanted;
    });
  },

  // NOTE: this is now async (it wasn't before) — see the role-sync section
  // below for why. All existing call sites already just call it without
  // awaiting the result, which is fine: everything it does is fire off
  // Firebase writes that resolve on their own, nothing here needs the
  // caller to wait.
  async claimPresence(name, silent, loginId) {
    if (!loginId) return { ok: false, reason: "missing-id" };
    const presRef = this._presenceRef;   // the room this claim is for (the person may switch away while we wait)
    const ban = await this.getBan(loginId);
    if (ban) return { ok: false, reason: "banned", ban };

    const presenceSnapshot = await presRef.get();
    const presence = presenceSnapshot.val() || {};
    const accountAlreadyOnline = Object.values(presence).some(entry =>
      entry && String(entry.loginId || "") === String(loginId)
    );
    if (accountAlreadyOnline) return { ok: false, reason: "already-online" };
    if (hasHiddenChars(name)) return { ok: false, reason: "bad-name" };
    // The join form's check is only a courtesy. THIS is where the name is written, so this
    // is where a different account already using it (or a lookalike of it) must be refused,
    // instead of silently overwriting that person.
    const wantedSkeleton = nameSkeleton(name);
    const nameClash = Object.entries(presence).some(([key, entry]) =>
      entry && String(entry.loginId || "") !== String(loginId) && nameSkeleton(key) === wantedSkeleton);
    if (nameClash) return { ok: false, reason: "name-taken" };

    if (this._presenceRef !== presRef) return { ok: false, reason: "switched" };   // moved on to another room meanwhile: don't write into the old one
    this.releasePresence();
    this._myPresenceRef = this._presenceRef.child(this._safeKey(name));
    this._silentSession = !!silent;

    const leaveEventRef = this._leaveEventsRef.push();
    if (!this._silentSession) {
      leaveEventRef.onDisconnect().set({ name, ts: firebase.database.ServerValue.TIMESTAMP });
    }
    this._myLeaveEventRef = leaveEventRef;

    this._myPresenceRef.onDisconnect().remove();
    try {
      await this._myPresenceRef.set({ loginId: String(loginId), joinedAt: firebase.database.ServerValue.TIMESTAMP });
    } catch (e) {
      // The database refused the join. While the chat is closed that is
      // intentional (the rules block new joins), so undo what we armed above.
      try { this._myPresenceRef.onDisconnect().cancel(); } catch (x) {}
      try { leaveEventRef.onDisconnect().cancel(); } catch (x) {}
      return { ok: false, reason: "closed" };
    }

    this._startPresenceHeal(name, loginId);
    await this._recordJoinedAt();

    // Roles/image access/color are tied to loginId (userProfiles + roleIds),
    // so joining changes nothing about them -- they were never removed.
    // Remember the name this ID last used so offline holders can still be
    // shown by name, and re-arm expiry timers for any temporary roles.
    this.updateProfile(loginId, { lastName: name }).catch(() => {});
    this.rearmTemporaryRoles(loginId);

    if (!this._silentSession) {
      this._ref.push({
        system: true,
        text: name + " joined",
        ts: firebase.database.ServerValue.TIMESTAMP
      });
    }
    return { ok: true };
  },

  // ── Presence self-repair ──
  // If my entry in the online list disappears while I'm still in the chat (a network
  // blip, or someone deleting it), put it back. It won't if I left on purpose, I'm
  // banned, or the chat is closed (the database refuses the write).
  _startPresenceHeal(name, loginId) {
    this._stopPresenceHeal();
    this._presenceMeta = { name, loginId: String(loginId) };
    this._healRef = this._myPresenceRef;
    this._myJoinedAt = null;
    this._healHandler = snap => {
      if (!snap.exists()) { this.ensurePresence(); return; }
      // Someone else (this account in another tab) re-claimed my entry: joinedAt no longer matches
      // the value I wrote. Step aside instead of fighting for it.
      const j = (snap.val() || {}).joinedAt;
      if (this._myJoinedAt != null && j != null && j !== this._myJoinedAt && typeof this.onDisplaced === "function") {
        const cb = this.onDisplaced;
        this.abandonPresence();
        cb();
      }
    };
    this._healRef.on("value", this._healHandler);
  },
  async _recordJoinedAt() {
    try {
      const ref = this._myPresenceRef;
      const v = (await ref.get()).val();
      if (ref === this._myPresenceRef && v && v.joinedAt != null) this._myJoinedAt = v.joinedAt;
    } catch (e) {}
  },
  _stopPresenceHeal() {
    if (this._healRef && this._healHandler) this._healRef.off("value", this._healHandler);
    this._healRef = this._healHandler = this._presenceMeta = null;
    clearTimeout(this._healTimer);
    this._healTimer = null;
  },
  ensurePresence() {
    if (!this._presenceMeta || this._healTimer) return;
    const wait = Math.max(1500, 5000 - (Date.now() - (this._lastHealAt || 0)));
    this._healTimer = setTimeout(async () => {
      this._healTimer = null;
      const meta = this._presenceMeta, mine = this._myPresenceRef;
      if (!meta || !mine) return;
      try {
        const listed = Object.values((await this._presenceRef.get()).val() || {})
          .some(v => v && String(v.loginId || "") === meta.loginId);
        if (listed) return;
        if (await this.getBan(meta.loginId)) return;
        if (this._myPresenceRef !== mine) return;
        this._lastHealAt = Date.now();
        mine.onDisconnect().remove();
        this._myJoinedAt = null;
        await mine.set({ loginId: meta.loginId, joinedAt: firebase.database.ServerValue.TIMESTAMP });
        await this._recordJoinedAt();
        if (!this._silentSession) {
          try { if (this._myLeaveEventRef) this._myLeaveEventRef.onDisconnect().cancel(); } catch (e) {}
          const leaveRef = this._leaveEventsRef.push();
          leaveRef.onDisconnect().set({ name: meta.name, ts: firebase.database.ServerValue.TIMESTAMP });
          this._myLeaveEventRef = leaveRef;
        }
      } catch (e) {}
    }, wait);
  },

  releasePresenceSilently() {
    this._stopPresenceHeal();
    if (this._myLeaveEventRef) {
      this._myLeaveEventRef.onDisconnect().cancel();
      this._myLeaveEventRef = null;
    }
    if (this._myPresenceRef) {
      this._myPresenceRef.onDisconnect().cancel();
      this._myPresenceRef.remove();
      this._myPresenceRef = null;
    }
    if (this._mySessionLockRef) {
      this._mySessionLockRef.onDisconnect().cancel();
      this._mySessionLockRef.remove();
      this._mySessionLockRef = null;
    }
  },

  releasePresence() {
    this._stopPresenceHeal();
    if (this._myPresenceRef) {
      const gone = this._myPresenceRef;
      gone.remove().catch(() => setTimeout(() => gone.remove().catch(() => {}), 2500));   // a failed removal would leave a ghost, so try once more
      this._myPresenceRef = null;
    }
    if (this._myLeaveEventRef) {
      this._myLeaveEventRef.onDisconnect().cancel();
      this._myLeaveEventRef = null;
    }
    if (this._mySessionLockRef) {
      this._mySessionLockRef.onDisconnect().cancel();
      this._mySessionLockRef.remove();
      this._mySessionLockRef = null;
    }
  },

  // A tab reload loses in-memory expiry timers; re-arm them from the store.
  async rearmTemporaryRoles(loginId) {
    if (!loginId) return;
    for (const role of Object.values(ROLES)) {
      if (role.implicit) continue;
      try {
        const val = (await this._roleIdRefs[role.id].child(this._pid(loginId)).get()).val();
        if (val && val.temporary) {
          if (Number(val.expiresAt) > this.serverNowSync()) this.scheduleTemporaryRoleExpiry(role.id, loginId, Number(val.expiresAt));
          else { await this._roleIdRefs[role.id].child(this._pid(loginId)).remove(); }
        }
      } catch (e) {}
    }
  },

  // See "LEAVE MESSAGES" above. Every client runs this timer; only the client
  // that wins the lock in _flushLeaves actually posts.
  watchLeaveEvents() {
    this._leaveEventsRef.on("child_added", snap => {
      if (!snap.val()) { snap.ref.remove(); return; }
      clearTimeout(this._leaveTimer);
      this._leaveAttempts = 0;
      this._leaveTimer = setTimeout(() => this._flushLeaves(), LEAVE_BATCH_QUIET_MS);
    });
  },

  async _isFirstOnline() {
    if (!this._myPresenceRef) return false;
    try {
      const keys = Object.keys((await this._presenceRef.get()).val() || {}).sort();
      return keys.length > 0 && keys[0] === this._myPresenceRef.key;
    } catch (e) { return false; }
  },

  async _flushLeaves() {
    const roomId = this.currentRoomId;
    if (!roomId || !this._leaveEventsRef) return;

    // Nothing waiting? (Someone else already announced it.)
    let waiting;
    try { waiting = (await this._leaveEventsRef.get()).val(); } catch (e) { return; }
    if (!waiting || !Object.keys(waiting).length) return;

    // Elect ONE poster. The lock expires so a poster who vanishes can't jam it.
    const lockRef = this._db.ref("rooms/" + roomId + "/leaveFlushLock");
    let won = false;
    try {
      const result = await lockRef.transaction(current => {
        const now = Date.now();
        if (current && current.by && (now - Number(current.at || 0)) < LEAVE_LOCK_TTL_MS) return undefined; // taken
        return { by: this._clientId, at: now };
      });
      won = !!(result && result.committed);
    } catch (e) {
      // The lock path isn't usable (e.g. the database rules don't allow it).
      // Fall back to a rule that needs no extra path: of the people online,
      // the one whose name sorts first is the poster.
      won = await this._isFirstOnline();
    }

    if (!won) {
      // Someone else is posting. If the events are still there a bit later
      // (they crashed mid-post), try again a few times.
      if (this._leaveAttempts++ < 5) {   // 5 x 4s outlasts the 15s lock
        clearTimeout(this._leaveTimer);
        this._leaveTimer = setTimeout(() => this._flushLeaves(), LEAVE_RETRY_MS);
      }
      return;
    }

    try {
      const events = (await this._leaveEventsRef.get()).val() || {};
      const keys = Object.keys(events);
      const presence = (await this._presenceRef.get()).val() || {};
      const now = await this._serverNow();
      const names = [];
      const seen = new Set();
      for (const key of keys) {
        const ev = events[key];
        if (!ev || !ev.name) continue;
        if (now - Number(ev.ts || now) > LEAVE_MAX_AGE_MS) continue;   // too old: drop quietly
        const safe = this._safeKey(ev.name);
        if (presence[safe]) continue;   // already back (a refresh): no "left" message
        if (seen.has(safe)) continue;   // same person, several events
        seen.add(safe);
        names.push(ev.name);
      }
      if (names.length) {
        await this._ref.push({
          system: true,
          text: formatLeaveText(names),
          leftNames: names,
          ts: firebase.database.ServerValue.TIMESTAMP
        });
      }
      // Remove exactly the events we handled. A leave that arrived while we
      // were posting stays, and starts the next 5-second timer for everyone.
      await Promise.all(keys.map(k => this._leaveEventsRef.child(k).remove()));
    } catch (e) {
      console.error("[VUS Chat] leave announcement failed:", e);
    } finally {
      try { await lockRef.remove(); } catch (e) {}
    }
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
      const list = Object.entries(val).map(([key, v]) => ({
        name: key,
        loginId: (v && typeof v === "object" && v.loginId) ? String(v.loginId) : null,
        joinedAt: (v && typeof v === "object") ? (v.joinedAt || null) : null,
        afk: !!(v && typeof v === "object" && v.afk === true)
      }));
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

  // ── Bans and timeouts (Owner Menu / Mod Menu) ──
  // A ban only counts if it was made by an Admin or higher who outranks the person
  // banned, and Co-owner / Owner can't be banned at all. A fake ban (e.g. a "loop ban"
  // script) is ignored. It can't stop someone who copies a real staff ID onto a fake
  // ban -- only real logins could. Bans made by hand in the database need byLoginId
  // set to a staff account ID, or they're ignored too.
  async isBanValid(ban, targetLoginId) {
    if (!ban || !ban.byLoginId) return false;
    if (await this.hasItem(targetLoginId, "protection")) return false; // protected: no ban counts
    const [byRole, targetRole] = await Promise.all([
      this.getEffectiveRole(ban.byLoginId),
      this.getEffectiveRole(targetLoginId)
    ]);
    const byRank = ROLES[byRole].rank, targetRank = ROLES[targetRole].rank;
    if (targetRank >= ROLES.coowner.rank) return false;
    if (byRank < ROLES.mod.rank || byRank <= targetRank) return false;
    if (byRank < ROLES.admin.rank) { // a Mod's ban only counts when it's temporary and within the Mod limit
      const len = Number(ban.expiresAt) - Number(ban.bannedAt);
      return Number.isFinite(len) && len > 0 && len <= TIME_LIMITS.modTempban.max + 20000;
    }
    return true;
  },

  async getBan(loginId) {
    if (!loginId) return null;
    try {
      const snap = await this._bansRef.child(this._safeKey(String(loginId))).get();
      const ban = snap.exists() ? snap.val() : null;
      if (ban && ban.expiresAt && Number(ban.expiresAt) <= (await this._serverNow())) {
        await snap.ref.remove();
        return null;
      }
      if (ban && !(await this.isBanValid(ban, loginId))) return null;
      return ban;
    } catch (e) {
      return null;
    }
  },

  async banUser(loginId, username, byLoginId, durationMs, reason) {
    if (!loginId) throw new Error("Missing login ID");
    // Server time, not this device's clock (see _serverOffset above).
    await this.issue("actions", { k: "ban", t: loginId, d: durationMs || 0 });
    const expiresAt = durationMs ? (await this._serverNow()) + durationMs : 0;
    const banRec = {
      loginId: String(loginId),
      username: username || "Unknown",
      byLoginId: byLoginId ? String(byLoginId) : null,
      bannedAt: firebase.database.ServerValue.TIMESTAMP,
      ...(expiresAt ? { expiresAt } : {}),
      ...(reason ? { reason: String(reason).slice(0, 100) } : {})
    };
    try { await this._bansRef.child(this._safeKey(String(loginId))).set(banRec); }
    catch (e) { if (banRec.reason && isPermissionDenied(e)) { delete banRec.reason; await this._bansRef.child(this._safeKey(String(loginId))).set(banRec); } else throw e; }
    const snapshot = await this._presenceRef.get();
    const entries = snapshot.val() || {};
    await Promise.all(Object.entries(entries)
      .filter(([, value]) => value && String(value.loginId) === String(loginId))
      .map(([key]) => this._presenceRef.child(key).remove()));
  },

  // ── ID-keyed role grants ──
  // A permanent grant is `true`; a temporary grant is an object with an
  // expiresAt. Both live at roleIds/{roleId}/{loginId} and persist until
  // explicitly removed or (for temporary) expired.
  scheduleTemporaryRoleExpiry(roleId, loginId, expiresAt) {
    const timerKey = roleId + ":" + loginId;
    clearTimeout(this._temporaryRoleTimers[timerKey]);
    const remaining = Math.max(0, expiresAt - this.serverNowSync());
    const wait = Math.min(remaining, 2147483647);
    this._temporaryRoleTimers[timerKey] = setTimeout(async () => {
      if (remaining > 2147483647) {
        this.scheduleTemporaryRoleExpiry(roleId, loginId, expiresAt);
        return;
      }
      try {
        const ref = this._roleIdRefs[roleId].child(this._pid(loginId));
        const current = (await ref.get()).val();
        if (current && current.temporary && Number(current.expiresAt) <= this.serverNowSync()) {
          await ref.remove();
              }
      } catch (e) {}
      delete this._temporaryRoleTimers[timerKey];
    }, wait);
  },

  async grantRoleToId(roleId, loginId) {
    if (!ROLES[roleId] || ROLES[roleId].implicit || !loginId) throw new Error("Invalid role grant");
    if (roleId === "mod" || roleId === "normie") await this.issue("grants", { k: "role", t: loginId, v: roleId });
    await this._roleIdRefs[roleId].child(this._pid(loginId)).set(true);
  },

  async grantTemporaryRoleToId(roleId, loginId, durationMs, byLoginId) {
    if (!ROLES[roleId] || ROLES[roleId].implicit || roleId === "crown" || !loginId || durationMs <= 0) {
      throw new Error("Invalid temporary role grant");
    }
    if (roleId === "mod" || roleId === "normie") await this.issue("grants", { k: "role", t: loginId, v: roleId, d: durationMs });
    const expiresAt = (await this._serverNow()) + durationMs;
    await this._roleIdRefs[roleId].child(this._pid(loginId)).set({
      temporary: true,
      byLoginId: byLoginId ? String(byLoginId) : null,
      grantedAt: firebase.database.ServerValue.TIMESTAMP,
      expiresAt
    });
    this.scheduleTemporaryRoleExpiry(roleId, loginId, expiresAt);
  },

  async removeRoleFromId(roleId, loginId) {
    if (!ROLES[roleId] || ROLES[roleId].implicit || !loginId) throw new Error("Invalid role removal");
    clearTimeout(this._temporaryRoleTimers[roleId + ":" + loginId]);
    if (roleId === "mod" || roleId === "normie") await this.issue("grants", { k: "unrole", t: loginId, v: roleId });
    await this._roleIdRefs[roleId].child(this._pid(loginId)).remove();
  },

  async unbanUser(identifier) {
    const clean = String(identifier || "").trim();
    if (!clean) throw new Error("Missing username or login ID");

    let loginId = clean;
    if (!/^\d{6}$/.test(clean)) {
      const snapshot = await this._bansRef.get();
      const bans = snapshot.val() || {};
      const wanted = clean.toLowerCase();
      const match = Object.values(bans).find(entry =>
        entry && String(entry.username || "").trim().toLowerCase() === wanted
      );
      if (!match || !match.loginId) throw new Error("No ban found for that username");
      loginId = String(match.loginId);
    }

    await this._bansRef.child(this._safeKey(loginId)).remove();
    return loginId;
  },

  watchBan(loginId, onChange) {
    if (!loginId) return () => {};
    const ref = this._bansRef.child(this._safeKey(String(loginId)));
    let lastSnap = null, retryTimer = null;
    const handler = async (snap, n) => {
      lastSnap = snap;
      const ban = snap.exists() ? snap.val() : null;
      let valid = !!(ban && (await this.isBanValid(ban, loginId)));
      if (valid && verifyActive()) {
        const st = banStatus(loginId, ban);
        if (st !== "ok") {
          valid = false;
          clearTimeout(retryTimer);
          if (st === "pending" && (n || 0) < 10) retryTimer = setTimeout(() => handler(snap, (n || 0) + 1), 1000);
        }
      }
      onChange(valid ? ban : null);
    };
    ref.on("value", handler);
    this._banRecheck = () => { if (lastSnap) handler(lastSnap, 0); };
    return () => { ref.off("value", handler); clearTimeout(retryTimer); this._banRecheck = null; };
  },

  // Stored per-room at rooms/{roomId}/timeouts/{loginId} = { expiresAt, by }.
  // expiresAt is anchored to SERVER time (see _serverNow) so a timed-out
  // person can't dodge it by winding back their local clock, and an
  // owner's/mod's timeout of someone in one room has no effect in another
  // room (matches how presence/roles-in-room are already scoped — only
  // ROLES like crown/mod are global, timeouts are not). `by` records who
  // set it (safe-keyed), so clearTimeout_ can enforce "only the mod who
  // set it can clear it early" for mod-issued timeouts — see
  // canClearTimeout below.
  async setTimeout_(targetLoginId, durationMs, byLoginId, reason) {
    await this.issue("actions", { k: "mute", t: targetLoginId, d: durationMs });
    const serverNow = await this._serverNow();
    const rec = {
      expiresAt: serverNow + durationMs,
      by: byLoginId ? String(byLoginId) : null,
      ...(reason ? { reason: String(reason).slice(0, 100) } : {})
    };
    try { await this._timeoutsRef.child(this._safeKey(String(targetLoginId))).set(rec); }
    catch (e) { if (rec.reason && isPermissionDenied(e)) { delete rec.reason; await this._timeoutsRef.child(this._safeKey(String(targetLoginId))).set(rec); } else throw e; }
  },

  // Unconditional clear — used by the Owner Menu (crown can always clear
  // any timeout) and internally once ownership of a clear request has
  // already been checked (see canClearTimeout).
  async clearTimeout_(targetLoginId) {
    await this._timeoutsRef.child(this._safeKey(String(targetLoginId))).remove();
  },

  // Returns { by } for the current timeout on targetName, or null if none
  // is active. Used to decide whether the requesting mod is the one who
  // set it, per "only the mod who set it can clear it early."
  async getTimeoutSetBy(targetLoginId) {
    try {
      const snap = await this._timeoutsRef.child(this._safeKey(String(targetLoginId))).get();
      const val = snap.val();
      return (val && val.by) ? val.by : null;
    } catch (e) {
      return null;
    }
  },

  // Returns remaining ms if targetName is currently timed out in this
  // room, or 0 if not (including if the record is stale/expired — a
  // stale record is left for the next read/write to clean up rather than
  // deleted here, to keep this a plain read with no side effects).
  async getTimeoutRemainingMs(targetLoginId) {
    try {
      const snap = await this._timeoutsRef.child(this._safeKey(String(targetLoginId))).get();
      const val = snap.val();
      if (!val || !val.expiresAt) return 0;
      if (await this.hasItem(targetLoginId, "protection")) return 0;
      const serverNow = await this._serverNow();
      return Math.max(0, val.expiresAt - serverNow);
    } catch (e) {
      return 0;
    }
  },

  // Live subscription: onChange(remainingMs) fires whenever targetName's
  // timeout record changes. Used to keep the composer lock in sync without
  // polling, for whoever is currently timed out.
  watchTimeout(targetLoginId, onChange) {
    const ref = this._timeoutsRef.child(this._safeKey(String(targetLoginId)));
    ref.on("value", async snap => {
      const val = snap.val();
      if (!val || !val.expiresAt) { onChange(0, null); return; }
      if (await this.hasItem(targetLoginId, "protection")) { onChange(0, null); return; }
      const serverNow = await this._serverNow();
      onChange(Math.max(0, val.expiresAt - serverNow), val);
    });
    return () => ref.off("value");
  },

  // ── Mod re-timeout cooldown ──
  // A mod who just set OR cleared a timeout on a given target must wait
  // MOD_RETIMEOUT_COOLDOWN_MS before they can time that same target out
  // again. Stored server-side (per room, per mod, per target) so it can't
  // be dodged by clearing localStorage the way the code-request cooldowns
  // are — this one's meant to actually hold. Anchored to server time like
  // everything else here.
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
    const now = await ChatBackend._serverNow();
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
    await ref.transaction(current => (current || ChatBackend.serverNowSync()) + ROOM_EXTEND_MS);
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

  async kickFromRoom(code, targetLoginId) {
    if (!targetLoginId) throw new Error("Missing login ID");
    await this.issue("actions", { k: "kick", t: targetLoginId, v: this._safeCode(code) });
    await this._metaRootRef.child(this._safeCode(code)).child("kicked").child(this._safeKeyName(String(targetLoginId))).set(true);
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

const $joinScreen  = document.getElementById("joinScreen");
const $banScreen = document.getElementById("banScreen");
const $banTitle = document.getElementById("banTitle");
const $banReason = document.getElementById("banReason");
const $banCountdownWrap = document.getElementById("banCountdownWrap");
const $banCountdown = document.getElementById("banCountdown");
const $banPermanentNote = document.getElementById("banPermanentNote");
const $banRefreshBtn = document.getElementById("banRefreshBtn");
const $joinCard    = document.getElementById("joinCard");
const $chatScreen  = document.getElementById("chatScreen");
const $messages    = document.getElementById("messages");
const $emptyState  = document.getElementById("emptyState");
const $msgInput    = document.getElementById("msgInput");
const $sendBtn     = document.getElementById("sendBtn");
const $onlineDot   = document.getElementById("onlineDot");
const $onlineCount = document.getElementById("onlineCount");
const $connError   = document.getElementById("connError");
const $composerNotice = document.getElementById("composerNotice");
const $youAre      = document.getElementById("youAre");
const $youAreAvatar = document.getElementById("youAreAvatar");
const $changeNameBtn = document.getElementById("changeNameBtn");
const $typingBar     = document.getElementById("typingBar");
const $autoScrollBtn = document.getElementById("autoScrollBtn");
const $clearChatBtn  = document.getElementById("clearChatBtn");
const $uploadImageBtn = document.getElementById("chatUploadImageBtn");
const $imageFileInput = document.getElementById("chatImageFileInput");
const $jumpToBottomBtn = document.getElementById("jumpToBottomBtn");
const $charCounter    = document.getElementById("charCounter");
const $globalClearPanel = document.getElementById("globalClearPanel");
const $settingsBtn = document.getElementById("settingsBtn");
const $commandList = document.getElementById("commandList");
const $commandGhost = document.getElementById("commandGhost");
const $onlineListPanel = document.getElementById("onlineListPanel");
const $pendingImageBar = document.getElementById("chatPendingImageBar");
const $pendingImagePreview = document.getElementById("chatPendingImagePreview");
const $cancelPendingImageBtn = document.getElementById("chatCancelPendingImageBtn");
const $pingYouBtn = document.getElementById("pingYouBtn");
const $pingYouPanel = document.getElementById("pingYouPanel");
const $pingYouNote = document.getElementById("pingYouNote");
const $pingYouSend = document.getElementById("pingYouSend");
const $mentionChip = document.getElementById("mentionChip");
const $mentionDropdown = document.getElementById("mentionDropdown");
const $composerInputWrap = document.getElementById("composerInputWrap");
const $pingToast = document.getElementById("pingToast");
const $pingToastTitle = document.getElementById("pingToastTitle");
const $pingToastBody = document.getElementById("pingToastBody");
const $pingSound = document.getElementById("pingSound");

let myName = "";
let myLoginId = "";
let messageCount = 0;
const CHAT_PREFS_KEY = "vus_chat_prefs_v1";
const chatPrefs = { autoScroll: true, showJoinLeave: true, peerVerify: true, wordFilter: true, textSize: "l", bubbleSize: "normal", bold: false,
  radius: 12, bgMode: "default", bgColor: "#0f172a", bgLink: "", bgFile: "",
  notifMentions: true, notifReplies: true, notifReactions: true, notifStaff: true };
try { Object.assign(chatPrefs, JSON.parse(localStorage.getItem(CHAT_PREFS_KEY) || "{}")); } catch (e) {}
function saveChatPrefs() { try { localStorage.setItem(CHAT_PREFS_KEY, JSON.stringify(chatPrefs)); } catch (e) {} }
let autoScroll = chatPrefs.autoScroll !== false;
let stickToBottom = true;      // true while the view is pinned to the newest message
document.body.classList.toggle("hide-joinleave", chatPrefs.showJoinLeave === false);
// Looks: text size, bubble size and bold text. Client-side only, remembered on this device.
function applyAppearance() {
  const b = document.body;
  ["s", "m", "l", "xl"].forEach(k => b.classList.toggle("fs-" + k, chatPrefs.textSize === k));
  ["compact", "normal", "roomy"].forEach(k => b.classList.toggle("bs-" + k, chatPrefs.bubbleSize === k));
  b.classList.toggle("bold-text", !!chatPrefs.bold);
  b.classList.toggle("hide-verified", chatPrefs.showVerified === false);
  b.classList.add("has-radius");
  const r = Number(chatPrefs.radius);
  b.style.setProperty("--bubble-radius", (r >= 0 && r <= 40 ? r : 12) + "px");
  applyBackground();
}
// Backgrounds for the chat and DM message areas: default / dark / light / a colour / an image link / an image file.
function safeBgUrl(u) {
  u = String(u || "").trim();
  return /^https?:\/\/[^\s"'()<>\\]{1,1500}$/i.test(u) ? u : "";
}
function isLightColor(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
}
function applyBackground() {
  const b = document.body, mode = chatPrefs.bgMode || "default";
  b.classList.remove("bg-on", "bg-light");
  b.style.removeProperty("--chat-bg-color");
  b.style.removeProperty("--chat-bg-img");
  if (mode === "default") return;
  let color = "", img = "", light = false;
  if (mode === "dark") color = "#060a12";
  else if (mode === "light") { color = "#eef2f8"; light = true; }
  else if (mode === "color") { color = /^#[0-9a-fA-F]{6}$/.test(chatPrefs.bgColor) ? chatPrefs.bgColor : "#0f172a"; light = isLightColor(color); }
  else if (mode === "link" || mode === "file") {
    const src = mode === "link" ? safeBgUrl(chatPrefs.bgLink) : (/^data:image\/[a-z+.-]+;base64,[A-Za-z0-9+\/=]+$/.test(String(chatPrefs.bgFile || "")) ? chatPrefs.bgFile : "");
    if (!src) return;
    img = 'linear-gradient(rgba(8,12,22,.42), rgba(8,12,22,.42)), url("' + src + '")';
    color = "#0b1220";
  } else return;
  b.style.setProperty("--chat-bg-color", color);
  if (img) b.style.setProperty("--chat-bg-img", img);
  b.classList.add("bg-on");
  b.classList.toggle("bg-light", light);
}
// Everything the Settings window can change, as one string: used to tell if anything is unsaved, and to undo it.
function getPrefsState() { return JSON.stringify(Object.keys(chatPrefs).sort().map(k => [k, chatPrefs[k]])); }
function restorePrefsState(str) {
  let arr = null;
  try { arr = JSON.parse(str); } catch (e) { return; }
  if (!Array.isArray(arr)) return;
  const saved = {};
  arr.forEach(p => { if (Array.isArray(p) && typeof p[0] === "string") saved[p[0]] = p[1]; });
  Object.keys(chatPrefs).forEach(k => { if (!(k in saved)) delete chatPrefs[k]; });
  Object.assign(chatPrefs, saved);
  saveChatPrefs();
  applyAppearance();
  document.body.classList.toggle("hide-joinleave", chatPrefs.showJoinLeave === false);
  autoScroll = chatPrefs.autoScroll !== false;
  if (typeof setAutoScrollUI === "function") setAutoScrollUI();
  if (typeof scheduleVerifyRefresh === "function") scheduleVerifyRefresh();
}
applyAppearance();
let myTimeoutRemainingMs = 0; // live, kept in sync by watchMyTimeout()
let myTimeoutReason = "";
const mutedNotice = () => "You're muted for " + formatCountdown(myTimeoutRemainingMs) + " more." + (myTimeoutReason ? " Reason: " + myTimeoutReason : "");
let unwatchMyTimeout = null;
let myTimeoutCountdownTimer = null;
let unwatchMyBan = null;
let roleHolders = {};

const NAME_STORAGE_KEY = "vusChatName";
const HUB_DISPLAY_NAME_KEY = "vus_hub_display_name";
const DM_SESSION_STORAGE_KEY = "dmAppSession";
/* Persistent (localStorage) copy of the logged-in account + last chat name.
   This is what makes auto-login work across tab closes/reopens. Logging out
   NEVER clears the account here -- it only clears the chat name, so the
   account (and everything tied to its ID) stays bound to this browser. */
const CHAT_ACCOUNT_KEY = "vusChatAccount";
const CHAT_LAST_NAME_KEY = "vusChatLastName";

/* Send delay is per-role now (ROLE_MESSAGE_COOLDOWNS_MS / ROLE_IMAGE_COOLDOWNS_MS).
   lastSentAt / lastImageSentAt are tracked separately so a text message and an
   image each respect their own delay. */
let lastSentAt = 0;
let lastImageSentAt = 0;
function currentMessageCooldownMs() {
  const base = ROLE_MESSAGE_COOLDOWNS_MS[myRoleId()] ?? ROLE_MESSAGE_COOLDOWNS_MS.unranked;
  return activeChannelId === "announce" ? Math.max(base, 15000) : base;
}
function currentImageCooldownMs()   { return ROLE_IMAGE_COOLDOWNS_MS[myRoleId()]   ?? ROLE_IMAGE_COOLDOWNS_MS.unranked; }
let cooldownTimer = null;

let isCurrentlyTyping = false;
let typingStopTimer = null;

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderOwnAvatar(username, avatarDataUrl) {
  if (!$youAreAvatar) return;
  $youAreAvatar.innerHTML = "";
  if (avatarDataUrl) {
    const img = document.createElement("img");
    img.src = avatarDataUrl;
    img.alt = "";
    $youAreAvatar.appendChild(img);
  } else {
    $youAreAvatar.textContent = (username || "?").trim().slice(0, 1).toUpperCase();
  }
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isNearBottom() {
  return $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 120;
}

let programmaticScrollUntil = 0;
function snapToBottom() {
  programmaticScrollUntil = Date.now() + 150;
  $messages.scrollTop = $messages.scrollHeight;
}
function scrollToBottom() {
  stickToBottom = true;
  snapToBottom();
  // layout can still grow a frame or two later (images, the typing bar, fonts): snap again
  requestAnimationFrame(() => { snapToBottom(); requestAnimationFrame(snapToBottom); });
  $jumpToBottomBtn.style.display = "none";
}
// Strict auto scroll: while it is on and the view is pinned, ANY growth of the chat
// (new rows, images loading, the composer resizing) keeps the newest message in view.
function keepPinned() { if (autoScroll && stickToBottom) snapToBottom(); }
new MutationObserver(keepPinned).observe($messages, { childList: true, subtree: true });
if (window.ResizeObserver) new ResizeObserver(keepPinned).observe($messages);
$messages.addEventListener("load", keepPinned, true);

// Fills (or refreshes) one badge row from the sender's current rank.
// The badge is looked up from who is actually ONLINE under that name right
// now. The loginId stamped on a message is only a claim -- anyone can write any
// ID there -- so it is never trusted on its own. A sender who isn't online (or
// whose claimed ID doesn't match the person online under that name) gets no badge.
function fillRoleBadge(row) {
  row.innerHTML = "";
  const liveId = loginIdForName(row.dataset.senderName);
  const claimedId = row.dataset.senderId;
  if (!liveId || (claimedId && claimedId !== String(liveId))) return;
  // If two different names are both online claiming this one account, one of them is not who it
  // says it is and we can't tell which. Better no badge on either than a crown on an impostor.
  if (latestPresenceList.filter(e => String(e.loginId || "") === String(liveId)).length > 1) return;
  const role = ROLES[effectiveRoleForLoginId(liveId)];
  const bubble = document.createElement("div");
  bubble.className = role.bubbleClass;
  bubble.textContent = role.icon;
  bubble.title = role.label;
  row.appendChild(bubble);
}

let badgeRefreshTimer = null;
function scheduleRoleBadgeRefresh() {
  clearTimeout(badgeRefreshTimer);
  badgeRefreshTimer = setTimeout(() => {
    document.querySelectorAll(".role-bubble-row[data-sender-name]").forEach(fillRoleBadge);
  }, 60);
}

/* Profile picture (from the account's profile in vus-dm), with the first letter as a placeholder. */
function paintAvatar(container, loginId, name) {
  container.textContent = (name || "?").trim().slice(0, 1).toUpperCase();
  if (!loginId || !window.VUS_DM || !window.VUS_DM.getAvatarByLoginId) return;
  window.VUS_DM.getAvatarByLoginId(loginId).then(url => {
    if (!url) return;
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    container.textContent = "";
    container.appendChild(img);
  }).catch(() => {});
}
function openProfileFor(loginId, name) { if (window.VUS_DM) window.VUS_DM.openChatUserProfile(loginId, name); }

// Text with @mentions drawn as chips. Messages from older tabs (no markers) fall back to the single `mention` field.
/* ══════════ Word filter ══════════
   The list is read from the database (chatFilter/words/<key> = "word"), so no banned word ever sits in the
   GitHub files. A plain entry matches a whole word however it's dressed up (caps, l33t, accents, spacing tricks
   inside the word's own letters like n!gg3r, repeated letters). An entry starting with * also matches inside
   other words and with separators between its letters (n.i.g.g.e.r) -- use that only for words that can never
   appear in a normal one. */
const FILTER_LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };
const FILTER_LEET_SYM = { "@": "a", "$": "s", "!": "i", "|": "i", "+": "t", "(": "c" };
const FILTER_HOMO = { "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x", "\u0443": "y", "\u0456": "i", "\u0455": "s" };
let filterWords = [], filterDeep = [], filterPhrases = [];
function normalizeForFilter(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f\u200b-\u200f\u2060\u00ad\ufeff]/g, "").toLowerCase().split("").map(ch => FILTER_HOMO[ch] || FILTER_LEET[ch] || ch).join("").replace(/[^a-z]/g, "");
}
// A word becomes a pattern where a letter that appears once may be stretched (sluuur) and a doubled letter
// (nigger) must stay doubled or longer. That keeps "Niger" the country from matching a longer word.
function filterPattern(word, anchored) {
  const w = normalizeForFilter(word);
  if (w.length < 2) return null;
  let src = "";
  for (let i = 0; i < w.length;) {
    let j = i; while (j < w.length && w[j] === w[i]) j++;
    src += w[i] + (j - i >= 2 ? "{2,}" : "+");
    i = j;
  }
  return new RegExp(anchored ? "^" + src + "$" : src, anchored ? "" : "g");
}
// chatFilter holds one child per word: chatFilter/<word> = 1 (on) or 0 (off). A leading * means "also inside other words".
// (Older layout still works: any child whose value is a text string is taken as the word itself.)
function filterListFromDb(val) {
  const out = [];
  const walk = obj => Object.entries(obj || {}).forEach(([k, v]) => {
    if (v && typeof v === "object") { walk(v); return; }
    if (v === 0 || v === false || v === "0" || v == null) return;                 // switched off
    out.push(typeof v === "string" && v !== "1" ? v : k);
  });
  walk(val);
  return out;
}
function setFilterWords(list) {
  const plain = [], deep = [], phrases = [];
  (list || []).forEach(w => {
    w = String(w || "").trim();
    if (!w) return;
    const isDeep = w[0] === "*";
    const isPhrase = !isDeep && /\s/.test(w);          // "word word": two or more words in a row
    const re = filterPattern(isDeep ? w.slice(1) : w, !isDeep && !isPhrase);
    if (re) (isDeep ? deep : isPhrase ? phrases : plain).push(re);
  });
  filterWords = plain; filterDeep = deep; filterPhrases = phrases;
  refreshFilteredText();
}
// Re-mask what's already on screen (after the list or the setting changes).
function refreshFilteredText() {
  try {
    msgEls.forEach(m => {
      if (m.isImage || !m.bubble) return;
      const edited = m.bubble.querySelector(".msg-edited");
      m.bubble.textContent = "";
      fillBubbleText(m.bubble, m.text, m.mention);
      if (edited) m.bubble.appendChild(edited);
    });
  } catch (e) {}
}
// Returns [[start, end), ...] ranges of the original text that hit the list.
function filterHits(text) {
  text = String(text || "");
  if (!text || (!filterWords.length && !filterDeep.length && !filterPhrases.length)) return [];
  const hits = [];
  for (const symbolsAreLetters of [true, false]) {
    // Build the kept letters with a map back to the original text; anything else is a word break.
    const items = [];
    for (let i = 0; i < text.length; i++) {
      let ch = text[i];
      if (/[\u200b-\u200f\u2060\u00ad\ufeff\u0300-\u036f]/.test(ch)) continue;
      ch = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const m = FILTER_HOMO[ch] || FILTER_LEET[ch] || (symbolsAreLetters ? FILTER_LEET_SYM[ch] : "") || ch;
      items.push({ ch: /^[a-z]$/.test(m) ? m : null, i });
    }
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const s = run.map(x => x.ch).join("");
      if (filterWords.some(re => re.test(s))) hits.push([run[0].i, run[run.length - 1].i + 1]);
      run = [];
    };
    items.forEach(it => { if (it.ch) run.push(it); else flush(); });
    flush();
    if (filterPhrases.length) {
      // A phrase matches across spaces or any separators, but must start and end on word edges.
      const sq = [];
      items.forEach((x, n) => { if (x.ch) sq.push({ ch: x.ch, i: x.i, start: n === 0 || !items[n - 1].ch, end: n === items.length - 1 || !items[n + 1].ch }); });
      const str = sq.map(x => x.ch).join("");
      filterPhrases.forEach(re => {
        re.lastIndex = 0; let m;
        while ((m = re.exec(str)) && m[0].length) {
          const a = sq[m.index], z = sq[m.index + m[0].length - 1];
          if (a.start && z.end) hits.push([a.i, z.i + 1]);
        }
      });
    }
    if (filterDeep.length) {
      const sq = items.filter(x => x.ch);
      const str = sq.map(x => x.ch).join("");
      filterDeep.forEach(re => {
        re.lastIndex = 0; let m;
        while ((m = re.exec(str)) && m[0].length) hits.push([sq[m.index].i, sq[m.index + m[0].length - 1].i + 1]);
      });
    }
  }
  return hits;
}
// Messages are never blocked. A filtered word is shown as w**d (first and last letter kept); very short ones are fully starred.
// The "Chat filter" setting (on by default, this device only) turns the hiding off for what you see.
function maskFiltered(text) {
  text = String(text || "");
  if (chatPrefs.wordFilter === false) return text;
  const hits = filterHits(text);
  if (!hits.length) return text;
  const chars = text.split("");
  hits.forEach(([a, b]) => {
    const idx = []; for (let k = a; k < b && k < chars.length; k++) if (!/\s/.test(chars[k])) idx.push(k);
    const keep = idx.length >= 4;
    idx.forEach((k, n) => { if (!keep || (n > 0 && n < idx.length - 1)) chars[k] = "*"; });
  });
  return chars.join("");
}

// Clicking an @mention opens that person's profile.
function mentionChip(name, extraClass) {
  const chip = document.createElement("span");
  chip.className = "mention-chip-inline mention-click" + (extraClass ? " " + extraClass : "");
  chip.textContent = "@" + name;
  chip.title = "View " + name + "'s profile";
  chip.addEventListener("click", async e => {
    e.stopPropagation();
    let t = null;
    try { t = await resolveModerationTarget(name, { allowOfflineId: true }); } catch (x) {}
    const id = (t && t.loginId) || (() => { const n2i = nameToLoginId(); return n2i[name] || null; })();
    if (id) openProfileFor(String(id), (t && t.name) || name); else showComposerNotice("Couldn't find " + name + "'s account.");
  });
  return chip;
}
function fillBubbleText(bubble, text, legacy) {
  fillBubbleTextRaw(bubble, text, legacy);
  if (bubble.dataset && bubble.dataset.fx) wrapFx(bubble);
}
function fillBubbleTextRaw(bubble, text, legacy) {
  text = maskFiltered(String(text || ""));
  const toks = parseMentionTokens(text);
  if (!toks.length) {
    if (legacy) {
      bubble.appendChild(mentionChip(mentionTargetOf(legacy)));
      if (text) bubble.appendChild(document.createTextNode(" " + text));
    } else bubble.appendChild(document.createTextNode(text));
    return;
  }
  let pos = 0;
  toks.forEach(t => {
    if (t.start > pos) bubble.appendChild(document.createTextNode(text.slice(pos, t.start)));
    bubble.appendChild(mentionChip(t.name, t.name === myName ? "mention-me" : ""));
    pos = t.end;
  });
  if (pos < text.length) bubble.appendChild(document.createTextNode(text.slice(pos)));
}
function mentionInfoFor(msg) {
  if (!myName || ((msg.imageData || msg.video) && !msg.text)) return { me: false, ping: false };
  const toks = parseMentionTokens(msg.text);
  let me = false, ping = false;
  toks.forEach(t => { if (t.name === myName) { me = true; if (t.ping) ping = true; } });
  if (!toks.length && msg.mention && mentionTargetOf(msg.mention) === myName) { me = true; ping = !isSilentMention(msg.mention); }
  return { me, ping };
}
const lastPingFrom = {};
// People this device has seen in chat (verified senders), so @mentions can find people who are offline.
const knownPeople = new Map();           // loginId -> name
const PEOPLE_KEY = "vus_chat_people_v1";
try { JSON.parse(localStorage.getItem(PEOPLE_KEY) || "[]").forEach(p => { if (Array.isArray(p) && /^\d{4,12}$/.test(String(p[0])) && typeof p[1] === "string") knownPeople.set(String(p[0]), p[1].slice(0, 40)); }); } catch (e) {}
let peopleSaveTimer = null;
function rememberPerson(id, name) {
  id = String(id || ""); name = String(name || "").trim();
  if (!/^\d{4,12}$/.test(id) || !name || name.length > 40 || /[\s@\u2063\u2064\u200b]/.test(name)) return;
  if (knownPeople.get(id) === name) return;
  knownPeople.delete(id); knownPeople.set(id, name);
  clearTimeout(peopleSaveTimer);
  peopleSaveTimer = setTimeout(() => { try { localStorage.setItem(PEOPLE_KEY, JSON.stringify([...knownPeople].slice(-400))); } catch (e) {} }, 1500);
}
// A mention is stored as the person's name. A "mention only" (no sound) mention carries an invisible
// zero-width marker after the name -- no database change needed, and older tabs simply ignore it.
const SILENT_MENTION_MARK = "\u200b";
function isSilentMention(v) { return String(v || "").endsWith(SILENT_MENTION_MARK); }
function mentionTargetOf(v) { return String(v || "").replace(/\u200b+$/, ""); }


/* ══════════════════════════════════════════════════════════
   CLIENT-SIDE ANTI-SPAM (only changes what THIS browser shows)
   1. Mute: hide everything from a person on this browser. Saved per browser.
   2. Duplicate filter: the same (or nearly the same) text from one person within
      2 seconds is hidden. The sender still sees their own messages.
   3. New-account burst: an account under a minute old that sends more than 2 messages
      in 2 seconds is muted for everyone already in the room. Not saved: someone who
      joins afterwards still sees those messages and can mute the account themselves.
   ══════════════════════════════════════════════════════════ */
const MUTE_KEY = "vus_chat_muted_v1";
const SPAM_WINDOW_MS = 2000;           // "same text within this long" and "burst window"
const BURST_MAX_MESSAGES = 2;          // more than this inside the window = burst
const NEW_ACCOUNT_MS = 60 * 1000;      // accounts younger than this count as "new"
const SIMILAR_AT = 0.75;               // 0..1, how alike two texts must be to count as the same
let mutedMap = {};                     // loginId -> { name }   (saved)
let autoMuted = {};                    // loginId -> { name }   (this session only)
try { mutedMap = JSON.parse(localStorage.getItem(MUTE_KEY) || "{}") || {}; } catch (e) { mutedMap = {}; }
function saveMutes() { try { localStorage.setItem(MUTE_KEY, JSON.stringify(mutedMap)); } catch (e) {} }
function isMuted(loginId) { const id = String(loginId || ""); return !!(id && (mutedMap[id] || autoMuted[id])); }
function applyMutesToDom() {
  document.querySelectorAll(".msg[data-sender-id]").forEach(el => {
    el.classList.toggle("muted-hidden", !el.classList.contains("mine") && isMuted(el.dataset.senderId));
  });
  if (autoScroll && stickToBottom) scrollToBottom();
}
function toggleMute(loginId, name) {
  const id = String(loginId || "");
  if (!id || id === String(myLoginId)) return false;
  if (isMuted(id)) { delete mutedMap[id]; delete autoMuted[id]; }
  else mutedMap[id] = { name: name || (mutedMap[id] && mutedMap[id].name) || "Someone" };
  saveMutes();
  applyMutesToDom();
  Object.keys(reactionsByMsg).forEach(renderReactions);
  renderMembersPane();
  return isMuted(id);
}
let liveSince = 0;                     // messages stamped after this arrived while we were here
/* Read-side rules: this version refuses to SHOW what the sender's role would not have let them send.
   The send box already enforces this for honest clients; this makes a modified client's messages invisible
   to everyone running this version. */
/* ══════════════════════════════════════════════════════════
   PEER VERIFICATION  (on by default for this device; the Owner switches it on for the room with /verify on)

   The database can't tell who wrote something, so a modified browser can write "Owner banned X" or give
   itself Mod. This makes every up-to-date client a checker instead:
     • staff actions (mute, ban, kick, image access, Mod/Normie grants) are written as an ACTION record first
     • other people's clients who see it live check: was the issuer online right then, does their rank allow it,
       is the length within their limit, is the target below them -> they vote yes/no on the record
     • the person named as the issuer vetoes any record in their name that their own client didn't make
     • an effect (a ban, a mute, a granted image/Mod) only counts in THIS client if its action record is approved
   Bans made before this shipped (their time stamp is set by the server, so it can't be faked) still count.
   ══════════════════════════════════════════════════════════ */
const VERIFY_EPOCH = 1792208707276;
const VETO_WAIT_MS = 3000;               // short window so the named issuer's own window can disown a forged record
const LIVE_JUDGE_MS = 30000;             // only actions this fresh get a live "was the issuer online" check
let verifyFlagOn = false;                // rooms/<main>/verify/on, switched on by the Owner
const recs = { actions: {}, grants: {} };
const liveVerdict = {};                  // my own live judgement per record id
const ISSUED_KEY = "vus_chat_issued_v1";
let issuedByMe = new Set();
try { issuedByMe = new Set(JSON.parse(localStorage.getItem(ISSUED_KEY) || "[]")); } catch (e) {}
function rememberIssued(id) {
  issuedByMe.add(id);
  try { localStorage.setItem(ISSUED_KEY, JSON.stringify([...issuedByMe].slice(-200))); } catch (e) {}
}
let attestCache = null, computingAttest = false, verifyRefreshQueued = false, verifyPollTimer = null;
function verifyActive() { return verifyFlagOn && chatPrefs.peerVerify !== false; }
function srvNow() { return ChatBackend.serverNowSync(); }
function presenceIds() { return [...new Set(latestPresenceList.map(e => String(e.loginId || "")).filter(Boolean))]; }
function kickByRoomOwner(by) { return !!(currentRoomMeta && currentRoomMeta.ownerName && loginIdForName(currentRoomMeta.ownerName) === by); }

// Would an honest client accept this record, judged only on ranks, limits and presence?
function recLooksValid(r, requireOnline) {
  const by = String(r.b || ""), t = String(r.t || "");
  if (r.k === "announce" || r.k === "poll") {      // no target: just an admin+ speaking in their own name
    if (!/^\d{6}$/.test(by) || rankOfLoginId(by) < ROLES.admin.rank) return false;
    return true;      // not tied to being listed online: announcements are posted from their own room
  }
  if (!/^\d{6}$/.test(by) || !/^\d{6}$/.test(t) || by === t) return false;
  if (requireOnline && !presenceIds().includes(by)) return false;
  const byRank = rankOfLoginId(by), tRank = rankOfLoginId(t), d = Number(r.d) || 0;
  switch (r.k) {
    case "mute": return byRank >= ROLES.mod.rank && tRank < byRank && !isProtected(t) && d > 0 && d <= timeoutLimitsForRank(byRank).max + 1000;
    case "ban":
      if (byRank < ROLES.mod.rank || tRank >= byRank || tRank >= ROLES.coowner.rank || isProtected(t)) return false;
      return d === 0 ? byRank >= ROLES.crown.rank : d <= banLimitsForRank(byRank).max + 1000;
    case "kick": return (byRank >= ROLES.admin.rank && tRank < byRank) || kickByRoomOwner(by);
    case "image": return byRank >= ROLES.admin.rank && tRank < byRank;
    case "role": case "unrole": {
      const rr = ROLES[r.v];
      return !!rr && (r.v === "mod" || r.v === "normie") && canGrantRole(byRank, r.v) && tRank < byRank;
    }
  }
  return false;
}

// "ok" | "pending" | "no".  No voting: a record counts when (1) the person named as the issuer really holds a rank that
// allows it (admin/co-owner/owner ranks can only be set from the database console, so they can't be faked),
// (2) it is within that rank's limits, (3) when we saw it happen the issuer was online, and (4) the issuer's own
// chat window didn't disown it (a forged record in someone's name is vetoed by that person's client).
function recWhy(node, id) {
  const r = (recs[node] || {})[id];
  if (!r) return "missing";
  if (r.veto === true) return "disowned by the person it names";
  if (liveVerdict[id] === false) return "issuer wasn't online / allowed when it happened";
  if (!recLooksValid(r, false)) return "rank or limit doesn't allow it";
  return "";
}
function recStatus(node, id) {
  const r = (recs[node] || {})[id];
  if (!r) return "no";
  if (srvNow() - (Number(r.ts) || 0) < VETO_WAIT_MS && r.veto !== true) return "pending";
  return recWhy(node, id) ? "no" : "ok";
}
function matchStatus(node, pred) {
  let best = "no";
  Object.keys(recs[node]).forEach(id => {
    if (!pred(recs[node][id])) return;
    const s = recStatus(node, id);
    if (s === "ok") best = "ok"; else if (s === "pending" && best !== "ok") best = "pending";
  });
  return best;
}
function muteLocalValid(targetId, rec) {
  if (!rec || !rec.by) return false;
  if (!rolesReady) return true;
  const byRank = rankOfLoginId(rec.by);
  if (byRank < ROLES.mod.rank || rankOfLoginId(targetId) >= byRank || isProtected(targetId)) return false;
  return Number(rec.expiresAt) - srvNow() <= timeoutLimitsForRank(byRank).max + 10000;
}
function muteStatus(targetId, rec) {
  if (!verifyActive()) return "ok";
  return matchStatus("actions", r => r.k === "mute" && String(r.t) === String(targetId) && String(r.b) === String(rec.by) && Math.abs((Number(r.ts) || 0) + (Number(r.d) || 0) - Number(rec.expiresAt)) <= 20000);
}
function banLocalValid(targetId, ban) {
  if (!ban || !ban.byLoginId) return false;
  if (!rolesReady) return true;
  const byRank = rankOfLoginId(ban.byLoginId), tRank = rankOfLoginId(targetId);
  if (byRank < ROLES.mod.rank || byRank <= tRank || tRank >= ROLES.coowner.rank || isProtected(targetId)) return false;
  if (byRank < ROLES.admin.rank) {
    const len = Number(ban.expiresAt) - Number(ban.bannedAt);
    return Number.isFinite(len) && len > 0 && len <= TIME_LIMITS.modTempban.max + 20000;
  }
  return true;
}
function banStatus(targetId, ban) {
  if (!verifyActive() || Number(ban.bannedAt) < VERIFY_EPOCH) return "ok";
  return matchStatus("actions", r => r.k === "ban" && String(r.t) === String(targetId) && String(r.b) === String(ban.byLoginId) && Math.abs((Number(r.ts) || 0) - Number(ban.bannedAt)) <= 30000);
}
function kickStatus(meta, targetId) {
  if (!verifyActive()) return "ok";
  return matchStatus("actions", r => r.k === "kick" && String(r.t) === String(targetId) && String(r.v) === String(meta.code || currentRoomCode || ""));
}
// Mod / Normie grants and image access count only with an approved grant record (once verification is on).
function computeAttested() {
  const roles = {}, images = {};
  computingAttest = true;
  try {
    Object.entries(recs.grants).sort((a, b) => (Number(a[1].ts) || 0) - (Number(b[1].ts) || 0)).forEach(([id, r]) => {
      if (recStatus("grants", id) !== "ok") return;
      const t = String(r.t);
      if (r.k === "role") (roles[t] = roles[t] || {})[r.v] = { on: true, exp: Number(r.d) > 0 ? (Number(r.ts) || 0) + Number(r.d) : 0 };
      else if (r.k === "unrole") (roles[t] = roles[t] || {})[r.v] = { on: false, exp: 0 };
      else if (r.k === "image") images[t] = { on: r.v === "on" };
    });
  } finally { computingAttest = false; }
  return { roles, images };
}
function attested() { return attestCache || (attestCache = computeAttested()); }
function roleAttested(roleId, id) {
  if (!verifyActive() || computingAttest || (roleId !== "mod" && roleId !== "normie")) return true;
  const e = (attested().roles[String(id)] || {})[roleId];
  return !!(e && e.on && (!e.exp || e.exp > srvNow()));
}
function imageAttested(id) {
  if (!verifyActive()) return true;
  const e = attested().images[String(id)];
  return !!(e && e.on);
}

const timeoutsAll = {}, bansAll = {};
function isSilenced(id) {
  id = String(id);
  const t = timeoutsAll[id];
  if (t && Number(t.expiresAt) > srvNow() && muteLocalValid(id, t) && muteStatus(id, t) === "ok") return true;
  const b = bansAll[id];
  if (b && (!b.expiresAt || Number(b.expiresAt) > srvNow()) && banLocalValid(id, b) && banStatus(id, b) === "ok") return true;
  return false;
}
function refreshSilencedMessages() {
  // newer messages from someone who is muted/banned stay hidden for people running this version
  document.querySelectorAll(".msg[data-sender-id]").forEach(el => {
    if (el.classList.contains("mine")) return;
    const ts = Number(el.dataset.ts) || 0;
    el.classList.toggle("silenced-hidden", ts >= liveSince && isSilenced(el.dataset.senderId));
  });
}

function onRec(node, id, val) {
  if (!val) { delete recs[node][id]; delete liveVerdict[id]; }
  else {
    recs[node][id] = val;
    // the person named as the issuer vetoes records in their name that their own client did not write
    if (verifyActive() && myLoginId && String(val.b) === String(myLoginId) && !issuedByMe.has(id) && !val.veto) ChatBackend.castVeto(node, id).catch(() => {});
  }
  scheduleVerifyRefresh();
}
function judgeLive(node, id, r) {
  if (!verifyActive() || !rolesReady || id in liveVerdict) return;
  const age = srvNow() - (Number(r.ts) || 0);
  if (age > LIVE_JUDGE_MS || age < -5000) return;           // not seen live: only the plain checks apply
  liveVerdict[id] = recLooksValid(r, true);
}
function anyPendingRec() {
  return ["actions", "grants"].some(node => Object.keys(recs[node]).some(id => srvNow() - (Number(recs[node][id].ts) || 0) < 60000 && recStatus(node, id) === "pending"));
}
function scheduleVerifyRefresh() {
  if (verifyRefreshQueued) return;
  verifyRefreshQueued = true;
  setTimeout(() => {
    verifyRefreshQueued = false;
    attestCache = null;
    ["actions", "grants"].forEach(node => Object.keys(recs[node]).forEach(id => judgeLive(node, id, recs[node][id])));
    applyMyMute();
    rebuildRoleHolders();
    renderMembersPane();
    onMyRoleMaybeChanged();
    refreshSilencedMessages();
    renderVerifyPanel();
    if (currentRoomMeta && currentRoomMeta.kicked && myLoginId && currentRoomMeta.kicked[ChatBackend._safeKey(String(myLoginId))]) onRoomMetaUpdate(currentRoomMeta);
    if (ChatBackend._banRecheck) ChatBackend._banRecheck();
    clearTimeout(verifyPollTimer);
    if (verifyActive() && anyPendingRec()) verifyPollTimer = setTimeout(scheduleVerifyRefresh, 1000);
  }, 120);
}
function describeUnverifiedHolders() {
  const out = [];
  ["mod", "normie"].forEach(roleId => {
    (roleIdHolders[roleId] || new Set()).forEach(id => { if (!roleAttested(roleId, id)) out.push((roomNameForId(id)) + " (" + ROLES[roleId].label + ")"); });
  });
  return out;
}
function roomNameForId(id) {
  const e = latestPresenceList.find(x => String(x.loginId) === String(id));
  return e ? e.name : "#" + id;
}
function reportUnverifiedHolders() {
  if (myRank() < ROLES.crown.rank || !verifyActive()) return;
  const n = describeUnverifiedHolders().length;
  if (n) showComposerNotice("Verification is on. " + n + " Mod/Normie rank" + (n === 1 ? " has" : "s have") + " no approval yet and " + (n === 1 ? "is" : "are") + " ignored. Type /verify to review and approve them.");
}
function nameOfId(id) {
  id = String(id);
  const e = latestPresenceList.find(x => String(x.loginId) === id);
  if (e) return e.name;
  if (knownPeople.has(id)) return knownPeople.get(id);
  const n2i = nameToLoginId(), k = Object.keys(n2i).find(k => String(n2i[k]) === id);
  return k || "#" + id;
}
// ── Verification panel ──
function ensureVerifyPanel() {
  let o = document.getElementById("verifyOverlay");
  if (o) return o;
  o = document.createElement("div");
  o.className = "chat-modal-overlay"; o.id = "verifyOverlay";
  o.innerHTML = '<div class="chat-modal vp-modal"><h3>Verification</h3><div id="verifyBody"></div><div class="chat-modal-row"><button class="chat-modal-btn-secondary" id="verifyCloseBtn">Close</button></div></div>';
  document.body.appendChild(o);
  o.addEventListener("click", e => { if (e.target === o) closeVerifyPanel(); });
  o.querySelector("#verifyCloseBtn").addEventListener("click", closeVerifyPanel);
  installBackButton(o, closeVerifyPanel);
  return o;
}
function closeVerifyPanel() { const o = document.getElementById("verifyOverlay"); if (o) o.style.display = "none"; }
function openVerifyPanel() { ensureVerifyPanel().style.display = "flex"; renderVerifyPanel(); }
function actionSentence(r) {
  const by = nameOfId(r.b), t = nameOfId(r.t), d = Number(r.d) || 0;
  const dur = d ? " for " + formatDurationShort(Math.round(d / 1000) * 1000) : "";
  switch (r.k) {
    case "mute": return by + " muted " + t + dur;
    case "ban": return by + (d ? " banned " : " permanently banned ") + t + dur;
    case "kick": return by + " kicked " + t + " from a room";
    case "image": return by + (r.v === "on" ? " gave " : " removed ") + t + (r.v === "on" ? " image access" : "'s image access");
    case "role": return by + " made " + t + " " + (ROLES[r.v] ? ROLES[r.v].label : r.v) + (d ? dur : "");
    case "unrole": return by + " removed " + t + "'s " + (ROLES[r.v] ? ROLES[r.v].label : r.v) + " rank";
  }
  return by + " did something to " + t;
}
function renderVerifyPanel() {
  const body = document.getElementById("verifyBody");
  const o = document.getElementById("verifyOverlay");
  if (!body || !o || o.style.display !== "flex") return;
  body.textContent = "";
  const add = (tag, cls, text, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; (parent || body).appendChild(e); return e; };
  const on = verifyActive();
  const st = add("div", "vp-status " + (on ? "on" : "off"));
  st.textContent = !verifyFlagOn ? "Verification is OFF for this room. The Owner can turn it on with /verify on." : (chatPrefs.peerVerify === false ? "Verification is on for the room, but you turned it off on this device." : "Verification is ON");
  add("p", "vp-help", "When it's on, a ban, mute, kick or rank grant only counts if the person who did it really has the rank for it. Admin, Co-owner and Owner ranks can only be set from the database, so they're trusted. Mod and Normie ranks and image access can be faked, so they only count when a real admin or owner approved them. Nothing here needs voting or clicking from regular users.");
  // ranks
  add("h4", null, "Ranks");
  const rows = [];
  ["crown", "coowner", "admin", "mod", "normie"].forEach(roleId => {
    (roleIdHolders[roleId] || new Set()).forEach(id => {
      const trusted = roleId !== "mod" && roleId !== "normie";
      rows.push({ id: String(id), roleId, ok: !on || trusted || roleAttested(roleId, id), trusted });
    });
  });
  if (!rows.length) add("div", "vp-empty", "No rank holders found.");
  rows.forEach(r => {
    const row = add("div", "vp-row");
    add("span", "vp-name", nameOfId(r.id), row);
    add("span", "vp-role", ROLES[r.roleId].label, row);
    const chip = add("span", "vp-chip " + (r.ok ? "ok" : "bad"), r.ok ? (r.trusted ? "Verified (database)" : (on ? "Approved" : "Not checked")) : "Not approved – ignored", row);
    if (!r.ok && myRank() >= ROLES.admin.rank && ROLES[r.roleId].rank < myRank()) {
      const b = add("button", "vp-btn", "Approve", row);
      b.addEventListener("click", async () => {
        b.disabled = true; b.textContent = "…";
        try { await ChatBackend.grantRoleToId(r.roleId, r.id); } catch (e) { b.textContent = "Failed"; return; }
        setTimeout(() => { scheduleVerifyRefresh(); setTimeout(renderVerifyPanel, 600); }, 200);
      });
    }
  });
  // recent actions
  add("h4", null, "Recent actions");
  const list = [];
  ["actions", "grants"].forEach(node => Object.keys(recs[node]).forEach(id => list.push({ node, id, r: recs[node][id] })));
  list.sort((a, b) => (Number(b.r.ts) || 0) - (Number(a.r.ts) || 0));
  if (!list.length) add("div", "vp-empty", "Nothing has been recorded yet.");
  list.slice(0, 15).forEach(({ node, id, r }) => {
    const row = add("div", "vp-row");
    const when = new Date(Number(r.ts) || Date.now());
    add("span", "vp-when", when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), row);
    add("span", "vp-name", actionSentence(r), row);
    const s = recStatus(node, id), why = recWhy(node, id);
    const chip = add("span", "vp-chip " + (s === "ok" ? "ok" : s === "pending" ? "wait" : "bad"), s === "ok" ? "Approved" : s === "pending" ? "Checking…" : "Rejected", row);
    if (s === "no" && why) chip.title = why;
    if (s === "no" && why) add("small", "vp-why", why, row);
  });
}
/* ══════════ Notifications (the bell) ══════════ */
const NOTIF_KEY = "vus_chat_notifs_v1";
const NOTIF_TYPES = [
  ["mentions", "notifMentions", "Mentions", "When someone @mentions you"],
  ["replies", "notifReplies", "Replies", "When someone replies to your message"],
  ["reactions", "notifReactions", "Reactions", "When someone reacts to your message"],
  ["staff", "notifStaff", "Moderation", "When you are muted or removed from a room"]
];
let notifList = [];
try { notifList = (JSON.parse(localStorage.getItem(NOTIF_KEY) || "[]") || []).filter(n => n && typeof n.id === "string" && typeof n.text === "string"); } catch (e) {}
function saveNotifs() { try { localStorage.setItem(NOTIF_KEY, JSON.stringify(notifList.slice(0, 40))); } catch (e) {} }
function notifOn(type) { const t = NOTIF_TYPES.find(x => x[0] === type); return !t || chatPrefs[t[1]] !== false; }
function myNotifs() { return notifList.filter(n => n.uid === String(myLoginId || "")); }
function pushNotif(n) {
  if (!myLoginId || !notifOn(n.type) || notifList.some(x => x.id === n.id && x.uid === String(myLoginId))) return false;
  notifList.unshift({ id: n.id, type: n.type, text: String(n.text || "").slice(0, 140), from: String(n.from || "").slice(0, 40), emoji: n.emoji || "", ts: Number(n.ts) || Date.now(), msgId: n.msgId ? String(n.msgId) : "", uid: String(myLoginId), read: !!n.read });
  notifList = notifList.slice(0, 60);
  saveNotifs(); paintNotifBadge(); renderNotifPanel();
  return true;
}
const $notifBtn = document.getElementById("notifBtn"), $notifBadge = document.getElementById("notifBadge");
function paintNotifBadge() {
  const n = myNotifs().filter(x => !x.read).length;
  $notifBadge.textContent = n > 9 ? "9+" : String(n);
  $notifBadge.style.display = n ? "inline-block" : "none";
}
function notifAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
let notifPanel = null;
function ensureNotifPanel() {
  if (notifPanel) return notifPanel;
  const p = document.createElement("div");
  p.id = "notifPanel";
  p.innerHTML = '<div class="np-head"><b>Notifications</b><span class="np-actions"><button type="button" id="npRead">Mark all read</button><button type="button" id="npClear">Clear</button></span></div><div class="np-list" id="npList"></div><button type="button" class="np-foot" id="npSettings">⚙ Notification settings</button>';
  document.body.appendChild(p);
  p.querySelector("#npRead").addEventListener("click", () => { myNotifs().forEach(n => { n.read = true; }); saveNotifs(); paintNotifBadge(); renderNotifPanel(); });
  p.querySelector("#npClear").addEventListener("click", () => { notifList = notifList.filter(n => n.uid !== String(myLoginId || "")); saveNotifs(); paintNotifBadge(); renderNotifPanel(); });
  p.querySelector("#npSettings").addEventListener("click", () => {
    closeNotifPanel();
    if (window.VUS_UI && window.VUS_UI.openSettings) window.VUS_UI.openSettings("chat");
    setTimeout(() => { const s = document.getElementById("csNotifSection"); if (s) s.scrollIntoView({ block: "start" }); }, 200);
  });
  return (notifPanel = p);
}
function notifLine(n) {
  switch (n.type) {
    case "mentions": return [n.from + " mentioned you", n.text];
    case "replies": return [n.from + " replied to you", n.text];
    case "reactions": return [n.from + " reacted " + (n.emoji || "") + " to your message", n.text];
    default: return [n.text, ""];
  }
}
function renderNotifPanel() {
  if (!notifPanel || notifPanel.style.display !== "block") return;
  const list = notifPanel.querySelector("#npList");
  list.textContent = "";
  const items = myNotifs();
  if (!items.length) { const e = document.createElement("div"); e.className = "np-empty"; e.textContent = "Nothing yet. Mentions, replies and reactions show up here, even ones from while you were away."; list.appendChild(e); return; }
  items.slice(0, 30).forEach(n => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "np-row" + (n.read ? "" : " unread");
    const ico = document.createElement("span"); ico.className = "np-ico"; ico.textContent = n.type === "mentions" ? "@" : n.type === "replies" ? "↩" : n.type === "reactions" ? (n.emoji || "❤") : "🛡️";
    const body = document.createElement("span"); body.className = "np-body";
    const [t1, t2] = notifLine(n);
    const a = document.createElement("span"); a.className = "np-t1"; a.textContent = t1;
    body.appendChild(a);
    if (t2) { const b = document.createElement("span"); b.className = "np-t2"; b.textContent = t2; body.appendChild(b); }
    const tm = document.createElement("span"); tm.className = "np-time"; tm.textContent = notifAgo(n.ts);
    row.append(ico, body, tm);
    row.addEventListener("click", () => {
      n.read = true; saveNotifs(); paintNotifBadge();
      closeNotifPanel();
      if (n.msgId) jumpToMessage(n.msgId);
    });
    list.appendChild(row);
  });
}
function openNotifPanel() {
  const p = ensureNotifPanel();
  p.style.display = "block";
  renderNotifPanel();
}
function closeNotifPanel() { if (notifPanel) notifPanel.style.display = "none"; }
$notifBtn.addEventListener("click", e => { e.stopPropagation(); if (notifPanel && notifPanel.style.display === "block") closeNotifPanel(); else openNotifPanel(); });
document.addEventListener("click", e => { if (notifPanel && notifPanel.style.display === "block" && !notifPanel.contains(e.target) && e.target !== $notifBtn && !$notifBtn.contains(e.target)) closeNotifPanel(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeNotifPanel(); });
window.addEventListener("vus:logout", () => { closeNotifPanel(); paintNotifBadge(); });
paintNotifBadge();
// reactions on my messages
const reactSeen = {};
let reactBootUntil = 0;
function notifyReactions(id, val) {
  const m = msgEls.get(id);
  const now = new Set();
  if (val) Object.keys(val).forEach(em => { if (val[em] && typeof val[em] === "object") Object.keys(val[em]).forEach(uid => now.add(em + "|" + uid)); });
  const prev = reactSeen[id] || (Date.now() >= reactBootUntil ? new Set() : null);
  reactSeen[id] = now;
  if (!prev || !m || m.loginId !== String(myLoginId) || Date.now() < reactBootUntil) return;
  now.forEach(k => {
    if (prev.has(k)) return;
    const [em, uid] = k.split("|");
    if (uid === String(myLoginId) || isMuted(uid) || !validEmojiKey(em)) return;
    pushNotif({ id: "r:" + id + ":" + k, type: "reactions", from: nameOfId(uid), emoji: em, text: snippetOf(m), ts: Date.now(), msgId: id });
  });
}

/* ══════════ Replies, edits, reactions ══════════ */
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const msgEls = new Map();            // message id -> { el, bubble, reactRow, loginId, ts, isImage, mention, text }
const pendingEdits = {};             // edits that arrived before their message did
const reactionsByMsg = {};           // message id -> { emoji: { loginId: true } }
let replyingTo = null;               // { id, name, text }
let editingMsgId = null;
let lastReactAt = 0, lastEditAt = 0;
const EMOJI_KEY_OK = /^[^.$#\[\]\/\u0000-\u001f]{1,32}$/;
function validEmojiKey(k) { return typeof k === "string" && EMOJI_KEY_OK.test(k) && /\p{Extended_Pictographic}/u.test(k); }
function snippetOf(m) {
  if (!m.isImage) return stripMentionMarks(m.text).slice(0, 80);
  const label = m.kind === "video" ? "\uD83C\uDFAC Video" : "\uD83D\uDCF7 Image";   // says which kind of media it is
  const cap = stripMentionMarks(m.text || "").trim();
  return cap ? (label + " \u00b7 " + cap).slice(0, 80) : label;
}

function jumpToMessage(id) {
  const m = msgEls.get(id);
  if (!m || !m.el.isConnected) { showComposerNotice("That message is no longer on screen."); return; }
  m.el.scrollIntoView({ block: "center", behavior: "smooth" });
  m.el.classList.add("msg-flash");
  setTimeout(() => m.el.classList.remove("msg-flash"), 1400);
}
function updateReplyBar() {
  const bar = document.getElementById("chatReplyBar"), txt = document.getElementById("chatReplyText");
  if (!bar) return;
  if (editingMsgId) { bar.style.display = "flex"; txt.textContent = "Editing your message \u2014 Enter to save, Esc to cancel"; }
  else if (replyingTo) { bar.style.display = "flex"; txt.textContent = "Replying to " + replyingTo.name + ": " + replyingTo.text; }
  else bar.style.display = "none";
}
function startReply(id) {
  const m = msgEls.get(id);
  if (!m) return;
  cancelEdit(true);
  const nameEl = m.el.querySelector(".msg-meta-name");
  replyingTo = { id, name: (m.el.dataset.senderId === String(myLoginId) ? myName : (nameEl ? nameEl.textContent : "Someone")) || "Someone", text: snippetOf(m) };
  updateReplyBar();
  $msgInput.focus();
}
function cancelReply() { replyingTo = null; updateReplyBar(); }
function startEdit(id) {
  const m = msgEls.get(id);
  if (!m || m.isImage || m.loginId !== String(myLoginId)) return;
  if (m.ts && Date.now() - m.ts > EDIT_WINDOW_MS) { showComposerNotice("You can only edit a message for 15 minutes."); return; }
  replyingTo = null;
  editingMsgId = id;
  picked.clear();
  parseMentionTokens(m.text || "").forEach(t => picked.set(t.name, t.ping));
  $msgInput.value = stripMentionMarks(m.text || "");
  syncMentionMirror();
  autosizeInput(); updateCharCounter(); updateReplyBar();
  $msgInput.focus();
}
function cancelEdit(keepText) {
  if (!editingMsgId) return;
  editingMsgId = null;
  if (!keepText) { $msgInput.value = ""; picked.clear(); syncMentionMirror(); autosizeInput(); updateCharCounter(); }
  updateReplyBar();
}
async function commitEdit(text) {
  const id = editingMsgId, m = msgEls.get(id);
  if (!m || !text) { cancelEdit(); return; }
  if (text === m.text) { cancelEdit(); return; }
  if (Date.now() - lastEditAt < 1500) { showComposerNotice("Slow down a little."); return; }
  if (m.ts && ChatBackend.serverNowSync() - m.ts > EDIT_WINDOW_MS) { showComposerNotice("You can only edit a message for 15 minutes."); cancelEdit(); return; }
  lastEditAt = Date.now();
  try {
    await ChatBackend.editMessage(id, text.slice(0, MAX_CHARS), myLoginId);
    cancelEdit();
  } catch (e) {
    showComposerNotice(isPermissionDenied(e) ? "Edits need the updated database rules." : "Couldn't save the edit.");
  }
}
function applyEdit(id, e) {
  const m = msgEls.get(id);
  if (!m) { pendingEdits[id] = e; return; }
  if (!e || typeof e.text !== "string" || m.isImage || !m.loginId) return;
  if (String(e.by) !== m.loginId) return;                                              // only the author's own edit counts
  const ts = Number(e.ts) || 0;
  if (ts && m.ts && ts - m.ts > EDIT_WINDOW_MS + 5000) return;                         // and only inside the edit window
  const text = e.text.slice(0, MAX_CHARS);
  m.text = text;
  m.bubble.textContent = "";
  fillBubbleText(m.bubble, text, m.mention);
  const tag = document.createElement("span");
  tag.className = "msg-edited";
  tag.textContent = " (edited)";
  m.bubble.appendChild(tag);
}
function renderReactions(id) {
  const m = msgEls.get(id);
  if (!m) return;
  m.reactRow.replaceChildren();
  const data = reactionsByMsg[id] || {};
  let shown = 0;
  Object.keys(data).forEach(emoji => {
    if (shown >= 12 || !validEmojiKey(emoji) || !data[emoji] || typeof data[emoji] !== "object") return;
    const ids = Object.keys(data[emoji]).filter(uid => /^\d{4,12}$/.test(uid) && !isMuted(uid));
    if (!ids.length) return;
    shown++;
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "react-pill" + (ids.includes(String(myLoginId)) ? " mine" : "");
    pill.textContent = emoji + " " + ids.length;
    const who = ids.map(uid => uid === String(myLoginId) ? "You" : nameOfId(uid));
    pill.dataset.tip = who.slice(0, 12).join("\n") + (who.length > 12 ? "\n+" + (who.length - 12) + " more" : "");
    pill.setAttribute("aria-label", emoji + " from " + who.join(", "));
    pill.addEventListener("click", () => reactTo(id, emoji));
    m.reactRow.appendChild(pill);
  });
}
function onReactions(id, val) {
  if (val) reactionsByMsg[id] = val; else delete reactionsByMsg[id];
  notifyReactions(id, val);
  renderReactions(id);
}
async function reactTo(id, emoji) {
  if (!myLoginId || !validEmojiKey(emoji)) return;
  if (myTimeoutRemainingMs > 0) { showComposerNotice(mutedNotice()); return; }
  if (Date.now() - lastReactAt < 400) return;
  lastReactAt = Date.now();
  const mine = String(myLoginId);
  const cur = reactionsByMsg[id] || (reactionsByMsg[id] = {});
  const on = !(cur[emoji] && cur[emoji][mine]);
  if (on) { (cur[emoji] = cur[emoji] || {})[mine] = true; } else if (cur[emoji]) { delete cur[emoji][mine]; }
  renderReactions(id);
  try { await ChatBackend.setReaction(id, emoji, mine, on); }
  catch (e) {
    if (on) delete cur[emoji][mine]; else (cur[emoji] = cur[emoji] || {})[mine] = true;
    renderReactions(id);
    showComposerNotice(isPermissionDenied(e) ? "Reactions need the updated database rules." : "Couldn't react \u2014 check your connection.");
  }
}
function buildMessageActions(msg, mine) {
  const bar = document.createElement("div");
  bar.className = "msg-acts";
  const add = (label, title, fn) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.title = title; b.setAttribute("aria-label", title);
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
    bar.appendChild(b);
  };
  add("\uD83D\uDE0A", "Add reaction", (b) => { if (window.VUS_UI && window.VUS_UI.openEmojiPicker) window.VUS_UI.openEmojiPicker(b, e => reactTo(String(msg.id), e)); });
  add("\u21A9", "Reply", () => startReply(String(msg.id)));
  if (mine && msg.text && !msg.imageData) add("\u270F\uFE0F", "Edit", () => startEdit(String(msg.id)));
  return bar;
}

let rolesSeen = 0, rolesReady = false;
const rolesReadyWaiters = [];
function noteRoleLoaded() {
  rolesSeen++;
  if (!rolesReady && rolesSeen >= Object.values(ROLES).filter(r => !r.implicit).length) {
    rolesReady = true;
    rolesReadyWaiters.splice(0).forEach(fn => fn());
  }
}
function whenRolesReady() { return rolesReady ? Promise.resolve() : new Promise(res => { rolesReadyWaiters.push(res); setTimeout(res, 6000); }); }
const RATE_TOLERANCE_MS = 1000;        // server-timestamp jitter between an honest sender's own clock and ours
const lastAccepted = {};               // loginId -> { ts, image }
function violatesRateLimit(msg) {
  if (activeChannelId === "announce") return annRateBad(msg, annRenderLast);
  if (!msg.loginId || !msg.ts || msg.ts < liveSince || !rolesReady) return false;
  const id = String(msg.loginId);
  const role = effectiveRoleForLoginId(id);
  const table = (msg.imageData || msg.video) ? ROLE_IMAGE_COOLDOWNS_MS : ROLE_MESSAGE_COOLDOWNS_MS;
  const cd = table[role] != null ? table[role] : 10000;
  const prev = lastAccepted[id];
  if (prev) {
    const gap = msg.ts - prev.ts;
    const captionAfterImage = prev.image && !msg.imageData && !msg.video && gap < 2500;   // an image and its caption go out together
    if (!captionAfterImage && gap < cd - RATE_TOLERANCE_MS) return true;     // too soon for their role: not accepted, doesn't reset their timer
  }
  lastAccepted[id] = { ts: msg.ts, image: !!(msg.imageData || msg.video) };
  return false;
}
const imgAccessCache = {};
async function senderMayPostImages(id) {
  await whenRolesReady();
  if (ROLES[effectiveRoleForLoginId(id)].rank > IMAGE_GATED_MAX_RANK) return true;
  const c = imgAccessCache[id];
  if (c && Date.now() - c.at < 5000) return c.v;
  let v = false;
  try { v = !!(await ChatBackend.getImageAccess(id)) && imageAttested(id); } catch (e) {}
  imgAccessCache[id] = { at: Date.now(), v };
  return v;
}
const dupHistory = {};                 // sender -> [{ ts, norm }]
const burstTimes = {};                 // loginId -> [ts]
const createdAtCache = {};

function normalizeForSpam(text) {
  const t = stripMentionMarks(text).toLowerCase();
  const stripped = t.replace(/[^\p{L}\p{N}]+/gu, "");
  return stripped || t.trim();
}
function bigrams(str) { const m = new Map(); for (let i = 0; i < str.length - 1; i++) { const g = str.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; }
function textsAlike(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shortLen = Math.min(a.length, b.length);
  if (shortLen < 5) return false;
  if (shortLen >= 8 && (a.includes(b) || b.includes(a))) return true;
  const A = bigrams(a), B = bigrams(b);
  let overlap = 0;
  A.forEach((n, g) => { overlap += Math.min(n, B.get(g) || 0); });
  return (2 * overlap) / ((a.length - 1) + (b.length - 1)) >= SIMILAR_AT;
}
function isSpamDuplicate(msg) {
  if (!msg.text) return false;
  const key = String(msg.loginId || msg.name || "");
  if (!key) return false;
  const ts = Number(msg.ts) || Date.now();
  const norm = normalizeForSpam(msg.text + (msg.mention ? "" : ""));
  const list = (dupHistory[key] = (dupHistory[key] || []).filter(e => ts - e.ts < SPAM_WINDOW_MS * 3 && ts - e.ts > -SPAM_WINDOW_MS));
  const dup = list.some(e => Math.abs(ts - e.ts) < SPAM_WINDOW_MS && textsAlike(e.norm, norm));
  list.push({ ts, norm });
  return dup;
}
async function accountCreatedAt(loginId) {
  const id = String(loginId);
  if (id in createdAtCache) return createdAtCache[id];
  let v = 0;
  try { v = window.VUS_DM && window.VUS_DM.getAccountCreatedAt ? await window.VUS_DM.getAccountCreatedAt(id) : 0; } catch (e) {}
  return (createdAtCache[id] = v || 0);
}
function trackNewAccountBurst(msg) {
  if (!msg.loginId || !msg.ts || msg.ts < liveSince) return;      // history never triggers this
  const id = String(msg.loginId);
  if (isMuted(id)) return;
  const list = (burstTimes[id] = (burstTimes[id] || []).filter(t => msg.ts - t < SPAM_WINDOW_MS));
  list.push(msg.ts);
  if (list.length <= BURST_MAX_MESSAGES) return;
  if (effectiveRoleForLoginId(id) && ROLES[effectiveRoleForLoginId(id)] && ROLES[effectiveRoleForLoginId(id)].rank > 0) return;   // never auto-mute staff
  accountCreatedAt(id).then(created => {
    if (!created || isMuted(id) || msg.ts - created >= NEW_ACCOUNT_MS) return;
    autoMuted[id] = { name: msg.name, auto: true };
    applyMutesToDom();
    renderMembersPane();
    showComposerNotice("Hid " + msg.name + " (new account sending too fast). You can unmute them in the members list.");
  });
}

let sysShownAt = [];
function renderMessage(msg) {
  $emptyState.style.display = "none";

  if (msg.system) {
    const text = String(msg.text || "");
    const isJoinLeave = text.length <= 400 && (Array.isArray(msg.leftNames) || /^.{1,60} joined$/.test(text) || / left$/.test(text));
    // Anything that isn't a plain "X joined" / "X left" line is not a real system notice: a hacked client can write
    // any text it likes there, so it isn't shown.
    if (!isJoinLeave) return;
    const live = Number(msg.ts) >= liveSince;
    // "X left" about ME only counts when my entry in the online list really is gone (a forged line can't kick me out).
    const leftIsMe = Array.isArray(msg.leftNames)
      ? msg.leftNames.some(n => ChatBackend._safeKey(n) === ChatBackend._safeKey(myName))
      : text === myName + " left";
    if (myName && leftIsMe && live && $chatScreen.style.display !== "none") {
      const roomAtSend = ChatBackend.currentRoomId;
      try {
        ChatBackend._presenceRef.child(ChatBackend._safeKey(myName)).get().then(snap => {
          if (!snap.exists() && ChatBackend.currentRoomId === roomAtSend && myName && $chatScreen.style.display !== "none") forceReturnToJoinScreen("You were disconnected from the chat.");
        }).catch(() => {});
      } catch (e) {}
    }
    // Same line again within the last 5 messages: count it ("X joined x2" ... "x9+") instead of adding another one.
    const lastFive = [...$messages.children].filter(c => c.classList && c.classList.contains("msg")).slice(-5);
    const dup = lastFive.reverse().find(c => c.dataset.sysKey === text);
    if (dup) {
      const n = (Number(dup.dataset.sysN) || 1) + 1;
      dup.dataset.sysN = String(n);
      const b = dup.querySelector(".msg-bubble");
      if (b) b.textContent = text + " x" + (n >= 9 ? "9+" : n);
      return;
    }
    // Flood cap: at most 8 join/leave lines per 10 seconds, however many different names a script invents.
    if (live) {
      const nowT = Date.now();
      sysShownAt = sysShownAt.filter(t => nowT - t < 10000);
      if (sysShownAt.length >= 8) return;
      sysShownAt.push(nowT);
    }
    const sysEl = document.createElement("div");
    sysEl.className = "msg system sys-joinleave";
    sysEl.dataset.sysKey = text;
    const sysBubble = document.createElement("div");
    sysBubble.className = "msg-bubble";
    sysBubble.textContent = text;
    sysEl.appendChild(sysBubble);
    $messages.appendChild(sysEl);
    messageCount++;
    if (autoScroll && stickToBottom) scrollToBottom();
    return;
  }

  const mine = msg.name === myName;
  const el = document.createElement("div");
  el.className = "msg has-av" + (mine ? " mine" : "");
  if (msg.loginId) el.dataset.senderId = String(msg.loginId);
  if (msg.id) el.dataset.msgId = String(msg.id);
  if (msg.ts) el.dataset.ts = String(msg.ts);
  // Hidden (not removed) so unmuting brings a muted person's messages back; spam stays hidden for good.
  let hiddenForMe = false, needsVerify = false;
  if (!mine) {
    if (msg.loginId && msg.ts >= liveSince && isSilenced(msg.loginId)) { el.classList.add("silenced-hidden"); hiddenForMe = true; }   // muted/banned: a modified client's posts stay invisible here
    else if (isSpamDuplicate(msg) || violatesRateLimit(msg)) { el.classList.add("spam-hidden"); hiddenForMe = true; }
    else if (msg.loginId && isMuted(msg.loginId)) { el.classList.add("muted-hidden"); hiddenForMe = true; }
    if (activeChannelId !== "announce") trackNewAccountBurst(msg);
    if (!hiddenForMe && msg.loginId && isMuted(msg.loginId)) hiddenForMe = true;
    // No real login id or no name = not a real account (forged client): hidden for everyone else.
    if (!/^\d{6}$/.test(String(msg.loginId || "")) || !String(msg.name || "").trim()) { el.classList.add("anon-hidden"); hiddenForMe = true; }
    else {
      needsVerify = true;
      if (msg.imageData || msg.video) el.classList.add("anon-hidden");   // images and videos stay hidden until the sender is confirmed
    }
  }

  if (activeChannelId === "announce") {
    el.classList.add("ann-msg");
    if (msg.id && !msg.poll) { annEls.set(String(msg.id), { el, msg, mine }); paintAnnGate(String(msg.id)); }
  }
  const avEl = document.createElement("div");
  avEl.className = "msg-av";
  avEl.title = "View profile";
  paintAvatar(avEl, msg.loginId, msg.name);
  applyRingTo(avEl, msg.ring, msg.rfx);
  if (msg.loginId) avEl.addEventListener("click", () => openProfileFor(msg.loginId, msg.name));
  el.appendChild(avEl);

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const nameLink = document.createElement("span");
  nameLink.className = "msg-meta-name";
  nameLink.textContent = mine ? "You" : msg.name;
  if (msg.loginId) {
    nameLink.title = "View profile";
    nameLink.addEventListener("click", () => openProfileFor(msg.loginId, msg.name));
  }
  meta.appendChild(nameLink);
  if (msg.tag) { const te = tagEl(msg.tag); if (te) meta.appendChild(te); }
  if (msg.loginId) { const vt = document.createElement("span"); vt.className = "verified-tag"; vt.dataset.vid = String(msg.loginId); vt.textContent = "\u2713 Verified"; meta.appendChild(vt); paintVerifiedTag(vt); }
  if (msg.ts) meta.appendChild(document.createTextNode(" · " + formatTime(msg.ts)));
  el.appendChild(meta);

  // Rank badge ABOVE the message bubble: the sender's highest rank, resolved by
  // their account ID (stamped on the message), so it survives renames and
  // shows for people who are offline. Old messages without an ID fall back to
  // the name. refreshRoleBadges() re-runs this whenever ranks change.
  const badgeRow = document.createElement("div");
  badgeRow.className = "role-bubble-row";
  badgeRow.dataset.senderName = msg.name || "";
  if (msg.loginId) badgeRow.dataset.senderId = String(msg.loginId);
  fillRoleBadge(badgeRow);
  meta.insertBefore(badgeRow, meta.firstChild);   // highest role sits before the name, same line

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (msg.imageData) {
    const link = document.createElement("div");
    link.style.cursor = "zoom-in";
    link.addEventListener("click", () => { if (window.VUS_UI && window.VUS_UI.openImage) window.VUS_UI.openImage(msg.imageData); });
    const img = document.createElement("img");
    img.src = msg.imageData;
    img.alt = "Shared image";
    img.style.cssText = "max-width:100%;max-height:280px;border-radius:10px;display:block";
    link.appendChild(img);
    bubble.appendChild(link);
    bubble.style.padding = "6px";
    if (msg.text) { const cap = document.createElement("div"); cap.className = "media-caption"; fillBubbleText(cap, msg.text, msg.mention); bubble.appendChild(cap); }
  } else if (msg.video && typeof msg.video === "object") {
    buildVideoBubble(bubble, msg);
    bubble.style.padding = "8px";
    if (msg.text) { const cap = document.createElement("div"); cap.className = "media-caption"; fillBubbleText(cap, msg.text, msg.mention); bubble.appendChild(cap); }
  } else if (msg.poll && typeof msg.poll === "object") {
    buildPollBubble(bubble, msg);
    if (msg.id) { pollEls.set(String(msg.id), { el, msg, mine }); paintAnnGate(String(msg.id)); }
  } else {
    if (msg.fx && itemOf(msg.fx, "fx")) bubble.dataset.fx = msg.fx;
    fillBubbleText(bubble, msg.text, msg.mention);
  }

  if (!msg.imageData && !msg.video && !msg.poll) {
    if (msg.bubble) bubble.style.background = msg.bubble;
    if (msg.textColor) bubble.style.color = msg.textColor;
  }

  if (msg.replyTo && typeof msg.replyTo === "object") {
    const q = document.createElement("div");
    q.className = "msg-reply";
    const qn = document.createElement("b");
    qn.textContent = String(msg.replyTo.name || "Someone").slice(0, 40);
    q.append("\u21A9 ", qn, document.createTextNode("  " + maskFiltered(String(msg.replyTo.text || "").slice(0, 100))));
    if (msg.replyTo.id) q.addEventListener("click", () => jumpToMessage(String(msg.replyTo.id)));
    el.appendChild(q);
  }
  el.appendChild(bubble);
  const reactRow = document.createElement("div");
  reactRow.className = "msg-reactions";
  el.appendChild(reactRow);
  if (msg.id) {
    msgEls.set(String(msg.id), { el, bubble, reactRow, loginId: String(msg.loginId || ""), ts: Number(msg.ts) || 0, isImage: !!(msg.imageData || msg.video), kind: msg.video ? "video" : msg.imageData ? "image" : "text", mention: msg.mention || "" , text: msg.text || "" });
    el.appendChild(buildMessageActions(msg, mine));
    el.addEventListener("click", (ev) => {
      if (!(window.matchMedia && window.matchMedia("(hover: none)").matches)) return;
      if (ev.target.closest("button,.msg-av,.msg-meta-name,img,a")) return;
      document.querySelectorAll(".msg.touch-active").forEach(x => { if (x !== el) x.classList.remove("touch-active"); });
      el.classList.toggle("touch-active");
    });
  }
  if (msg.loginId && !mine) gateChannelEl(el, msg.loginId);
  $messages.appendChild(el);
  if (msg.id) {
    if (pendingEdits[msg.id]) applyEdit(String(msg.id), pendingEdits[msg.id]);
    renderReactions(String(msg.id));
  }

  messageCount++;
  while (messageCount > MAX_MESSAGES) {
    const first = $messages.querySelector(".msg");
    if (!first) break;
    // Trimming old rows from the top must not shove what you're reading upward.
    const removed = first.offsetHeight;
    first.remove();
    if (!(autoScroll && stickToBottom) && removed) $messages.scrollTop = Math.max(0, $messages.scrollTop - removed);
    messageCount--;
  }

  if (mine || (autoScroll && stickToBottom)) {
    scrollToBottom();
  } else if (!isNearBottom()) {
    $jumpToBottomBtn.style.display = "block";
  }

  const firePing = () => {
    if (hiddenForMe || el.classList.contains("anon-hidden") || msg.name === myName || (msg.loginId && isMuted(msg.loginId))) return;
    const recent = !msg.ts || Date.now() - msg.ts < 2 * 86400000;
    const mm = mentionInfoFor(msg);
    if (mm.me) {
      el.classList.add("mentions-me");
      if (notifOn("mentions")) {
        if (recent) pushNotif({ id: "m:" + (msg.id || msg.ts), type: "mentions", from: msg.name, text: stripMentionMarks(msg.text), ts: msg.ts, msgId: msg.id });
        const live = liveSince > 0 && msg.ts >= liveSince;
        if (mm.ping && live && Date.now() - (lastPingFrom[msg.loginId] || 0) > 30000) {
          lastPingFrom[msg.loginId] = Date.now();
          triggerIncomingPing(msg.name, stripMentionMarks(msg.text));
        }
      }
    }
    if (msg.replyTo && typeof msg.replyTo === "object" && recent) {
      const target = msg.replyTo.id ? msgEls.get(String(msg.replyTo.id)) : null;
      const toMe = target ? target.loginId === String(myLoginId) : String(msg.replyTo.name || "") === myName;
      if (toMe) pushNotif({ id: "p:" + (msg.id || msg.ts), type: "replies", from: msg.name, text: stripMentionMarks(msg.text), ts: msg.ts, msgId: msg.id });
    }
  };
  if (needsVerify && window.VUS_DM && window.VUS_DM.verifySender) {
    window.VUS_DM.verifySender(msg.loginId, msg.name).then(async r => {
      // Text: hidden only if the id isn't a real account. Images: the account must be real, the name must match it,
      // and the sender must actually have image access (rank above Normie, or granted by a higher-up).
      const isMedia = !!(msg.imageData || msg.video);
      let bad = !r.ok || (isMedia && !r.nameMatches);
      if (!bad && isMedia && !(await senderMayPostImages(String(msg.loginId)))) bad = true;
      if (bad && !(r.unknown && !isMedia)) { el.classList.add("anon-hidden"); }
      else { el.classList.remove("anon-hidden"); if (r.ok && r.nameMatches) rememberPerson(msg.loginId, msg.name); firePing(); }
      if (autoScroll && stickToBottom) scrollToBottom();
    }).catch(() => { if (msg.imageData || msg.video) el.classList.add("anon-hidden"); else firePing(); });
  } else {
    firePing();
  }
}

// Tracks whether THIS tab has ever seen a real disconnect while it had an
// active session, so a reconnect can be
// told apart from the very first connection at boot.
let hadConnectionDrop = false;

function setConnectionStatus(isOnline) {
  $onlineDot.className = "chat-online-dot" + (isOnline ? "" : " offline");
  if (isOnline) {
    $connError.style.display = "none";

    // If we're reconnecting after a real drop while we had a name/session,
    // the server-side onDisconnect hook already wiped our presence (and
    // posted "X left" for us) while we were gone — from everyone else's
    // point of view we already left. Don't let the tab keep pretending
    // it's still in that session: force it back to the "Continue as X?"
    // screen so re-joining is a deliberate action, not automatic.
    if (hadConnectionDrop && myName && $chatScreen.style.display !== "none") {
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

// Drops the client-side view of the current session and returns to the
// join screen's "Continue as X?" prompt, without touching the person's
// saved name in localStorage — used both for real disconnects (see
// setConnectionStatus above) and for detecting our own "left" system
// message coming back from the server (see watchLeaveEvents' onSelfLeft
// hook wired up in attachRoomListeners).
function forceReturnToJoinScreen(noticeText) {
  stopTyping();
  clearPendingImage();
  closeClearPanel();
  closeOnlineListPanel();
  closePingYouPanel();
  closeMentionDropdown();

  // Presence/typing/roles for this session are already gone server-side
  // (that's what triggered this in the first place) — just clear local
  // refs so a subsequent join starts clean instead of trying to release
  // something that no longer exists.
  ChatBackend._myPresenceRef = null;
  ChatBackend._myLeaveEventRef = null;
  ChatBackend._myTypingRef = null;

  myName = "";
  myLoginId = "";
  renderOwnAvatar("", null);
  $changeNameBtn.style.display = "none";
  $youAre.textContent = "";
  $chatScreen.style.display = "none";
  $joinScreen.style.display = "flex";

  const savedSession = loadDmSession();
  if (savedSession) {
    // The account is still valid -- offer a one-click way back in rather than
    // making the person type a password again.
    renderRejoinPrompt(savedSession, noticeText || "Your chat session ended.");
  } else {
    renderDmLoginPrompt(noticeText || "Your chat session ended. Log in to rejoin.");
  }
}

// ── Status card shown over the chat pane ("joining", "disconnected", errors) ──
function showStatusCard(title, message, buttons) {
  $joinCard.innerHTML = "";
  const h2 = document.createElement("h2");
  h2.textContent = title;
  $joinCard.appendChild(h2);
  if (message) {
    const p = document.createElement("p");
    p.textContent = message;
    $joinCard.appendChild(p);
  }
  (buttons || []).forEach((def, i) => {
    const btn = document.createElement("button");
    if (i === 0) btn.id = "joinBtn"; else btn.className = "join-secondary-btn";
    btn.textContent = def.label;
    btn.addEventListener("click", def.onClick);
    $joinCard.appendChild(btn);
  });
  $joinScreen.style.display = "flex";
}

function renderRejoinPrompt(session, message) {
  showStatusCard("Disconnected", message, [{ label: "Rejoin chat", onClick: () => autoLoginOrPrompt() }]);
}

function handleChatClosed(isClosed) {
  if (!isClosed) return;
  if (myName && $chatScreen.style.display !== "none") {
    ChatBackend.releasePresenceSilently();
    forceReturnToJoinScreen("The Owner closed VUS Chat for everyone.");
    return;
  }
  if (!myName) renderChatClosedPrompt();
}

function renderChatClosedPrompt() {
  $joinCard.innerHTML = "";
  const h2 = document.createElement("h2");
  h2.textContent = "VUS Chat is closed";
  const p = document.createElement("p");
  p.textContent = "The Owner has closed chat for everyone. Try again later.";
  $joinCard.appendChild(h2);
  $joinCard.appendChild(p);
}

function loadDmSession() {
  try { return window.VUS_DM ? window.VUS_DM.getSession() : null; } catch (e) { return null; }
}

function loadLastChatName() {
  const s = loadDmSession();
  return s ? s.username : "";
}
function saveLastChatName() {}

function renderDmLoginPrompt(message) {
  showStatusCard("Can't join chat", message || "Something went wrong joining the chat.", [
    { label: "Try again", onClick: () => autoLoginOrPrompt() },
    { label: "Log out", onClick: () => { if (window.VUS_DM) window.VUS_DM.logout(); } }
  ]);
}

function saveDmSession() {}

// Full sign-out of the stored account. Only used when the saved account is
// no longer valid (deleted / password-changed) -- NOT by the Log out button.
function clearSavedAccount() {}

async function validateDmSession(session) {
  if (!session || !session.accountKey || !session.username || !session.id) return false;
  if (!dmAuthDb) return true; // can't check; dm.js already validated the login
  try {
    const snapshot = await dmAuthDb.ref("users/" + session.accountKey).get();
    const account = snapshot.val();
    return !!(account && account.username === session.username && String(account.id) === String(session.id));
  } catch (e) { return true; }
}

async function loadDmAvatar(session) {
  if (!dmAuthDb) return null;
  try {
    const snapshot = await dmAuthDb.ref("users/" + session.accountKey + "/avatar").get();
    return snapshot.exists() ? (snapshot.val() || null) : null;
  } catch (e) { return null; }
}

function renderNicknamePrompt(session, message) {
  showStatusCard("Can't join chat", message || "Couldn't join chat as " + (session && session.username ? session.username : "your account") + ".", [
    { label: "Try again", onClick: () => autoLoginOrPrompt() }
  ]);
}

/* ══════════════════════════════════════════════════════════
   AUTO LOGIN + LOG OUT
   - On load, if this browser has a saved, still-valid account we go straight
     into chat under the last chat name used (no password screen).
   - "Log out" does NOT sign the account out. It only forgets the chat name
     and returns to the name picker. The account, and everything tied to its
     ID (rank, image access, color), stays bound to this browser -- you can
     only pick a new NAME, never swap to a different password/account.
   - The only thing that ever shows the password form again is a saved
     account that no longer validates (deleted/changed), or a fresh browser.
   ══════════════════════════════════════════════════════════ */
let chatJoinInFlight = false;
let roomListenersLive = false;
async function autoLoginOrPrompt() {
  if (chatJoinInFlight || myName) return;
  const session = loadDmSession();
  if (!session) return;
  if (!bootChat()) return;
  chatJoinInFlight = true;
  try {
    if (!roomListenersLive) { attachRoomListeners(); roomListenersLive = true; }
    showStatusCard("Joining chat…", "");
    // On a plain page refresh, our previous tab's presence can linger for a
    // second or two before onDisconnect clears it. Wait it out once rather
    // than bouncing the person to an error on every refresh.
    // Leaving the site and coming back leaves a ghost entry until the old connection times
    // out, so give it a few seconds to clear before offering "Join from this tab".
    for (let i = 0; i < 3 && (await ChatBackend.isAccountOnline(session.id)); i++) {
      await new Promise(r => setTimeout(r, 2000));
    }
    await joinWithDmSession(session, session.username);
  } catch (e) {
    renderDmLoginPrompt("Couldn't reach the chat server — try again.");
  } finally {
    chatJoinInFlight = false;
  }
}

// Called when the account logs out (dm.js fires "vus:logout"). Tears the whole
// chat session down; the next login starts it fresh. Nothing here touches DMs.
function shutdownChatSession() {
  if (!chatBooted) return;
  ChatBackend.releasePresenceSilently();
  stopTyping();
  clearPendingImage();
  closeAllPanels();
  if (unwatchMyProfile) { unwatchMyProfile(); unwatchMyProfile = null; }
  if (unwatchMyTimeout) { unwatchMyTimeout(); unwatchMyTimeout = null; }
  if (unwatchMyBan) { unwatchMyBan(); unwatchMyBan = null; }
  clearInterval(myTimeoutCountdownTimer);
  myName = "";
  myLoginId = "";
  imagesEnabledForMe = false;
  myTimeoutRemainingMs = 0;
  teardownCurrentRoomMetaWatch();
  currentRoomCode = null;
  currentRoomMeta = null;
  activeChannelId = "main";
  ChatBackend.detachAllListeners();
  if (typeof stopChannelCounts === "function") stopChannelCounts();
  ChatBackend.bindToRoom(MAIN_ROOM_ID);
  roomListenersLive = false;
  latestPresenceList = [];
  renderMembersPane();
  $messages.innerHTML = "";
  messageCount = 0;
  $roomTopBar.style.display = "none";
  stopRoomsSidebarLive();
  hideBanScreen();
  renderOwnAvatar("", null);
  $youAre.textContent = "";
  $changeNameBtn.style.display = "none";
  $chatScreen.style.display = "none";
  $joinScreen.style.display = "none";
  updateUploadButtonVisibility();
}

// Closes EVERY transient overlay/panel/dropdown in one call. Used on logout and,
// importantly, the instant a ban screen appears: anything the person had open (a
// staff menu, the rooms sidebar, a dropdown) used to stay open underneath the ban
// screen and pop back up, stale, once they were unbanned.
function closeAllPanels() {
  closeRoster();
  closeRankGuide();
  closeOwnerMenu();
  closeClearPanel();
  closeOnlineListPanel();
  closePingYouPanel();
  closeMentionDropdown();
  closeCommandList();
  closeRoomsSidebar();
  closeBanConfirm();
}

let unwatchMyProfile = null;

async function joinWithDmSession(session, nickname) {
  if (!session || !session.username || !session.username.trim()) {
    renderDmLoginPrompt("Your VUS DM's account does not have a valid username.");
    return;
  }
  if (!(await validateDmSession(session))) {
    clearSavedAccount();
    renderDmLoginPrompt("Your VUS DM session is no longer valid. Log in again to join the chat.");
    return;
  }
  const name = (nickname || session.username).trim();
  const result = await ChatBackend.claimPresence(name, false, session.id);
  if (!result.ok) {
    if (result.reason === "banned") {
      // claimPresence already read the ban; only do a fresh read if it did not hand it back.
      const ban = result.ban || (await ChatBackend.getBan(session.id).catch(() => null));
      if (ban) {
        showBanScreen(ban);
        watchMyBan(session);   // so an unban while they sit here lets them straight back in
      } else {
        renderRejoinPrompt(session, "Your ban has just ended.");
      }
    } else if (result.reason === "name-taken" || result.reason === "bad-name") {
      renderNicknamePrompt(session, result.reason === "name-taken"
        ? "That name is already in use right now (or looks too much like one that is). Pick another."
        : "That name has hidden characters in it. Use normal letters, numbers and symbols.");
    } else if (result.reason === "closed") {
      renderChatClosedPrompt();
    } else if (result.reason === "already-online") {
      // Don't dump the person to a password form -- their account is fine,
      // it's just open elsewhere. Keep the saved account and say so.
      renderAutoLoginBlocked(session, "This account is already in VUS Chat on another tab or device.");
    } else {
      renderDmLoginPrompt("Your DM login could not be used for chat.");
    }
    return;
  }
  myName = name;
  myLoginId = String(session.id);

  // Switch screens FIRST. Everything below is a nicety; if any of it fails the
  // person is still in the chat instead of stuck on the join screen with their
  // presence already written.
  updateYouAre();
  $changeNameBtn.style.display = "none";
  $joinScreen.style.display = "none";
  $chatScreen.style.display = "flex";

  const safely = (label, fn) => { try { fn(); } catch (e) { console.error("[VUS Chat] " + label + " failed:", e); } };
  safely("save session", () => { saveDmSession(session); saveLastChatName(name); });
  safely("avatar", () => {
    renderOwnAvatar(name, null);
    loadDmAvatar(session).then(avatar => {
      if (myLoginId === String(session.id) && myName === name) renderOwnAvatar(name, avatar);
    }).catch(() => {});
  });
  safely("ban watcher", watchMyBan);
  safely("mute watcher", watchMyTimeout);
  safely("profile watcher", startWatchingMyProfile);
  safely("notifications", requestNotificationPermissionIfNeeded);
  safely("composer state", () => { updateComposerLockState(); updateUploadButtonVisibility(); });
  safely("focus", () => { $msgInput.focus(); scrollToBottom(); });
}

// Keeps image access + rank live for this ID (someone can grant/revoke while
// you're in the room and it should apply immediately, no rejoin needed).
function startWatchingMyProfile() {
  if (unwatchMyProfile) { unwatchMyProfile(); unwatchMyProfile = null; }
  if (!myLoginId) return;
  unwatchMyProfile = ChatBackend.watchProfile(myLoginId, profile => {
    imagesEnabledForMe = !!(profile && profile.imageAccess === true);
    onMyRoleMaybeChanged();
  });
}

// Called whenever role sets or the profile change; re-evaluates everything
// that depends on MY rank (upload button, send delay, menu items).
// Header line: your name and your highest rank, always visible.
function updateYouAre() {
  $youAre.textContent = "";
  $youAre.title = "";
  if (!myName) return;
  const role = ROLES[myRoleId()];
  const piece = (cls, text) => { const el = document.createElement("span"); el.className = cls; el.textContent = text; return el; };
  $youAre.appendChild(piece("ya-prefix", "You: "));
  $youAre.appendChild(piece("ya-name", myName));
  $youAre.appendChild(piece("ya-sep", "  \u00b7  "));
  $youAre.appendChild(piece("ya-role", role.icon + " " + role.label));
  $youAre.title = myName + " (" + role.label + ")";   // full name on hover/long-press when it is shortened
}

function onMyRoleMaybeChanged() {
  scheduleRoleBadgeRefresh();   // badges on messages already on screen
  if (!myLoginId) return;
  updateYouAre();
  updateUploadButtonVisibility();
  updateSendButtonState();
  if ($globalClearPanel.style.display === "block" && typeof renderSettingsPanel === "function") renderSettingsPanel();
}

// Shown when auto-login finds the account already online elsewhere.
function renderAutoLoginBlocked(session, message) {
  showStatusCard("Already in chat", message, [
    { label: "Join from this tab", onClick: () => joinFromThisTab(session) },
    { label: "Try again", onClick: () => autoLoginOrPrompt() }
  ]);
}

// Moves the chat session to THIS tab: clears the account's old entry (a closed tab's leftover
// ghost, or a live tab elsewhere, which then shows "you're in another tab") and joins fresh.
async function joinFromThisTab(session) {
  if (chatJoinInFlight || myName) return;
  chatJoinInFlight = true;
  try {
    showStatusCard("Joining from this tab…", "");
    if (!bootChat()) return;
    if (!roomListenersLive) { attachRoomListeners(); roomListenersLive = true; }
    await ChatBackend.removeAccountPresence(session.id);
    await joinWithDmSession(session, session.username);
  } catch (e) {
    renderAutoLoginBlocked(session, "Couldn't switch to this tab — try again.");
  } finally {
    chatJoinInFlight = false;
  }
}

// This tab lost its presence to the same account joining from another tab.
ChatBackend.onDisplaced = function () {
  const session = loadDmSession();
  shutdownChatSession();
  if (!session) return;
  showStatusCard("You're chatting in another tab", "This account just joined VUS Chat from another tab or window.", [
    { label: "Join from this tab", onClick: () => joinFromThisTab(session) }
  ]);
  $joinScreen.style.display = "flex";
};

// Renaming = log out of this name and pick another. The account is unchanged.
function announceLocked() { return activeChannelId === "announce" && myRank() < ROLES.admin.rank; }
function updateSendButtonState() {
  const elapsed = Date.now() - lastSentAt;
  const remaining = currentMessageCooldownMs() - elapsed;
  if (announceLocked()) {
    $sendBtn.disabled = true; $msgInput.disabled = true;
    $msgInput.placeholder = "Only admins and above can post announcements";
    return;
  }
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

// The composer hint. Phones only have ~160px of input, so a long hint was cut
// off mid-word ("Type a"); keep it short there and only mention commands to
// people who actually have some.
function isPhoneWidth() {
  return !!(window.matchMedia && window.matchMedia("(max-width: 600px)").matches);
}
function defaultComposerPlaceholder() {
  if (activeChannelId === "announce") return announceLocked() ? "Only admins and above can post announcements" : "Write an announcement\u2026 (one every 15 seconds)";
  if (isPhoneWidth()) return "Message\u2026";
  return availableSlashCommands().length
    ? "Type a message\u2026 (@ mention, / commands)"
    : "Type a message\u2026 (@ to mention someone)";
}
if (window.matchMedia) {
  const phoneQuery = window.matchMedia("(max-width: 600px)");
  const onPhoneChange = () => { if (myLoginId && typeof updateComposerLockState === "function") updateComposerLockState(); };
  if (phoneQuery.addEventListener) phoneQuery.addEventListener("change", onPhoneChange);
  else if (phoneQuery.addListener) phoneQuery.addListener(onPhoneChange);
}

function updateComposerLockState() {
  if (myTimeoutRemainingMs > 0) {
    $msgInput.disabled = true;
    $msgInput.placeholder = "Muted — try again in " + formatCountdown(myTimeoutRemainingMs);
    $sendBtn.disabled = true;
    $sendBtn.classList.add("cooldown");
    $sendBtn.textContent = formatCountdown(myTimeoutRemainingMs);
  } else {
    $msgInput.disabled = false;
    $msgInput.placeholder = defaultComposerPlaceholder();
    updateSendButtonState();
  }
}

// Live-watches this browser's OWN timeout status in the current room so the
// composer locks/unlocks the moment an owner issues or a timeout expires,
// without the person needing to send a message to find out. Re-subscribes
// whenever we (re)claim presence under a name or switch rooms — see the
// call sites in joinWithDmSession / joinRoomByCode / switchToMainRoom.
function watchMyTimeout() {
  if (unwatchMyTimeout) { unwatchMyTimeout(); unwatchMyTimeout = null; }
  clearInterval(myTimeoutCountdownTimer);
  if (!myLoginId) { myTimeoutRemainingMs = 0; return; }

  unwatchMyTimeout = ChatBackend.watchTimeout(myLoginId, (remainingMs, rec) => {
    myMuteRaw = { remaining: remainingMs, rec, at: Date.now() };
    applyMyMute();
  });
}
// A mute only locks you if the person who set it was allowed to (rank, length limit, target below them)
// and, with peer verification on, if its action record has been approved.
let myMuteRaw = { remaining: 0, rec: null, at: 0 };
function applyMyMute() {
  let eff = Math.max(0, myMuteRaw.remaining - (Date.now() - myMuteRaw.at));
  if (eff > 0 && myMuteRaw.rec && myLoginId) {
    if (!muteLocalValid(myLoginId, myMuteRaw.rec) || muteStatus(myLoginId, myMuteRaw.rec) !== "ok") eff = 0;
  }
  const wasMuted = myTimeoutRemainingMs > 0;
  myTimeoutRemainingMs = eff;
  myTimeoutReason = eff > 0 && myMuteRaw.rec && typeof myMuteRaw.rec.reason === "string" ? myMuteRaw.rec.reason.slice(0, 100) : "";
  if (eff > 0 && !wasMuted && myMuteRaw.rec) pushNotif({ id: "s:mute:" + (myMuteRaw.rec.expiresAt || Date.now()), type: "staff", from: "Moderation", text: "You were muted for " + formatCountdown(eff) + "." + (myTimeoutReason ? " Reason: " + myTimeoutReason : ""), ts: Date.now() });
  updateComposerLockState();
  clearInterval(myTimeoutCountdownTimer);
  if (eff > 0) {
    myTimeoutCountdownTimer = setInterval(() => {
      myTimeoutRemainingMs = Math.max(0, myTimeoutRemainingMs - 1000);
      updateComposerLockState();
      if (myTimeoutRemainingMs <= 0) clearInterval(myTimeoutCountdownTimer);
    }, 1000);
  }
}


/* ══════════════════════════════════════════════════════════
   BAN SCREEN
   Being banned NEVER shows login/signup again. It shows this screen and
   nothing else -- refreshing, closing and reopening the tab, or trying the
   login form directly all land back here as long as the ban is active. A
   temporary ban counts down live and clears itself the instant it expires;
   a permanent ban stays until an Owner runs /unban.
   ══════════════════════════════════════════════════════════ */
let banCountdownTimer = null;

function formatBanCountdown(msRemaining) {
  const totalSecs = Math.max(0, Math.ceil(msRemaining / 1000));
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const sec = totalSecs % 60;
  if (d > 0) return d + "d " + String(h).padStart(2, "0") + "h " + String(m).padStart(2, "0") + "m";
  if (h > 0) return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
  return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
}

function stopBanCountdown() {
  clearInterval(banCountdownTimer);
  banCountdownTimer = null;
}

function showBanScreen(ban) {
  stopBanCountdown();
  closeAllPanels();
  $joinScreen.style.display = "none";
  $chatScreen.style.display = "none";
  $banScreen.style.display = "flex";

  const isTemporary = !!ban.expiresAt;
  $banTitle.textContent = isTemporary ? "You're temporarily banned" : "You are banned";
  $banReason.textContent = "Your account was removed from VUS Chat by staff." + (ban.reason ? " Reason: " + String(ban.reason).slice(0, 100) : "");
  $banCountdownWrap.style.display = isTemporary ? "block" : "none";
  $banPermanentNote.style.display = isTemporary ? "none" : "block";

  if (isTemporary) {
    const tick = () => {
      const remaining = Number(ban.expiresAt) - ChatBackend.serverNowSync();
      if (remaining <= 0) {
        stopBanCountdown();
        // Ban has run out -- re-check with the server rather than trusting
        // the local clock, then drop back to the normal join flow.
        setTimeout(recheckBanStatus, 400);   // short grace so the server's view of "over" has caught up
        return;
      }
      $banCountdown.textContent = formatBanCountdown(remaining);
    };
    tick();
    banCountdownTimer = setInterval(tick, 1000);
  }
}

function hideBanScreen() {
  stopBanCountdown();
  $banScreen.style.display = "none";
}

// Re-asks the database "am I still banned?" -- used when a countdown hits
// zero, and by the "Check again" button for a permanent ban (in case an
// Owner just lifted it).
let banRecheckBusy = false;
async function recheckBanStatus() {
  if (banRecheckBusy) return;
  banRecheckBusy = true;
  $banRefreshBtn.disabled = true;
  $banRefreshBtn.textContent = "Checking...";
  try {
    // watchMyBan clears myLoginId when it puts this screen up, so ask about the SAVED account.
    // (Before, this skipped the question entirely: it dropped you into the login flow, which
    // found the ban again and flashed the ban screen back up.)
    const saved = loadDmSession();
    const id = myLoginId || (saved && saved.id);
    let ban = null;
    if (id) {
      try { ban = await ChatBackend.getBan(id); } catch (e) { return; }   // can't reach the server: stay put
    }
    if (ban) { showBanScreen(ban); return; }
    hideBanScreen();
    $joinScreen.style.display = "flex";
    if (saved) rejoinAfterBanLifted(saved);
    else autoLoginOrPrompt();
  } finally {
    banRecheckBusy = false;
    $banRefreshBtn.disabled = false;
    $banRefreshBtn.textContent = "Check again";
  }
}
$banRefreshBtn.addEventListener("click", recheckBanStatus);

function watchMyBan(forSession) {
  if (unwatchMyBan) { unwatchMyBan(); unwatchMyBan = null; }
  // forSession lets this keep watching for an unban while someone sits on the ban screen
  // after a refresh (they never got far enough to have a login ID in memory).
  const watchId = myLoginId || (forSession && String(forSession.id)) || "";
  if (!watchId) return;
  // Remembers the account so that when the ban clears (lifted early, or its
  // own countdown running out and being reported by this same listener) we
  // can rejoin under it directly -- without this, unbanning someone left them
  // stuck on the ban screen forever with no session to recover with.
  const watchedSession = loadDmSession();
  unwatchMyBan = ChatBackend.watchBan(watchId, ban => {
    if (ban) {
      if (!myName) {   // not in chat: if the ban screen is up, refresh it (e.g. the ban was extended)
        if ($banScreen.style.display === "flex") showBanScreen(ban);
        return;
      }
      ChatBackend.releasePresenceSilently();
      myName = "";
      myLoginId = "";
      showBanScreen(ban);
      return;
    }
    // Ban is gone. Only act if we're actually sitting on the ban screen for
    // this account -- a `null` fires once on every fresh subscribe too
    // (nothing to do then, since the person is already in chat normally).
    if ($banScreen.style.display !== "flex") return;
    hideBanScreen();
    $joinScreen.style.display = "flex";
    if (watchedSession) rejoinAfterBanLifted(watchedSession);
    else autoLoginOrPrompt();
  });
}

// Rejoins directly under the account that was banned, rather than routing
// through autoLoginOrPrompt() a second time mid-session (that path is meant
// for the very first load and assumes nothing is running yet).
async function rejoinAfterBanLifted(session) {
  try { await joinWithDmSession(session, session.username); }
  catch (e) { renderDmLoginPrompt("Couldn't rejoin the chat — try again."); }
}

function parseModerationDuration(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d|w)?$/i);
  if (!match) return 0;
  const unitMs = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return Number(match[1]) * (unitMs[(match[2] || "m").toLowerCase()] || 60000);
}

/* ══════════════════════════════════════════════════════════
   SLASH COMMANDS
   One table drives everything: the "/" list, tab-autofill, the ghost hint,
   the permission check and the unknown-command check. `minRank` hides a
   command from anyone who can't use it. `desc` may be a function of your rank
   so the min/max shown always matches what YOUR rank is allowed.
   ══════════════════════════════════════════════════════════ */
const SLASH_COMMANDS = [
  { name: "/mute", args: "time username [reason]",    minRank: ROLES.mod.rank,
    desc: rank => "Mute someone for a while (" + limitsText(timeoutLimitsForRank(rank)) + ").", insert: "/mute " },
  { name: "/kick",    args: "username",               minRank: ROLES.admin.rank,
    desc: "Remove a user from the current private room.", insert: "/kick " },
  { name: "/ban",     args: "username or ID [reason]", minRank: ROLES.mod.rank,
    desc: rank => "Ban the account ID, so a new name won't get around it. " + (rank >= ROLES.crown.rank ? "Permanent." : "Lasts " + formatDurationShort(banLimitsForRank(rank).max) + " (the longest your rank can do).") + " A 6-digit ID works even if they're offline.", insert: "/ban " },
  { name: "/tempban", args: "time username or ID [reason]", minRank: ROLES.mod.rank,
    desc: () => "Ban the account ID for a while (" + limitsText(banLimitsForRank(myRank())) + ").", insert: "/tempban " },
  { name: "/grant",   args: "rank perm|time username", minRank: ROLES.mod.rank,
    desc: rank => "Give a rank below yours. perm = permanent, or a time (" + limitsText(TIME_LIMITS.tempGrant) + "). " + (rank >= ROLES.admin.rank ? "Ranks: normie, mod, admin, coowner." : "Mods can give Normie."), insert: "/grant " },
  { name: "/remove",  args: "rank username",          minRank: ROLES.mod.rank,
    desc: rank => rank >= ROLES.admin.rank ? "Take away a rank below yours." : "Take away Normie from someone.", insert: "/remove " },
  { name: "/image",   args: "on|off username",        minRank: ROLES.admin.rank,
    desc: "Give or take away image access for someone below your rank.", insert: "/image " },
  { name: "/poll", args: "", minRank: ROLES.admin.rank,
    desc: "Open the poll menu: a question with Yes / No (add up to 4 options). Lasts 1 minute.", insert: "/poll" },
  { name: "/verify", args: "[on]",              minRank: ROLES.crown.rank,
    desc: "Open the Verification panel (who is verified, recent actions). Use /verify on to turn it on for the room.", insert: "/verify " },
  { name: "/unban",   args: "username or ID",         minRank: ROLES.crown.rank,
    desc: "Lift a ban by username or 6-digit account ID.", insert: "/unban " }
];

function commandDescription(cmd, rank) {
  const r = rank === undefined ? myRank() : rank;
  return typeof cmd.desc === "function" ? cmd.desc(r) : cmd.desc;
}

function availableSlashCommands() {
  const rank = myRank();
  return SLASH_COMMANDS.filter(c => rank >= c.minRank && (c.name !== "/kick" || currentRoomCode)); // /kick only does anything inside a private room
}

// Online-only lookup by exact chat name (case-insensitive).
function findModerationTarget(name) {
  const wanted = String(name || "").trim().toLowerCase();
  return latestPresenceList.find(entry => entry.name.toLowerCase() === wanted) || null;
}

// Real account with this 6-digit ID? (checks both DM databases)
// Real account with this exact username? (checks both DM databases) Lets staff ban
// people who are offline by name, not just by 6-digit ID.
async function lookupAccountByUsername(name) {
  const lower = String(name || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(lower)) return null;
  for (const database of [dmAuthDb]) {
    if (!database) continue;
    try {
      const keySnap = await database.ref("usernameIndex/" + lower).get();
      if (!keySnap.exists()) continue;
      const account = (await database.ref("users/" + keySnap.val()).get()).val();
      if (account && account.id) return { loginId: String(account.id), username: account.username || lower };
    } catch (e) {}
  }
  return null;
}

async function lookupAccountByLoginId(id) {
  for (const database of [dmAuthDb]) {
    if (!database) continue;
    try {
      const snap = await database.ref("idIndex/" + id).get();
      if (!snap.exists()) continue;
      const val = snap.val();
      let username = val && typeof val === "object" ? val.username : null;
      if (!username && typeof val === "string") {
        try { username = (await database.ref("users/" + val + "/username").get()).val(); } catch (e) {}
      }
      return { loginId: String(id), username: username || null };
    } catch (e) {}
  }
  return null;
}

// Resolves what someone typed to { name, loginId }. Accepts a chat name of
// someone online, or a 6-digit account ID. With allowOfflineId, an ID that
// belongs to a real account works even when that person isn't online -- that
// is what makes /ban stick to the ACCOUNT no matter what name they use.
async function resolveModerationTarget(raw, opts) {
  const wanted = String(raw || "").trim();
  if (!wanted) return null;
  if (/^[0-9]{6}$/.test(wanted)) {
    const online = latestPresenceList.find(e => String(e.loginId || "") === wanted);
    if (online) return { name: online.name, loginId: wanted, online: true };
    if (!(opts && opts.allowOfflineId)) return null;
    const account = await lookupAccountByLoginId(wanted);
    if (!account) return null;
    let last = null;
    try { const profile = await ChatBackend.getProfile(wanted); last = profile && profile.lastName; } catch (e) {}
    return { name: last || account.username || ("ID #" + wanted), loginId: wanted, online: false };
  }
  const hit = findModerationTarget(wanted);
  if (hit && hit.loginId) return { name: hit.name, loginId: String(hit.loginId), online: true };
  if (opts && opts.allowOfflineId) {
    const account = await lookupAccountByUsername(wanted);
    if (account) return { name: account.username, loginId: account.loginId, online: false };
  }
  return null;
}

// Shared checks before acting on someone. Returns true when it's OK to go on.
function guardModerationTarget(target, verb) {
  if (!target || !target.loginId) {
    showComposerNotice("Couldn't find that user. Use the name of someone who's online" + (verb === "ban" ? ", or their exact username or 6-digit ID." : "."));
    return false;
  }
  if (String(target.loginId) === String(myLoginId)) {
    showComposerNotice("You cannot " + verb + " yourself.");
    return false;
  }
  if ((verb === "kick" || verb === "mute" || verb === "ban") && isProtected(target.loginId)) {
    const past = verb === "kick" ? "kicked" : verb === "mute" ? "muted" : "banned";
    showComposerNotice(PROTECTION_EMOJI + " " + (target.name || "That person") + " is protected and can't be " + past + ".");
    return false;
  }
  if (rankOfLoginId(target.loginId) >= myRank()) {
    showComposerNotice("You can only " + verb + " ranks below your own.");
    return false;
  }
  return true;
}

/* Staff actions on a profile card (Mute / Ban / Kick). Only what YOUR rank allows against someone BELOW you;
   Kick only shows while you're inside a private room. They open the same dialogs and use the same limits as the
   menus and commands, so nothing here is a new way around a rule. */
function staffActionsFor(loginId, name) {
  const out = [];
  const id = String(loginId || "");
  const rank = myRank();
  if (!id || !myLoginId || id === String(myLoginId) || rank < ROLES.mod.rank || !rolesReady) return out;
  if (rankOfLoginId(id) >= rank || isProtected(id)) return out;
  out.push({ id: "mute", label: "Mute…" });
  out.push({ id: "tempban", label: "Temp ban…" });
  out.push({ id: "ban", label: rank >= ROLES.crown.rank ? "Ban" : "Ban (" + formatDurationShort(banLimitsForRank(rank).max) + ")" });
  if (rank >= ROLES.admin.rank) {
    if (currentRoomCode) out.push({ id: "kick", label: "Kick from room" });
  }
  return out;
}
/* Rank changes from a profile card. Only Mod and Normie can be handed out from the app (the others are set by hand
   in the database). You can only touch ranks below your own: Mods Normie only, Admins and up Mod and Normie.
   The list starts on the next rank up from where the person is; ranks they hold can be taken away. */
function roleActionsFor(loginId) {
  const id = String(loginId || "");
  const rank = myRank();
  if (!id || !myLoginId || id === String(myLoginId) || rank < ROLES.mod.rank || !rolesReady) return [];
  const tRank = rankOfLoginId(id);
  if (tRank >= rank || isProtected(id)) return [];
  const held = rid => !!(roleIdRaw[rid] && roleIdRaw[rid][id]);
  const out = [];
  ["normie", "mod"].forEach(rid => {
    if (!canGrantRole(rank, rid)) return;
    if (ROLES[rid].rank > tRank && !(roleIdRaw[rid] && roleIdRaw[rid][id] === true)) out.push({ kind: "grant", roleId: rid, label: "Give " + ROLES[rid].icon + " " + ROLES[rid].label });
  });
  ["mod", "normie"].forEach(rid => {
    if (canGrantRole(rank, rid) && held(rid)) out.push({ kind: "remove", roleId: rid, label: "Remove " + ROLES[rid].icon + " " + ROLES[rid].label });
  });
  return out;   // the first entry is the default (next rank up); with nothing to give, the first removal
}
async function runRoleAction(kind, roleId, loginId, name, durationMs) {
  const rank = myRank();
  const target = { name: name || "Someone", loginId: String(loginId || "") };
  const ok = roleActionsFor(loginId).some(a => a.kind === kind && a.roleId === roleId);
  if (!ok) { showComposerNotice("You can't do that for " + target.name + "."); return false; }
  const role = ROLES[roleId];
  try {
    if (kind === "remove") {
      await ChatBackend.removeRoleFromId(roleId, target.loginId);
      showComposerNotice("Removed " + role.label + " from " + target.name + ".");
    } else if (durationMs) {
      const problem = checkDurationLimits(durationMs, TIME_LIMITS.tempGrant);
      if (problem) { showComposerNotice(problem); return false; }
      await ChatBackend.grantTemporaryRoleToId(roleId, target.loginId, durationMs, myLoginId);
      showComposerNotice("Gave " + role.label + " to " + target.name + " for " + formatDurationShort(durationMs) + ".");
    } else {
      await ChatBackend.grantRoleToId(roleId, target.loginId);
      showComposerNotice("Gave " + role.label + " to " + target.name + " permanently.");
    }
    return true;
  } catch (e) {
    showComposerNotice(isPermissionDenied(e) ? rankByHandNotice(role) : "Couldn't change the rank: " + (e && e.message ? e.message : "check your connection") + ".");
    return false;
  }
}
async function runStaffAction(kind, loginId, name) {
  const target = { name: name || "Someone", loginId: String(loginId || "") };
  const rank = myRank();
  const allowed = staffActionsFor(loginId, name).some(a => a.id === kind);
  if (!allowed) { showComposerNotice("You can't do that to " + target.name + "."); return; }
  if (!guardModerationTarget(target, kind === "kick" ? "kick" : kind === "mute" ? "mute" : "ban")) return;
  if (kind === "mute") {
    if (rank < ROLES.admin.rank) {
      const remaining = await ChatBackend.getTimeoutRemainingMs(target.loginId);
      if (remaining > 0) { showComposerNotice(target.name + " is already muted for " + formatCountdown(remaining) + "."); return; }
      const cooldown = await ChatBackend.getModRetimeoutRemainingMs(myLoginId, target.loginId);
      if (cooldown > 0) { showComposerNotice("Wait " + Math.ceil(cooldown / 1000) + "s before muting " + target.name + " again."); return; }
    }
    staffMenuMode = rank < ROLES.admin.rank ? "mod" : "admin";
    openTimeoutSetModal(target);
  } else if (kind === "tempban") {
    openTempBanSetModal(target);
  } else if (kind === "ban") {
    openBanConfirm(target, 0);
  } else if (kind === "kick") {
    try { await RoomManager.kickFromRoom(currentRoomCode, target.loginId); showComposerNotice("Removed " + target.name + " from the room."); }
    catch (e) { showComposerNotice("Couldn't kick " + target.name + "."); }
  }
}

// True when the database (its security rules) refused a write.
function isPermissionDenied(e) {
  return /permission[_ ]denied/i.test(String((e && (e.code || e.message)) || ""));
}
// Owner and Co-owner can only be added by hand in the Firebase console, so the
// rules refuse them from the browser. Say so plainly instead of a raw error.
function rankByHandNotice(role) {
  return role.label + " can only be added by hand in the Firebase console: roleIds/" + role.id + "/<6-digit ID> = true.";
}

async function handleModerationCommand(text) {
  if (!text.startsWith("/")) return false;
  const parts = text.trim().split(/\s+/);
  let command = parts[0].toLowerCase();
  if (command === "/timeout") command = "/mute";   // old name still works
  const rank = myRank();

  const def = SLASH_COMMANDS.find(c => c.name === command);
  if (!def) {
    // Someone with no commands at all (Unranked/Normie) typing "/s" or "/shrug"
    // is just chatting -- send it as a normal message instead of blocking it.
    if (availableSlashCommands().length === 0) return false;
    showComposerNotice("Unknown command. Type / to see the list.");
    return true;
  }
  if (rank < def.minRank) {
    showComposerNotice("You do not have permission to use " + command + ".");
    return true;
  }
  ChatBackend.logCommand(text);

  // ── /unban (Owner) ──
  if (command === "/unban") {
    if (parts.length < 2) { showComposerNotice("Use /unban username or /unban loginID"); return true; }
    try {
      const loginId = await ChatBackend.unbanUser(parts.slice(1).join(" "));
      showComposerNotice("Unbanned login ID #" + loginId + ".");
    } catch (e) {
      showComposerNotice("Couldn't unban that user: " + (e && e.message ? e.message : "check your connection") + ".");
    }
    return true;
  }

  if (command === "/poll") { openPollMenu(); return true; }

  // ── /verify (Owner) ──
  if (command === "/verify") {
    const mode = (parts[1] || "").toLowerCase();
    if (mode === "on") {
      try { await ChatBackend.setVerify(); showComposerNotice("Verification is now ON for this room."); openVerifyPanel(); }
      catch (e) { showComposerNotice(isPermissionDenied(e) ? "The database rules don't allow this yet. Publish the updated chat rules first." : "Couldn't turn it on."); }
    } else openVerifyPanel();
    return true;
  }

  // ── /image ──
  if (command === "/image") {
    const mode = (parts[1] || "").toLowerCase();
    if (parts.length < 3 || !["on", "off"].includes(mode)) {
      showComposerNotice("Use /image on username or /image off username");
      return true;
    }
    const target = await resolveModerationTarget(parts.slice(2).join(" "));
    if (!guardModerationTarget(target, "change image access for")) return true;
    try {
      await ChatBackend.setImageAccess(target.loginId, mode === "on");
      showComposerNotice((mode === "on" ? "Gave image access to " : "Removed image access from ") + target.name + ".");
    } catch (e) {
      showComposerNotice("Couldn't update image access: " + (e && e.message ? e.message : "check your connection") + ".");
    }
    return true;
  }

  // ── /kick ──
  if (command === "/kick") {
    if (parts.length < 2 || !currentRoomCode) {
      showComposerNotice("Use /kick name inside a private room.");
      return true;
    }
    const target = await resolveModerationTarget(parts.slice(1).join(" "));
    if (!guardModerationTarget(target, "kick")) return true;
    await RoomManager.kickFromRoom(currentRoomCode, target.loginId);
    showComposerNotice("Removed " + target.name + " from the room.");
    return true;
  }

  // ── /timeout (Mod and up) ──
  if (command === "/mute") {
    const limits = timeoutLimitsForRank(rank);
    if (parts.length < 3) {
      showComposerNotice("Use /mute time username, such as /mute 10m alex (" + limitsText(limits) + ").");
      return true;
    }
    const durationMs = parseModerationDuration(parts[1]);
    const problem = checkDurationLimits(durationMs, limits);
    if (problem) { showComposerNotice(problem); return true; }
    const reason = parts.slice(3).join(" ").slice(0, 100);   // anything after the name is the reason
    const target = await resolveModerationTarget(parts[2]);
    if (!guardModerationTarget(target, "mute")) return true;

    const isJustMod = rank < ROLES.admin.rank;
    if (isJustMod) {
      // Same rules the Mod Menu enforces: no stacking on an active timeout, and
      // a short wait before re-timing-out the same person.
      const remaining = await ChatBackend.getTimeoutRemainingMs(target.loginId);
      if (remaining > 0) {
        showComposerNotice(target.name + " is already muted for " + formatCountdown(remaining) + ".");
        return true;
      }
      const cooldown = await ChatBackend.getModRetimeoutRemainingMs(myLoginId, target.loginId);
      if (cooldown > 0) {
        showComposerNotice("Wait " + Math.ceil(cooldown / 1000) + "s before muting " + target.name + " out again.");
        return true;
      }
    }
    await ChatBackend.setTimeout_(target.loginId, durationMs, myLoginId, reason);
    if (isJustMod) watchModIssuedTimeoutExpiry(myLoginId, target.loginId);
    showComposerNotice("Muted " + target.name + " for " + formatCountdown(durationMs) + "." + (reason ? " Reason: " + reason : ""));
    return true;
  }

  // ── /ban and /tempban: ALWAYS act on the account ID ──
  if (command === "/ban" || command === "/tempban") {
    let durationMs = 0;
    let nameParts;
    let banReason = "";
    if (command === "/tempban") {
      if (parts.length < 3) {
        showComposerNotice("Use /tempban time username, such as /tempban 2h alex (" + limitsText(banLimitsForRank(myRank())) + ").");
        return true;
      }
      durationMs = parseModerationDuration(parts[1]);
      const problem = checkDurationLimits(durationMs, banLimitsForRank(myRank()));
      if (problem) { showComposerNotice(problem); return true; }
      nameParts = parts.slice(2, 3);
      banReason = parts.slice(3).join(" ").slice(0, 100);
    } else {
      if (parts.length < 2) { showComposerNotice("Use /ban username, or /ban 123456 (account ID)."); return true; }
      nameParts = parts.slice(1, 2);
      banReason = parts.slice(2).join(" ").slice(0, 100);
      if (myRank() < ROLES.crown.rank) durationMs = banLimitsForRank(myRank()).max;   // no permanent bans for this rank: use the longest allowed
    }
    const target = await resolveModerationTarget(nameParts.join(" "), { allowOfflineId: true });
    if (!target) {
      showComposerNotice("Couldn't find that user. Use their exact username or a real 6-digit account ID.");
      return true;
    }
    if (!guardModerationTarget(target, "ban")) return true;
    openBanConfirm(target, durationMs, banReason);
    return true;
  }

  // ── /remove ──
  if (command === "/remove") {
    if (parts.length < 3) { showComposerNotice("Use /remove rank username, such as /remove mod alex"); return true; }
    const roleToRemove = ROLES[parts[1].toLowerCase()];
    if (!roleToRemove || roleToRemove.implicit || roleToRemove.id === "crown") {
      showComposerNotice("Rank must be one of: normie, mod, admin, coowner.");
      return true;
    }
    if (roleToRemove.rank >= rank) {
      showComposerNotice("You can only remove ranks below your own.");
      return true;
    }
    if (!canGrantRole(rank, roleToRemove.id)) {
      showComposerNotice("Mods can only remove Normie.");
      return true;
    }
    const target = await resolveModerationTarget(parts.slice(2).join(" "), { allowOfflineId: true });
    if (!guardModerationTarget(target, "remove a rank from")) return true;
    try {
      await ChatBackend.removeRoleFromId(roleToRemove.id, target.loginId);
      showComposerNotice("Removed " + roleToRemove.label + " from " + target.name + ".");
    } catch (e) {
      showComposerNotice(isPermissionDenied(e)
        ? rankByHandNotice(roleToRemove)
        : "Couldn't remove " + roleToRemove.label + ": " + (e && e.message ? e.message : "check your connection") + ".");
    }
    return true;
  }

  // ── /grant rank perm|time username ──
  if (command === "/grant") {
    if (parts.length < 3) {
      showComposerNotice("Use /grant rank perm username, or /grant rank 2h username (" + limitsText(TIME_LIMITS.tempGrant) + ").");
      return true;
    }
    const roleToGrant = ROLES[parts[1].toLowerCase()];
    if (!roleToGrant || roleToGrant.implicit || roleToGrant.id === "crown") {
      showComposerNotice("Rank must be one of: normie, mod, admin, coowner.");
      return true;
    }
    // You can only hand out ranks strictly below your own.
    if (roleToGrant.rank >= rank) {
      showComposerNotice("You can only grant ranks below your own.");
      return true;
    }
    if (!canGrantRole(rank, roleToGrant.id)) {
      showComposerNotice("Mods can only give Normie.");
      return true;
    }
    // Third word is "perm" or a time only when a name follows it, so someone
    // literally named "Perm" (or "10m") can still be granted a rank.
    const word = (parts[2] || "").toLowerCase();
    let permanent = true;
    let durationMs = 0;
    let nameParts = parts.slice(2);
    if (parts.length >= 4 && PERMANENT_WORDS.has(word)) {
      nameParts = parts.slice(3);
    } else if (parts.length >= 4 && parseModerationDuration(parts[2]) > 0) {
      permanent = false;
      durationMs = parseModerationDuration(parts[2]);
      const problem = checkDurationLimits(durationMs, TIME_LIMITS.tempGrant);
      if (problem) { showComposerNotice(problem); return true; }
      nameParts = parts.slice(3);
    } else if (parts.length >= 4 && /^[0-9]+(\.[0-9]+)?[smhdw]?$/i.test(parts[2])) {
      // Looks like a time but didn't parse to anything usable.
      showComposerNotice(checkDurationLimits(0, TIME_LIMITS.tempGrant));
      return true;
    }
    const target = await resolveModerationTarget(nameParts.join(" "), { allowOfflineId: true });
    if (!guardModerationTarget(target, "grant a rank to")) return true;

    const alreadyPermanent = roleIdRaw[roleToGrant.id] && roleIdRaw[roleToGrant.id][target.loginId] === true;
    if (alreadyPermanent) {
      showComposerNotice(target.name + " already has " + roleToGrant.label + " permanently.");
      return true;
    }
    try {
      if (permanent) {
        await ChatBackend.grantRoleToId(roleToGrant.id, target.loginId);
        showComposerNotice("Granted " + roleToGrant.label + " to " + target.name + " permanently.");
      } else {
        await ChatBackend.grantTemporaryRoleToId(roleToGrant.id, target.loginId, durationMs, myLoginId);
        showComposerNotice("Granted " + roleToGrant.label + " to " + target.name + " for " + formatDurationShort(durationMs) + ".");
      }
    } catch (e) {
      showComposerNotice(isPermissionDenied(e)
        ? rankByHandNotice(roleToGrant)
        : "Couldn't grant " + roleToGrant.label + ": " + (e && e.message ? e.message : "check your connection") + ".");
    }
    return true;
  }

  return true;
}

async function sendMessage() {
  const text = $msgInput.value.trim();

  // Moderation commands must run before timeout and send-cooldown guards so
  // an Owner/Admin can always issue them and receives a useful response.
  if (await handleModerationCommand(text)) {
    $msgInput.value = "";
    updateCharCounter();
    autosizeInput();
    return;
  }

  // Chatting but missing from the online list? Put them back.
  if (myLoginId && !latestPresenceList.some(e => String(e.loginId || "") === String(myLoginId))) ChatBackend.ensurePresence();
  if (!channelAllowedFor(activeChannel(), myLoginId)) { showComposerNotice("You can't post in this channel."); return; }
  if (myTimeoutRemainingMs > 0) {
    showComposerNotice(mutedNotice());
    return;
  }
  if (activeChannelId === "announce") {
    if (editingMsgId) { cancelEdit(); showComposerNotice("Announcements can't be edited."); return; }
    await sendAnnouncement(text);
    return;
  }
  const segs = composerSegments(text);
  const silentText = segs.length ? markText(text, segs, new Set()) : text;
  if (editingMsgId) { await commitEdit(silentText); return; }
  // Text and images each respect their own per-rank delay. Tell the person how
  // long is left instead of silently swallowing the Enter key.
  const textWait = currentMessageCooldownMs() - (Date.now() - lastSentAt);
  if (!pendingImageDataUrl && textWait > 0) {
    showComposerNotice("Slow down — wait " + Math.ceil(textWait / 1000) + "s before sending again (your rank's delay is " + Math.round(currentMessageCooldownMs() / 1000) + "s).");
    return;
  }

  if (pendingVideo) {
    if (!canPostImages()) { clearPendingImage(); showComposerNotice("You don't have image/video access. Ask an Admin or higher."); return; }
    const vWait = currentImageCooldownMs() - (Date.now() - lastImageSentAt);
    if (vWait > 0) { showComposerNotice("Images and videos have a " + Math.round(currentImageCooldownMs() / 1000) + "s delay for your rank — wait " + Math.ceil(vWait / 1000) + "s."); return; }
    const pv = pendingVideo;
    const lbl = document.getElementById("chatPendingLabel");
    pendingVideo = null;
    $sendBtn.disabled = true; $uploadImageBtn.disabled = true;
    lastSentAt = Date.now(); lastImageSentAt = Date.now();
    stopTyping();
    ChatBackend.sendVideo(myName, pv.file, pv.dur, myLoginId, p => { lbl.textContent = "Uploading video… " + Math.round(p * 100) + "%"; }, text ? silentText : "", currentReplyPayload())
      .then(() => { clearPendingImage(); })
      .then(() => { cancelReply(); $msgInput.value = ""; autosizeInput(); updateCharCounter(); autoScroll = true; setAutoScrollUI(); })
      .catch(() => { clearPendingImage(); $connError.textContent = "Video failed to send — check your connection (or the clip may be too large)."; $connError.style.display = "block"; })
      .finally(() => { $sendBtn.disabled = false; $uploadImageBtn.disabled = false; updateSendButtonState(); $msgInput.focus(); });
    return;
  }

  if (pendingImageDataUrl) {
    // Enforce, don't just hide the button: the pending image could have been
    // staged before access was revoked.
    if (!canPostImages()) {
      clearPendingImage();
      showComposerNotice("You don't have image access. Ask an Admin or higher.");
      return;
    }
    const imgWait = currentImageCooldownMs() - (Date.now() - lastImageSentAt);
    if (imgWait > 0) {
      showComposerNotice("Images have a " + Math.round(currentImageCooldownMs() / 1000) + "s delay for your rank — wait " + Math.ceil(imgWait / 1000) + "s.");
      return;
    }
    const imageToSend = pendingImageDataUrl;
    clearPendingImage();

    lastSentAt = Date.now();
    lastImageSentAt = Date.now();
    updateSendButtonState();
    stopTyping();

    ChatBackend.sendImage(myName, imageToSend, myLoginId, text ? silentText : "", currentReplyPayload())
      .then(() => {
        cancelReply();
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

  if (!text) return;
  if (!segs.length) { finalizeSend(text, null); return; }

  // Pings with sound keep the 30s-per-person limit; anything that can't ping goes out as a silent mention.
  const wantPing = [...new Set(segs.filter(sg => picked.get(sg.name)).map(sg => sg.name))];
  $sendBtn.disabled = true;
  (async () => {
    const ok = new Set(), held = [];
    for (const n of wantPing) {
      try {
        const r = await ChatBackend.tryStartAtPingCooldown(n);
        if (r.ok) ok.add(n); else held.push(n + " (" + Math.ceil(r.remainingMs / 1000) + "s)");
      } catch (e) { held.push(n); }
    }
    return { ok, held };
  })().then(({ ok, held }) => {
    $sendBtn.disabled = false;
    const out = markText(text, segs, ok);
    if (out.length > MAX_CHARS) { showComposerNotice("That's too long once the mentions are counted \u2014 shorten it a little."); return; }
    if (held.length) showComposerNotice("Sent as a silent mention (just pinged): " + held.join(", "));
    finalizeSend(out, { name: segs[0].name, silent: !ok.has(segs[0].name) });
  });
}

function currentReplyPayload() {
  return replyingTo ? { id: String(replyingTo.id).slice(0, 40), name: String(replyingTo.name || "").slice(0, 40), text: String(replyingTo.text || "").slice(0, 100) } : null;
}
function finalizeSend(text, mention) {
  lastSentAt = Date.now();
  updateSendButtonState();
  stopTyping();

  ChatBackend.send(myName, text, mention, myLoginId, currentReplyPayload())
    .then(() => {
      if (activeChannelId !== "announce") crateCountMessage();
      cancelReply();
      $msgInput.value = "";
      clearMention();
      autosizeInput();
      updateCharCounter();
      scrollToBottom();   // your own message always scrolls into view
    })
    .catch(error => {
      $connError.textContent = "Message failed to send — check your connection.";
      $connError.style.display = "block";
    })
    .finally(() => { $msgInput.focus(); });
}

let composerNoticeTimer = null;
function showComposerNotice(text) {
  $composerNotice.textContent = text;
  $composerNotice.style.display = "block";
  clearTimeout(composerNoticeTimer);
  composerNoticeTimer = setTimeout(() => {
    $composerNotice.style.display = "none";
  }, 4000);
}

function autosizeInput() {
  $msgInput.style.height = "auto";
  $msgInput.style.height = Math.min($msgInput.scrollHeight, 135) + "px";
}

const MAX_IMAGE_SOURCE_BYTES = 15 * 1024 * 1024;
const IMAGE_MAX_DIMENSION = 1000;
const IMAGE_JPEG_QUALITY = 0.7;

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read file"));
    reader.onload = () => {
      img.onerror = () => reject(new Error("Couldn't decode image"));
      img.onload = () => {
        let { width, height } = img;
        if (width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION) {
          const scale = IMAGE_MAX_DIMENSION / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

let pendingImageDataUrl = null;

let pendingVideo = null;   // { file, dur }
function clearPendingImage() {
  pendingImageDataUrl = null;
  pendingVideo = null;
  $pendingImageBar.style.display = "none";
  $pendingImagePreview.src = "";
  const lbl = document.getElementById("chatPendingLabel"); if (lbl) lbl.textContent = "Image ready — click Send to post it";
}
function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
// Reads a video's length and a poster frame without uploading anything.
function probeVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata"; v.muted = true; v.playsInline = true;
    const fail = (m) => { URL.revokeObjectURL(url); reject(new Error(m)); };
    const t = setTimeout(() => fail("timeout"), 15000);
    const grab = () => {
      let poster = "";
      try {
        const cv = document.createElement("canvas"); const w = 160, ratio = (v.videoHeight || 90) / (v.videoWidth || 160);
        cv.width = w; cv.height = Math.max(1, Math.round(w * ratio));
        cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height); poster = cv.toDataURL("image/jpeg", 0.6);
      } catch (e) {}
      clearTimeout(t); URL.revokeObjectURL(url); resolve({ dur: v.duration, poster });
    };
    v.onerror = () => fail("unplayable");
    v.onloadedmetadata = () => {
      if (!isFinite(v.duration)) { v.currentTime = 1e9; v.ontimeupdate = () => { v.ontimeupdate = null; v.currentTime = 0; }; v.onseeked = () => { v.onseeked = null; v.currentTime = 0.05; v.onseeked = grab; }; }
      else { v.onseeked = grab; v.currentTime = Math.min(0.1, v.duration / 2); }
    };
    v.src = url;
  });
}
async function stageVideoFile(file) {
  const note = (m) => { $connError.textContent = m; $connError.style.display = "block"; };
  if (file.size > VIDEO_MAX_BYTES) { note("That video is " + fmtBytes(file.size) + ". The chat can hold clips up to " + fmtBytes(VIDEO_MAX_BYTES) + " (about 3 minutes of lower-quality video)."); return; }
  $uploadImageBtn.disabled = true; $uploadImageBtn.textContent = "Checking…";
  try {
    const info = await probeVideo(file);
    if (info.dur > VIDEO_MAX_SECONDS + 0.5) { note("Videos can be at most " + VIDEO_MAX_SECONDS + " seconds. This one is " + Math.round(info.dur) + "s."); return; }
    pendingImageDataUrl = null;
    pendingVideo = { file, dur: info.dur };
    $pendingImagePreview.src = info.poster || "";
    document.getElementById("chatPendingLabel").textContent = "Video ready (" + Math.round(info.dur) + "s, " + fmtBytes(file.size) + ") — click Send. It disappears 4 minutes after posting.";
    $pendingImageBar.style.display = "flex";
  } catch (e) { note("Couldn't read that video — try an MP4 or WebM."); }
  finally { $uploadImageBtn.disabled = false; $uploadImageBtn.textContent = "\uD83D\uDCCE Image / video"; $imageFileInput.value = ""; }
}

function stageImageFile(file) {
  if (!canPostImages()) return;

  if (!file) return;
  if (/^video\//.test(file.type)) { stageVideoFile(file); return; }
  if (!file.type.startsWith("image/")) {
    $connError.textContent = "That file isn't an image.";
    $connError.style.display = "block";
    return;
  }
  if (file.size > MAX_IMAGE_SOURCE_BYTES) {
    $connError.textContent = "Image is too large.";
    $connError.style.display = "block";
    return;
  }

  $uploadImageBtn.disabled = true;
  $uploadImageBtn.textContent = "Processing…";

  compressImageFile(file)
    .then(dataUrl => {
      pendingImageDataUrl = dataUrl;
      $pendingImagePreview.src = dataUrl;
      $pendingImageBar.style.display = "flex";
    })
    .catch(() => {
      $connError.textContent = "Couldn't process that image — try another.";
      $connError.style.display = "block";
    })
    .finally(() => {
      $uploadImageBtn.disabled = false;
      $uploadImageBtn.textContent = "\uD83D\uDCCE Image / video";
      $imageFileInput.value = "";
    });
}

$cancelPendingImageBtn.addEventListener("click", clearPendingImage);

$uploadImageBtn.addEventListener("click", () => {
  if (!canPostImages()) return;
  $imageFileInput.click();
});
$imageFileInput.addEventListener("change", () => {
  const file = $imageFileInput.files[0];
  stageImageFile(file);
});

function updateCharCounter() {
  const remaining = MAX_CHARS - $msgInput.value.length - composerSegments($msgInput.value).length;
  $charCounter.textContent = remaining;
  $charCounter.classList.toggle("warn", remaining <= 50 && remaining > 10);
  $charCounter.classList.toggle("limit", remaining <= 10);
}

function setAutoScrollUI() {
  $autoScrollBtn.textContent = "Auto Scroll: " + (autoScroll ? "On" : "Off");
  $autoScrollBtn.classList.toggle("active", autoScroll);
  if (autoScroll) scrollToBottom();
}
function setAutoScroll(on) {
  autoScroll = !!on;
  chatPrefs.autoScroll = autoScroll;
  saveChatPrefs();
  setAutoScrollUI();
}
$autoScrollBtn.addEventListener("click", () => setAutoScroll(!autoScroll));

$messages.addEventListener("scroll", () => {
  const away = $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight;
  if (Date.now() > programmaticScrollUntil) stickToBottom = away < 40;   // only the person's own scrolling unpins
  if (away < 40) $jumpToBottomBtn.style.display = "none";
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

let imagesEnabledForMe = false; // mirrors userProfiles/{myId}.imageAccess, live

/* SETTINGS PANEL ACCESS IS BY RANK -- there is no unlock code any more.
   Everyone can open it; each section only shows if your rank allows it. */
const COLOR_MIN_RANK = ROLES.normie.rank;  // custom bubble colors: Normie and up
const IDS_MIN_RANK   = ROLES.mod.rank;     // seeing other people's account IDs: Mod and up

/* IMAGE ACCESS
   Normie and below can never get images on their own. Only a higher-up can
   switch image access on for them (per account ID, persistent across leaving
   and rejoining). Mod and above can always post images. */
function canPostImages() {
  if (!myLoginId) return false;
  if (myRank() > IMAGE_GATED_MAX_RANK) return true;
  return imagesEnabledForMe === true && imageAttested(myLoginId);
}

function updateUploadButtonVisibility() {
  const may = canPostImages() && activeChannelId !== "announce";
  $uploadImageBtn.style.display = may ? "inline-block" : "none";
  if (!may) clearPendingImage();
}

function leaveSilently() {
  const dmSession = loadDmSession();
  ChatBackend.releasePresenceSilently();
  stopTyping();
  clearPendingImage();
  myName = "";
  myLoginId = "";
  $changeNameBtn.style.display = "none";
  $youAre.textContent = "";
  closeClearPanel();
  $chatScreen.style.display = "none";
  if (dmSession) renderRejoinPrompt(dmSession, "You left the chat quietly. Rejoin whenever you like.");
  else renderDmLoginPrompt();
}

function renderPreCodeActions(container) {
  if (myName) {
    const leaveBtn = document.createElement("button");
    leaveBtn.textContent = "Leave Silently";
    leaveBtn.className = "toolbar-btn";
    leaveBtn.style.cssText = "width:100%;margin-bottom:8px";
    leaveBtn.addEventListener("click", leaveSilently);
    container.appendChild(leaveBtn);
  }

  const divider = document.createElement("div");
  divider.style.cssText = "height:1px;background:#334155;margin:2px 0 10px 0";
  container.appendChild(divider);
}

// ── Chat settings: everything that used to sit in the toolbar ──
function renderChatSettings(container) {
  const wrap = document.createElement("div");
  wrap.className = "chat-settings";
  const title = document.createElement("div");
  title.className = "cs-title";
  title.textContent = "Chat settings";
  wrap.appendChild(title);

  // Each group is its own rounded card; the helpers below add to whichever card is current.
  let host = wrap;
  const card = (icon, name, hint, id) => {
    const el = document.createElement("section");
    el.className = "cs-card";
    if (id) el.id = id;
    const head = document.createElement("div");
    head.className = "cs-card-head";
    const ic = document.createElement("span"); ic.className = "cs-card-icon"; ic.textContent = icon;
    const tx = document.createElement("span"); tx.className = "cs-card-text";
    const nm = document.createElement("b"); nm.textContent = name; tx.appendChild(nm);
    if (hint) { const h = document.createElement("small"); h.textContent = hint; tx.appendChild(h); }
    head.append(ic, tx); el.appendChild(head);
    wrap.appendChild(el);
    host = el;
    return el;
  };

  const toggle = (label, hint, isOn, onChange) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cs-row";
    const text = document.createElement("span");
    text.className = "cs-label";
    text.textContent = label;
    if (hint) { const h = document.createElement("small"); h.textContent = hint; text.appendChild(h); }
    const sw = document.createElement("span");
    sw.className = "cs-switch" + (isOn() ? " on" : "");
    row.append(text, sw);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      onChange(!isOn());
      sw.classList.toggle("on", isOn());
    });
    host.appendChild(row);
  };

  card("\uD83D\uDCAC", "Chat", "How the conversation behaves");
  toggle("Auto scroll", "Keeps the newest message in view", () => autoScroll, v => setAutoScroll(v));
  toggle("Verified tag", "Show the green \u201cVerified\u201d tag next to verified people", () => chatPrefs.showVerified !== false, v => {
    chatPrefs.showVerified = v; saveChatPrefs(); applyAppearance();
  });
  toggle("Auto-download videos", "Videos over " + VIDEO_AUTO_SECONDS + " seconds wait for a click unless this is on. Short ones always load by themselves.", () => chatPrefs.autoVideo === true, v => { chatPrefs.autoVideo = v; saveChatPrefs(); });
  toggle("Announcements", "Pop-ups for new announcements, wherever you are. The \ud83d\udce2 server still shows them when off.", () => chatPrefs.announcements !== false, v => { chatPrefs.announcements = v; saveChatPrefs(); });
  toggle("Auto AFK", "Shows a yellow dot after 2 minutes without clicking or messaging", () => chatPrefs.autoAfk !== false, v => { chatPrefs.autoAfk = v; saveChatPrefs(); afkCheck(true); });
  toggle("Show join / leave", "\u201cX joined\u201d and \u201cX left\u201d lines", () => chatPrefs.showJoinLeave !== false, v => {
    chatPrefs.showJoinLeave = v;
    saveChatPrefs();
    document.body.classList.toggle("hide-joinleave", !v);
    if (autoScroll && stickToBottom) scrollToBottom();
  });

  const choice = (label, options, get, set) => {
    const row = document.createElement("div");
    row.className = "cs-choice";
    const lab = document.createElement("span");
    lab.className = "cs-label";
    lab.textContent = label;
    const seg = document.createElement("span");
    seg.className = "cs-seg";
    options.forEach(([val, text]) => {
      const bt = document.createElement("button");
      bt.type = "button";
      bt.textContent = text;
      bt.className = get() === val ? "on" : "";
      bt.addEventListener("click", (e) => {
        e.stopPropagation();
        set(val);
        seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === bt));
      });
      seg.appendChild(bt);
    });
    row.append(lab, seg);
    host.appendChild(row);
  };
  card("\uD83D\uDD14", "Notifications", "What gets your attention", "csNotifSection");
  NOTIF_TYPES.forEach(([type, key, label, hint]) => toggle(label, hint, () => chatPrefs[key] !== false, v => { chatPrefs[key] = v; saveChatPrefs(); }));
  card("\uD83D\uDEE1\uFE0F", "Safety", "Filters and staff-action checks");
  toggle("Peer verification", verifyFlagOn ? "Checks that bans, mutes and grants come from someone allowed to do them" : "Off in this room until the Owner runs /verify on", () => chatPrefs.peerVerify !== false, v => {
    chatPrefs.peerVerify = v; saveChatPrefs(); scheduleVerifyRefresh();
  });
  toggle("Chat filter", "Stars out banned words (w**d). On for everyone by default; turn off to see them. Remembered on this device.", () => chatPrefs.wordFilter !== false, v => {
    chatPrefs.wordFilter = v; saveChatPrefs(); refreshFilteredText();
  });
  { const r = document.createElement("button"); r.type = "button"; r.className = "cs-row"; r.innerHTML = '<span class="cs-label">Open Verification panel<small>See who is verified and what was approved or rejected</small></span>'; r.addEventListener("click", e => { e.stopPropagation(); openFromSettings(openVerifyPanel); }); host.appendChild(r); }
  const persCard = card("\uD83C\uDFA8", "Personalization", "Looks and background, saved on this device only");
  choice("Text size", [["s", "Small"], ["m", "Medium"], ["l", "Large"], ["xl", "Huge"]], () => chatPrefs.textSize, v => { chatPrefs.textSize = v; saveChatPrefs(); applyAppearance(); keepPinned(); });
  choice("Bubble size", [["compact", "Compact"], ["normal", "Normal"], ["roomy", "Roomy"]], () => chatPrefs.bubbleSize, v => { chatPrefs.bubbleSize = v; saveChatPrefs(); applyAppearance(); keepPinned(); });
  toggle("Bold text", "Easier to read", () => !!chatPrefs.bold, v => { chatPrefs.bold = v; saveChatPrefs(); applyAppearance(); keepPinned(); });
  {
    const row = document.createElement("div");
    row.className = "cs-choice cs-slider";
    const lab = document.createElement("span"); lab.className = "cs-label"; lab.textContent = "Bubble radius";
    const val = document.createElement("span"); val.className = "cs-slider-val";
    const rng = document.createElement("input");
    rng.type = "range"; rng.min = "0"; rng.max = "28"; rng.step = "1";
    rng.value = String(Number.isFinite(Number(chatPrefs.radius)) ? Number(chatPrefs.radius) : 12);
    val.textContent = rng.value + "px";
    rng.addEventListener("input", () => { chatPrefs.radius = Number(rng.value); val.textContent = rng.value + "px"; saveChatPrefs(); applyAppearance(); });
    row.append(lab, rng, val);
    host.appendChild(row);
  }
  renderBackgroundControls(host, choice);
  card("\uD83E\uDDF0", "Tools", "Quick actions");

  const action = (label, onClick, danger) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cs-action" + (danger ? " danger" : "");
    b.textContent = label;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(b); });
    host.appendChild(b);
    return b;
  };
  const rem = getPingYouRemainingMs();
  const pingBtn = action(rem > 0 ? "\uD83D\uDD14 Ping Devs (" + Math.ceil(rem / 1000) + "s)" : "\uD83D\uDD14 Ping Devs", () => {
    if (getPingYouRemainingMs() > 0) return;
    closeClearPanel();
    $pingYouBtn.click();
  });
  if (rem > 0) pingBtn.disabled = true;
  action("\uD83D\uDD04 Check for updates", b => manualUpdateCheck(b));
  action("Clear chat on my screen", () => { $clearChatBtn.click(); closeClearPanel(); }, true);
  wrap.insertBefore(persCard, title.nextSibling);   // looks first

  container.appendChild(wrap);
}

function renderBackgroundControls(wrap, choice) {
  const box = document.createElement("div");
  box.className = "cs-bg";
  wrap.appendChild(box);
  const draw = () => {
    box.textContent = "";
    const modes = [["default", "Default"], ["dark", "Dark"], ["light", "Light"], ["color", "Color"], ["link", "Link"], ["file", "File"]];
    const head = document.createElement("div");
    head.className = "cs-choice cs-choice-stack";
    const lab = document.createElement("span"); lab.className = "cs-label"; lab.textContent = "Background";
    const hint = document.createElement("small"); hint.textContent = "Chat and DMs, on this device only"; lab.appendChild(hint);
    const seg = document.createElement("span"); seg.className = "cs-seg";
    modes.forEach(([val, text]) => {
      const bt = document.createElement("button");
      bt.type = "button"; bt.textContent = text; bt.className = (chatPrefs.bgMode || "default") === val ? "on" : "";
      bt.addEventListener("click", e => { e.stopPropagation(); chatPrefs.bgMode = val; saveChatPrefs(); applyAppearance(); draw(); });
      seg.appendChild(bt);
    });
    head.append(lab, seg);
    box.appendChild(head);
    const mode = chatPrefs.bgMode || "default";
    const note = (t, bad) => { const n = document.createElement("div"); n.className = "cs-bg-note" + (bad ? " bad" : ""); n.textContent = t; box.appendChild(n); return n; };
    if (mode === "color") {
      const row = document.createElement("div"); row.className = "cs-bg-row";
      const pick = document.createElement("input"); pick.type = "color";
      pick.value = /^#[0-9a-fA-F]{6}$/.test(chatPrefs.bgColor) ? chatPrefs.bgColor : "#0f172a";
      pick.addEventListener("input", () => { chatPrefs.bgColor = pick.value; saveChatPrefs(); applyAppearance(); });
      const t = document.createElement("span"); t.textContent = "Pick any colour";
      row.append(pick, t); box.appendChild(row);
    } else if (mode === "link") {
      const row = document.createElement("div"); row.className = "cs-bg-row";
      const inp = document.createElement("input"); inp.type = "text"; inp.placeholder = "https://\u2026 image link"; inp.value = chatPrefs.bgLink || ""; inp.maxLength = 1500;
      const go = document.createElement("button"); go.type = "button"; go.textContent = "Apply";
      const apply = () => {
        const ok = safeBgUrl(inp.value);
        if (!ok) { msg.textContent = inp.value.trim() ? "That doesn't look like a normal https image link." : "Paste an image link first."; msg.classList.add("bad"); return; }
        chatPrefs.bgLink = ok; saveChatPrefs(); applyAppearance(); msg.textContent = "Applied."; msg.classList.remove("bad");
      };
      go.addEventListener("click", e => { e.stopPropagation(); apply(); });
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
      row.append(inp, go); box.appendChild(row);
      var msg = note("");
    } else if (mode === "file") {
      const row = document.createElement("div"); row.className = "cs-bg-row";
      const file = document.createElement("input"); file.type = "file"; file.accept = "image/*";
      const rm = document.createElement("button"); rm.type = "button"; rm.textContent = "Remove";
      rm.addEventListener("click", e => { e.stopPropagation(); chatPrefs.bgFile = ""; saveChatPrefs(); applyAppearance(); draw(); });
      row.append(file); if (chatPrefs.bgFile) row.append(rm); box.appendChild(row);
      var fmsg = note(chatPrefs.bgFile ? "Image set." : "Choose a picture from your device. It is shrunk to fit and kept only on this device.");
      file.addEventListener("change", async () => {
        const f = file.files && file.files[0]; if (!f) return;
        if (!f.type.startsWith("image/")) { fmsg.textContent = "That isn't an image."; fmsg.classList.add("bad"); return; }
        try {
          const url = await shrinkBackground(f);
          chatPrefs.bgFile = url; saveChatPrefs(); applyAppearance();
          fmsg.textContent = "Image set."; fmsg.classList.remove("bad");
          if (!rm.isConnected) row.append(rm);
        } catch (e) { fmsg.textContent = "Couldn't use that image."; fmsg.classList.add("bad"); }
      });
    }
  };
  draw();
}
function shrinkBackground(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const max = 1600, s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.src = url;
  });
}

async function renderModMenu() {
  $globalClearPanel.innerHTML = "";
  $globalClearPanel.style.width = "260px";

  renderChatSettings($globalClearPanel);
  renderPreCodeActions($globalClearPanel);

  const showColor = myRank() >= COLOR_MIN_RANK;
  // Your colors live in their own card at the very top of Settings.
  const colorHost = document.createElement("section");
  colorHost.className = "cs-card cs-colors";
  { const head = document.createElement("div"); head.className = "cs-card-head";
    head.innerHTML = '<span class="cs-card-icon">\uD83C\uDF08</span><span class="cs-card-text"><b>Your colors</b><small>Bubble, text and profile ring \u2014 everyone sees these</small></span>';
    colorHost.appendChild(head); }
  { const csWrap = $globalClearPanel.querySelector(".chat-settings"); if (csWrap) csWrap.insertBefore(colorHost, csWrap.querySelector(".cs-title").nextSibling); else $globalClearPanel.appendChild(colorHost); }
  if (!showColor) {
    const lockedColor = document.createElement("div");
    lockedColor.textContent = "Bubble colors unlock at " + ROLES.normie.icon + " " + ROLES.normie.label + ".";
    lockedColor.style.cssText = "color:#64748b;font-size:12.5px;line-height:1.4;margin-bottom:6px";
    colorHost.appendChild(lockedColor);
  }
  if (showColor) {
  const loading = document.createElement("div");
  loading.textContent = "Loading…";
  loading.style.cssText = "color:#64748b;font-size:14px";
  colorHost.appendChild(loading);

  let existing = null;
  try {
    existing = myLoginId ? await ChatBackend.getNameColor(myLoginId) : null;
  } catch (e) { /* treat as no existing color if the check fails */ }

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
  colorHost.appendChild(previewWrap);

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

  colorHost.appendChild(
    makeColorRow("Bubble color", pendingBubble, (val) => {
      pendingBubble = val;
      previewBubble.style.background = val;
    })
  );
  colorHost.appendChild(
    makeColorRow("Text color", pendingText, (val) => {
      pendingText = val;
      previewBubble.style.color = val;
    })
  );

  let pendingRing = (existing && existing.ring) || "";
  const ringRow = document.createElement("div");
  ringRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px";
  const ringLbl = document.createElement("label"); ringLbl.textContent = "Profile ring"; ringLbl.style.color = "#94a3b8";
  const ringBox = document.createElement("span"); ringBox.style.cssText = "display:flex;align-items:center;gap:8px";
  const ringOn = document.createElement("input"); ringOn.type = "checkbox"; ringOn.checked = !!pendingRing; ringOn.title = "Show a ring around your picture";
  const ringInput = document.createElement("input"); ringInput.type = "color"; ringInput.value = pendingRing || "#22c55e";
  ringInput.style.cssText = "width:36px;height:28px;border:none;background:none;cursor:pointer;padding:0";
  const ringPrev = document.createElement("span"); ringPrev.className = "ring-preview";
  const paintRing = () => { pendingRing = ringOn.checked ? ringInput.value : ""; ringPrev.style.boxShadow = pendingRing ? "0 0 0 3px " + pendingRing : "none"; };
  ringOn.addEventListener("change", paintRing); ringInput.addEventListener("input", () => { ringOn.checked = true; paintRing(); });
  paintRing();
  ringBox.append(ringPrev, ringOn, ringInput); ringRow.append(ringLbl, ringBox);
  { const rn = document.createElement('div'); rn.style.cssText = 'color:#94a3b8;font-size:12.5px;line-height:1.4;margin-bottom:8px'; rn.textContent = '\uD83D\uDCE6 Profile rings, tags and text effects now come from crates (the crate button on the left).'; colorHost.appendChild(rn); }

  const note = document.createElement("div");
  note.textContent = "Note: color can be changed again every " + Math.round(COLOR_CHANGE_COOLDOWN_MS / 1000) + " seconds.";
  note.style.cssText = "color:#64748b;font-size:12.5px;margin-bottom:10px;line-height:1.4";
  colorHost.appendChild(note);

  const confirmErr = document.createElement("div");
  confirmErr.style.cssText = "color:#ef4444;font-size:13px;min-height:16px;margin-bottom:4px";
  colorHost.appendChild(confirmErr);

  const confirmBtn = document.createElement("button");
  confirmBtn.textContent = "Confirm";
  confirmBtn.className = "toolbar-btn";
  confirmBtn.style.cssText = "width:100%;margin-top:4px";
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Saving…";
    try {
      const result = await ChatBackend.claimColor(myLoginId, pendingBubble, pendingText, pendingRing);
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
  colorHost.appendChild(confirmBtn);
  } // end showColor

  const divider = document.createElement("div");
  divider.style.cssText = "height:1px;background:#334155;margin:12px 0";
  $globalClearPanel.appendChild(divider);

  const imgTitle = document.createElement("div");
  imgTitle.textContent = "Images";
  imgTitle.style.cssText = "color:#f1f5f9;font-weight:600;margin-bottom:8px";
  $globalClearPanel.appendChild(imgTitle);

  const imgStatus = document.createElement("div");
  imgStatus.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px";
  const imgLabel = document.createElement("span");
  imgLabel.textContent = "Image access";
  imgLabel.style.color = "#94a3b8";
  const imgValue = document.createElement("span");
  imgValue.textContent = canPostImages() ? "On" : "Off";
  imgValue.style.cssText = "font-weight:700;color:" + (canPostImages() ? "#4ade80" : "#f87171");
  imgStatus.appendChild(imgLabel);
  imgStatus.appendChild(imgValue);
  $globalClearPanel.appendChild(imgStatus);

  const imgNote = document.createElement("div");
  const gated = myRank() <= IMAGE_GATED_MAX_RANK;
  imgNote.textContent = gated
    ? "Normie and below can't post images unless an Admin or higher turns it on for your account. It stays on across leaving and rejoining."
    : "Your rank can always post images. Delay: " + Math.round(currentImageCooldownMs() / 1000) + "s.";
  imgNote.style.cssText = "color:#64748b;font-size:12px;line-height:1.4;margin-bottom:4px";
  $globalClearPanel.appendChild(imgNote);

  const myRankLine = document.createElement("div");
  const myRoleObj = ROLES[myRoleId()];
  myRankLine.textContent = "Your rank: " + myRoleObj.icon + " " + myRoleObj.label + " · message delay " + Math.round(currentMessageCooldownMs() / 1000) + "s";
  myRankLine.style.cssText = "color:#94a3b8;font-size:12.5px;margin-top:8px";
  $globalClearPanel.appendChild(myRankLine);

  // Your own account ID (only you see it here; it is not shown on the main screen).
  const idRow = document.createElement("div");
  idRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px";
  const idLabel = document.createElement("span");
  idLabel.textContent = "Your account ID";
  idLabel.style.cssText = "color:#94a3b8;font-size:12.5px";
  const idBtn = document.createElement("button");
  idBtn.className = "toolbar-btn";
  idBtn.style.cssText = "padding:4px 10px;font-family:monospace";
  idBtn.textContent = "#" + (myLoginId || "");
  idBtn.title = "Tap to copy";
  idBtn.addEventListener("click", () => {
    const done = () => { idBtn.textContent = "Copied"; setTimeout(() => { idBtn.textContent = "#" + (myLoginId || ""); }, 1200); };
    try { navigator.clipboard.writeText(String(myLoginId || "")).then(done, () => {}); } catch (e) {}
  });
  idRow.appendChild(idLabel);
  idRow.appendChild(idBtn);
  $globalClearPanel.appendChild(idRow);

  const rolesDivider = document.createElement("div");
  rolesDivider.style.cssText = "height:1px;background:#334155;margin:12px 0";
  $globalClearPanel.appendChild(rolesDivider);

  // One staff menu per person, chosen by their highest rank. Checked fresh on
  // every render, so it appears/disappears the moment a rank changes.
  const rank = myRank();
  const addPanelButton = (label, handler) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.className = "toolbar-btn";
    btn.style.cssText = "width:100%;margin-bottom:6px";
    btn.addEventListener("click", handler);
    $globalClearPanel.appendChild(btn);
  };
  addPanelButton("\uD83D\uDCD6 Rank guide", () => openFromSettings(openRankGuide));
  if (rank >= ROSTER_MIN_RANK)       addPanelButton("\uD83D\uDC65 Rank roster", () => openFromSettings(openRoster));
  if (rank >= ROLES.crown.rank)      addPanelButton("👑 Owner Menu", () => openFromSettings(openOwnerMenu));
  else if (rank >= ROLES.admin.rank) addPanelButton("🛡️ Admin Menu", () => openFromSettings(openAdminMenuStaff));
  else if (rank >= ROLES.mod.rank)   addPanelButton("🧩 Mod Menu", () => openFromSettings(openModMenuStaff));

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.className = "toolbar-btn";
  closeBtn.style.cssText = "width:100%;margin-top:6px";
  closeBtn.addEventListener("click", closeClearPanel);
  $globalClearPanel.appendChild(closeBtn);
}

// Re-renders whichever view of the settings panel is appropriate right now.
function renderSettingsPanel() {
  renderModMenu();
}

/* ── Back buttons: every menu opened from Settings can step back instead of dropping you on the main screen ── */
const navStack = [];                    // what "Back" does, innermost last
function reopenSettings() { if (window.VUS_UI && window.VUS_UI.openSettings) window.VUS_UI.openSettings("chat"); }
function reopenStaffMenu() { if (staffMenuMode === "owner") openOwnerMenu(); else if (staffMenuMode === "admin") openAdminMenuStaff(); else openModMenuStaff(); }
function openFromSettings(openFn) {
  navStack.length = 0;
  navStack.push(reopenSettings);
  closeClearPanel();
  openFn();
}
const navOverlays = [];
function installBackButton(ov, closeFn) {
  if (!ov || ov.dataset.backInstalled) return;
  ov.dataset.backInstalled = "1";
  const modal = ov.querySelector(".chat-modal");
  if (!modal) return;
  const b = document.createElement("button");
  b.type = "button"; b.className = "modal-back"; b.textContent = "\u2039 Back"; b.style.display = "none";
  modal.insertBefore(b, modal.firstChild);
  let open = ov.style.display === "flex";
  b.addEventListener("click", () => { const go = navStack.pop(); closeFn(); if (go) go(); });
  navOverlays.push(ov);
  new MutationObserver(() => {
    const now = ov.style.display === "flex";
    if (now && !open) b.style.display = navStack.length ? "" : "none";
    if (!now && open) {
      b.style.display = "none";
      setTimeout(() => { if (!navOverlays.some(o => o.style.display === "flex")) navStack.length = 0; }, 0);
    }
    open = now;
  }).observe(ov, { attributes: true, attributeFilter: ["style"] });
}

function closeClearPanel() {
  $globalClearPanel.style.display = "none";
  $settingsBtn.classList.remove("open");
  if (window.VUS_UI && window.VUS_UI.closeSettings) window.VUS_UI.closeSettings();
}
// The chat panel now lives in the shared Settings window (Chat tab).
window.addEventListener("vus:settings-tab", ev => {
  if (ev.detail && ev.detail.tab === "chat") {
    closeOnlineListPanel(); closeCommandList(); closeMentionDropdown(); closePingYouPanel();
    $globalClearPanel.style.display = "block";
    $settingsBtn.classList.add("open");
    renderModMenu();
  } else {
    $globalClearPanel.style.display = "none";
    $settingsBtn.classList.remove("open");
  }
});
window.addEventListener("vus:settings-closed", () => {
  $globalClearPanel.style.display = "none";
  $settingsBtn.classList.remove("open");
});

function openModMenu() {
  if (window.VUS_UI && window.VUS_UI.openSettings) window.VUS_UI.openSettings("chat");
}

/* ══════════════════════════════════════════════════════════
   STAFF MENU — one shared modal backing both the crown-only Owner Menu
   (full power: any duration up to 3:00, Grant/Remove Mod, clear anyone's
   timeout) and the mod-only Mod Menu (limited: timeout only, capped at
   0:40, defaults to 0:10, can only clear a timeout THEY set, and must
   wait MOD_RETIMEOUT_COOLDOWN_MS after setting/clearing before re-timing
   the same target out). `staffMenuMode` tracks which one is currently
   open so the shared rendering/submit logic can branch on it without
   duplicating the list/refresh machinery twice.
   Reuses latestPresenceList (already kept live by attachRoomListeners)
   rather than opening a second presence subscription — the 5s timer here
   just re-renders from whatever that list currently holds, plus a fresh
   per-person timeout-remaining read so stale timeouts don't linger in the
   list display.
   ══════════════════════════════════════════════════════════ */
const $ownerMenuOverlay = document.getElementById("ownerMenuOverlay");
const $ownerMenuTitle = document.getElementById("ownerMenuTitle");
const $ownerMenuSubtitle = document.getElementById("ownerMenuSubtitle");
const $ownerMenuCommands = document.getElementById("ownerMenuCommands");
const $ownerMenuList = document.getElementById("ownerMenuList");
const $ownerMenuCloseBtn = document.getElementById("ownerMenuCloseBtn");
const $ownerMenuRefreshBtn = document.getElementById("ownerMenuRefreshBtn");

const $timeoutSetOverlay = document.getElementById("timeoutSetOverlay");
const $timeoutSetTitle = document.getElementById("timeoutSetTitle");
const $timeoutSetNote = document.getElementById("timeoutSetNote");
const $timeoutMinutesInput = document.getElementById("timeoutMinutesInput");
const $timeoutSecondsInput = document.getElementById("timeoutSecondsInput");
const $timeoutSetErr = document.getElementById("timeoutSetErr");
const $timeoutSetCancelBtn = document.getElementById("timeoutSetCancelBtn");
const $timeoutReasonInput = document.getElementById("timeoutReasonInput");
const $timeoutSetConfirmBtn = document.getElementById("timeoutSetConfirmBtn");

const $grantModConfirmOverlay = document.getElementById("grantModConfirmOverlay");
const $grantModConfirmText = document.getElementById("grantModConfirmText");
const $grantModConfirmTitle = document.getElementById("grantModConfirmTitle");
const $grantModCancelBtn = document.getElementById("grantModCancelBtn");
const $grantModConfirmBtn = document.getElementById("grantModConfirmBtn");
const $banConfirmOverlay = document.getElementById("banConfirmOverlay");
const $banConfirmTitle = document.getElementById("banConfirmTitle");
const $banConfirmText = document.getElementById("banConfirmText");
const $banConfirmErr = document.getElementById("banConfirmErr");
const $banCancelBtn = document.getElementById("banCancelBtn");
const $banConfirmBtn = document.getElementById("banConfirmBtn");

let staffMenuMode = "owner"; // "owner" | "mod" — which gate/limits currently apply
let pendingTimeoutTarget = null;
let pendingTempBanTarget = null;   // set while the duration dialog is picking a TEMPORARY BAN length
let pendingTemporaryModTarget = null;
let pendingGrantModTarget = null;
let pendingBanTarget = null;
let pendingBanDurationMs = 0;

/* ── Role lookup ──
   Truth is ID-based: roleIdHolders[roleId] = Set of loginIds holding it.
   `roleHolders[roleId]` (Set of safe-keyed NAMES) is still maintained, derived
   from the ID sets, so older code that asks "does this name hold X?" keeps
   working -- see rebuildRoleHolders(). */
let roleIdHolders = {};      // roleId -> Set<loginId>
let roleIdRaw = {};          // roleId -> raw db value ({id: true | {temporary,expiresAt}}) so we can tell perm from temp
const nameToLoginId = () => {
  // Live presence wins (it's who is actually here under that name right now);
  // fall back to the last name each ID was seen using.
  const map = {};
  latestPresenceList.forEach(e => { if (e.loginId) map[ChatBackend._safeKey(e.name)] = String(e.loginId); });
  return map;
};

function rebuildRoleHolders() {
  if (typeof onRolesChangedForChannels === "function") setTimeout(onRolesChangedForChannels, 0);
  const n2i = nameToLoginId();
  const idToName = {};
  Object.entries(n2i).forEach(([safeName, id]) => { idToName[id] = safeName; });
  Object.values(ROLES).forEach(role => {
    const names = new Set();
    (roleIdHolders[role.id] || new Set()).forEach(id => { if (idToName[id] && roleAttested(role.id, id)) names.add(idToName[id]); });
    roleHolders[role.id] = names;
  });
}

function loginIdForName(name) {
  return name ? (nameToLoginId()[ChatBackend._safeKey(name)] || null) : null;
}
const PROTECTION_EMOJI = "⚕️";
let inventoryData = {}; // loginId -> { itemId: quantity }, kept live from the database
function isProtected(loginId) {
  return !!(loginId && Number((inventoryData[String(loginId)] || {}).protection) > 0);
}
function holdsRoleId(roleId, loginId) {
  return !!(loginId && (roleIdHolders[roleId] || new Set()).has(String(loginId)) && roleAttested(roleId, loginId));
}
function holdsRoleName(roleId, name) {
  return holdsRoleId(roleId, loginIdForName(name));
}
function rankOfLoginId(loginId) {
  let best = 0;
  Object.values(ROLES).forEach(role => { if (!role.implicit && holdsRoleId(role.id, loginId) && role.rank > best) best = role.rank; });
  return best;
}
function effectiveRoleForLoginId(loginId) {
  const rank = rankOfLoginId(loginId);
  return Object.values(ROLES).find(r => r.rank === rank).id;
}
function myRoleId() { return myLoginId ? effectiveRoleForLoginId(myLoginId) : "unranked"; }
function myRank() { return myLoginId ? rankOfLoginId(myLoginId) : 0; }

function isCrownHolder(name) { return holdsRoleName("crown", name); }
function isCoownerHolder(name) { return holdsRoleName("coowner", name); }
function isAdminHolder(name) { return holdsRoleName("admin", name); }
function isModHolder(name) { return holdsRoleName("mod", name); }

function openBanConfirm(target, durationMs, reason) {
  if (!durationMs && myRank() < ROLES.crown.rank) durationMs = banLimitsForRank(myRank()).max;   // permanent is Owner-only: ban for the longest time this rank can
  if (durationMs) {
    const problem = checkDurationLimits(durationMs, banLimitsForRank(myRank()));
    if (problem) { showComposerNotice(problem); return; }
  }
  pendingBanTarget = target;
  pendingBanDurationMs = durationMs;
  document.getElementById("banReasonInput").value = String(reason || "").slice(0, 100);
  $banConfirmTitle.textContent = durationMs ? "Temporary ban?" : "Ban user?";
  $banConfirmText.textContent = (durationMs
    ? "Ban " + target.name + " (#" + target.loginId + ") for " + formatDurationShort(durationMs) + "?"
    : "Ban " + target.name + " (#" + target.loginId + ") from VUS Chat?")
    + " This bans the account ID, so logging out and picking a new name won't get around it.";
  $banConfirmErr.textContent = "";
  $banConfirmBtn.disabled = false;
  $banConfirmBtn.textContent = durationMs ? "Temporary ban" : "Ban";
  $banConfirmOverlay.style.display = "flex";
}

function closeBanConfirm() {
  pendingBanTarget = null;
  pendingBanDurationMs = 0;
  $banConfirmOverlay.style.display = "none";
}

$banCancelBtn.addEventListener("click", closeBanConfirm);
$banConfirmOverlay.addEventListener("click", event => {
  if (event.target === $banConfirmOverlay) closeBanConfirm();
});
$banConfirmBtn.addEventListener("click", async () => {
  if (!pendingBanTarget) return;
  const target = pendingBanTarget;
  const durationMs = pendingBanDurationMs;
  if (isProtected(target.loginId)) { $banConfirmErr.textContent = PROTECTION_EMOJI + " " + target.name + " is protected and can't be banned."; return; }
  $banConfirmBtn.disabled = true;
  $banConfirmBtn.textContent = "Applying…";
  $banConfirmErr.textContent = "";
  try {
    await ChatBackend.banUser(target.loginId, target.name, myLoginId, durationMs, document.getElementById("banReasonInput").value.trim());
    closeBanConfirm();
    if ($ownerMenuOverlay.style.display === "flex") renderOwnerMenuList();
    if ($modListOverlay.style.display === "flex") renderModList();
    showComposerNotice(durationMs ? "Temporarily banned " + target.name + "." : "Banned " + target.name + ".");
  } catch (e) {
    $banConfirmErr.textContent = "Couldn't apply that ban. Check your connection and try again.";
    $banConfirmBtn.disabled = false;
    $banConfirmBtn.textContent = durationMs ? "Temporary ban" : "Ban";
  }
});

// ── Inventory (what you own; items are added by hand in the Firebase console) ──
const INVENTORY_ITEMS = {
  protection: { emoji: PROTECTION_EMOJI, label: "Protection", desc: "Can't be muted or banned." }
};
const $inventoryOverlay = document.getElementById("inventoryOverlay");
const $inventoryList = document.getElementById("inventoryList");
function renderInventory() {
  $inventoryList.innerHTML = "";
  const mine = (myLoginId && inventoryData[String(myLoginId)]) || {};
  const owned = Object.entries(mine).filter(([, qty]) => Number(qty) > 0);
  if (owned.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rooms-empty";
    empty.textContent = "You have no items";
    $inventoryList.appendChild(empty);
    return;
  }
  owned.forEach(([id, qty]) => {
    const def = INVENTORY_ITEMS[id] || { emoji: "📦", label: id, desc: "" };
    const row = document.createElement("div");
    row.className = "room-member-row";
    const nameEl = document.createElement("span");
    nameEl.className = "room-member-name";
    nameEl.textContent = def.emoji + " " + def.label + (def.desc ? " — " + def.desc : "");
    const countEl = document.createElement("span");
    countEl.textContent = "×" + Number(qty);
    row.appendChild(nameEl);
    row.appendChild(countEl);
    $inventoryList.appendChild(row);
  });
}
document.getElementById("inventoryBtn").addEventListener("click", () => { renderInventory(); $inventoryOverlay.style.display = "flex"; });
document.getElementById("inventoryCloseBtn").addEventListener("click", () => { $inventoryOverlay.style.display = "none"; });
$inventoryOverlay.addEventListener("click", e => { if (e.target === $inventoryOverlay) $inventoryOverlay.style.display = "none"; });

// ── Bans & timeouts list (Admin and up). Loads when opened and on Refresh. ──
const $modListOverlay = document.getElementById("modListOverlay");
const $modListBody = document.getElementById("modListBody");
const $modListBanInput = document.getElementById("modListBanInput");
let modListTab = "bans";
let modListToken = 0;

function openModListMenu() {
  if (myRank() < ROLES.admin.rank) return;
  modListTab = "bans";
  $modListOverlay.style.display = "flex";
  renderModList();
}

async function modListName(id, fallback) {
  const online = latestPresenceList.find(e => String(e.loginId || "") === String(id));
  if (online) return online.name;
  if (fallback) return fallback;
  try { const p = await ChatBackend.getProfile(id); if (p && p.lastName) return p.lastName; } catch (e) {}
  return "ID #" + id;
}

async function renderModList() {
  const token = ++modListToken;
  [["bans", "modListTabBans"], ["temp", "modListTabTemp"], ["timeouts", "modListTabTimeouts"]].forEach(([tab, id]) => {
    document.getElementById(id).style.opacity = tab === modListTab ? "1" : "0.55";
  });
  $modListBody.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "rooms-empty";
  loading.textContent = "Loading…";
  $modListBody.appendChild(loading);

  let rows = [];
  try {
    const now = await ChatBackend._serverNow();
    if (modListTab === "timeouts") {
      const val = (await ChatBackend._timeoutsRef.get()).val() || {};
      rows = Object.entries(val).filter(([, v]) => v && v.expiresAt > now)
        .map(([id, v]) => ({ id, remaining: v.expiresAt - now }));
    } else {
      const val = (await ChatBackend._bansRef.get()).val() || {};
      const all = Object.entries(val).filter(([, v]) => v && !(v.expiresAt && v.expiresAt <= now))
        .map(([id, v]) => ({ id, ban: v, remaining: v.expiresAt ? v.expiresAt - now : 0 }));
      const valid = await Promise.all(all.map(r => ChatBackend.isBanValid(r.ban, r.id)));
      rows = all.filter((r, i) => valid[i] && (modListTab === "temp" ? r.remaining > 0 : r.remaining === 0));
    }
    const names = await Promise.all(rows.map(r => modListName(r.id, r.ban && r.ban.username)));
    rows.forEach((r, i) => { r.name = names[i]; });
  } catch (e) {
    if (token === modListToken) loading.textContent = "Couldn't load the list. Try Refresh.";
    return;
  }
  if (token !== modListToken) return;
  $modListBody.innerHTML = "";
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rooms-empty";
    empty.textContent = modListTab === "bans" ? "No bans" : modListTab === "temp" ? "No temp bans" : "No one is muted";
    $modListBody.appendChild(empty);
    return;
  }
  const isOwner = myRank() >= ROLES.crown.rank;
  rows.sort((a, b) => a.name.localeCompare(b.name)).forEach(r => {
    const row = document.createElement("div");
    row.className = "room-member-row";
    const nameEl = document.createElement("span");
    nameEl.className = "room-member-name";
    nameEl.textContent = r.name + " (#" + r.id + ")" + (r.remaining ? " — " + formatCountdown(r.remaining) + " left" : "");
    row.appendChild(nameEl);
    const actions = document.createElement("div");
    actions.className = "room-member-actions";
    const addBtn = (label, cls, handler) => {
      const b = document.createElement("button");
      if (cls) b.className = cls;
      b.textContent = label;
      b.addEventListener("click", handler);
      actions.appendChild(b);
    };
    const target = { name: r.name, loginId: r.id, online: false };
    if (modListTab !== "bans") {
      addBtn(modListTab === "temp" ? "Make permanent" : "Ban", "kick", () => { if (guardModerationTarget(target, "ban")) openBanConfirm(target, 0); });
    }
    if (isOwner) {
      addBtn(modListTab === "timeouts" ? "Clear" : "Unban", "", async () => {
        try {
          if (modListTab === "timeouts") await ChatBackend.clearTimeout_(r.id);
          else await ChatBackend.unbanUser(r.id);
          renderModList();
        } catch (e) { showComposerNotice("Couldn't do that: " + (e && e.message ? e.message : "check your connection") + "."); }
      });
    }
    row.appendChild(actions);
    $modListBody.appendChild(row);
  });
}
document.getElementById("modListTabBans").addEventListener("click", () => { modListTab = "bans"; renderModList(); });
document.getElementById("modListTabTemp").addEventListener("click", () => { modListTab = "temp"; renderModList(); });
document.getElementById("modListTabTimeouts").addEventListener("click", () => { modListTab = "timeouts"; renderModList(); });
document.getElementById("modListRefreshBtn").addEventListener("click", renderModList);
document.getElementById("modListCloseBtn").addEventListener("click", () => { $modListOverlay.style.display = "none"; });
$modListOverlay.addEventListener("click", e => { if (e.target === $modListOverlay) $modListOverlay.style.display = "none"; });
document.getElementById("modListBanBtn").addEventListener("click", async () => {
  const raw = $modListBanInput.value.trim();
  if (!raw) return;
  const target = await resolveModerationTarget(raw, { allowOfflineId: true });
  if (!guardModerationTarget(target, "ban")) return;
  $modListBanInput.value = "";
  openBanConfirm(target, 0);
});

function openOwnerMenu() {
  staffMenuMode = "owner";
  closeClearPanel();
  $ownerMenuTitle.textContent = "👑 Owner Menu";
  $ownerMenuSubtitle.textContent = "Online now. Press Refresh to update the list.";
  renderOwnerMenuList();
  $ownerMenuOverlay.style.display = "flex";
}

// Mod Menu: same modal, same list/refresh machinery, far fewer buttons per
// row (see renderOwnerMenuList's staffMenuMode branch below) — mods only
// ever see a Timeout button, capped smaller, with their own re-timeout
// cooldown and "only I can clear my own" restriction enforced there.
function openModMenuStaff() {
  staffMenuMode = "mod";
  closeClearPanel();
  $ownerMenuTitle.textContent = "🧩 Mod Menu";
  $ownerMenuSubtitle.textContent = "Online now. Press Refresh to update the list. Mutes (" + limitsText(TIME_LIMITS.modTimeout) + ") and temp bans (" + limitsText(TIME_LIMITS.modTempban) + ").";
  renderOwnerMenuList();
  $ownerMenuOverlay.style.display = "flex";
}

function openAdminMenuStaff() {
  staffMenuMode = "admin";
  closeClearPanel();
  $ownerMenuTitle.textContent = "🛡️ Admin Menu";
  $ownerMenuSubtitle.textContent = "Online now. Press Refresh to update the list. Use /grant to give ranks.";
  renderOwnerMenuList();
  $ownerMenuOverlay.style.display = "flex";
}

// Whether the two fold-out sections were open, so a Refresh doesn't snap them shut.
let staffCommandsOpen = false;
let staffHistoryOpen = false;

function renderStaffCommands() {
  $ownerMenuCommands.innerHTML = "";
  const rank = myRank();
  const visible = availableSlashCommands();

  // Commands: folded by default. Open, this list is taller than a phone screen and
  // used to push the actual member list (the reason anyone opens this menu) off the bottom.
  const cmds = document.createElement("details");
  cmds.className = "staff-details";
  cmds.open = staffCommandsOpen;
  cmds.addEventListener("toggle", () => { staffCommandsOpen = cmds.open; });
  const cmdsSummary = document.createElement("summary");
  cmdsSummary.textContent = "Commands (" + visible.length + ")";
  cmds.appendChild(cmdsSummary);

  const list = document.createElement("div");
  list.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 14px;padding:10px;background:#0f172a;border:1px solid #334155;border-radius:9px;margin-bottom:6px";
  visible.forEach(c => {
    const item = document.createElement("div");
    item.style.cssText = "font-size:12.5px;line-height:1.35";
    const name = document.createElement("strong");
    name.style.cssText = "color:#4ade80;font-family:monospace";
    name.textContent = c.name + (c.args ? " " + c.args : "");
    const desc = document.createElement("span");
    desc.style.color = "#94a3b8";
    desc.textContent = commandDescription(c, rank);
    item.appendChild(name);
    item.appendChild(document.createElement("br"));
    item.appendChild(desc);
    list.appendChild(item);
  });
  cmds.appendChild(list);
  const note = document.createElement("div");
  note.style.cssText = "font-size:12.5px;color:#64748b;line-height:1.4";
  note.textContent = "Use the name popup while typing a command. Only online VUS DM accounts can be moderated.";
  cmds.appendChild(note);
  $ownerMenuCommands.appendChild(cmds);

  // Recent commands: also folded, and only fetched when it is actually opened.
  const hist = document.createElement("details");
  hist.className = "staff-details";
  const histSummary = document.createElement("summary");
  histSummary.textContent = "Recent commands";
  hist.appendChild(histSummary);
  const histBody = document.createElement("div");
  histBody.style.cssText = "font-size:12.5px;line-height:1.45;color:#94a3b8;padding:0 2px 6px";
  hist.appendChild(histBody);
  let histLoaded = false;
  const loadHistory = async () => {
    if (histLoaded) return;
    histLoaded = true;
    histBody.textContent = "Loading...";
    let entries = [];
    try { entries = await ChatBackend.getCommandHistory(); } catch (e) {}
    histBody.textContent = "";
    if (!entries.length) { histBody.textContent = "No commands logged in this room."; return; }
    entries.forEach(entry => {
      const row = document.createElement("div");
      const who = document.createElement("span");
      who.style.color = "#f1f5f9";
      who.textContent = entry.actorName || "?";
      const cmd = document.createElement("span");
      cmd.style.cssText = "font-family:monospace;color:#4ade80";
      cmd.textContent = entry.command || "";
      const when = document.createElement("span");
      when.style.color = "#64748b";
      when.textContent = entry.ts ? new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      row.appendChild(who); row.appendChild(document.createTextNode(": ")); row.appendChild(cmd); row.appendChild(document.createTextNode("  ")); row.appendChild(when);
      histBody.appendChild(row);
    });
  };
  const fullBtn = document.createElement("button");
  fullBtn.type = "button"; fullBtn.className = "cs-action"; fullBtn.textContent = "View full history";
  fullBtn.addEventListener("click", () => openFullCommandHistory());
  hist.appendChild(fullBtn);
  if (myRank() >= ROLES.admin.rank) {
    const logsBtn = document.createElement("button");
    logsBtn.type = "button"; logsBtn.className = "cs-action"; logsBtn.textContent = "\uD83D\uDCDC Full chat logs";
    logsBtn.addEventListener("click", () => openFullChatLogs());
    $ownerMenuCommands.appendChild(logsBtn);
  }
  hist.addEventListener("toggle", () => { staffHistoryOpen = hist.open; if (hist.open) loadHistory(); });
  hist.open = staffHistoryOpen;
  if (staffHistoryOpen) loadHistory();
  $ownerMenuCommands.appendChild(hist);
}

function closeOwnerMenu() {
  $ownerMenuOverlay.style.display = "none";
}

/* Full chat logs (Admin and up): every message of this room in a new about:blank tab, loaded gradually in pages.
   Filter by name/ID, by words in the message, and by rank (Verified, Owner ... Unranked, several at once).
   Edited messages show the edit and can flip back to the original. Images and videos show as a label only. */
async function openFullChatLogs() {
  if (myRank() < ROLES.admin.rank) { showComposerNotice("Chat logs are for Admins and above."); return; }
  const w = window.open("about:blank", "_blank");
  if (!w) { showComposerNotice("Your browser blocked the new tab. Allow pop-ups for this site and try again."); return; }
  const roomId = ChatBackend.currentRoomId;
  const roomRef = ChatBackend._ref, editsRef = ChatBackend._editsRef;
  const label = activeChannelId && activeChannelId !== "main" && activeChannel() ? "#" + activeChannel().label : (currentRoomCode ? "room " + currentRoomCode : "#main");
  const html = `<!doctype html><meta charset="utf-8"><title>Chat logs</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{background:#0f172a;color:#e2e8f0;font:14px system-ui,sans-serif;margin:0}
header{position:sticky;top:0;background:#0f172a;border-bottom:1px solid #1e293b;padding:12px 16px;z-index:2}
h1{font-size:17px;margin:0 0 8px} small,.mut{color:#94a3b8}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}
input[type=text]{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:8px 10px;font-size:14px;min-width:200px;flex:1}
label.cb{display:inline-flex;gap:5px;align-items:center;background:#1e293b;border:1px solid #334155;border-radius:999px;padding:4px 10px;cursor:pointer;user-select:none}
button{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:13px}
main{padding:8px 16px 40px}
.m{border-bottom:1px solid #1e293b;padding:9px 0}.m .h{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.n{font-weight:600}.id{color:#64748b;font-size:12px}.t{color:#64748b;font-size:12px}
.tag{font-size:11px;border:1px solid #334155;border-radius:999px;padding:1px 7px;color:#cbd5e1}.tag.v{color:#4ade80;border-color:#1b6a3b}
.x{margin-top:4px;white-space:pre-wrap;word-break:break-word}.media{color:#a5b4fc;font-style:italic}
.ed{margin-top:4px;font-size:12px;color:#fbbf24}.ed button{padding:1px 8px;font-size:12px;margin-left:6px}
mark{background:#854d0e;color:#fff;border-radius:3px}
</style>
<header><h1>Chat logs <small id="where"></small></h1>
<div class="row"><input type="text" id="fwho" placeholder="Name or ID (e.g. alex or 123456)"><input type="text" id="ftext" placeholder="Message contains (e.g. hel finds hello)"></div>
<div class="row" id="roles"></div>
<div class="row"><button id="all">Select all</button><button id="none">Clear all</button><span class="mut" id="status"></span></div></header>
<main id="list"></main>
<script>
const ROLES=[["verified","Verified"],["crown","Owner"],["coowner","Co-owner"],["admin","Admin"],["mod","Mod"],["normie","Normie"],["unranked","Unranked"]];
const rows=[];let timer=null,loading=true,total=0;
const $=id=>document.getElementById(id);
const rbox=$("roles");
ROLES.forEach(([k,t])=>{const l=document.createElement("label");l.className="cb";const i=document.createElement("input");i.type="checkbox";i.checked=true;i.dataset.k=k;i.addEventListener("change",draw);l.append(i,document.createTextNode(t));rbox.appendChild(l);});
$("all").onclick=()=>{rbox.querySelectorAll("input").forEach(i=>i.checked=true);draw();};
$("none").onclick=()=>{rbox.querySelectorAll("input").forEach(i=>i.checked=false);draw();};
$("fwho").addEventListener("input",draw);$("ftext").addEventListener("input",draw);
function checked(){const s=new Set();rbox.querySelectorAll("input").forEach(i=>{if(i.checked)s.add(i.dataset.k)});return s}
function hl(el,text,q){if(!q){el.textContent=text;return}const lo=text.toLowerCase();let p=0,i;while((i=lo.indexOf(q,p))>=0){el.append(document.createTextNode(text.slice(p,i)));const m=document.createElement("mark");m.textContent=text.slice(i,i+q.length);el.append(m);p=i+q.length}el.append(document.createTextNode(text.slice(p)))}
function draw(){clearTimeout(timer);timer=setTimeout(render,120)}
function render(){
  const who=$("fwho").value.trim().toLowerCase(),q=$("ftext").value.trim().toLowerCase(),on=checked();
  const list=$("list");list.textContent="";let shown=0,match=0;
  for(const r of rows){
    if(!r.tags.some(t=>on.has(t)))continue;
    if(who&&!((r.name||"").toLowerCase().includes(who)||String(r.loginId||"").includes(who)))continue;
    const body=(r.text||"")+(r.edited?" "+r.edited.text:"");
    if(q&&!body.toLowerCase().includes(q))continue;
    match++;if(shown>=2000)continue;shown++;
    const d=document.createElement("div");d.className="m";
    const h=document.createElement("div");h.className="h";
    const n=document.createElement("span");n.className="n";n.textContent=r.name||"?";
    const id=document.createElement("span");id.className="id";id.textContent=r.loginId?"#"+r.loginId:"";
    const rt=document.createElement("span");rt.className="tag";rt.textContent=r.role;
    h.append(n,id,rt);
    if(r.verified){const v=document.createElement("span");v.className="tag v";v.textContent="Verified";h.append(v)}
    const t=document.createElement("span");t.className="t";t.textContent=r.ts?new Date(r.ts).toLocaleString():"";h.append(t);
    d.append(h);
    const x=document.createElement("div");x.className="x";
    if(r.kind!=="text"){x.className="x media";x.textContent=r.kind==="video"?"[video]":"[image]";if(r.text){const c=document.createElement("div");c.className="x";c.textContent=r.edited?r.edited.text:r.text;d.append(x,c)}else d.append(x)}
    else{
      let showEdited=!!r.edited;
      const paint=()=>{hl(x,showEdited?r.edited.text:r.text,q)};paint();d.append(x);
      if(r.edited){const e=document.createElement("div");e.className="ed";const lab=document.createElement("span");
        const b=document.createElement("button");
        const set=()=>{lab.textContent=showEdited?"Edited version shown":"Original version shown";b.textContent=showEdited?"View original":"View edited"};set();
        b.onclick=()=>{showEdited=!showEdited;paint();set()};
        e.append(lab,b);if(r.edited.ts){const s=document.createElement("span");s.className="mut";s.textContent="  edited "+new Date(r.edited.ts).toLocaleString();e.append(s)}d.append(e)}
    }
    list.append(d);
  }
  $("status").textContent=(loading?"Loading\u2026 ":"")+total+" loaded \u00b7 "+match+" match"+(match===1?"":"es")+(match>shown?" (showing "+shown+")":"");
}
window.__logs={add(batch){for(const r of batch)rows.push(r);rows.sort((a,b)=>(b.ts||0)-(a.ts||0));total=rows.length;draw()},done(){loading=false;draw()},fail(m){loading=false;$("status").textContent=m},where(t){$("where").textContent=t}};
</script>`;
  try { w.document.open(); w.document.write(html); w.document.close(); } catch (e) { return; }
  const api = () => w.__logs;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  try {
    api().where("\u2014 " + label);
    let edits = {};
    try { edits = (await editsRef.get()).val() || {}; } catch (e) {}
    const vcache = new Map();
    const verifiedFor = async id => {
      if (!id) return false;
      if (!vcache.has(id)) vcache.set(id, window.VUS_DM ? window.VUS_DM.isVerified(id).catch(() => false) : Promise.resolve(false));
      return vcache.get(id);
    };
    let before = null, guard = 0;
    while (!w.closed && guard++ < 400) {
      let q = roomRef.orderByKey();
      if (before) q = q.endAt(before);
      const snap = await q.limitToLast(before ? 201 : 200).get();
      const val = snap.val() || {};
      let keys = Object.keys(val).sort();
      if (before) keys = keys.filter(k => k !== before);
      if (!keys.length) break;
      const batch = [];
      for (const k of keys) {
        const m = val[k];
        if (!m || m.system) continue;
        const id = m.loginId ? String(m.loginId) : "";
        const roleId = id ? effectiveRoleForLoginId(id) : "unranked";
        const verified = id ? await verifiedFor(id) : false;
        const ed = edits[k];
        const valid = ed && typeof ed.text === "string" && String(ed.by) === id && (!ed.ts || !m.ts || Number(ed.ts) - Number(m.ts) <= EDIT_WINDOW_MS + 5000);
        batch.push({
          id: k, ts: Number(m.ts) || 0, name: String(m.name || ""), loginId: id,
          text: stripMentionMarks(String(m.text || "")), kind: m.video ? "video" : m.imageData ? "image" : "text",
          edited: valid ? { text: stripMentionMarks(ed.text), ts: Number(ed.ts) || 0 } : null,
          role: (ROLES[roleId] || ROLES.unranked).label, tags: [roleId].concat(verified ? ["verified"] : []), verified
        });
      }
      if (!w.closed) api().add(batch);
      before = keys[0];
      if (keys.length < 200) break;
      await wait(450);   // gradual on purpose: a big room fills in over time instead of freezing the tab
    }
    if (!w.closed) api().done();
  } catch (e) { try { api().fail("Couldn't load everything: " + (e && e.message ? e.message : "check your connection")); } catch (x) {} }
}

// Every logged command in a new about:blank tab: who ran it (name first, ID beside it) and who it was aimed at.
const CMD_SKIP = { "/mute": 1, "/timeout": 1, "/tempban": 1, "/image": 1, "/remove": 1, "/ban": 0, "/kick": 0, "/unban": 0 };
function commandTargetText(cmd) {
  const parts = String(cmd || "").trim().split(/\s+/);
  const name = (parts[0] || "").toLowerCase();
  let skip;
  if (name === "/grant") skip = 1 + ((parts.length >= 4 && (PERMANENT_WORDS.has((parts[2] || "").toLowerCase()) || parseModerationDuration(parts[2]) > 0 || /^[0-9]+(\.[0-9]+)?[smhdw]?$/i.test(parts[2]))) ? 1 : 0);
  else if (name in CMD_SKIP) skip = CMD_SKIP[name];
  else return null;
  return parts.slice(1 + skip).join(" ") || null;
}
async function openFullCommandHistory() {
  const w = window.open("about:blank", "_blank");     // opened right away so the browser allows it
  if (!w) { showComposerNotice("Your browser blocked the new tab. Allow pop-ups for this site and try again."); return; }
  const say = html => { try { w.document.open(); w.document.write(html); w.document.close(); } catch (e) {} };
  const page = body => '<!doctype html><meta charset="utf-8"><title>Command history</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#0f172a;color:#e2e8f0;font:14px system-ui,sans-serif;margin:0;padding:18px}h1{font-size:18px;margin:0 0 4px}small{color:#94a3b8}table{border-collapse:collapse;width:100%;margin-top:14px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #1e293b;vertical-align:top}th{color:#94a3b8;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;position:sticky;top:0;background:#0f172a}code{color:#4ade80;font-family:ui-monospace,monospace;word-break:break-word}.id{color:#64748b;font-size:12px}.t{white-space:nowrap;color:#94a3b8}</style>' + body;
  say(page("<h1>Command history</h1><small>Loading\u2026</small>"));
  let entries = [];
  try {
    const snap = await ChatBackend._commandHistoryRef.limitToLast(3000).get();
    entries = Object.values(snap.val() || {}).sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  } catch (e) { say(page("<h1>Command history</h1><small>Couldn't load it. Check your connection.</small>")); return; }
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const cache = new Map();
  const resolve = text => {
    if (!cache.has(text)) cache.set(text, resolveModerationTarget(text, { allowOfflineId: true }).catch(() => null));
    return cache.get(text);
  };
  const rows = [];
  for (const e of entries) {
    const tt = commandTargetText(e.command);
    const target = tt ? await resolve(tt) : null;
    const when = e.ts ? new Date(Number(e.ts)).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    const actor = esc(e.actorName || "?") + (e.actorLoginId ? ' <span class="id">#' + esc(e.actorLoginId) + "</span>" : "");
    const tgt = target ? esc(target.name) + ' <span class="id">#' + esc(target.loginId) + "</span>" : (tt ? esc(tt) + ' <span class="id">(not found)</span>' : '<span class="id">\u2014</span>');
    rows.push("<tr><td class=t>" + esc(when) + "</td><td>" + actor + "</td><td><code>" + esc(e.command) + "</code></td><td>" + tgt + "</td></tr>");
  }
  say(page("<h1>Command history</h1><small>" + entries.length + " command" + (entries.length === 1 ? "" : "s") + ", newest first. Names are shown first; the account ID is beside them.</small><table><thead><tr><th>When</th><th>Who</th><th>Command</th><th>Aimed at</th></tr></thead><tbody>" + (rows.join("") || "<tr><td colspan=4>No commands logged yet.</td></tr>") + "</tbody></table>"));
}

$ownerMenuCloseBtn.addEventListener("click", closeOwnerMenu);
installBackButton($ownerMenuOverlay, closeOwnerMenu);
installBackButton($modListOverlay, () => { $modListOverlay.style.display = "none"; });
$ownerMenuOverlay.addEventListener("click", (e) => {
  if (e.target === $ownerMenuOverlay) closeOwnerMenu();
});


/* ══════════════════════════════════════════════════════════
   STAFF MENU: Refresh button (the list no longer refreshes by itself)
   ══════════════════════════════════════════════════════════ */
$ownerMenuRefreshBtn.addEventListener("click", async () => {
  const box = $ownerMenuOverlay.querySelector(".chat-modal");
  const scrolled = box ? box.scrollTop : 0;
  $ownerMenuRefreshBtn.disabled = true;
  $ownerMenuRefreshBtn.textContent = "Refreshing...";
  try { await renderOwnerMenuList(); } finally {
    $ownerMenuRefreshBtn.disabled = false;
    $ownerMenuRefreshBtn.innerHTML = "&#8635; Refresh";
    if (box) box.scrollTop = scrolled;   // keep your place in a long list
  }
});

/* ══════════════════════════════════════════════════════════
   RANK ROSTER (Mod and up)
   Everyone who holds a rank, offline people included, each listed once under
   their highest rank. Names of offline people come from their saved profile
   (their last chat name). Account IDs show for Mod and up.
   ══════════════════════════════════════════════════════════ */
const ROSTER_MIN_RANK = ROLES.mod.rank;
const $rosterOverlay = document.getElementById("rosterOverlay");
const $rosterList = document.getElementById("rosterList");
const $rosterRefreshBtn = document.getElementById("rosterRefreshBtn");
const $rosterCloseBtn = document.getElementById("rosterCloseBtn");

function closeRoster() { $rosterOverlay.style.display = "none"; }

async function renderRoster() {
  if (!myLoginId || myRank() < ROSTER_MIN_RANK) { closeRoster(); return; }
  const showIds = myRank() >= IDS_MIN_RANK;

  // Everyone who holds any stored rank, grouped by their HIGHEST one.
  const holderIds = new Set();
  Object.values(ROLES).forEach(role => {
    if (!role.implicit) (roleIdHolders[role.id] || new Set()).forEach(id => { if (roleAttested(role.id, id)) holderIds.add(String(id)); });
  });
  const ids = [...holderIds];
  const profiles = {};
  await Promise.all(ids.map(async id => {
    try { profiles[id] = await ChatBackend.getProfile(id); } catch (e) { profiles[id] = null; }
  }));

  const people = ids.map(id => {
    const roleId = effectiveRoleForLoginId(id);
    const online = latestPresenceList.find(e => String(e.loginId || "") === id);
    const raw = (roleIdRaw[roleId] || {})[id];
    return {
      id, role: ROLES[roleId], online: !!online,
      name: (online && online.name) || (profiles[id] && profiles[id].lastName) || "Unknown",
      tempLeftMs: raw && typeof raw === "object" && raw.temporary ? Number(raw.expiresAt) - ChatBackend.serverNowSync() : 0
    };
  });

  $rosterList.innerHTML = "";
  if (people.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "Nobody holds a rank yet.";
    empty.style.cssText = "color:#64748b;font-size:13.5px;padding:6px 0";
    $rosterList.appendChild(empty);
    return;
  }

  Object.values(ROLES).filter(r => !r.implicit).sort((a, b) => b.rank - a.rank).forEach(role => {
    const group = people.filter(p => p.role.id === role.id)
      .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    if (group.length === 0) return;

    const header = document.createElement("div");
    header.textContent = role.icon + " " + role.label + " (" + group.length + ")";
    header.style.cssText = "margin:12px 0 2px;color:#94a3b8;font-size:12.5px;font-weight:700;letter-spacing:.03em";
    $rosterList.appendChild(header);

    group.forEach(person => {
      const row = document.createElement("div");
      row.className = "room-member-row";
      row.dataset.loginId = person.id;

      const nameEl = document.createElement("div");
      nameEl.className = "room-member-name";
      const dot = document.createElement("span");
      dot.textContent = person.online ? "\u25cf" : "\u25cb";
      dot.style.color = person.online ? "#22c55e" : "#64748b";
      dot.title = person.online ? "Online" : "Offline";
      const label = document.createElement("span");
      label.textContent = person.name;
      nameEl.appendChild(dot);
      nameEl.appendChild(label);

      const meta = document.createElement("div");
      meta.style.cssText = "color:#64748b;font-size:12px;flex-shrink:0;text-align:right";
      const bits = [person.online ? "Online" : "Offline"];
      if (person.tempLeftMs > 0) bits.push("temporary, " + formatCountdown(person.tempLeftMs) + " left");
      if (showIds) bits.push("#" + person.id);
      meta.textContent = bits.join(" \u00b7 ");

      row.appendChild(nameEl);
      row.appendChild(meta);
      $rosterList.appendChild(row);
    });
  });
}

function openRoster() {
  if (myRank() < ROSTER_MIN_RANK) return;
  $rosterOverlay.style.display = "flex";
  return renderRoster();
}

$rosterRefreshBtn.addEventListener("click", async () => {
  const box = $rosterOverlay.querySelector(".chat-modal");
  const scrolled = box ? box.scrollTop : 0;
  $rosterRefreshBtn.disabled = true;
  $rosterRefreshBtn.textContent = "Refreshing...";
  try { await renderRoster(); } finally {
    $rosterRefreshBtn.disabled = false;
    $rosterRefreshBtn.innerHTML = "&#8635; Refresh";
    if (box) box.scrollTop = scrolled;
  }
});
$rosterCloseBtn.addEventListener("click", closeRoster);
$rosterOverlay.addEventListener("click", e => { if (e.target === $rosterOverlay) closeRoster(); });
installBackButton($rosterOverlay, closeRoster);

/* ══════════════════════════════════════════════════════════
   RANK GUIDE (everyone)
   What each rank can do. Everything numeric or command-related is read from
   the same tables the chat enforces (delays, TIME_LIMITS, SLASH_COMMANDS), so
   this can't disagree with what actually happens.
   ══════════════════════════════════════════════════════════ */
const $rankGuideOverlay = document.getElementById("rankGuideOverlay");
const $rankGuideBody = document.getElementById("rankGuideBody");
const $rankGuideCloseBtn = document.getElementById("rankGuideCloseBtn");

function closeRankGuide() { $rankGuideOverlay.style.display = "none"; }

function rankGuideLines(role) {
  const msgEvery = formatDurationShort(ROLE_MESSAGE_COOLDOWNS_MS[role.id]);
  const imgEvery = formatDurationShort(ROLE_IMAGE_COOLDOWNS_MS[role.id]);
  const gated = role.rank <= IMAGE_GATED_MAX_RANK;
  const byHand = role.id === "crown" || role.id === "coowner";
  const newCommands = SLASH_COMMANDS.filter(c => c.minRank === role.rank);
  const grantable = Object.values(ROLES).filter(r => !r.implicit && r.id !== "crown" && r.id !== "coowner" && r.rank < role.rank && canGrantRole(role.rank, r.id));
  const canGrant = grantable.length > 0;
  const menu = role.rank >= ROLES.crown.rank ? "Owner Menu" : role.rank >= ROLES.admin.rank ? "Admin Menu" : role.rank >= ROLES.mod.rank ? "Mod Menu" : null;

  const lines = [];
  lines.push(["How you get it", role.implicit ? "Everyone starts here."
    : byHand ? "Added by hand in the database. It can't be given out in chat."
    : "Given to you by a higher rank."]);
  lines.push(["Chatting", "One message every " + msgEvery + "."]);
  lines.push(["Images", gated
    ? "One every " + imgEvery + ", but only after a higher rank turns image access on for you."
    : "You can post images, one every " + imgEvery + "."]);
  lines.push(["Bubble color", role.rank >= COLOR_MIN_RANK ? "You can pick your own colors in Settings." : "Unlocks at " + ROLES.normie.icon + " " + ROLES.normie.label + "."]);
  if (menu) lines.push(["Menu", menu + (role.id === "mod" ? " (mutes, temp bans up to " + formatDurationShort(TIME_LIMITS.modTempban.max) + ", give Normie)" : "") + " in Settings."]);
  if (canGrant) lines.push(["Can give out", grantable.map(r => r.icon + " " + r.label).join(", ") + ", permanently or for a set time."]);
  if (role.id === "coowner") lines.push(["Commands", "The same as " + ROLES.admin.icon + " " + ROLES.admin.label + "."]);
  return { lines, newCommands, notes: [
    role.id === "crown" ? "The only rank that can /unban." : null,
    byHand ? "Can't be banned or muted." : null
  ].filter(Boolean) };
}

function openRankGuide() {
  const mine = myRoleId();
  $rankGuideBody.innerHTML = "";

  const intro = document.createElement("p");
  intro.textContent = "Ranks belong to your account, so they stay when you leave, rename or log back in. A rank can only give out or take away ranks below its own, and nobody can act on someone of the same or higher rank.";
  intro.style.marginBottom = "6px";
  $rankGuideBody.appendChild(intro);

  Object.values(ROLES).sort((a, b) => a.rank - b.rank).forEach(role => {
    const guide = rankGuideLines(role);
    const card = document.createElement("div");
    card.dataset.role = role.id;
    card.style.cssText = "border:1.5px solid " + (role.id === mine ? "#22c55e" : "#334155") + ";border-radius:11px;padding:11px 13px;margin-bottom:9px";

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;justify-content:space-between;font-weight:700;font-size:15px;margin-bottom:6px";
    const title = document.createElement("span");
    title.textContent = role.icon + " " + role.label;
    head.appendChild(title);
    if (role.id === mine) {
      const tag = document.createElement("span");
      tag.textContent = "You are here";
      tag.style.cssText = "font-size:11.5px;font-weight:700;color:#052e16;background:#22c55e;border-radius:6px;padding:1px 7px";
      head.appendChild(tag);
    }
    card.appendChild(head);

    const addLine = (label, text) => {
      const line = document.createElement("div");
      line.style.cssText = "font-size:13.5px;line-height:1.45;color:#cbd5e1;margin-bottom:3px";
      const strong = document.createElement("strong");
      strong.textContent = label + ": ";
      strong.style.color = "#f1f5f9";
      line.appendChild(strong);
      line.appendChild(document.createTextNode(text));
      card.appendChild(line);
    };
    guide.lines.forEach(([label, text]) => addLine(label, text));

    if (guide.newCommands.length) {
      const cmdTitle = document.createElement("div");
      cmdTitle.textContent = "Commands you get:";
      cmdTitle.style.cssText = "font-size:13.5px;font-weight:700;color:#f1f5f9;margin:4px 0 2px";
      card.appendChild(cmdTitle);
      guide.newCommands.forEach(cmd => {
        const item = document.createElement("div");
        item.style.cssText = "font-size:13px;line-height:1.4;color:#94a3b8;margin-bottom:2px";
        const name = document.createElement("span");
        name.textContent = cmd.name + (cmd.args ? " " + cmd.args : "");
        name.style.cssText = "color:#4ade80;font-family:monospace";
        item.appendChild(name);
        item.appendChild(document.createTextNode(" \u2014 " + commandDescription(cmd, role.rank)));
        card.appendChild(item);
      });
    }
    guide.notes.forEach(note => {
      const n = document.createElement("div");
      n.textContent = note;
      n.style.cssText = "font-size:13px;color:#fbbf24;margin-top:4px";
      card.appendChild(n);
    });
    $rankGuideBody.appendChild(card);
  });

  $rankGuideOverlay.style.display = "flex";
  const box = $rankGuideOverlay.querySelector(".chat-modal");
  if (box) box.scrollTop = 0;
}
$rankGuideCloseBtn.addEventListener("click", closeRankGuide);
$rankGuideOverlay.addEventListener("click", e => { if (e.target === $rankGuideOverlay) closeRankGuide(); });
installBackButton($rankGuideOverlay, closeRankGuide);

let staffRenderToken = 0;

// Ban + Temp ban buttons for a staff-menu row. Owners and Admins both have /ban and
// /tempban, but the menu only ever offered a permanent "Ban" (to Owners only), so a
// temporary ban could only be typed out as a command.
function addBanButtons(actions, entry) {
  const { name, loginId } = entry;

  const banBtn = document.createElement("button");
  banBtn.className = "kick";
  banBtn.textContent = "Ban";
  banBtn.disabled = !loginId;
  banBtn.title = loginId ? "Ban login ID #" + loginId + (myRank() >= ROLES.crown.rank ? " permanently" : " for " + formatDurationShort(banLimitsForRank(myRank()).max) + " (the longest your rank can do)") : "This user has not supplied a login ID";
  banBtn.addEventListener("click", () => { if (loginId) openBanConfirm({ name, loginId }, 0); });
  actions.appendChild(banBtn);

  const tempBanBtn = document.createElement("button");
  tempBanBtn.className = "kick";
  tempBanBtn.textContent = "Temp ban";
  tempBanBtn.disabled = !loginId;
  tempBanBtn.title = loginId ? "Ban login ID #" + loginId + " for a set time (" + limitsText(banLimitsForRank(myRank())) + ")" : "This user has not supplied a login ID";
  tempBanBtn.addEventListener("click", () => { if (loginId) openTempBanSetModal(entry); });
  actions.appendChild(tempBanBtn);
}

async function renderOwnerMenuList() {
  // Re-check the relevant gate every refresh too — if the role backing
  // whichever menu is open gets lost while it's open (timeout, disconnect,
  // another owner revokes it, etc.) the menu should close itself rather
  // than keep offering actions the person no longer has.
  const stillEligible = staffMenuMode === "owner"
    ? myRank() >= ROLES.crown.rank
    : staffMenuMode === "admin"
      ? myRank() >= ROLES.admin.rank
      : myRank() >= ROLES.mod.rank;
  if (!stillEligible) {
    closeOwnerMenu();
    return;
  }

  // A newer render replaces an older one that is still waiting on the network, so two
  // overlapping renders can never both add rows (which used to show everyone twice).
  const renderToken = ++staffRenderToken;

  $ownerMenuList.innerHTML = "";
  renderStaffCommands();

  if (staffMenuMode === "owner") {
    const staffTools = document.createElement("div");
    staffTools.className = "staff-tools";
    const unbanBtn = document.createElement("button");
    unbanBtn.className = "toolbar-btn";
    unbanBtn.textContent = "Unban...";
    unbanBtn.title = "Unban by username or 6-digit login ID";
    unbanBtn.addEventListener("click", async () => {
      const identifier = prompt("Enter the banned username or 6-digit login ID:");
      if (!identifier || !identifier.trim()) return;
      try {
        const loginId = await ChatBackend.unbanUser(identifier);
        showComposerNotice("Unbanned login ID #" + loginId + ".");
      } catch (e) {
        showComposerNotice("Couldn't unban that user: " + (e && e.message ? e.message : "check your connection") + ".");
      }
    });
    staffTools.appendChild(unbanBtn);
    $ownerMenuList.appendChild(staffTools);
  }
  if (staffMenuMode === "owner" || staffMenuMode === "admin") {
    const listTools = document.createElement("div");
    listTools.className = "staff-tools";
    const listBtn = document.createElement("button");
    listBtn.className = "toolbar-btn";
    listBtn.textContent = "Bans & mutes…";
    listBtn.addEventListener("click", () => { navStack.push(reopenStaffMenu); openModListMenu(); });
    listTools.appendChild(listBtn);
    $ownerMenuList.appendChild(listTools);
  }

  const others = latestPresenceList
    .filter(entry => entry.name !== myName)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (others.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rooms-empty";
    empty.textContent = "No one else online right now.";
    $ownerMenuList.appendChild(empty);
    return;
  }

  // Look everyone up at once instead of one network round trip per person. The list used
  // to fill in one row at a time, which was slow with a lot of people online.
  const lookups = {};
  await Promise.all(others.map(async (entry) => {
    if (!entry.loginId) return;
    const result = {};
    try {
      result.remainingMs = await ChatBackend.getTimeoutRemainingMs(entry.loginId);
      if (result.remainingMs > 0) result.setBy = await ChatBackend.getTimeoutSetBy(entry.loginId);
      else if (staffMenuMode === "mod") result.cooldownMs = await ChatBackend.getModRetimeoutRemainingMs(myLoginId, entry.loginId);
    } catch (e) {}
    lookups[entry.loginId] = result;
  }));
  if (renderToken !== staffRenderToken) return;   // a newer render took over while we waited

  for (const entry of others) {
    const name = entry.name;
    const loginId = entry.loginId;
    const row = document.createElement("div");
    row.className = "room-member-row";

    const nameEl = document.createElement("span");
    nameEl.className = "room-member-name";
    const rowRole = loginId ? ROLES[effectiveRoleForLoginId(loginId)] : null;
    const badges = rowRole && !rowRole.implicit ? rowRole.icon + " " : "";
    nameEl.textContent = badges + name + (loginId ? " (#" + loginId + ")" : "");
    row.appendChild(nameEl);

    const actions = document.createElement("div");
    actions.className = "room-member-actions";

    // Grant/Remove Mod: owner-only power, never shown in the mod menu.
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

      if (!isModHolder(name)) {
        const tempModBtn = document.createElement("button");
        tempModBtn.textContent = "Temp Mod";
        tempModBtn.disabled = !loginId;
        tempModBtn.title = loginId ? "Grant temporary Mod to #" + loginId : "This user needs a VUS DM account to receive Mod status";
        tempModBtn.addEventListener("click", () => {
          if (loginId) openTemporaryModSetModal(entry);
        });
        actions.appendChild(tempModBtn);
      }

      addBanButtons(actions, entry);
    } else if (staffMenuMode === "admin" && !isModHolder(name)) {
      const tempModBtn = document.createElement("button");
      tempModBtn.textContent = "Temp Mod";
      tempModBtn.disabled = !loginId;
      tempModBtn.title = loginId ? "Grant temporary Mod to #" + loginId : "This user needs a VUS DM account to receive Mod status";
      tempModBtn.addEventListener("click", () => {
        if (loginId) openTemporaryModSetModal(entry);
      });
      actions.appendChild(tempModBtn);
    }

    // Admins can ban too (they have /ban and /tempban); Owners got theirs above.
    if (staffMenuMode === "admin") addBanButtons(actions, entry);
    else if (staffMenuMode === "mod" && loginId) {
      const mb = document.createElement("button");
      mb.className = "kick"; mb.textContent = "Temp ban";
      mb.title = "Ban login ID #" + loginId + " for a set time (" + limitsText(TIME_LIMITS.modTempban) + ")";
      mb.addEventListener("click", () => { if (guardModerationTarget({ name, loginId }, "ban")) openTempBanSetModal(entry); });
      actions.appendChild(mb);
    }

    const timeoutBtn = document.createElement("button");
    timeoutBtn.className = "kick";
    const found = (loginId && lookups[loginId]) || {};
    const remainingMs = found.remainingMs || 0;
    const setBy = found.setBy || null;

    if (remainingMs > 0) {
      timeoutBtn.textContent = "Muted (" + formatCountdown(remainingMs) + ")";
      // Owners can always clear any timeout. Mods can only clear a timeout
      // THEY personally set — per "only the mod who set it can clear it
      // early." A mod looking at a timeout someone else (owner or another
      // mod) set just sees the countdown with no click action.
      const canClear = staffMenuMode === "owner" || (staffMenuMode === "mod" && setBy === String(myLoginId));
      if (canClear) {
        timeoutBtn.addEventListener("click", () => {
          ChatBackend.clearTimeout_(loginId).then(async () => {
            if (staffMenuMode === "mod") {
              // Belt-and-suspenders: watchModIssuedTimeoutExpiry (started
              // when this timeout was set) already starts the cooldown the
              // moment this remove() fires. This second call is a no-op
              // duplicate write in the normal case, and only matters if
              // that watcher somehow isn't still attached (e.g. a page
              // reload happened between setting and clearing).
              await ChatBackend.startModRetimeoutCooldown(myLoginId, loginId).catch(() => {});
            }
            renderOwnerMenuList();
          }).catch(() => {
            showComposerNotice("Couldn't clear mute — try again.");
          });
        });
        timeoutBtn.title = "Click to clear this mute early";
      } else {
        timeoutBtn.disabled = true;
        timeoutBtn.title = "Only the mod who set this can clear it early";
      }
    } else {
      const cooldownMs = found.cooldownMs || 0;
      if (cooldownMs > 0) {
        timeoutBtn.textContent = "Wait " + Math.ceil(cooldownMs / 1000) + "s";
        timeoutBtn.disabled = true;
        timeoutBtn.title = "Re-mute cooldown for this person";
      } else {
        timeoutBtn.textContent = "Timeout";
        timeoutBtn.disabled = !loginId;
        timeoutBtn.title = loginId ? "Set a mute for login ID #" + loginId : "This user has not supplied a login ID";
        timeoutBtn.addEventListener("click", () => { if (loginId) openTimeoutSetModal(entry); });
      }
    }
    actions.appendChild(timeoutBtn);

    // Nobody can act on someone of the same or higher rank.
    if (loginId && rankOfLoginId(loginId) >= myRank()) {
      actions.querySelectorAll("button").forEach(b => { b.disabled = true; b.title = "Same or higher rank than you"; });
    }

    row.appendChild(actions);
    $ownerMenuList.appendChild(row);
  }
}

/* ── Timeout duration modal — shared by both menus, limits/defaults set
   by openTimeoutSetModal based on staffMenuMode. ── */
function openTimeoutSetModal(target) {
  pendingTimeoutTarget = target;
  pendingTemporaryModTarget = null;
  pendingTempBanTarget = null;
  $timeoutReasonInput.value = ""; $timeoutReasonInput.style.display = "";
  $timeoutSetConfirmBtn.textContent = "Timeout";
  $timeoutSetTitle.textContent = "Mute " + target.name + " (#" + target.loginId + ")";

  if (staffMenuMode === "mod") {
    const defaultSecs = MOD_TIMEOUT_DEFAULT_MS / 1000;
    $timeoutMinutesInput.value = String(Math.floor(defaultSecs / 60));
    $timeoutSecondsInput.value = String(defaultSecs % 60);
    $timeoutSetNote.textContent = "Allowed: " + limitsText(timeoutLimitsForRank(myRank())) + ". Prefilled with " + formatDurationShort(MOD_TIMEOUT_DEFAULT_MS) + ".";
  } else {
    $timeoutMinutesInput.value = "";
    $timeoutSecondsInput.value = "";
    $timeoutSetNote.textContent = "Allowed: " + limitsText(timeoutLimitsForRank(myRank())) + ".";
  }

  $timeoutSetErr.textContent = "";
  $timeoutSetOverlay.style.display = "flex";
  $timeoutMinutesInput.focus();
}

function openTemporaryModSetModal(target) {
  pendingTemporaryModTarget = target;
  pendingTimeoutTarget = null;
  pendingTempBanTarget = null;
  $timeoutReasonInput.value = ""; $timeoutReasonInput.style.display = "none";
  $timeoutSetTitle.textContent = "Temporary Mod for " + target.name + " (#" + target.loginId + ")";
  $timeoutMinutesInput.value = "";
  $timeoutSecondsInput.value = "";
  $timeoutSetNote.textContent = "Allowed: " + limitsText(TIME_LIMITS.tempGrant) + ".";
  $timeoutSetErr.textContent = "";
  $timeoutSetConfirmBtn.textContent = "Grant Temp Mod";
  $timeoutSetOverlay.style.display = "flex";
  $timeoutMinutesInput.focus();
}

// Temporary BAN length picker. Staff could only ever make a temporary ban by typing
// /tempban; the menu's Ban button was permanent-only. Picking a length here leads to
// the same confirmation (and the same "bans the account ID" wording) as the command.
function openTempBanSetModal(target) {
  pendingTempBanTarget = target;
  pendingTimeoutTarget = null;
  pendingTemporaryModTarget = null;
  $timeoutReasonInput.value = ""; $timeoutReasonInput.style.display = "";
  $timeoutSetTitle.textContent = "Temporary ban for " + target.name + " (#" + target.loginId + ")";
  $timeoutMinutesInput.value = "";
  $timeoutSecondsInput.value = "";
  $timeoutSetNote.textContent = "Allowed: " + limitsText(banLimitsForRank(myRank())) + ". You will be asked to confirm next.";
  $timeoutSetErr.textContent = "";
  $timeoutSetConfirmBtn.textContent = "Continue";
  $timeoutSetOverlay.style.display = "flex";
  $timeoutMinutesInput.focus();
}

$timeoutSetCancelBtn.addEventListener("click", () => {
  pendingTimeoutTarget = null;
  pendingTemporaryModTarget = null;
  pendingTempBanTarget = null;
  $timeoutSetOverlay.style.display = "none";
});
$timeoutSetOverlay.addEventListener("click", (e) => {
  if (e.target === $timeoutSetOverlay) {
    pendingTimeoutTarget = null;
    pendingTemporaryModTarget = null;
    pendingTempBanTarget = null;
    $timeoutSetOverlay.style.display = "none";
  }
});

// Digit-only guards on the two duration fields — minutes capped to a
// single digit (0-3) and seconds to two digits (0-59) at the input level,
// with the real 3:00 ceiling enforced on submit below regardless of what
// slips through here.
$timeoutMinutesInput.addEventListener("input", () => {
  $timeoutMinutesInput.value = $timeoutMinutesInput.value.replace(/[^0-9]/g, "").slice(0, 5);
});
$timeoutSecondsInput.addEventListener("input", () => {
  $timeoutSecondsInput.value = $timeoutSecondsInput.value.replace(/[^0-9]/g, "").slice(0, 2);
});

$timeoutSetConfirmBtn.addEventListener("click", async () => {
  if (!pendingTimeoutTarget && !pendingTemporaryModTarget && !pendingTempBanTarget) return;
  const mins = parseInt($timeoutMinutesInput.value || "0", 10) || 0;
  const secs = parseInt($timeoutSecondsInput.value || "0", 10) || 0;
  const totalMs = (mins * 60 + secs) * 1000;
  const limits = pendingTempBanTarget
    ? banLimitsForRank(myRank())
    : pendingTemporaryModTarget
      ? TIME_LIMITS.tempGrant
      : timeoutLimitsForRank(myRank());
  const problem = checkDurationLimits(totalMs, limits);
  if (problem) {
    $timeoutSetErr.textContent = problem;
    return;
  }

  $timeoutSetConfirmBtn.disabled = true;
  $timeoutSetErr.textContent = "";
  try {
    if (pendingTempBanTarget) {
      const banTarget = pendingTempBanTarget;
      pendingTempBanTarget = null;
      $timeoutSetOverlay.style.display = "none";
      $timeoutSetConfirmBtn.textContent = "Timeout";
      openBanConfirm({ name: banTarget.name, loginId: banTarget.loginId }, totalMs, $timeoutReasonInput.value.trim());
      return;
    }
    if (pendingTemporaryModTarget) {
      const target = pendingTemporaryModTarget;
      await ChatBackend.grantTemporaryRoleToId("mod", target.loginId, totalMs, myLoginId);
      pendingTemporaryModTarget = null;
      $timeoutSetOverlay.style.display = "none";
      $timeoutSetConfirmBtn.textContent = "Timeout";
      renderOwnerMenuList();
      showComposerNotice("Granted temporary Mod to " + target.name + ".");
      return;
    }
    if (isProtected(pendingTimeoutTarget.loginId)) {
      $timeoutSetErr.textContent = PROTECTION_EMOJI + " " + (pendingTimeoutTarget.name || "That person") + " is protected and can't be muted.";
      $timeoutSetConfirmBtn.disabled = false;
      return;
    }
    await ChatBackend.setTimeout_(pendingTimeoutTarget.loginId, totalMs, myLoginId, $timeoutReasonInput.value.trim());
    // NOTE: the re-timeout cooldown is deliberately NOT started here. It
    // should apply AFTER the timeout ends (naturally or via early clear),
    // not from the moment it's set — starting it here would let most of
    // the 7s tick away underneath a long timeout instead of coming after
    // it. See watchModIssuedTimeoutExpiry for where it actually starts.
    if (staffMenuMode === "mod") {
      watchModIssuedTimeoutExpiry(myLoginId, pendingTimeoutTarget.loginId);
    }
    $timeoutSetOverlay.style.display = "none";
    pendingTimeoutTarget = null;
    renderOwnerMenuList();
  } catch (e) {
    $timeoutSetErr.textContent = "Couldn't set mute — try again.";
  } finally {
    $timeoutSetConfirmBtn.disabled = false;
  }
});

// Watches a mod-issued timeout on targetName and starts that mod's
// re-timeout cooldown against targetName the moment it actually ends —
// either by running out naturally, or by being cleared early (which also
// calls startModRetimeoutCooldown directly in the "clear" click handler in
// renderOwnerMenuList; that early-clear path additionally removes the
// Firebase record, which this watcher treats the same as natural expiry).
// Firebase's "value" listener only fires on writes, not on the passage of
// time, so a plain listener would never notice a record that simply goes
// stale — this pairs the listener with a timer set for exactly when
// expiresAt is reached, and re-arms that timer if the record changes
// (e.g. an owner extends/replaces it) before then.
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
    if ($modListOverlay.style.display === "flex") renderModList();
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

/* ── Grant/Remove-mod double confirm — shares one overlay, `pendingModConfirmAction`
   tracks whether this open is a grant or a remove so the confirm button
   applies the right change. Kept as one modal since the two flows are
   otherwise identical (name a target, ask for a second explicit click). ── */
let pendingModConfirmAction = null; // "grant" | "remove"

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
    const targetId = loginIdForName(pendingGrantModTarget);
    if (!targetId) throw new Error("That user needs a VUS DM account.");
    if (pendingModConfirmAction === "grant") {
      await ChatBackend.grantRoleToId("mod", targetId);
    } else {
      await ChatBackend.removeRoleFromId("mod", targetId);
    }
    $grantModConfirmOverlay.style.display = "none";
    pendingGrantModTarget = null;
    pendingModConfirmAction = null;
    renderOwnerMenuList();
  } catch (e) {
    showComposerNotice("Couldn't update Mod status — try again.");
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

// The green dot is now ONLY a connection indicator (green = online, red =
// offline). The old menu that hung off it lives behind the settings button.
$settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = $globalClearPanel.style.display === "block";
  if (isOpen) closeClearPanel();
  else openModMenu();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "`") return;
  if (!myLoginId || myRank() < ROLES.mod.rank) return;   // staff hotkey
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


function handleTypingActivity() {
  const hasText = $msgInput.value.trim().length > 0;
  clearTimeout(typingStopTimer);

  if (hasText) {
    if (!isCurrentlyTyping) {
      isCurrentlyTyping = true;
      ChatBackend.setTyping(myName);
    } else {
      ChatBackend.setTyping(myName);
    }
    typingStopTimer = setTimeout(stopTyping, 2000);
  } else {
    stopTyping();
  }
}

function stopTyping() {
  clearTimeout(typingStopTimer);
  if (isCurrentlyTyping) {
    isCurrentlyTyping = false;
    ChatBackend.clearTyping();
  }
}

// "Who is typing" keeps a stable order: the first person to start stays first, the next
// is second, and when someone stops (or sends) everyone behind them moves up one.
let typingOrder = [];
function renderTyping(names) {
  names = names.filter(n => !isMuted(loginIdForName(n)));
  const present = new Set(names);
  typingOrder = typingOrder.filter(n => present.has(n));
  names.forEach(n => { if (!typingOrder.includes(n)) typingOrder.push(n); });   // newcomers go last (names arrive oldest-first)
  const list = typingOrder;
  if (list.length === 0) {
    $typingBar.classList.add("idle");
    $typingBar.textContent = "\u00a0";
    return;
  }
  let text;
  if (list.length >= 4) text = "Several people are typing\u2026";
  else if (list.length === 1) text = list[0] + " is typing\u2026";
  else if (list.length === 2) text = list[0] + " and " + list[1] + " are typing\u2026";
  else text = list[0] + ", " + list[1] + " and " + list[2] + " are typing\u2026";
  $typingBar.textContent = text;   // textContent: names are never parsed as HTML
  $typingBar.classList.remove("idle");
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
      showComposerNotice("Ping failed to send — check your connection.");
    })
    .finally(() => {
      $pingYouSend.disabled = false;
      $pingYouSend.textContent = "Send Ping";
    });
});

let mentionDropdownOpen = false;
let mentionTriggerCharIndex = -1;
let mentionDropdownMode = "mention";
let mentionQuery = "";
let mentionActiveIdx = 0;
let mentionSearchToken = 0;
let mentionSearchHits = [];

/* ══════════ Inline @mentions ══════════
   A mention is "@Name" anywhere in the message, several per message. When it goes out, each one carries an invisible
   marker after the name: silent or ping. (The first one is also written to the old single `mention` field, so older
   tabs still show it.) In the box, mentions are highlighted; click into one (or just pick it) to switch Silent/Ping
   from a popup above it, or press its x to remove it. */
const MARK_SILENT = "⁣", MARK_PING = "⁤";
const MENTION_MAX = 5;
const picked = new Map();          // name -> true when it should ping with a sound
let popupFor = null;               // name whose popup stays open right after picking
let mirrorSegs = [];
let lastMirrorText = null;
const $mentionMirror = document.getElementById("mentionMirror");
function stripMentionMarks(t) { return String(t || "").replace(/[⁣⁤]/g, ""); }
function parseMentionTokens(text) {
  const out = [], re = /@([^\s@⁣⁤​]{1,40})([⁣⁤])/g;
  text = String(text || "");
  let m;
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, name: m[1], ping: m[2] === MARK_PING });
  return out;
}
// where the picked @Names sit in the box right now
function composerSegments(text) {
  const segs = [];
  [...picked.keys()].sort((x, y) => y.length - x.length).forEach(n => {
    const tok = "@" + n;
    let i = 0;
    while ((i = text.indexOf(tok, i)) >= 0) {
      const end = i + tok.length, nx = text[end], pv = text[i - 1];
      const okAfter = !nx || !/[\p{L}\p{N}_\-]/u.test(nx), okBefore = i === 0 || !/[\p{L}\p{N}_]/u.test(pv);
      if (okAfter && okBefore && !segs.some(s => i < s.end && end > s.start)) segs.push({ start: i, end, name: n });
      i = end;
    }
  });
  return segs.sort((p, q) => p.start - q.start);
}
function markText(text, segs, pingOk) {
  let out = "", pos = 0;
  segs.forEach(s => { out += text.slice(pos, s.start) + "@" + s.name + (pingOk.has(s.name) ? MARK_PING : MARK_SILENT); pos = s.end; });
  return out + text.slice(pos);
}
function syncMentionMirror() {
  const text = $msgInput.value;
  lastMirrorText = text;
  const segs = composerSegments(text);
  const present = new Set(segs.map(x => x.name));
  [...picked.keys()].forEach(n => { if (!present.has(n)) picked.delete(n); });
  mirrorSegs = segs;
  if (!segs.length) { $mentionMirror.style.display = "none"; $mentionMirror.textContent = ""; updateMentionPopup(); return; }
  const cs = getComputedStyle($msgInput);
  ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "textIndent", "wordSpacing"].forEach(p => { $mentionMirror.style[p] = cs[p]; });
  $mentionMirror.style.display = "block";
  $mentionMirror.textContent = "";
  let pos = 0;
  segs.forEach((sg, i) => {
    if (sg.start > pos) $mentionMirror.appendChild(document.createTextNode(text.slice(pos, sg.start)));
    const sp = document.createElement("span");
    sp.className = "mt" + (picked.get(sg.name) ? " ping" : "");
    sp.dataset.idx = String(i);
    sp.appendChild(document.createTextNode(text.slice(sg.start, sg.end)));
    const x = document.createElement("span");
    x.className = "mt-x"; x.dataset.idx = String(i); x.textContent = "×"; x.title = "Remove mention";
    sp.appendChild(x);
    if (picked.get(sg.name)) { const bl = document.createElement("span"); bl.className = "mt-bell"; bl.textContent = "🔔"; sp.appendChild(bl); }
    $mentionMirror.appendChild(sp);
    pos = sg.end;
  });
  if (pos < text.length) $mentionMirror.appendChild(document.createTextNode(text.slice(pos)));
  if (text.endsWith("\n")) $mentionMirror.appendChild(document.createTextNode("​"));
  $mentionMirror.scrollTop = $msgInput.scrollTop;
  updateMentionPopup();
}
function removeMentionSeg(i) {
  const v = $msgInput.value, sg = composerSegments(v)[i];
  if (!sg) return;
  let end = sg.end;
  if (v[end] === " ") end++;
  $msgInput.value = v.slice(0, sg.start) + v.slice(end);
  $msgInput.selectionStart = $msgInput.selectionEnd = sg.start;
  popupFor = null;
  syncMentionMirror(); autosizeInput(); updateCharCounter(); $msgInput.focus();
}
$mentionMirror.addEventListener("click", e => {
  const x = e.target.closest && e.target.closest(".mt-x");
  if (x) { e.preventDefault(); removeMentionSeg(Number(x.dataset.idx)); }
});
$mentionMirror.addEventListener("mousedown", e => { if (e.target.closest && e.target.closest(".mt-x")) e.preventDefault(); });

let mentionPopupEl = null, mentionPopupName = null, mentionPopupIdx = -1;
function ensureMentionPopup() {
  if (mentionPopupEl) return mentionPopupEl;
  const p = document.createElement("div");
  p.id = "mentionPopup";
  p.innerHTML = '<span class="mp-name"></span><button type="button" data-a="silent">🔕 Silent</button><button type="button" data-a="ping">🔔 Ping</button><button type="button" data-a="remove" class="mp-x" title="Remove mention">✕</button>';
  p.addEventListener("mousedown", e => e.preventDefault());   // keep the caret in the message box
  p.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b || !mentionPopupName) return;
    const n = mentionPopupName, act = b.dataset.a;
    if (act === "remove") { removeMentionSeg(mentionPopupIdx); return; }
    picked.set(n, act === "ping");
    popupFor = null;
    syncMentionMirror();
    $msgInput.focus();
  });
  document.body.appendChild(p);
  return (mentionPopupEl = p);
}
function hideMentionPopup() { if (mentionPopupEl) mentionPopupEl.style.display = "none"; mentionPopupName = null; }
function updateMentionPopup() {
  const segs = mirrorSegs;
  if (!segs.length || document.activeElement !== $msgInput && !popupFor) { hideMentionPopup(); return; }
  let idx = -1;
  if (popupFor) idx = segs.findIndex(sg => sg.name === popupFor);
  if (idx < 0 && $msgInput.selectionStart === $msgInput.selectionEnd) {
    const c = $msgInput.selectionStart;
    idx = segs.findIndex(sg => c >= sg.start && c <= sg.end);
  }
  if (idx < 0) { hideMentionPopup(); return; }
  const sp = $mentionMirror.querySelector('.mt[data-idx="' + idx + '"]');
  if (!sp) { hideMentionPopup(); return; }
  const r = sp.getBoundingClientRect(), box = $mentionMirror.getBoundingClientRect();
  if (r.bottom < box.top || r.top > box.bottom) { hideMentionPopup(); return; }
  const p = ensureMentionPopup(), name = segs[idx].name, ping = !!picked.get(name);
  mentionPopupName = name; mentionPopupIdx = idx;
  p.querySelector(".mp-name").textContent = "@" + name;
  p.querySelector('[data-a="silent"]').classList.toggle("on", !ping);
  p.querySelector('[data-a="ping"]').classList.toggle("on", ping);
  p.style.display = "flex";
  const w = p.offsetWidth;
  p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  p.style.bottom = (window.innerHeight - r.top + 8) + "px";
}
function clearMention() {
  picked.clear(); popupFor = null;
  syncMentionMirror();
}
$msgInput.addEventListener("input", () => { popupFor = null; syncMentionMirror(); });
["keyup", "click", "focus"].forEach(ev => $msgInput.addEventListener(ev, () => updateMentionPopup()));
$msgInput.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== $msgInput) { popupFor = null; hideMentionPopup(); } }, 160));
$msgInput.addEventListener("scroll", () => { $mentionMirror.scrollTop = $msgInput.scrollTop; updateMentionPopup(); });
window.addEventListener("resize", () => { if (mirrorSegs.length) syncMentionMirror(); });
setInterval(() => { if ($msgInput.value !== lastMirrorText) syncMentionMirror(); }, 200);   // catches changes made by code (send, edit)

function mentionCandidates(q) {
  q = String(q || "").toLowerCase();
  const onlineIds = new Set(latestPresenceList.map(e => String(e.loginId || "")));
  const seen = new Set([myName]);
  const usable = n => n && !/[\s@⁣⁤​]/.test(n) && n.length <= 40;
  const online = [], offline = [];
  latestPresenceList.forEach(e => { if (usable(e.name) && !seen.has(e.name)) { seen.add(e.name); online.push({ name: e.name, online: true }); } });
  knownPeople.forEach((name, id) => { if (usable(name) && !seen.has(name) && !onlineIds.has(id)) { seen.add(name); offline.push({ name, online: false }); } });
  mentionSearchHits.forEach(name => { if (usable(name) && !seen.has(name)) { seen.add(name); offline.push({ name, online: false }); } });
  const rank = c => { const l = c.name.toLowerCase(); return !q || l.startsWith(q) ? 0 : l.includes(q) ? 1 : 2; };
  const f = list => list.filter(c => rank(c) < 2).sort((p, r) => rank(p) - rank(r) || p.name.localeCompare(r.name));
  return { online: f(online), offline: f(offline) };
}
function pickMention(name) {
  if (picked.size >= MENTION_MAX && !picked.has(name)) { showComposerNotice("You can mention up to " + MENTION_MAX + " people in one message."); return; }
  const v = $msgInput.value, cur = $msgInput.selectionStart;
  const start = mentionTriggerCharIndex >= 0 ? mentionTriggerCharIndex : cur;
  const before = v.slice(0, start), after = v.slice(cur).replace(/^ /, "");
  const ins = "@" + name + " ";
  $msgInput.value = before + ins + after;
  $msgInput.selectionStart = $msgInput.selectionEnd = before.length + ins.length;
  if (!picked.has(name)) picked.set(name, false);
  closeMentionDropdown();
  syncMentionMirror();
  popupFor = name;
  updateMentionPopup();
  $msgInput.focus();
  autosizeInput(); updateCharCounter();
}
function renderMentionDropdown() {
  $mentionDropdown.innerHTML = "";
  addMentionCancelRow(mentionQuery ? "Mention “" + mentionQuery + "”…" : "Mention someone");
  const { online, offline } = mentionCandidates(mentionQuery);
  const rows = [];
  const group = (label, list) => {
    if (!list.length) return;
    const g = document.createElement("div");
    g.className = "mention-group";
    g.textContent = label + " — " + list.length;
    $mentionDropdown.appendChild(g);
    list.forEach(c => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mention-option";
      const dot = document.createElement("span"); dot.className = "mo-dot " + (c.online ? "on" : "off");
      const nm = document.createElement("span"); nm.className = "mo-name"; nm.textContent = c.name;
      btn.append(dot, nm);
      if (!c.online) { const t = document.createElement("span"); t.className = "mo-tag"; t.textContent = "offline"; btn.appendChild(t); }
      btn.addEventListener("mousedown", e => e.preventDefault());
      btn.addEventListener("click", () => pickMention(c.name));
      $mentionDropdown.appendChild(btn);
      rows.push(btn);
    });
  };
  group("Online", online);
  group("Offline (they’ll see it when they’re back)", offline);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "mention-empty";
    empty.textContent = mentionQuery ? "No one found. Keep typing the start of their name." : "No one to mention yet.";
    $mentionDropdown.appendChild(empty);
  }
  mentionActiveIdx = Math.min(mentionActiveIdx, Math.max(0, rows.length - 1));
  if (rows[mentionActiveIdx]) rows[mentionActiveIdx].classList.add("active");
}
function openMentionDropdown(triggerIndex, query) {
  const q = query || "";
  if (!mentionDropdownOpen || q !== mentionQuery) mentionActiveIdx = 0;
  mentionDropdownMode = "mention";
  mentionTriggerCharIndex = triggerIndex;
  mentionQuery = q;
  mentionDropdownOpen = true;
  $mentionDropdown.style.display = "block";
  renderMentionDropdown();
  // people who haven't chatted on this device: look them up by the start of their name
  const token = ++mentionSearchToken;
  mentionSearchHits = [];
  if (q.length >= 2 && window.VUS_DM && window.VUS_DM.searchUsernames) {
    window.VUS_DM.searchUsernames(q).then(list => {
      if (token !== mentionSearchToken || !mentionDropdownOpen || mentionDropdownMode !== "mention") return;
      mentionSearchHits = list.map(x => x.username);
      renderMentionDropdown();
    }).catch(() => {});
  }
}
// arrow keys + Enter/Tab pick from the list while it is open (before Enter would send the message)
$msgInput.addEventListener("keydown", e => {
  if (!mentionDropdownOpen || mentionDropdownMode !== "mention") return;
  const rows = [...$mentionDropdown.querySelectorAll(".mention-option")];
  if (!rows.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); e.stopImmediatePropagation();
    mentionActiveIdx = (mentionActiveIdx + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle("active", i === mentionActiveIdx));
    rows[mentionActiveIdx].scrollIntoView({ block: "nearest" });
  } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
    e.preventDefault(); e.stopImmediatePropagation();
    rows[mentionActiveIdx].click();
  }
}, true);

function closeMentionDropdown() {
  mentionSearchToken++;
  mentionDropdownOpen = false;
  mentionDropdownMode = "mention";
  $mentionDropdown.style.display = "none";
  $mentionDropdown.innerHTML = "";
}

function addMentionCancelRow(labelText) {
  const row = document.createElement("div");
  row.className = "mention-head";
  const label = document.createElement("span");
  label.textContent = labelText || "Mention someone";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "mention-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("mousedown", (e) => e.preventDefault());   // keep focus in the message box
  cancel.addEventListener("click", (e) => { e.stopPropagation(); closeMentionDropdown(); $msgInput.focus(); });
  row.append(label, cancel);
  $mentionDropdown.appendChild(row);
}

function openModerationTargetDropdown(tokenStart) {
  mentionDropdownMode = "moderation";
  mentionTriggerCharIndex = tokenStart;
  mentionDropdownOpen = true;
  $mentionDropdown.style.display = "block";
  $mentionDropdown.innerHTML = "";
  addMentionCancelRow("Pick a user");

  const typed = $msgInput.value.slice(tokenStart).trim().toLowerCase();
  const candidates = latestPresenceList
    .filter(entry => entry.name !== myName && entry.loginId)
    .filter(entry => !typed || entry.name.toLowerCase().startsWith(typed))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (candidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mention-empty";
    empty.textContent = "No logged-in users match.";
    $mentionDropdown.appendChild(empty);
    return;
  }

  candidates.forEach(entry => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mention-option";
    btn.textContent = entry.name + " (#" + entry.loginId + ")";
    btn.addEventListener("click", () => {
      const cursor = $msgInput.selectionStart;
      const before = $msgInput.value.slice(0, mentionTriggerCharIndex);
      const after = $msgInput.value.slice(cursor);
      $msgInput.value = before + entry.name + after;
      $msgInput.selectionStart = $msgInput.selectionEnd = before.length + entry.name.length;
      closeMentionDropdown();
      $msgInput.focus();
    });
    $mentionDropdown.appendChild(btn);
  });
}

function refreshMentionDropdownIfOpen() {
  if (!mentionDropdownOpen) return;
  if (mentionDropdownMode === "moderation") {
    openModerationTargetDropdown(mentionTriggerCharIndex);
  } else {
    renderMentionDropdown();
  }
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && mentionDropdownOpen) { closeMentionDropdown(); } });

document.addEventListener("click", (e) => {
  if (mentionDropdownOpen && !$mentionDropdown.contains(e.target) && e.target !== $msgInput) {
    closeMentionDropdown();
  }
});

/* ══════════════════════════════════════════════════════════
   COMMAND LIST + GHOST HELPER
   - Typing "/" as the first thing in the box opens a clickable list of every
     command YOUR rank can use, filtered live as you keep typing.
   - A faint transparent ghost shows the rest of the top match right in the
     input; Tab (or clicking a row) fills it in.
   - Clicking anywhere outside the list closes it.
   ══════════════════════════════════════════════════════════ */
let commandListOpen = false;
let commandActiveIndex = 0;
let commandMatches = [];

// The command word currently being typed, only while the cursor is still in
// the first word ("/ti" yes, "/timeout 10m al" no -- past the command).
function currentCommandToken() {
  const value = $msgInput.value;
  if (!value.startsWith("/")) return null;
  const firstSpace = value.search(/\s/);
  if (firstSpace !== -1 && $msgInput.selectionStart > firstSpace) return null;
  return firstSpace === -1 ? value : value.slice(0, firstSpace);
}

function closeCommandList() {
  commandListOpen = false;
  commandMatches = [];
  $commandList.style.display = "none";
  $commandList.innerHTML = "";
  updateCommandGhost();
}

function acceptCommand(cmd) {
  if (!cmd) return;
  $msgInput.value = cmd.insert;
  $msgInput.selectionStart = $msgInput.selectionEnd = $msgInput.value.length;
  closeCommandList();
  $msgInput.focus();
  autosizeInput();
  updateCharCounter();
  // Landing on "/ban " etc. should flow straight into the name popup.
  handleMentionTrigger();
}

function updateCommandGhost() {
  $commandGhost.innerHTML = "";
  const token = currentCommandToken();
  const top = commandMatches[commandActiveIndex] || commandMatches[0];
  if (!token || !top || $msgInput.value.length !== token.length) return;
  // Only ghost when the typed text is a strict prefix of the match.
  if (!top.name.toLowerCase().startsWith(token.toLowerCase()) || top.name.length === token.length) {
    return;
  }
  const typed = document.createElement("span");
  typed.textContent = $msgInput.value;
  const hint = document.createElement("span");
  hint.className = "ghost-hint";
  hint.textContent = top.name.slice(token.length) + (top.args ? " " + top.args : "");
  const tab = document.createElement("span");
  tab.className = "ghost-tab";
  tab.textContent = "Tab";
  $commandGhost.appendChild(typed);
  $commandGhost.appendChild(hint);
  $commandGhost.appendChild(tab);
}

function renderCommandList() {
  const token = currentCommandToken();
  if (token === null || !myLoginId) { closeCommandList(); return; }

  if (availableSlashCommands().length === 0) { closeCommandList(); return; }   // nothing to offer this rank

  const lower = token.toLowerCase();
  commandMatches = availableSlashCommands().filter(c => c.name.toLowerCase().startsWith(lower));
  if (commandActiveIndex >= commandMatches.length) commandActiveIndex = 0;

  closeMentionDropdown();
  commandListOpen = true;
  $commandList.style.display = "block";
  $commandList.innerHTML = "";

  if (commandMatches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "command-empty";
    empty.textContent = availableSlashCommands().length === 0
      ? "No commands available for your rank."
      : "No matching command.";
    $commandList.appendChild(empty);
    updateCommandGhost();
    return;
  }

  commandMatches.forEach((cmd, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "command-option" + (i === commandActiveIndex ? " active" : "");
    btn.setAttribute("role", "option");
    btn.innerHTML =
      '<span class="cmd-name">' + esc(cmd.name) + '</span>' +
      (cmd.args ? '<span class="cmd-args">' + esc(cmd.args) + '</span>' : '') +
      '<span class="cmd-desc">' + esc(commandDescription(cmd)) + '</span>';
    // mousedown (not click) so the textarea never loses focus first.
    btn.addEventListener("mousedown", e => { e.preventDefault(); acceptCommand(cmd); });
    btn.addEventListener("mouseenter", () => { commandActiveIndex = i; highlightCommandRow(); updateCommandGhost(); });
    $commandList.appendChild(btn);
  });
  updateCommandGhost();
}

function highlightCommandRow() {
  [...$commandList.querySelectorAll(".command-option")].forEach((el, i) => {
    el.classList.toggle("active", i === commandActiveIndex);
    if (i === commandActiveIndex) el.scrollIntoView({ block: "nearest" });
  });
}

// Tab accepts the highlighted command; Up/Down move; Esc closes. Returns true
// when the key was consumed so the caller can skip its own handling.
function handleCommandKeydown(e) {
  if (!commandListOpen) return false;
  if (e.key === "Escape") { e.preventDefault(); closeCommandList(); return true; }
  if (!commandMatches.length) return false;
  if (e.key === "Tab") {
    e.preventDefault();
    acceptCommand(commandMatches[commandActiveIndex] || commandMatches[0]);
    return true;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    commandActiveIndex = (commandActiveIndex + 1) % commandMatches.length;
    highlightCommandRow(); updateCommandGhost();
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    commandActiveIndex = (commandActiveIndex - 1 + commandMatches.length) % commandMatches.length;
    highlightCommandRow(); updateCommandGhost();
    return true;
  }
  return false;
}

// Click anywhere outside the list/input closes it.
document.addEventListener("mousedown", (e) => {
  if (!commandListOpen) return;
  if ($commandList.contains(e.target) || e.target === $msgInput) return;
  closeCommandList();
});
$msgInput.addEventListener("blur", () => {
  // Small delay so a row's mousedown handler can run first.
  setTimeout(() => { if (document.activeElement !== $msgInput) closeCommandList(); }, 120);
});

function handleMentionTrigger() {
  // "/" at the start of the box -> command list (takes priority over @).
  if (currentCommandToken() !== null) {
    renderCommandList();
    return;
  }
  if (commandListOpen) closeCommandList();
  const cursor = $msgInput.selectionStart;
  const before = $msgInput.value.slice(0, cursor);
  const moderationMatch = before.match(/(?:^|\s)\/(?:ban\s+|kick\s+|image\s+(?:on|off)\s+|(?:timeout|mute)\s+\S+\s+|tempban\s+\S+\s+|remove\s+\S+\s+|grant\s+(?:normie|mod|admin|coowner)\s+(?:(?:\S+\s+)?))([^\s]*)$/i);
  if (moderationMatch) {
    openModerationTargetDropdown(cursor - moderationMatch[1].length);
    return;
  }
  const am = before.match(/(^|\s)@([^\s@\u2063\u2064]{0,24})$/);
  if (am) openMentionDropdown(cursor - am[2].length - 1, am[2]);
  else if (mentionDropdownOpen && mentionDropdownMode === "mention") closeMentionDropdown();
}

let pingSoundReady = false;

function preloadPingSound() {
  $pingSound.src = PING_SOUND_URL;

  $pingSound.addEventListener("canplaythrough", () => {
    pingSoundReady = true;
    console.log("Ping sound loaded!");
  }, { once: true });

  $pingSound.addEventListener("error", () => {
    console.error("Ping sound failed to load:", $pingSound.error);
  }, { once: true });

  $pingSound.load();
}

function requestNotificationPermissionIfNeeded() {
  // Optional nicety -- must NEVER be able to break joining. Older Safari and
  // some in-app browsers return undefined (callback style) instead of a
  // Promise, or throw; both are swallowed here.
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      const result = Notification.requestPermission(() => {});
      if (result && typeof result.catch === "function") result.catch(() => {});
    }
  } catch (e) {}
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
  if (totalSecs >= 86400) {
    return Math.floor(totalSecs / 86400) + "d " + Math.floor((totalSecs % 86400) / 3600) + "h";
  }
  if (totalSecs >= 3600) {
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    return h + ":" + String(m).padStart(2, "0") + ":" + String(totalSecs % 60).padStart(2, "0");
  }
  return Math.floor(totalSecs / 60) + ":" + String(totalSecs % 60).padStart(2, "0");
}

function openRoomsSidebar() {
  $roomsSidebar.classList.add("open");
  renderRoomsSidebar();
  clearInterval(sidebarCountdownTimer);
  sidebarCountdownTimer = setInterval(renderRoomsSidebar, 1000);
}

function stopRoomsSidebarLive() {
  clearInterval(sidebarCountdownTimer);
}

// The rooms list is docked in the sidebar, so "close" only means: on phones,
// slide the drawer away after picking something; always clear the footer note.

/* ══════════════════════════════════════════════════════════
   ROOMS IN THE SERVER RAIL
   Main chat = the Chat button. Joined private rooms and public rooms get their own icon,
   "+" opens the room browser (join by code / new room / public list) beside the rail.
   ══════════════════════════════════════════════════════════ */
const $railRooms = document.getElementById("railRooms");
const $navRooms = document.getElementById("navRooms");
const $roomsRailDot = document.getElementById("roomsRailDot");
const $navChatBtn = document.getElementById("navChat");
const railMetaCache = {};
let railSignature = "";

function railRoomEntries() {
  const out = new Map();
  for (const code of joinedPrivateRoomCodes) {
    const m = railMetaCache[code];
    out.set(code, { code, name: (m && m.name) || ("Room " + code) });
    if (!m && !railMetaCache.__loading) {
      railMetaCache.__loading = true;
      RoomManager.getRoomMeta(code).then(meta => { if (meta) railMetaCache[code] = meta; }).catch(() => {})
        .then(() => { railMetaCache.__loading = false; });
    }
  }
  for (const m of publicRoomsList) if (m && m.code) out.set(m.code, { code: m.code, name: m.name || ("Room " + m.code) });
  if (currentRoomCode && !out.has(currentRoomCode)) {
    out.set(currentRoomCode, { code: currentRoomCode, name: (currentRoomMeta && currentRoomMeta.name) || ("Room " + currentRoomCode) });
  }
  return [...out.values()];
}

function railInitials(name) {
  const words = String(name || "?").trim().split(/\s+/).filter(Boolean);
  const chars = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2);
  return chars;
}

function renderRailRooms() {
  const shell = document.getElementById("appShell");
  if (shell) shell.classList.toggle("in-private-room", currentRoomCode !== null);
  const entries = railRoomEntries();
  const pinged = roomPingBadges.size > 0;
  $roomsRailDot.classList.toggle("show", pinged);
  const sig = entries.map(e => e.code + "|" + e.name + "|" + (roomPingBadges.has(e.code) ? 1 : 0)).join(",") + "#" + currentRoomCode;
  if (sig === railSignature) return;
  railSignature = sig;
  $railRooms.innerHTML = "";
  entries.forEach(e => {
    const btn = document.createElement("button");
    btn.className = "rail-nav-btn rail-room" + (currentRoomCode === e.code ? " active" : "");
    btn.title = e.name;
    btn.setAttribute("aria-label", e.name);
    btn.textContent = railInitials(e.name);
    if (roomPingBadges.has(e.code)) {
      const dot = document.createElement("span");
      dot.className = "rail-dot show";
      btn.appendChild(dot);
    }
    btn.addEventListener("click", () => {
      if (window.VUS_UI) window.VUS_UI.showChat();
      closeRoomsSidebar();
      joinRoomByCode(e.code);
    });
    $railRooms.appendChild(btn);
  });
}
setInterval(renderRailRooms, 1200);

// Chat button = main room (only when you're already in chat mode; from DMs it just returns).
$navChatBtn.addEventListener("click", () => {
  const shell = document.getElementById("appShell");
  const wasChat = shell && shell.classList.contains("mode-chat");
  if (shell) shell.classList.remove("rooms-open");
  $navRooms.classList.remove("active");
  if (wasChat && myName && currentRoomCode !== null) switchToMainRoom();
  else if (wasChat && myName && activeChannelId === "announce") openChannel("main");
  setTimeout(renderRailRooms, 0);
}, true);

// Going to DMs always closes the rooms list, so the rail never shows both lit.
window.addEventListener("vus:mode", (e) => {
  if (e.detail && e.detail.mode === "dm") {
    const shell = document.getElementById("appShell");
    if (shell) shell.classList.remove("rooms-open");
    $navRooms.classList.remove("active");
  }
});

$navRooms.addEventListener("click", () => {
  const shell = document.getElementById("appShell");
  const wasDm = shell.classList.contains("mode-dm");
  if (window.VUS_UI) window.VUS_UI.showChat();
  const open = wasDm ? true : !shell.classList.contains("rooms-open");
  shell.classList.toggle("rooms-open", open);
  $navRooms.classList.toggle("active", open);
  if (open && window.matchMedia("(max-width: 720px)").matches) shell.classList.add("nav-open");
  if (open) { renderRoomsSidebar(); }
});

function closeRoomsSidebar() {
  $roomsFooterMsg.textContent = "";
  $roomsFooterMsg.classList.remove("err");
  const shell = document.getElementById("appShell");
  if (shell) { shell.classList.remove("nav-open"); shell.classList.remove("rooms-open"); }
  if ($navRooms) $navRooms.classList.remove("active");
  setTimeout(renderRailRooms, 0);
}

$roomsToggleBtn.addEventListener("click", () => {
  const isOpen = $roomsSidebar.classList.contains("open");
  if (isOpen) closeRoomsSidebar(); else openRoomsSidebar();
});
$roomsSidebarClose.addEventListener("click", closeRoomsSidebar);

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
  const remaining = (meta.expiresAt || 0) - ChatBackend.serverNowSync();
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
  if (!myName) {
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
    showComposerNotice("That room no longer exists.");
    return;
  }

  if (roomPingBadges.has(code)) {
    roomPingBadges.delete(code);
    savePingBadgesToStorage();
    updateRoomsHeaderBadge();
  }

  teardownCurrentRoomMetaWatch();
  currentRoomCode = code;
  activeChannelId = null; paintChannelsUi();
  ChatBackend.bindToRoom(code);
  await ChatBackend.claimPresence(myName, false, myLoginId);
  watchMyTimeout();
  attachRoomListeners();

  $messages.innerHTML = "";
  messageCount = 0;
  $emptyState.style.display = "flex";

  $roomTopBar.style.display = "flex";
  unsubscribeRoomMeta = RoomManager.watchRoomMeta(code, onRoomMetaUpdate);
}

// Claims my spot in the room I just switched to. A leftover entry of my own (a ghost from an earlier visit) is
// cleared and the claim retried, instead of silently leaving me "in" a room without actually being listed.
async function claimSpotInCurrentRoom(silent) {
  let r = await ChatBackend.claimPresence(myName, !!silent, myLoginId);
  if (r && r.reason === "already-online") {
    try { await ChatBackend.removeAccountPresence(myLoginId); } catch (e) {}
    r = await ChatBackend.claimPresence(myName, !!silent, myLoginId);
  }
  if (r && r.ok && myAfk) { try { ChatBackend.setAfk(true); } catch (e) {} }
  return r;
}
async function switchToMainRoom() {
  if (currentRoomCode === null && activeChannelId === "main") return;
  activeChannelId = "main";

  teardownCurrentRoomMetaWatch();
  currentRoomCode = null;
  currentRoomMeta = null;
  ChatBackend.bindToRoom(MAIN_ROOM_ID);
  if (myName) await claimSpotInCurrentRoom();
  watchMyTimeout();
  attachRoomListeners();

  $messages.innerHTML = "";
  messageCount = 0;
  $emptyState.style.display = "flex";

  $roomTopBar.style.display = "none";
  clearInterval(topBarCountdownTimer);
  extendPromptShownForCode = null;
  paintChannelsUi();
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
    showComposerNotice("This room has closed.");
    switchToMainRoom();
    return;
  }

  currentRoomMeta = meta;

  if (meta.kicked && meta.kicked[ChatBackend._safeKey(String(myLoginId))] && kickStatus(meta, myLoginId) === "ok") {
    ChatBackend.releasePresenceSilently();
    showComposerNotice("You were removed from this room.");
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
  const remaining = (meta.expiresAt || 0) - ChatBackend.serverNowSync();

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
    showComposerNotice("Couldn't extend the room — try again.");
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
  const members = latestPresenceList.filter(e => e.loginId).sort((a, b) => a.name.localeCompare(b.name));

  if (members.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rooms-empty";
    empty.textContent = "No one else here yet.";
    $roomMembersList.appendChild(empty);
    return;
  }

  members.forEach(member => {
    const name = member.name;
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
          showComposerNotice("Couldn't send transfer offer — try again.");
        });
      });
      actions.appendChild(transferBtn);

      const kickBtn = document.createElement("button");
      kickBtn.className = "kick";
      kickBtn.textContent = "Kick";
      kickBtn.addEventListener("click", () => {
        pendingKickTarget = member;
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
    await RoomManager.kickFromRoom(currentRoomCode, pendingKickTarget.loginId);
  } catch (e) {
    showComposerNotice("Couldn't kick — try again.");
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
  if (handleCommandKeydown(e)) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    closeCommandList();
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
  if (!canPostImages()) return;

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

/* ══════════════════════════════════════════════════════════
   MEMBERS PANEL (right side of the chat view)
   Same data as the "N online" dropdown. Highest ranks first; clicking a
   person opens their profile with Add Friend.
   ══════════════════════════════════════════════════════════ */
const $membersList = document.getElementById("membersList");
const $membersCount = document.getElementById("membersCount");

const memberNameCache = {};   // loginId -> last known chat name (for offline rank holders)
const memberNameLoading = new Set();
let memberSongUnsubs = [];   // live "now playing" listeners for the rows currently drawn

let showOfflineRanks = false;   // offline rank-holders are tucked away until you expand the list
function renderMembersPane() {
  if (typeof renderChannelList === "function") renderChannelList();
  if (!$membersList) return;
  memberSongUnsubs.forEach(f => { try { f(); } catch (e) {} });
  memberSongUnsubs = [];
  const list = latestPresenceList || [];
  $membersCount.textContent = String(list.length);

  // Everyone online, plus everyone who holds a rank even if offline (shown dimmed),
  // like Discord's role list.
  const byId = {};
  list.forEach(entry => {
    const id = String(entry.loginId || "");
    byId[id || ("name:" + entry.name)] = { id, name: entry.name, online: true, joinedAt: entry.joinedAt || 0, afk: !!entry.afk };
  });
  Object.values(ROLES).forEach(role => {
    if (role.implicit) return;
    (roleIdHolders[role.id] || new Set()).forEach(rawId => {
      const id = String(rawId);
      if (byId[id] || !roleAttested(role.id, id)) return;
      const cached = memberNameCache[id];
      if (!cached && !memberNameLoading.has(id)) {
        memberNameLoading.add(id);
        ChatBackend.getProfile(id).then(p => {
          memberNameCache[id] = (p && p.lastName) || "";
        }).catch(() => { memberNameCache[id] = ""; }).then(() => { renderMembersPane(); });
      }
      if (cached) byId[id] = { id, name: cached, online: false, joinedAt: 0 };
    });
  });
  const everyone = Object.values(byId).map(p => {
    const role = (p.id && ROLES[effectiveRoleForLoginId(p.id)]) || ROLES.unranked;
    return Object.assign(p, { role });
  });
  const offlineTotal = everyone.filter(p => !p.online).length;
  const people = everyone.filter(p => showOfflineRanks || p.online).sort((a, b) =>
    b.role.rank - a.role.rank || (b.online - a.online) ||
    String(a.name || "").toLowerCase().localeCompare(String(b.name || "").toLowerCase()));

  const frag = document.createDocumentFragment();
  if (offlineTotal > 0 || showOfflineRanks) {
    const tog = document.createElement("button");
    tog.type = "button";
    tog.className = "member-offline-toggle";
    tog.textContent = showOfflineRanks ? "\u25BE Hide offline (" + offlineTotal + ")" : "\u25B8 Show offline (" + offlineTotal + ")";
    tog.title = showOfflineRanks ? "Hide offline rank-holders" : "Show offline rank-holders";
    tog.addEventListener("click", () => { showOfflineRanks = !showOfflineRanks; renderMembersPane(); });
    frag.appendChild(tog);
  }
  if (people.length === 0) {
    const empty = document.createElement("div");
    empty.className = "member-empty";
    empty.textContent = "No one's here yet.";
    frag.appendChild(empty);
  }
  const groupKey = role => (role.rank > 0 ? role.id : "online");
  const counts = {}, offCounts = {};
  people.forEach(p => { const k = groupKey(p.role); counts[k] = (counts[k] || 0) + 1; if (!p.online) offCounts[k] = (offCounts[k] || 0) + 1; });
  let lastGroup = null;
  people.forEach(p => {
    const role = p.role;
    const gk = groupKey(role);
    if (gk !== lastGroup) {
      lastGroup = gk;
      const head = document.createElement("div");
      head.className = "member-group-head role-" + gk;
      const onN = counts[gk] - (offCounts[gk] || 0);
      head.textContent = (role.rank > 0 ? role.icon + " " + role.label : "Online") + " — " + onN +
        (offCounts[gk] ? " \u00b7 " + offCounts[gk] + " offline" : "");
      frag.appendChild(head);
    }
    const row = document.createElement("div");
    row.className = "member-row role-" + gk + (p.online ? "" : " off");
    const wrap = document.createElement("div");
    wrap.className = "member-av-wrap";
    const av = document.createElement("div");
    av.className = "member-av";
    paintAvatar(av, p.id, p.name);
    wrap.appendChild(av);
    if (p.online) {
      const dot = document.createElement("div");
      dot.className = "member-dot" + (p.afk ? " afk" : "");
      if (p.afk) dot.title = "AFK";
      wrap.appendChild(dot);
    }
    const nameEl = document.createElement("div");
    nameEl.className = "member-name";
    const isMe = myLoginId && p.id === String(myLoginId);
    nameEl.textContent = (isMuted(p.id) ? "\uD83D\uDD07 " : "") + p.name + (isMe ? " (you)" : "");
    if (isMuted(p.id)) row.classList.add("muted");
    const textEl = document.createElement("div");
    textEl.className = "member-text";
    textEl.appendChild(nameEl);
    if (p.online && p.id && window.VUS_DM && window.VUS_DM.watchSongByLoginId) {
      const songEl = document.createElement("div");
      songEl.className = "member-song";
      songEl.style.display = "none";
      textEl.appendChild(songEl);
      memberSongUnsubs.push(window.VUS_DM.watchSongByLoginId(p.id, song => {
        if (!song) { songEl.style.display = "none"; songEl.textContent = ""; return; }
        const line = song.title + (song.artist ? " · " + song.artist : "");
        songEl.textContent = "♪ " + line;
        songEl.title = "Listening on MZK: " + line;
        songEl.style.display = "";
      }));
    }
    row.appendChild(wrap);
    row.appendChild(textEl);
    if (p.id) {
      row.addEventListener("click", () => { if (window.VUS_DM) window.VUS_DM.openChatUserProfile(p.id, p.name); });
    }
    frag.appendChild(row);
  });
  const mutedIds = Object.keys(Object.assign({}, mutedMap, autoMuted));
  if (mutedIds.length) {
    const head = document.createElement("div");
    head.className = "member-group-head role-muted";
    head.textContent = "\uD83D\uDD07 Muted \u2014 " + mutedIds.length;
    frag.appendChild(head);
    mutedIds.forEach(id => {
      const info = mutedMap[id] || autoMuted[id] || {};
      const row = document.createElement("div");
      row.className = "member-row muted-row";
      const text = document.createElement("div");
      text.className = "member-text";
      const nm = document.createElement("div");
      nm.className = "member-name";
      nm.textContent = (info.name || "Someone") + (autoMuted[id] && !mutedMap[id] ? " (auto)" : "");
      text.appendChild(nm);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "member-unmute";
      btn.textContent = "Unmute";
      btn.addEventListener("click", (e) => { e.stopPropagation(); toggleMute(id, info.name); });
      row.append(text, btn);
      frag.appendChild(row);
    });
  }
  $membersList.replaceChildren(frag);
}

function attachRoomListeners() {
  ChatBackend.watchPresenceCount(count => {
    $onlineCount.textContent = "";
    const ocNum = document.createElement("span"); ocNum.className = "oc-num"; ocNum.textContent = String(count);
    const ocWord = document.createElement("span"); ocWord.className = "oc-word"; ocWord.textContent = " online";
    $onlineCount.appendChild(ocNum); $onlineCount.appendChild(ocWord);
  });
  ChatBackend.watchPresenceList(list => {
    latestPresenceList = list;
    rebuildRoleHolders();
    renderMembersPane();
    if ($onlineListPanel.style.display === "block") renderOnlineListPanel();
    refreshMentionDropdownIfOpen();
    checkSoleSurvivorAutoOwnership(list);
  });
  liveSince = ChatBackend.serverNowSync();
  Object.keys(dupHistory).forEach(k => delete dupHistory[k]);
  Object.keys(burstTimes).forEach(k => delete burstTimes[k]);
  Object.keys(lastAccepted).forEach(k => delete lastAccepted[k]);
  msgEls.clear();
  annEls.clear(); pollEls.clear(); pollRecs.forEach(r => { if (r.modal) r.modal.remove(); }); pollRecs.clear();
  pollUnsubs.forEach(f => { try { f(); } catch (e) {} }); pollUnsubs = [];
  Object.keys(annRenderLast).forEach(k => delete annRenderLast[k]);
  Object.keys(pendingEdits).forEach(k => delete pendingEdits[k]);
  Object.keys(reactionsByMsg).forEach(k => delete reactionsByMsg[k]);
  replyingTo = null; editingMsgId = null; updateReplyBar();
  Object.keys(timeoutsAll).forEach(k => delete timeoutsAll[k]);
  ChatBackend.watchAllTimeouts((id, val) => { if (val) timeoutsAll[id] = val; else delete timeoutsAll[id]; refreshSilencedMessages(); });
  Object.keys(mediaExp).forEach(k => delete mediaExp[k]);
  ChatBackend.watchMedia(onMediaMeta);
  ChatBackend.watchEdits(applyEdit);
  reactBootUntil = Date.now() + 3000;   // the burst of existing reactions at attach isn't news
  ChatBackend.watchReactions(onReactions);
  ChatBackend.watchMessages(renderMessage);
  ChatBackend.watchLeaveEvents();
  ChatBackend.watchTyping(renderTyping, () => myName);
}

let chatBooted = false;

// Emoji button + reply/edit bar
(function wireComposerExtras() {
  const btn = document.getElementById("emojiBtn");
  if (btn) btn.addEventListener("click", () => {
    if (!window.VUS_UI || !window.VUS_UI.openEmojiPicker) return;
    window.VUS_UI.openEmojiPicker(btn, (emoji) => {
      const el = $msgInput;
      if (el.value.length + emoji.length > MAX_CHARS) return;
      const s = el.selectionStart == null ? el.value.length : el.selectionStart, e2 = el.selectionEnd == null ? s : el.selectionEnd;
      el.value = el.value.slice(0, s) + emoji + el.value.slice(e2);
      el.selectionStart = el.selectionEnd = s + emoji.length;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.focus();
    }, { input: $msgInput });
  });
  if (window.VUS_UI && window.VUS_UI.attachEmojiSuggest) window.VUS_UI.attachEmojiSuggest($msgInput);
  const cancel = document.getElementById("chatReplyCancel");
  if (cancel) cancel.addEventListener("click", () => { if (editingMsgId) cancelEdit(); else cancelReply(); });
  $msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (editingMsgId || replyingTo)) { e.preventDefault(); if (editingMsgId) cancelEdit(); else cancelReply(); }
  });
})();

// One-time setup, run on the first login. (Nothing here runs for visitors who
// never log in, so the chat database isn't touched until it's needed.)
function bootChat() {
  if (chatBooted) return true;
  try {
    dmAuthDb = window.VUS_DM_DB || null;
    ChatBackend.init();
    RoomManager.init(ChatBackend._db);
    ChatBackend.watchChatClosed(handleChatClosed);
  } catch (e) {
    showStatusCard("Couldn't connect to chat", e && e.message ? e.message : "Unknown error", [{ label: "Try again", onClick: () => autoLoginOrPrompt() }]);
    return false;
  }
  chatBooted = true;

  ChatBackend.watchConnection(setConnectionStatus);
  Object.values(ROLES).forEach(role => {
    roleHolders[role.id] = new Set();
    roleIdHolders[role.id] = new Set();
    if (role.implicit) return;
    ChatBackend.watchRoleIds(role.id, (idSet, raw) => {
      roleIdHolders[role.id] = idSet;
      roleIdRaw[role.id] = raw || {};
      noteRoleLoaded();
      rebuildRoleHolders();
      renderMembersPane();
      onMyRoleMaybeChanged();
    });
  });
  ChatBackend.watchVerify(on => {
    const was = verifyFlagOn;
    verifyFlagOn = on;
    scheduleVerifyRefresh();
    if (on && !was) setTimeout(reportUnverifiedHolders, 2500);
  });
  recsWatchAt = Date.now();
  ChatBackend.watchRecs("actions", onRec);
  ChatBackend.watchRecs("grants", onRec);
  setTimeout(startAnnouncementWatch, 2500);
  ChatBackend.watchAllBans((id, val) => { if (val) bansAll[id] = val; else delete bansAll[id]; refreshSilencedMessages(); });
  ChatBackend.watchInventory(data => { inventoryData = data; if ($inventoryOverlay.style.display === "flex") renderInventory(); });
  watchPublicRoomsList();
  restoreSidebarRoomList();
  openRoomsSidebar();

  updateUploadButtonVisibility();
  updatePingYouButtonState();
  preloadPingSound();

  $emptyState.style.display = "flex";
  updateCharCounter();

  window.addEventListener("beforeunload", () => {
    stopTyping();
    ChatBackend.releasePresence();
  });
  return true;
}

function init() {
  // dm.js owns the login. It fires "vus:session" after a login (or a saved
  // login being restored) and "vus:logout" on logout. The saved-session check
  // covers dm.js having finished before this file loaded.
  window.addEventListener("vus:session", () => autoLoginOrPrompt());
  window.addEventListener("vus:profile", () => renderMembersPane());
  window.addEventListener("vus:logout", () => shutdownChatSession());
  window.addEventListener("vus:mode", ev => {
    if (!chatBooted) return;
    if (ev.detail && ev.detail.mode === "chat") openRoomsSidebar(); else stopRoomsSidebarLive();
  });
  if (loadDmSession()) autoLoginOrPrompt();
}

/* Lets dm.js (profile cards) ask which ranks an account holds. */
/* ══════════ Video clips: click to load, gone 4 minutes after posting ══════════ */
const VIDEO_AUTO_SECONDS = 5;   // clips this short load by themselves; longer ones wait for a click (unless auto-download is on)
const mediaExp = {};            // clip id -> expiry (ms), from rooms/<room>/mediaMeta
const mediaJitter = {};         // so every browser doesn't try the cleanup in the same instant
const videoRecs = new Set();
function onMediaMeta(id, exp) {
  if (exp == null) { delete mediaExp[id]; return; }
  mediaExp[id] = Number(exp) || 0;
  if (mediaJitter[id] === undefined) mediaJitter[id] = Math.floor(Math.random() * 3000);
}
function fmtCountdown(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
function buildVideoBubble(bubble, msg) {
  const v = msg.video;
  const holder = document.createElement("div");     // the clip lives in its own box so a caption can sit under it
  bubble.appendChild(holder);
  const rec = { id: String(v.id || ""), v, bubble: holder, exp: Number(v.exp) || 0, state: "", countEl: null, vidEl: null, load: null, autoTried: false };
  videoRecs.add(rec);
  bubble.classList.add("video-bubble");
  paintVideo(rec);
}
function paintVideo(rec) {
  const { bubble, v } = rec;
  const expired = ChatBackend.serverNowSync() >= rec.exp;
  const want = expired ? "expired" : (localVideoUrls.has(rec.id) ? "playing" : "card");
  if (rec.state === want) return;
  rec.state = want; rec.vidEl = null; rec.countEl = null;
  bubble.replaceChildren();
  if (want === "expired") {
    const url = localVideoUrls.get(rec.id); if (url) { URL.revokeObjectURL(url); localVideoUrls.delete(rec.id); }
    const t = document.createElement("div"); t.className = "vid-gone"; t.textContent = "\u23F1 Countdown reached \u2014 this video was removed.";
    bubble.appendChild(t); return;
  }
  const count = document.createElement("div"); count.className = "vid-count"; rec.countEl = count;
  if (want === "playing") {
    const vid = document.createElement("video");
    vid.src = localVideoUrls.get(rec.id); vid.controls = true; vid.playsInline = true; vid.preload = "auto";
    vid.className = "vid-el"; rec.vidEl = vid;
    bubble.append(vid, count);
    return;
  }
  const card = document.createElement("button"); card.type = "button"; card.className = "vid-card";
  const play = document.createElement("span"); play.className = "vid-play"; play.textContent = "\u25B6";
  const info = document.createElement("span"); info.className = "vid-info";
  const l1 = document.createElement("b"); l1.textContent = "Video \u00b7 " + Math.round(Number(v.dur) || 0) + "s \u00b7 " + fmtBytes(Number(v.size) || 0);
  const l2 = document.createElement("span"); l2.className = "vid-sub"; l2.textContent = "Click to download";
  info.append(l1, l2); card.append(play, info);
  const load = async () => {
    if (card.dataset.busy) return; card.dataset.busy = "1"; l2.textContent = "Loading\u2026 0%";
    try {
      const blob = await ChatBackend.fetchVideo(rec.id, Number(v.n) || 0, String(v.mime || "video/mp4"), p => { l2.textContent = "Loading\u2026 " + Math.round(p * 100) + "%"; });
      localVideoUrls.set(rec.id, URL.createObjectURL(blob));
      rec.state = ""; paintVideo(rec);
      if (rec.vidEl) rec.vidEl.play().catch(() => {});
    } catch (e) { delete card.dataset.busy; l2.textContent = "Couldn't load \u2014 it may have expired. Click to retry."; }
  };
  rec.load = load;
  card.addEventListener("click", load);
  bubble.append(card, count);
}
function videoTick() {
  const now = ChatBackend.serverNowSync();
  videoRecs.forEach(rec => {
    if (!rec.bubble.isConnected) { videoRecs.delete(rec); return; }
    paintVideo(rec);
    if (rec.state === "card" && rec.load && !rec.autoTried && (Number(rec.v.dur) <= VIDEO_AUTO_SECONDS || chatPrefs.autoVideo === true)
        && !rec.bubble.closest(".anon-hidden, .spam-hidden, .silenced-hidden, .muted-hidden")) { rec.autoTried = true; rec.load(); }
    if (rec.countEl) rec.countEl.textContent = "disappears in " + fmtCountdown(rec.exp - now);
  });
  Object.keys(mediaExp).forEach(id => {
    if (now >= mediaExp[id] + (mediaJitter[id] || 0)) { delete mediaExp[id]; ChatBackend.deleteMedia(id); }
  });
}
setInterval(() => { try { if (ChatBackend._db) videoTick(); } catch (e) {} }, 1000);

/* ══════════ Pop-ups that show over everything (updates, announcements) ══════════
   Click anywhere on one to close it. They sit above settings, DMs and every other window. */
function showGlobalPopup(opts) {
  let host = document.getElementById("vusPopups");
  if (!host) { host = document.createElement("div"); host.id = "vusPopups"; document.body.appendChild(host); }
  const el = document.createElement("div");
  el.className = "vus-popup" + (opts.small ? " small" : "") + (opts.kind ? " " + opts.kind : "");
  const t = document.createElement("div"); t.className = "vp-title"; t.textContent = opts.title || "";
  el.appendChild(t);
  if (opts.body) { const b = document.createElement("div"); b.className = "vp-body"; b.textContent = opts.body; el.appendChild(b); }
  if (opts.buttonLabel) {
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "vp-btn"; btn.textContent = opts.buttonLabel;
    btn.addEventListener("click", e => { e.stopPropagation(); try { opts.onButton && opts.onButton(); } catch (x) {} el.remove(); });
    el.appendChild(btn);
  }
  const hint = document.createElement("div"); hint.className = "vp-hint"; hint.textContent = "Click anywhere on this to close"; if (!opts.small) el.appendChild(hint);
  el.addEventListener("click", () => el.remove());
  host.appendChild(el);
  if (opts.autoCloseMs) setTimeout(() => el.remove(), opts.autoCloseMs);
  return el;
}

/* ══════════ Announcements ══════════
   A server of its own (rail button, room "ch-announce"). Everyone can read it; only admins and above can post, one
   every 15 seconds. With peer verification on, every announcement needs an approval record written in the sender's
   name (see PEER VERIFICATION), so a forged post from a modified client is simply not shown. Each new announcement
   also pops up wherever you are (settings, DMs, ...) unless you turn that off in Settings. */
const ANNOUNCE_ROOM = "ch-announce";
const ANNOUNCE_GAP_MS = 15000;
const ANNOUNCE_POPUP_CHARS = 220;
const POLL_MS = 60000;
const annSleep = ms => new Promise(r => setTimeout(r, ms));
function annHash(text) {
  let h = 0x811c9dc5; const s = String(text);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + "." + s.length.toString(36);
}
const annEls = new Map();                 // message id -> { el, msg, mine }
const pollEls = new Map();                // message id -> { el, msg, mine }
const annRenderLast = {}, annPopupLast = {};
let recsWatchAt = 0, lastAnnounceAt = 0, annUnread = false;
function annRateBad(msg, store) {
  const id = String(msg.loginId || ""), ts = Number(msg.ts) || 0;
  const prev = store[id];
  if (prev && ts - prev < ANNOUNCE_GAP_MS - RATE_TOLERANCE_MS) return true;
  store[id] = ts;
  return false;
}
// "ok" | "pending" | "no": did an admin+ really say this, in their own name (when verification is on)?
function attestStatus(kind, id, v, ts) {
  if (!verifyActive() || ts < VERIFY_EPOCH) return "ok";
  const st = matchStatus("actions", r => r.k === kind && String(r.b) === id && r.v === v && Math.abs((Number(r.ts) || 0) - ts) <= 30000);
  if (st !== "no") return st;
  const all = Object.values(recs.actions);
  if (all.length >= 150 && ts < Math.min(...all.map(r => Number(r.ts) || 0))) return "ok";   // older than the records we still hold
  if (Date.now() - recsWatchAt < 5000) return "pending";                                    // records are still loading
  return "no";
}
function annStatus(msg) {
  const id = String(msg.loginId || "");
  if (!/^\d{6}$/.test(id) || typeof msg.text !== "string" || !msg.text || msg.imageData || msg.video || msg.poll) return "no";
  if (!rolesReady) return "pending";
  if (rankOfLoginId(id) < ROLES.admin.rank) return "no";
  return attestStatus("announce", id, annHash(msg.text), Number(msg.ts) || 0);
}
function pollShapeOk(msg) {
  const p = msg.poll;
  return !!p && typeof p === "object" && /^[a-z0-9]{8}$/.test(String(p.id)) && typeof p.q === "string" && p.q.length >= 1 && p.q.length <= 120 &&
    Array.isArray(p.o) && p.o.length >= 2 && p.o.length <= 4 && p.o.every(o => typeof o === "string" && o.length >= 1 && o.length <= 40) &&
    Number(p.exp) - Number(msg.ts) > 0 && Number(p.exp) - Number(msg.ts) <= POLL_MS + 5000;
}
function pollSig(p) { return p.id + ":" + annHash(p.q + "|" + p.o.join("|")); }
function pollStatus(msg) {
  const id = String(msg.loginId || "");
  if (!/^\d{6}$/.test(id) || !pollShapeOk(msg)) return "no";
  if (!rolesReady) return "pending";
  if (rankOfLoginId(id) < ROLES.admin.rank) return "no";
  return attestStatus("poll", id, pollSig(msg.poll), Number(msg.ts) || 0);
}
function paintAnnGate(id) {
  const rec = annEls.get(id) || pollEls.get(id);
  if (!rec) return;
  const { el, msg, mine } = rec;
  if (mine) { el.classList.remove("ann-hidden"); return; }
  const st = msg.poll ? pollStatus(msg) : annStatus(msg);
  el.classList.toggle("ann-hidden", st !== "ok" || isSilenced(msg.loginId));
}
setInterval(() => {
  [annEls, pollEls].forEach(m => m.forEach((r, id) => { if (!r.el.isConnected) m.delete(id); else paintAnnGate(id); }));
}, 1500);

let lastAnnouncePostAt = 0;
async function sendAnnouncement(text) {
  if (myRank() < ROLES.admin.rank) { showComposerNotice("Only admins and above can post announcements."); return; }
  if (!text) return;
  const wait = ANNOUNCE_GAP_MS - (Date.now() - lastAnnouncePostAt);
  if (wait > 0) { showComposerNotice("Announcements can go out once every 15 seconds — wait " + Math.ceil(wait / 1000) + "s."); return; }
  lastAnnouncePostAt = lastSentAt = Date.now();
  updateSendButtonState(); stopTyping(); cancelReply();
  const key = await ChatBackend.issue("actions", { k: "announce", t: "000000", v: annHash(text) });
  if (!key && verifyActive()) {
    lastAnnouncePostAt = 0; lastSentAt = 0; updateSendButtonState();
    showComposerNotice("Couldn't record the approval, so nobody would see it. Publish the updated chat rules, then try again.");
    return;
  }
  try {
    await ChatBackend.send(myName, text, null, myLoginId, null);
    $msgInput.value = ""; autosizeInput(); updateCharCounter(); scrollToBottom();
  } catch (e) { $connError.textContent = "Announcement failed to send — check your connection."; $connError.style.display = "block"; }
  $msgInput.focus();
}

let annWatchRef = null, annWatchStart = 0;
const annPopupSeen = new Set();
function startAnnouncementWatch() {
  if (annWatchRef || !ChatBackend._db) return;
  annWatchStart = srvNow();
  annWatchRef = ChatBackend._db.ref("rooms/" + ANNOUNCE_ROOM + "/messages").limitToLast(1);
  annWatchRef.on("child_added", snap => { onAnnouncementLive({ id: snap.key, ...snap.val() }); });
}
async function onAnnouncementLive(msg) {
  if (!msg || msg.system || !msg.text || annPopupSeen.has(msg.id)) return;
  annPopupSeen.add(msg.id);
  if (Number(msg.ts) < annWatchStart - 1000) return;                 // history, not news
  if (!myLoginId || String(msg.loginId) === String(myLoginId)) return;
  await whenRolesReady();
  let ok = false;
  for (let i = 0; i < 10; i++) { const st = annStatus(msg); if (st === "ok") { ok = true; break; } if (st === "no") break; await annSleep(800); }
  if (!ok || isSilenced(msg.loginId) || isMuted(msg.loginId)) return;
  if (annRateBad(msg, annPopupLast)) return;
  if (activeChannelId !== "announce") { annUnread = true; paintAnnounceUi(); }
  if (chatPrefs.announcements === false) return;
  const plain = maskFiltered(stripMentionMarks(msg.text));
  const cut = plain.length > ANNOUNCE_POPUP_CHARS;
  showGlobalPopup({
    kind: "announce", title: "📢 " + msg.name,
    body: cut ? plain.slice(0, ANNOUNCE_POPUP_CHARS).trimEnd() + "…" : plain,
    buttonLabel: cut ? "Read the full announcement" : "Open announcements",
    onButton: () => goToAnnouncement(msg.id)
  });
}
async function goToAnnouncement(id) {
  try { if (window.VUS_UI) { window.VUS_UI.showChat(); if (window.VUS_UI.closeSettings) window.VUS_UI.closeSettings(); } } catch (e) {}
  await openChannel("announce");
  for (let i = 0; i < 25; i++) {
    const m = msgEls.get(String(id));
    if (m && m.el.isConnected && !m.el.classList.contains("ann-hidden")) {
      m.el.scrollIntoView({ block: "center", behavior: "smooth" });
      m.el.classList.add("ann-highlight");
      setTimeout(() => m.el.classList.remove("ann-highlight"), 5000);
      return;
    }
    await annSleep(300);
  }
}
function paintAnnounceUi() {
  const b = document.getElementById("navAnnounce");
  if (!b) return;
  const on = activeChannelId === "announce";
  if (on) annUnread = false;
  b.classList.toggle("active", on);
  const shell = document.getElementById("appShell");
  if (shell) shell.classList.toggle("announce-on", on);
  const dot = document.getElementById("announceRailDot");
  if (dot) dot.classList.toggle("show", annUnread && !on);
  if (typeof updateComposerLockState === "function" && myLoginId) { updateComposerLockState(); updateUploadButtonVisibility(); }
}
(function wireAnnounceRail() {
  const b = document.getElementById("navAnnounce");
  if (!b) return;
  b.addEventListener("click", () => {
    if (window.VUS_UI) { window.VUS_UI.showChat(); }
    if (!myName) return;
    if (activeChannelId === "announce") openChannel("main"); else openChannel("announce");
  });
})();

/* ══════════ Polls (/poll, admin and above) ══════════
   A poll is a chat message with a `poll` field. It lasts one minute: the end time lives at polls/<id> and the
   database only accepts a vote while that time hasn't passed. Votes are one per account, written once.
   Posting a poll writes an approval record in the poster's name, so with peer verification on a forged poll isn't shown. */
const pollRecs = new Set();
let pollUnsubs = [];
let lastPollAt = 0;
function pollTally(rec) {
  const n = rec.p.o.length, counts = new Array(n).fill(0);
  Object.entries(rec.votes || {}).forEach(([id, v]) => { if (/^[0-9]{4,12}$/.test(id) && Number.isInteger(v) && v >= 0 && v < n) counts[v]++; });
  return counts;
}
function pollEnded(rec) { return srvNow() >= Number(rec.p.exp); }
function buildPollBubble(bubble, msg) {
  const p = msg.poll;
  bubble.classList.add("poll-bubble");
  bubble.style.background = ""; bubble.style.color = "";
  const rec = { msg, p, bubble, votes: {}, modal: null };
  const q = document.createElement("div"); q.className = "pb-q"; q.textContent = "📊 " + maskFiltered(p.q);
  const o = document.createElement("div"); o.className = "pb-opts"; o.textContent = p.o.map(x => maskFiltered(x)).join("  ·  ");
  const foot = document.createElement("div"); foot.className = "pb-foot";
  bubble.append(q, o, foot);
  rec.foot = foot;
  bubble.addEventListener("click", () => openPollModal(rec));
  bubble.title = "Click to open the poll";
  pollRecs.add(rec);
  if (ChatBackend._pollVotesRef) pollUnsubs.push(ChatBackend.watchPollVotes(p.id, v => { rec.votes = v; paintPoll(rec); }));
  paintPoll(rec);
}
function paintPoll(rec) {
  const total = pollTally(rec).reduce((a, b) => a + b, 0);
  rec.foot.textContent = pollEnded(rec) ? "Poll ended · " + total + " vote" + (total === 1 ? "" : "s") : fmtCountdown(Number(rec.p.exp) - srvNow()) + " left · " + total + " vote" + (total === 1 ? "" : "s") + " · click to vote";
  rec.bubble.classList.toggle("poll-done", pollEnded(rec));
  if (rec.modal && rec.modal.isConnected) paintPollModal(rec);
}
setInterval(() => { pollRecs.forEach(rec => { if (!rec.bubble.isConnected) { if (rec.modal) rec.modal.remove(); pollRecs.delete(rec); } else paintPoll(rec); }); }, 1000);
function openPollModal(rec) {
  if (rec.modal && rec.modal.isConnected) return;
  const ov = document.createElement("div");
  ov.className = "poll-overlay";
  ov.innerHTML = '<div class="poll-modal"><button type="button" class="poll-x" aria-label="Close">×</button><div class="pm-q"></div><div class="pm-by"></div><div class="pm-opts"></div><div class="pm-foot"></div></div>';
  ov.addEventListener("click", e => { if (e.target === ov) { ov.remove(); rec.modal = null; } });
  ov.querySelector(".poll-x").addEventListener("click", () => { ov.remove(); rec.modal = null; });
  document.body.appendChild(ov);
  rec.modal = ov;
  paintPollModal(rec);
}
function paintPollModal(rec) {
  const ov = rec.modal, p = rec.p, counts = pollTally(rec), total = counts.reduce((a, b) => a + b, 0);
  const ended = pollEnded(rec), mine = rec.votes ? rec.votes[String(myLoginId)] : undefined;
  const top = Math.max(...counts);
  ov.querySelector(".pm-q").textContent = maskFiltered(p.q);
  ov.querySelector(".pm-by").textContent = "Poll by " + rec.msg.name;
  const box = ov.querySelector(".pm-opts");
  box.replaceChildren();
  p.o.forEach((label, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pm-opt" + (mine === i ? " mine" : "") + (ended && total && counts[i] === top ? " win" : "");
    const bar = document.createElement("span"); bar.className = "pm-bar"; bar.style.width = (total ? Math.round(counts[i] * 100 / total) : 0) + "%";
    const t = document.createElement("span"); t.className = "pm-label"; t.textContent = maskFiltered(label);
    const c = document.createElement("span"); c.className = "pm-count"; c.textContent = counts[i] + (total ? " · " + Math.round(counts[i] * 100 / total) + "%" : "");
    b.append(bar, t, c);
    b.disabled = ended || mine !== undefined || !myLoginId;
    b.addEventListener("click", async () => {
      if (pollEnded(rec) || (rec.votes && rec.votes[String(myLoginId)] !== undefined)) return;
      rec.votes = Object.assign({}, rec.votes, { [String(myLoginId)]: i });   // show it at once; the database confirms
      paintPoll(rec);
      try { await ChatBackend.vote(p.id, myLoginId, i); }
      catch (e) { delete rec.votes[String(myLoginId)]; paintPoll(rec); showComposerNotice(isPermissionDenied(e) ? "The vote wasn't accepted (the poll may have just ended)." : "Couldn't send your vote."); }
    });
    box.appendChild(b);
  });
  ov.querySelector(".pm-foot").textContent = (ended ? "Poll ended" : fmtCountdown(Number(p.exp) - srvNow()) + " left") + " · " + total + " vote" + (total === 1 ? "" : "s") + (mine !== undefined ? " · you voted" : "");
}
function openPollMenu() {
  if (myRank() < ROLES.admin.rank) { showComposerNotice("Only admins and above can start polls."); return; }
  if (activeChannelId === "announce") { showComposerNotice("Start polls in a normal chat, not in announcements."); return; }
  const old = document.getElementById("pollMenuOverlay"); if (old) old.remove();
  const ov = document.createElement("div");
  ov.className = "poll-overlay"; ov.id = "pollMenuOverlay";
  ov.innerHTML = '<div class="poll-modal pm-menu"><button type="button" class="poll-x" aria-label="Close">×</button><h3>Start a poll</h3>' +
    '<input id="pollQ" type="text" maxlength="120" placeholder="Question" autocomplete="off">' +
    '<div id="pollOpts"></div><button type="button" id="pollAdd" class="pm-add">+ Add option</button>' +
    '<div class="pm-note">Lasts 1 minute. One vote per account.</div><div class="pm-err" id="pollErr"></div>' +
    '<div class="pm-row"><button type="button" id="pollCancel" class="chat-modal-btn-secondary">Cancel</button><button type="button" id="pollGo" class="pm-go">Start poll</button></div></div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  ov.querySelector(".poll-x").addEventListener("click", close);
  ov.querySelector("#pollCancel").addEventListener("click", close);
  const list = ov.querySelector("#pollOpts"), add = ov.querySelector("#pollAdd");
  const addOpt = (val, removable) => {
    const row = document.createElement("div"); row.className = "pm-optrow";
    const inp = document.createElement("input"); inp.type = "text"; inp.maxLength = 40; inp.value = val; inp.placeholder = "Option"; inp.className = "pollOpt";
    row.appendChild(inp);
    if (removable) { const x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.className = "pm-rm"; x.addEventListener("click", () => { row.remove(); add.style.display = ""; }); row.appendChild(x); }
    list.appendChild(row);
    if (list.children.length >= 4) add.style.display = "none";
  };
  addOpt("Yes", false); addOpt("No", false);
  add.addEventListener("click", () => { if (list.children.length < 4) { addOpt("", true); list.lastChild.querySelector("input").focus(); } });
  const err = ov.querySelector("#pollErr");
  ov.querySelector("#pollGo").addEventListener("click", async () => {
    const q = ov.querySelector("#pollQ").value.trim();
    const opts = [...ov.querySelectorAll(".pollOpt")].map(i => i.value.trim()).filter(Boolean);
    if (!q) { err.textContent = "Write a question."; return; }
    if (opts.length < 2 || new Set(opts.map(o => o.toLowerCase())).size !== opts.length) { err.textContent = "Give at least 2 different options."; return; }
    if (Date.now() - lastPollAt < 15000) { err.textContent = "Wait a few seconds before starting another poll."; return; }
    lastPollAt = Date.now();
    try {
      const color = await ChatBackend.getNameColor(myLoginId);
      await ChatBackend.createPoll(q, opts, myLoginId, color);
      close();
    } catch (e) {
      lastPollAt = 0;
      err.textContent = e && e.message === "approval" ? "Couldn't record the approval. Publish the updated chat rules first." : (isPermissionDenied(e) ? "The database rules don't allow polls yet. Publish the updated chat rules." : "Couldn't start the poll — check your connection.");
    }
  });
  ov.querySelector("#pollQ").focus();
}

/* ══════════ Auto AFK: a yellow dot after 2 minutes without clicking or messaging (typing counts as active) ══════════ */
const AFK_AFTER_MS = 120000;
let lastActivityAt = Date.now(), myAfk = false;
function setMyAfk(v) {
  if (myAfk === v) return;
  myAfk = v;
  try { ChatBackend.setAfk(v); } catch (e) {}
  try { if (window.VUS_DM && window.VUS_DM.setAfk) window.VUS_DM.setAfk(v); } catch (e) {}
  if ($onlineDot) $onlineDot.classList.toggle("afk", v);
}
function afkCheck(force) {
  if (!myLoginId || chatPrefs.autoAfk === false) { if (myAfk) setMyAfk(false); return; }
  if (Date.now() - lastActivityAt >= AFK_AFTER_MS) setMyAfk(true);
  else if (force && myAfk) setMyAfk(false);
}
function noteActivity() { lastActivityAt = Date.now(); if (myAfk) setMyAfk(false); }
["pointerdown", "mousedown", "keydown", "touchstart", "wheel"].forEach(ev => window.addEventListener(ev, noteActivity, true));
setInterval(() => afkCheck(false), 5000);
ChatBackend.setAfk = function (v) {
  if (!this._myPresenceRef) return;
  const r = this._myPresenceRef.child("afk");
  return v ? r.set(true) : r.remove();
};

/* ══════════ Crates ══════════
   One crate per 12-hour window (04:00 and 16:00 UTC = noon and midnight US Eastern during daylight time).
   To claim: 15 messages and 5 minutes online inside the window. The database keeps one claim record per account and
   only accepts the window that is current on ITS clock, so changing your device clock does nothing.
   Rings, tags and text effects come from here; what you equip is stored on your profile (`cosm`). */
const CRATE_WINDOW_MS = 12 * 3600 * 1000, CRATE_OFFSET_MS = 4 * 3600 * 1000;
const CRATE_NEED_MSGS = 15, CRATE_NEED_MS = 5 * 60 * 1000;
const RARITY = {
  common:    { label: "Common",    color: "#94a3b8", weight: 70 },
  rare:      { label: "Rare",      color: "#38bdf8", weight: 22 },
  epic:      { label: "Epic",      color: "#a855f7", weight: 6 },
  legendary: { label: "Legendary", color: "#f59e0b", weight: 2 }
};
const CRATE_ITEMS = [
  // rings: solid ones carry a color, the rest are animated (CSS class rfx-<id>)
  { id: "ring-sun",   type: "ring", rar: "common", name: "Sunny", color: "#f5c542" },
  { id: "ring-leaf",  type: "ring", rar: "common", name: "Leaf", color: "#22c55e" },
  { id: "ring-rose",  type: "ring", rar: "common", name: "Rose", color: "#f43f5e" },
  { id: "ring-sky",   type: "ring", rar: "common", name: "Sky", color: "#38bdf8" },
  { id: "ring-peach", type: "ring", rar: "common", name: "Peach", color: "#fb923c" },
  { id: "ring-lilac", type: "ring", rar: "common", name: "Lilac", color: "#c4b5fd" },
  { id: "ring-mint",  type: "ring", rar: "common", name: "Mint", color: "#34d399" },
  { id: "ring-pulse-cyan", type: "ring", rar: "rare", name: "Cyan Pulse" },
  { id: "ring-pulse-pink", type: "ring", rar: "rare", name: "Pink Pulse" },
  { id: "ring-pulse-lime", type: "ring", rar: "rare", name: "Lime Pulse" },
  { id: "ring-pulse-amber", type: "ring", rar: "rare", name: "Amber Pulse" },
  { id: "ring-rainbow",    type: "ring", rar: "epic", name: "Rainbow" },
  { id: "ring-fire",       type: "ring", rar: "epic", name: "Fire" },
  { id: "ring-frostbite",  type: "ring", rar: "epic", name: "Frostbite" },
  { id: "ring-toxic",      type: "ring", rar: "epic", name: "Toxic" },
  { id: "ring-galaxy",     type: "ring", rar: "legendary", name: "Galaxy" },
  { id: "ring-goldshine",  type: "ring", rar: "legendary", name: "Gold Shine" },
  { id: "ring-aurora",     type: "ring", rar: "legendary", name: "Aurora" },
  { id: "ring-eclipse",    type: "ring", rar: "legendary", name: "Eclipse" },
  // tags (CSS class tg-<id>)
  { id: "tag-rookie", type: "tag", rar: "common", name: "Rookie" },
  { id: "tag-chill",  type: "tag", rar: "common", name: "Chill" },
  { id: "tag-sleepy", type: "tag", rar: "common", name: "Sleepy" },
  { id: "tag-snacker", type: "tag", rar: "common", name: "Snacker" },
  { id: "tag-lurker",  type: "tag", rar: "common", name: "Lurker" },
  { id: "tag-coffee",  type: "tag", rar: "common", name: "Caffeinated" },
  { id: "tag-potato",  type: "tag", rar: "common", name: "Couch Potato" },
  { id: "tag-vibes",   type: "tag", rar: "common", name: "Good Vibes" },
  { id: "tag-nightowl",  type: "tag", rar: "rare", name: "Night Owl" },
  { id: "tag-earlybird", type: "tag", rar: "rare", name: "Early Bird" },
  { id: "tag-lucky",     type: "tag", rar: "rare", name: "Lucky" },
  { id: "tag-wizard",    type: "tag", rar: "rare", name: "Wizard" },
  { id: "tag-sweaty",    type: "tag", rar: "rare", name: "Sweaty" },
  { id: "tag-bookworm",  type: "tag", rar: "rare", name: "Bookworm" },
  { id: "tag-speedy",    type: "tag", rar: "rare", name: "Speedy" },
  { id: "tag-gremlin", type: "tag", rar: "epic", name: "Gremlin" },
  { id: "tag-menace",  type: "tag", rar: "epic", name: "Menace" },
  { id: "tag-chaos",   type: "tag", rar: "epic", name: "Chaos" },
  { id: "tag-villain", type: "tag", rar: "epic", name: "Villain" },
  { id: "tag-prodigy", type: "tag", rar: "epic", name: "Prodigy" },
  { id: "tag-typhoon", type: "tag", rar: "legendary", name: "Typhoon" },
  { id: "tag-mythic",  type: "tag", rar: "legendary", name: "Mythic" },
  { id: "tag-ascended", type: "tag", rar: "legendary", name: "Ascended" },
  { id: "tag-legend",  type: "tag", rar: "legendary", name: "Legend" },
  { id: "tag-goat",    type: "tag", rar: "legendary", name: "G.O.A.T." },
  // text effects (CSS class fxt-<id>)
  { id: "fx-sunset", type: "fx", rar: "common", name: "Sunset Fade" },
  { id: "fx-ocean",  type: "fx", rar: "common", name: "Ocean Fade" },
  { id: "fx-peach",  type: "fx", rar: "common", name: "Peach Fade" },
  { id: "fx-lilac",  type: "fx", rar: "common", name: "Lilac Fade" },
  { id: "fx-mint",   type: "fx", rar: "rare", name: "Mint Fade" },
  { id: "fx-berry",  type: "fx", rar: "rare", name: "Berry Fade" },
  { id: "fx-candy",  type: "fx", rar: "rare", name: "Candy Fade" },
  { id: "fx-forest", type: "fx", rar: "rare", name: "Forest Fade" },
  { id: "fx-ember",  type: "fx", rar: "rare", name: "Ember Fade" },
  { id: "fx-aurora", type: "fx", rar: "epic", name: "Aurora (animated)" },
  { id: "fx-lava",   type: "fx", rar: "epic", name: "Lava (animated)" },
  { id: "fx-glitch", type: "fx", rar: "epic", name: "Glitch (animated)" },
  { id: "fx-neon",   type: "fx", rar: "epic", name: "Neon (animated)" },
  { id: "fx-rainbow", type: "fx", rar: "legendary", name: "Rainbow Flow (animated)" },
  { id: "fx-void",    type: "fx", rar: "legendary", name: "Void Shimmer (animated)" },
  { id: "fx-prism",   type: "fx", rar: "legendary", name: "Prism (animated)" },
  // ── seasonal: only from the Seasonal crate while its season is running (dates live in the database: crateSeasons/<id>) ──
  { id: "sea-w26-snow",      season: "w26", type: "ring", rar: "common",    name: "Snowfall", color: "#e0f2fe" },
  { id: "sea-w26-frost",     season: "w26", type: "ring", rar: "rare",      name: "Frozen Pulse" },
  { id: "sea-w26-north",     season: "w26", type: "ring", rar: "epic",      name: "Northern Glow" },
  { id: "sea-w26-blizz",     season: "w26", type: "ring", rar: "legendary", name: "Blizzard" },
  { id: "sea-w26-snowball",  season: "w26", type: "tag",  rar: "common",    name: "Snowball" },
  { id: "sea-w26-frosty",    season: "w26", type: "tag",  rar: "rare",      name: "Frosty" },
  { id: "sea-w26-yeti",      season: "w26", type: "tag",  rar: "epic",      name: "Yeti" },
  { id: "sea-w26-frostfall", season: "w26", type: "tag",  rar: "legendary", name: "Frostfall" },
  { id: "sea-w26-icicle",    season: "w26", type: "fx",   rar: "common",    name: "Icicle Fade" },
  { id: "sea-w26-cocoa",     season: "w26", type: "fx",   rar: "rare",      name: "Cocoa Fade" },
  { id: "sea-w26-drift",     season: "w26", type: "fx",   rar: "epic",      name: "Snowdrift (animated)" },
  { id: "sea-w26-glacier",   season: "w26", type: "fx",   rar: "legendary", name: "Glacier Shine (animated)" }
];
const ITEM_BY_ID = {};
CRATE_ITEMS.forEach(i => { ITEM_BY_ID[i.id] = i; });
const CRATE_TYPES = [
  { id: "ring",  label: "Ring crate",        icon: "⭕", blurb: "A profile ring" },
  { id: "tag",   label: "Tag crate",         icon: "🏷️", blurb: "A tag by your name" },
  { id: "fx",    label: "Text effect crate", icon: "✨", blurb: "Fades and animated text" },
  { id: "mixed", label: "Mixed crate",       icon: "🎁", blurb: "Any of the above" },
  { id: "season", label: "Seasonal crate",    icon: "❄️", blurb: "Limited-time items" }
];
// seasons come from the database: crateSeasons/<id> = { name, start, end } (ms). Only seasons the code has items for count.
let crateSeasons = {};
function activeSeason() {
  const now = srvNow();
  let best = null;
  Object.keys(crateSeasons).forEach(id => {
    const v = crateSeasons[id];
    if (!v || typeof v !== "object" || !(Number(v.start) <= now && now < Number(v.end))) return;
    if (!CRATE_ITEMS.some(i => i.season === id)) return;
    if (!best || Number(v.start) > best.start) best = { id, name: String(v.name || id).slice(0, 30), start: Number(v.start), end: Number(v.end) };
  });
  return best;
}
function seasonName(id) { const v = crateSeasons[id]; return (v && v.name) || id; }
function visibleTypes() { return CRATE_TYPES.filter(t => t.id !== "season" || activeSeason()); }
function itemOf(id, type) { const i = ITEM_BY_ID[String(id || "")]; return i && (!type || i.type === type) ? i : null; }
// What goes on a message / profile for an equipped set: solid rings keep using the plain `ring` colour.
function cosmFields(c) {
  const out = {};
  if (!c || typeof c !== "object") return out;
  const r = itemOf(c.ring, "ring"); if (r) { if (r.color) out.ring = r.color; else out.rfx = r.id; }
  const t = itemOf(c.tag, "tag"); if (t) out.tag = t.id;
  const f = itemOf(c.fx, "fx"); if (f) out.fx = f.id;
  return out;
}
function crateWindow(now) { return Math.floor((now - CRATE_OFFSET_MS) / CRATE_WINDOW_MS); }
function crateWindowEnd(w) { return (w + 1) * CRATE_WINDOW_MS + CRATE_OFFSET_MS; }
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function seedOf(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; }
function rollCrate(type, w, owned) {
  // genuinely random (the browser's secure generator), not a seeded sequence
  const rng = () => { const u = new Uint32Array(1); crypto.getRandomValues(u); return u[0] / 4294967296; };
  const pool = cratePool(type);
  const pick = () => {
    let r = rng() * 100, rar = "legendary", acc = 0;
    for (const k of ["common", "rare", "epic", "legendary"]) { acc += RARITY[k].weight; if (r < acc) { rar = k; break; } }
    const list = pool.filter(i => i.rar === rar);
    const from = list.length ? list : pool;
    return from[Math.floor(rng() * from.length)];
  };
  const steps = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const item = pick();
    if (!owned.has(item.id)) { steps.push({ item, dup: false }); return { steps, final: item }; }
    const retry = rng() < 0.5;
    steps.push({ item, dup: true, retry });
    if (!retry) return { steps, final: null };
  }
  return { steps, final: null };
}

// ── progress (messages sent + time online in this window), kept on this device ──
const CRATE_KEY = "vus_crate_progress_v1";
let crateProgAll = {};
try { crateProgAll = JSON.parse(localStorage.getItem(CRATE_KEY) || "{}") || {}; } catch (e) { crateProgAll = {}; }
let crateClaimedW = null, crateOwned = new Set(), crateWatchId = "", crateWatchRefs = [], crateNotifiedW = null, lastCrateMsgAt = 0, myCosm = {};
function progFor() {
  const w = crateWindow(srvNow());
  let p = crateProgAll[myLoginId];
  if (!p || p.w !== w) p = crateProgAll[myLoginId] = { w, ms: 0, msgs: 0 };
  return p;
}
function saveProg() { try { localStorage.setItem(CRATE_KEY, JSON.stringify(crateProgAll)); } catch (e) {} }
function crateCountMessage() {
  if (!myLoginId) return;
  const now = Date.now();
  if (now - lastCrateMsgAt < 3000) return;          // a burst isn't several messages
  lastCrateMsgAt = now;
  progFor().msgs++; saveProg(); crateTick(true);
}
function crateReady() {
  if (!myLoginId || crateClaimedW === undefined) return false;
  const p = progFor();
  return crateClaimedW !== crateWindow(srvNow()) && p.msgs >= CRATE_NEED_MSGS && p.ms >= CRATE_NEED_MS;
}
function ensureCrateWatch() {
  if (!myLoginId || !ChatBackend._db || crateWatchId === myLoginId) return;
  crateWatchRefs.forEach(r => { try { r.off(); } catch (e) {} });
  crateWatchId = myLoginId; crateClaimedW = undefined; crateOwned = new Set(); myCosm = {};
  const claim = ChatBackend._db.ref("crateClaims/" + myLoginId), inv = ChatBackend._db.ref("crateInv/" + myLoginId + "/items");
  claim.on("value", s => { const v = s.val(); crateClaimedW = v && typeof v.w === "number" ? v.w : null; crateTick(true); }, () => { crateClaimedW = null; });
  inv.on("value", s => { crateOwned = new Set(Object.keys(s.val() || {}).filter(k => itemOf(k))); if (crateModal && !crateBusy) paintCrateModal(); });
  const seasons = ChatBackend._db.ref("crateSeasons");
  seasons.on("value", s => { crateSeasons = s.val() || {}; crateTick(true); }, () => { crateSeasons = {}; });
  crateWatchRefs = [claim, inv, seasons];
  ChatBackend.getProfile(myLoginId).then(p => { myCosm = (p && p.cosm) || {}; });
}
function crateTick(noTime) {
  if (!myLoginId) return;
  ensureCrateWatch();
  if (!noTime && myName && $chatScreen.style.display !== "none") { progFor().ms += 5000; saveProg(); }
  const ready = crateReady();
  const dot = document.getElementById("crateRailDot"); if (dot) dot.classList.toggle("show", ready);
  const w = crateWindow(srvNow());
  if (ready && crateNotifiedW !== w) {
    crateNotifiedW = w;
    showGlobalPopup({ kind: "crate", title: "📦 Your crate is ready!", body: "Open it from the crate button on the left.", buttonLabel: "Open crates", onButton: () => openCrateModal(), autoCloseMs: 12000 });
  }
  if (crateModal && !crateBusy) paintCrateModal();
}
setInterval(() => crateTick(false), 5000);

// ── look of items ──
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function tagEl(id) { const it = itemOf(id, "tag"); if (!it) return null; return el("span", "msg-tag tg-" + it.id + " r-" + it.rar, it.name); }
function applyRingTo(node, ringHex, rfx) {
  const it = itemOf(rfx, "ring");
  if (/^#[0-9a-fA-F]{6}$/.test(String(ringHex || ""))) { node.classList.add("has-ring"); node.style.setProperty("--ring", ringHex); }
  if (it && !it.color) { node.classList.add("has-ring", "rfx", "rfx-" + it.id); }
}
function itemPreview(item) {
  if (item.type === "ring") { const a = el("div", "cr-av", (myName || "?").slice(0, 1).toUpperCase()); applyRingTo(a, item.color, item.color ? "" : item.id); return a; }
  if (item.type === "tag") return tagEl(item.id);
  const s = el("span", "fxtext fxt-" + item.id, "Hello there!"); return s;
}
// A text effect wraps the message text in its own span, so the bubble keeps its colour behind it.
function wrapFx(bubble) {
  const id = bubble.dataset.fx; if (!itemOf(id, "fx")) return;
  // Colour emoji can't be drawn through a clipped gradient (they turn into a flat blob), so emoji are
  // left outside the effect and only the words around them get it.
  const EMO = /((?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[‍️⃣])+)/u;
  const nodes = [...bubble.childNodes];
  bubble.replaceChildren();
  let cur = null;
  const addFx = n => { if (!cur) { cur = el("span", "fxtext fxt-" + id); bubble.appendChild(cur); } cur.appendChild(n); };
  nodes.forEach(n => {
    if (n.nodeType !== 3) { addFx(n); return; }
    String(n.nodeValue).split(EMO).forEach((part, i) => {
      if (!part) return;
      if (i % 2 === 1) { cur = null; bubble.appendChild(el("span", "fxemoji", part)); }
      else addFx(document.createTextNode(part));
    });
  });
}

// ── the crate window ──
let crateModal = null, crateView = "open", crateBusy = false, crateReveal = null, collectionType = "ring";
function openCrateModal() {
  if (!myLoginId) return;
  if (crateModal) return;
  ensureCrateWatch();
  const ov = el("div", "crate-overlay");
  const box = el("div", "crate-modal");
  ov.appendChild(box);
  document.body.appendChild(ov);
  crateModal = ov; crateView = "open"; crateReveal = null;
  ov.addEventListener("click", e => { if (e.target === ov && !crateBusy) closeCrateModal(); });
  paintCrateModal();
}
function closeCrateModal() { if (crateModal) { crateModal.remove(); crateModal = null; } }
function fmtLeft(ms) { const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? h + "h " + m + "m" : m + "m " + (s % 60) + "s"; }
function paintCrateModal() {
  if (!crateModal) return;
  const box = crateModal.querySelector(".crate-modal");
  box.replaceChildren();
  const x = el("button", "poll-x", "×"); x.type = "button"; x.addEventListener("click", () => { if (!crateBusy) closeCrateModal(); });
  box.appendChild(x);
  const tabs = el("div", "cr-tabs");
  [["open", "📦 Crates"], ["collection", "🎨 Collection"]].forEach(([k, t]) => {
    const b = el("button", "cr-tab" + (crateView === k ? " on" : ""), t); b.type = "button";
    b.addEventListener("click", () => { if (crateBusy) return; crateView = k; crateReveal = null; paintCrateModal(); });
    tabs.appendChild(b);
  });
  box.appendChild(tabs);
  if (crateView === "collection") paintCollection(box); else paintOpen(box);
  crateModal.querySelectorAll(".cr-side").forEach(n => n.remove());
  if (crateView === "open") crateModal.appendChild(buildOddsBar(crateBarType));
}
function paintOpen(box) {
  if (crateReveal) { box.appendChild(crateReveal); return; }
  const p = progFor(), w = crateWindow(srvNow()), claimed = crateClaimedW === w, ready = crateReady();
  box.appendChild(el("h3", "cr-h", claimed ? "You've opened this window's crate" : ready ? "Your crate is ready!" : "Earn your crate"));
  const bar = (label, val, need, fmt) => {
    const r = el("div", "cr-prog"); const t = el("div", "cr-prog-t", label + "  " + fmt(Math.min(val, need)) + " / " + fmt(need));
    const b = el("div", "cr-bar"); const f = el("span"); f.style.width = Math.min(100, Math.round(val * 100 / need)) + "%"; b.appendChild(f); r.append(t, b); return r;
  };
  if (!claimed) {
    box.appendChild(bar("Messages", p.msgs, CRATE_NEED_MSGS, v => String(v)));
    box.appendChild(bar("Time online", p.ms, CRATE_NEED_MS, v => Math.floor(v / 60000) + ":" + String(Math.floor(v % 60000 / 1000)).padStart(2, "0")));
  }
  box.appendChild(el("div", "cr-note", "A new crate window starts in " + fmtLeft(crateWindowEnd(w) - srvNow()) + " (every 12 hours, at noon and midnight US Eastern — an hour earlier in winter)."));
  const grid = el("div", "cr-types");
  visibleTypes().forEach(t => {
    const b = el("button", "cr-type" + (t.id === "season" ? " cr-season" : "")); b.type = "button"; b.disabled = !ready || crateBusy;
    let label = t.label, blurb = t.blurb;
    if (t.id === "season") { const a = activeSeason(); label = a.name + " crate"; blurb = "Only this season · ends in " + Math.max(1, Math.ceil((a.end - srvNow()) / 86400000)) + "d"; }
    b.append(el("span", "cr-type-ic", t.icon), el("b", "", label), el("small", "", blurb));
    b.addEventListener("click", () => openCrate(t.id));
    b.addEventListener("mouseenter", () => { if (crateBusy || crateBarType === t.id) return; crateBarType = t.id; const old = crateModal && crateModal.querySelector(".cr-side"); if (old) old.replaceWith(buildOddsBar(t.id)); });
    grid.appendChild(b);
  });
  box.appendChild(grid);
  box.appendChild(el("div", "cr-odds", "Rarity odds: Common " + RARITY.common.weight + "% · Rare " + RARITY.rare.weight + "% · Epic " + RARITY.epic.weight + "% · Legendary " + RARITY.legendary.weight + "%, split evenly between the items of that rarity. The wheel's slices are the real chances. Landing on something you own: 50% another spin, 50% nothing."));
}

// ── true odds: the weight of a rarity is split evenly between the items of that rarity in the crate ──
function cratePool(type) {
  if (type === "season") { const a = activeSeason(); return a ? CRATE_ITEMS.filter(i => i.season === a.id) : []; }
  return CRATE_ITEMS.filter(i => !i.season && (type === "mixed" || i.type === type));
}
function crateChance(it, pool) { return RARITY[it.rar].weight / pool.filter(i => i.rar === it.rar).length; }
// chance that opening this crate ends with something you don't own yet (up to 4 rolls, 50% retry on a duplicate)
function crateNewChance(type) {
  const pool = cratePool(type);
  const p = pool.filter(i => !crateOwned.has(i.id)).reduce((a, i) => a + crateChance(i, pool), 0) / 100;
  const r = 0.5 * (1 - p);
  return p * (1 + r + r * r + r * r * r) * 100;
}
let crateBarType = "mixed", lastWheel = null;
function fmtPct(v) { return (v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, "") + "%"; }
function buildOddsBar(type) {
  if (type === "season" && !activeSeason()) type = "mixed";
  const bar = el("div", "cr-side");
  const pills = el("div", "cr-side-tabs");
  visibleTypes().forEach(t => {
    const b = el("button", "cr-side-tab" + (t.id === type ? " on" : ""), t.id === "fx" ? "Text" : t.id === "season" ? "Season" : t.label.replace(" crate", "")); b.type = "button";
    b.addEventListener("click", () => { if (crateBusy) return; crateBarType = t.id; const nb = buildOddsBar(t.id); bar.replaceWith(nb); });
    pills.appendChild(b);
  });
  bar.append(el("div", "cr-side-h", "Chances"), pills);
  const pool = cratePool(type), order = { legendary: 0, epic: 1, rare: 2, common: 3 };
  const list = el("div", "cr-side-list");
  pool.slice().sort((a, b) => order[a.rar] - order[b.rar]).forEach(it => {
    const row = el("div", "cr-side-row r-" + it.rar + (crateOwned.has(it.id) ? " own" : ""));
    row.append(el("i", "cr-dot"), el("span", "cr-side-n", it.name.replace(/ \(animated\)/, "")), el("b", "", fmtPct(crateChance(it, pool))));
    row.title = RARITY[it.rar].label + (crateOwned.has(it.id) ? " · you own this" : "");
    list.appendChild(row);
  });
  bar.appendChild(list);
  bar.appendChild(el("div", "cr-side-foot", "Chance of a NEW item: " + fmtPct(crateNewChance(type)) + ". Landing on one you own is a 50% retry (up to 4 spins), else nothing."));
  return bar;
}
// ── the wheel: every item gets a slice as wide as its real chance ──
function buildWheel(type) {
  const pool = cratePool(type), order = { common: 0, rare: 1, epic: 2, legendary: 3 };
  // spread rarities around the circle so thin slices don't all sit together
  const slices = []; let a0 = 0;
  const byR = k => pool.filter(i => i.rar === k);
  const seq = [];
  const lists = ["common", "rare", "epic", "legendary"].map(byR);
  const total = pool.length;
  for (let k = 0; k < total; k++) {
    // take from the list that is furthest behind its share
    let best = -1, bestScore = -1;
    lists.forEach((l, li) => { if (!l.length) return; const done = byR(["common", "rare", "epic", "legendary"][li]).length - l.length; const score = 1 - done / byR(["common", "rare", "epic", "legendary"][li]).length; if (score > bestScore) { bestScore = score; best = li; } });
    seq.push(lists[best].shift());
  }
  seq.forEach(it => { const w = crateChance(it, pool) * 3.6; slices.push({ it, a0, w }); a0 += w; });
  const SIZE = 300, dpr = Math.min(2, window.devicePixelRatio || 1);
  const wrap = el("div", "cr-wheel-wrap");
  const cv = document.createElement("canvas"); cv.className = "cr-wheel"; cv.width = SIZE * dpr; cv.height = SIZE * dpr;
  const ctx = cv.getContext("2d");
  if (ctx) {
    ctx.scale(dpr, dpr);
    const cx = SIZE / 2, cy = SIZE / 2, R = SIZE / 2 - 4;
    slices.forEach((sl, i) => {
      const s = (sl.a0 - 90) * Math.PI / 180, e = (sl.a0 + sl.w - 90) * Math.PI / 180;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, s, e); ctx.closePath();
      ctx.fillStyle = RARITY[sl.it.rar].color; ctx.globalAlpha = i % 2 ? 0.78 : 1; ctx.fill(); ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5; ctx.strokeStyle = "#0b1220"; ctx.stroke();
    });
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.lineWidth = 4; ctx.strokeStyle = "#0b1220"; ctx.stroke();
  }
  const pointer = el("div", "cr-pointer"), hub = el("div", "cr-hub", "🎁");
  wrap.append(cv, pointer, hub);
  let rot = Math.random() * 360;   // the wheel starts at a random angle
  cv.style.transform = "rotate(" + rot + "deg)";
  const spinTo = (item, ms) => {
    const sl = slices.find(x => x.it.id === item.id) || slices[0];
    const target = sl.a0 + sl.w * (0.15 + Math.random() * 0.7);   // anywhere inside its slice
    const need = (((-target - rot) % 360) + 360) % 360;
    rot += 360 * 5 + need;
    cv.style.transition = "transform " + ms + "ms cubic-bezier(.12,.62,.08,1)";
    cv.style.transform = "rotate(" + rot + "deg)";
  };
  return { wrap, spinTo, slices };
}
function revealCard(item, heading, sub) {
  const c = el("div", "cr-reveal-card r-" + item.rar);
  c.append(el("div", "cr-reveal-h", heading), itemPreview(item), el("b", "", item.name), el("div", "cr-rar", RARITY[item.rar].label + " " + ({ ring: "ring", tag: "tag", fx: "text effect" })[item.type]));
  if (sub) c.appendChild(el("div", "cr-note", sub));
  return c;
}
async function openCrate(type) {
  if (crateBusy || !crateReady()) return;
  crateBusy = true;
  const w = crateWindow(srvNow());
  try {
    const sea = type === "season" ? activeSeason() : null;
    if (type === "season" && !sea) throw new Error("no-season");
    await ChatBackend._db.ref("crateClaims/" + myLoginId).set(Object.assign({ w, ts: firebase.database.ServerValue.TIMESTAMP }, sea ? { s: sea.id } : {}));
  } catch (e) {
    crateBusy = false;
    showComposerNotice(isPermissionDenied(e) ? "Crates need the updated database rules (crateClaims). Publish the new chat rules." : String(e && e.message) === "no-season" ? "That season has just ended." : "Couldn't open the crate — check your connection.");
    return;
  }
  crateClaimedW = w;
  const res = rollCrate(type, w, crateOwned);
  crateBarType = type;
  const wheel = buildWheel(type); lastWheel = wheel;
  const status = el("div", "cr-note", "Spinning…");
  const spinBox = el("div", "cr-shake"); spinBox.append(wheel.wrap, status);
  crateReveal = spinBox; paintCrateModal();
  await annSleep(400);
  const SPIN_MS = 4600;
  for (const st of res.steps) {
    wheel.spinTo(st.item, SPIN_MS);
    status.textContent = "Spinning…";
    await annSleep(SPIN_MS + 250);
    if (st.dup) {
      status.replaceChildren(); status.append(el("b", "", "Duplicate: " + st.item.name + ". "), document.createTextNode(st.retry ? "You already own it — spinning again…" : "You already own it — nothing this time."));
      await annSleep(1700);
    }
  }
  let wrote = true;
  if (res.final) {
    wrote = false;
    for (let i = 0; i < 3 && !wrote; i++) {
      try { await ChatBackend._db.ref("crateInv/" + myLoginId + "/items/" + res.final.id).set(firebase.database.ServerValue.TIMESTAMP); wrote = true; } catch (e) { await annSleep(600); }
    }
  }
  const done = el("div", "cr-shake");
  done.appendChild(wheel.wrap);
  if (res.final && wrote) {
    done.appendChild(revealCard(res.final, "You got", "Open the Collection tab to equip it."));
  } else if (res.final) {
    done.appendChild(el("div", "cr-note", "You got " + res.final.name + " but it couldn't be saved. Check your connection; the crate is used up for this window."));
  } else done.appendChild(el("div", "cr-note", "No new item this time. Come back next window!"));
  const again = el("button", "pm-go", "Nice"); again.type = "button"; again.addEventListener("click", () => { crateReveal = null; paintCrateModal(); });
  done.appendChild(again);
  crateReveal = done; crateBusy = false;
  crateTick(true);
}
function paintCollection(box) {
  const tabs = el("div", "cr-subtabs");
  const act = activeSeason();
  // a seasonal item shows up while its season runs, or once you own it (past seasons you missed stay hidden)
  const shown = i => !i.season || crateOwned.has(i.id) || (act && act.id === i.season);
  [["ring", "Rings"], ["tag", "Tags"], ["fx", "Text effects"]].forEach(([k, t]) => {
    const own = CRATE_ITEMS.filter(i => i.type === k && shown(i) && crateOwned.has(i.id)).length, all = CRATE_ITEMS.filter(i => i.type === k && shown(i)).length;
    const b = el("button", "cr-subtab" + (collectionType === k ? " on" : ""), t + " " + own + "/" + all); b.type = "button";
    b.addEventListener("click", () => { collectionType = k; paintCrateModal(); });
    tabs.appendChild(b);
  });
  box.appendChild(tabs);
  const grid = el("div", "cr-grid");
  const order = { legendary: 0, epic: 1, rare: 2, common: 3 };
  CRATE_ITEMS.filter(i => i.type === collectionType && shown(i)).sort((a, b) => (a.season ? 1 : 0) - (b.season ? 1 : 0) || order[a.rar] - order[b.rar]).forEach(it => {
    const own = crateOwned.has(it.id), on = myCosm && myCosm[it.type] === it.id;
    const c = el("button", "cr-item r-" + it.rar + (own ? "" : " locked") + (on ? " equipped" : "")); c.type = "button";
    c.append(own ? itemPreview(it) : el("div", "cr-q", "?"), el("b", "", own ? it.name : "???"), el("small", "", RARITY[it.rar].label + (it.season ? " · " + seasonName(it.season) : "") + (on ? " · equipped" : "")));
    if (own) c.addEventListener("click", () => equipItem(it, !on));
    grid.appendChild(c);
  });
  box.appendChild(grid);
  box.appendChild(el("div", "cr-note", "Click an item you own to equip it (click again to take it off). Everyone sees what you equip."));
}
async function equipItem(it, on) {
  const next = Object.assign({}, myCosm);
  if (on) next[it.type] = it.id; else delete next[it.type];
  try {
    await ChatBackend.updateProfile(myLoginId, { cosm: Object.keys(next).length ? next : null });
    myCosm = next; paintCrateModal();
  } catch (e) { showComposerNotice(isPermissionDenied(e) ? "Equipping needs the updated database rules." : "Couldn't equip that."); }
}
(function wireCrateRail() {
  const b = document.getElementById("navCrate");
  if (b) b.addEventListener("click", () => { if (crateModal) closeCrateModal(); else openCrateModal(); });
})();

/* ══════════ Menus close with a double click outside (one stray click on the edge doesn't close them) ══════════ */
(function doubleClickOutside() {
  const SEL = ".chat-modal-overlay, .poll-overlay, .crate-overlay, #settingsOverlay, #modalOverlay";
  let last = { el: null, t: 0 }, hint = null, hintTimer = null;
  document.addEventListener("click", e => {
    const t = e.target;
    if (!(t instanceof Element) || !t.matches(SEL)) return;
    const now = Date.now();
    if (last.el === t && now - last.t < 800) { last = { el: null, t: 0 }; return; }   // second click: let it close
    last = { el: t, t: now };
    e.stopImmediatePropagation(); e.preventDefault();
    if (!hint) { hint = el("div", "dbl-hint", "Click outside again to close"); document.body.appendChild(hint); }
    hint.classList.add("show"); clearTimeout(hintTimer); hintTimer = setTimeout(() => hint.classList.remove("show"), 1100);
  }, true);
})();

/* ══════════ Games: a list on the rail, each game opens in its own pop-out window ══════════
   The list comes from Chat-DM/games.txt on GitHub: any number of [Title](https://raw.githubusercontent.com/...) entries,
   on one line or many. Entries whose link isn't http(s) (the placeholders) are ignored. If the file can't be
   loaded the built-in list below is used. Games run inside a sandboxed frame with no access to this page. */
const GAMES_URL = "https://raw.githubusercontent.com/Cra-Z-Gaming/VUS/refs/heads/main/Chat-DM/games.txt";
const DEFAULT_GAMES = [
  { title: "Blackjack", url: "https://raw.githubusercontent.com/Cra-Z-Gaming/VUSL/refs/heads/main/HTML_Games/Blackjack.html" },
  { title: "OVO", url: "https://raw.githubusercontent.com/Cra-Z-Gaming/VUSL/refs/heads/main/HTML_Games/ovo.html" },
];
function parseGamesText(text) {
  const out = [], seen = new Set();
  const re = /\[([^\]\n]{1,60})\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const title = m[1].trim(), url = m[2];
    if (!title || seen.has(url)) continue;
    seen.add(url); out.push({ title, url });
  }
  return out;
}
let gamesList = null, gamesLoading = null;
function loadGames() {
  if (gamesList) return Promise.resolve(gamesList);
  if (gamesLoading) return gamesLoading;
  gamesLoading = fetch(GAMES_URL + "?t=" + Math.floor(Date.now() / 60000), { cache: "no-store" })
    .then(r => { if (!r.ok) throw new Error("http " + r.status); return r.text(); })
    .then(t => { const g = parseGamesText(t); gamesList = g.length ? g : DEFAULT_GAMES; return gamesList; })
    .catch(() => { gamesList = DEFAULT_GAMES; return gamesList; })
    .finally(() => { gamesLoading = null; });
  return gamesLoading;
}
const GAME_SHIM = '<script>(function(){function mk(){var d={};return{getItem:function(k){return k in d?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}'
  + 'try{window.localStorage.getItem("a")}catch(e){try{Object.defineProperty(window,"localStorage",{value:mk(),configurable:true})}catch(_){}try{Object.defineProperty(window,"sessionStorage",{value:mk(),configurable:true})}catch(_){}}})();<\/script>';
function gameDoc(text) {
  const t = String(text || "");
  return /^\s*<!doctype[^>]*>/i.test(t) ? t.replace(/^(\s*<!doctype[^>]*>)/i, "$1" + GAME_SHIM) : GAME_SHIM + t;
}
const GAME_SANDBOX = "allow-scripts allow-pointer-lock allow-forms allow-modals allow-popups";
const GAME_BAR_H = 36;
const gameWins = new Map();   // url -> { win, ... }
let gameZ = 9000;
function openGameWindow(game) {
  const have = gameWins.get(game.url);
  if (have) { if (have.min) have.toggleMin(); have.front(); return have; }
  const vw = () => window.innerWidth, vh = () => window.innerHeight;
  const win = el("div", "game-win");
  const bar = el("div", "game-bar");
  const title = el("span", "game-title", game.title);
  const mkBtn = (cls, label, txt) => { const b = el("button", "game-btn " + cls, txt); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); return b; };
  const bMin = mkBtn("g-min", "Minimize", "–"), bFull = mkBtn("g-full", "Fullscreen in this tab", "⤢"), bTab = mkBtn("g-tab", "Open in a new tab", "↗"), bClose = mkBtn("g-close", "Close", "✕");
  bar.append(title, bMin, bFull, bTab, bClose);
  const body = el("div", "game-body");
  const status = el("div", "game-status", "Loading…");
  const frame = document.createElement("iframe");
  frame.className = "game-frame"; frame.setAttribute("sandbox", GAME_SANDBOX); frame.setAttribute("allow", "autoplay; fullscreen; gamepad");
  frame.title = game.title;
  body.append(frame, status);
  const edges = ["e", "s", "se"].map(d => { const r = el("div", "game-rs game-rs-" + d); r.dataset.d = d; return r; });
  win.append(bar, body, ...edges);
  document.body.appendChild(win);
  const w0 = Math.min(720, vw() - 20), h0 = Math.min(520, vh() - 20);
  const n = gameWins.size;
  const st = { win, game, min: false, full: false, x: Math.max(0, Math.min(vw() - w0, 90 + n * 28)), y: Math.max(0, Math.min(vh() - GAME_BAR_H - 2, 60 + n * 28)), w: w0, h: h0, html: "" };
  const apply = () => {
    win.classList.toggle("min", st.min); win.classList.toggle("full", st.full);
    if (st.full) { win.style.cssText = "z-index:" + win.style.zIndex; return; }
    // the top bar is never allowed off screen
    st.w = Math.max(240, Math.min(st.w, vw())); st.h = Math.max(GAME_BAR_H + 120, Math.min(st.h, vh()));
    st.x = Math.max(0, Math.min(st.x, vw() - st.w)); st.y = Math.max(0, Math.min(st.y, vh() - GAME_BAR_H - 2));
    win.style.left = st.x + "px"; win.style.top = st.y + "px"; win.style.width = st.w + "px";
    win.style.height = (st.min ? GAME_BAR_H : st.h) + "px";
  };
  st.front = () => { win.style.zIndex = String(++gameZ); };
  st.toggleMin = () => { st.min = !st.min; apply(); };
  st.close = () => { win.remove(); gameWins.delete(game.url); window.removeEventListener("resize", apply); };
  st.front(); apply();
  gameWins.set(game.url, st);
  win.addEventListener("pointerdown", () => st.front(), true);
  window.addEventListener("resize", apply);
  bMin.addEventListener("click", st.toggleMin);
  bFull.addEventListener("click", () => { st.full = !st.full; if (st.full) st.min = false; apply(); if (!st.full) apply(); });
  bClose.addEventListener("click", st.close);
  bTab.addEventListener("click", () => {
    const t = window.open("about:blank", "_blank");
    if (!t) { status.textContent = "Your browser blocked the new tab. Allow pop-ups for this site and try again."; status.style.display = ""; return; }
    t.document.open();
    t.document.write('<!doctype html><title>' + game.title.replace(/[<&]/g, "") + '</title><style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%}</style><iframe id="g" sandbox="' + GAME_SANDBOX + '" allow="autoplay; fullscreen; gamepad"></iframe>');
    t.document.close();
    const f = t.document.getElementById("g");
    if (f) f.srcdoc = st.html || "<p style=\"color:#fff;font:14px sans-serif\">Still loading — close this tab and try again in a moment.</p>";
  });
  // drag by the top bar
  const shield = on => win.classList.toggle("dragging", on);
  bar.addEventListener("pointerdown", e => {
    if (e.target.closest(".game-btn") || st.full) return;
    const sx = e.clientX, sy = e.clientY, ox = st.x, oy = st.y;
    shield(true); try { bar.setPointerCapture(e.pointerId); } catch (_) {}
    const mv = ev => { st.x = ox + ev.clientX - sx; st.y = oy + ev.clientY - sy; apply(); };
    const up = () => { shield(false); bar.removeEventListener("pointermove", mv); bar.removeEventListener("pointerup", up); bar.removeEventListener("pointercancel", up); };
    bar.addEventListener("pointermove", mv); bar.addEventListener("pointerup", up); bar.addEventListener("pointercancel", up);
    e.preventDefault();
  });
  bar.addEventListener("dblclick", e => { if (!e.target.closest(".game-btn")) st.toggleMin(); });
  // resize from the right edge, bottom edge or corner
  edges.forEach(r => r.addEventListener("pointerdown", e => {
    if (st.full || st.min) return;
    const d = r.dataset.d, sx = e.clientX, sy = e.clientY, ow = st.w, oh = st.h;
    shield(true); try { r.setPointerCapture(e.pointerId); } catch (_) {}
    const mv = ev => { if (d.includes("e")) st.w = ow + ev.clientX - sx; if (d.includes("s")) st.h = oh + ev.clientY - sy; apply(); };
    const up = () => { shield(false); r.removeEventListener("pointermove", mv); r.removeEventListener("pointerup", up); r.removeEventListener("pointercancel", up); };
    r.addEventListener("pointermove", mv); r.addEventListener("pointerup", up); r.addEventListener("pointercancel", up);
    e.preventDefault(); e.stopPropagation();
  }));
  fetch(game.url, { cache: "no-store" })
    .then(r => { if (!r.ok) throw new Error("http " + r.status); return r.text(); })
    .then(t => { st.html = gameDoc(t); frame.srcdoc = st.html; status.style.display = "none"; })
    .catch(() => { status.textContent = "Couldn't load this game. Check the link in games.txt."; });
  return st;
}
let gamesPop = null;
function closeGamesPop() { if (gamesPop) { gamesPop.remove(); gamesPop = null; } const b = document.getElementById("navGames"); if (b) b.classList.remove("active"); }
function openGamesPop() {
  if (gamesPop) { closeGamesPop(); return; }
  const btn = document.getElementById("navGames"); if (!btn) return;
  btn.classList.add("active");
  const pop = el("div", "games-pop");
  const search = document.createElement("input");
  search.type = "search"; search.className = "games-search"; search.placeholder = "Search games…"; search.autocomplete = "off"; search.spellcheck = false;
  const list = el("div", "games-list");
  pop.append(search, list);
  document.body.appendChild(pop); gamesPop = pop;
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.min(r.right + 8, window.innerWidth - 250) + "px";
  pop.style.bottom = Math.max(8, window.innerHeight - r.bottom) + "px";
  let games = [];
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const shown = games.filter(g => !q || g.title.toLowerCase().includes(q));
    list.replaceChildren();
    if (!shown.length) { list.appendChild(el("div", "games-empty", games.length ? "No games match." : "Loading…")); return; }
    shown.forEach(g => {
      const b = el("button", "games-item" + (gameWins.has(g.url) ? " open" : ""), g.title); b.type = "button";
      b.addEventListener("click", () => { closeGamesPop(); openGameWindow(g); });
      list.appendChild(b);
    });
  };
  paint();
  search.addEventListener("input", paint);
  loadGames().then(g => { if (gamesPop !== pop) return; games = g; paint(); });
  setTimeout(() => search.focus(), 30);
}
(function wireGames() {
  const btn = document.getElementById("navGames");
  if (!btn) return;
  btn.addEventListener("click", e => { e.stopPropagation(); openGamesPop(); });
  document.addEventListener("pointerdown", e => { if (gamesPop && !gamesPop.contains(e.target) && !btn.contains(e.target)) closeGamesPop(); }, true);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && gamesPop) closeGamesPop(); });
})();

/* ══════════ Update check: Chat-DM/version on GitHub ══════════
   Fetched when the chat opens and every 5 minutes. The first answer is "the version I'm running"; if it later
   changes, a pop-up says to reopen the page. The Check button in Settings does the same on demand (5 s wait). */
const VERSION_URL = "https://raw.githubusercontent.com/Cra-Z-Gaming/VUS/refs/heads/main/Chat-DM/version";
const VERSION_CHECK_EVERY_MS = 5 * 60 * 1000;
const VERSION_MANUAL_COOLDOWN_MS = 5000;
let runningVersion = null, notifiedVersion = null, lastManualCheckAt = 0;
async function fetchSiteVersion() {
  try {
    const res = await fetch(VERSION_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return null;
    const v = (await res.text()).trim();
    return v && v.length <= 80 && !/[<>]/.test(v) ? v : null;
  } catch (e) { return null; }
}
async function checkForUpdate(manual) {
  const v = await fetchSiteVersion();
  if (v === null) { if (manual) showGlobalPopup({ title: "Couldn't check for updates right now.", small: true, autoCloseMs: 3000 }); return; }
  if (runningVersion === null) runningVersion = v;
  if (v !== runningVersion) {
    if (manual || notifiedVersion !== v) {
      notifiedVersion = v;
      showGlobalPopup({ kind: "update", title: "\uD83D\uDD04 A new update is out", body: "Close this tab and reopen the site (or refresh the page) to get the latest version." });
    }
    return;
  }
  if (manual) showGlobalPopup({ title: "No update found", small: true, autoCloseMs: 2500 });
}
function manualUpdateCheck(btn) {
  const wait = VERSION_MANUAL_COOLDOWN_MS - (Date.now() - lastManualCheckAt);
  if (wait > 0) return;
  lastManualCheckAt = Date.now();
  if (btn) { btn.disabled = true; setTimeout(() => { btn.disabled = false; }, VERSION_MANUAL_COOLDOWN_MS); }
  checkForUpdate(true);
}
setTimeout(() => checkForUpdate(false), 3000);
setInterval(() => checkForUpdate(false), VERSION_CHECK_EVERY_MS);

/* ══════════ Channels (Discord-style list) ══════════
   Main is everyone. Mods / Admins / Owners are rank channels: anyone at that rank OR HIGHER can enter.
   Verified is its own channel (MZK-linked accounts only), independent of rank.
   Each channel is its own chat room (own messages, presence, typing). Access is enforced in this client
   (the chat database has no per-user auth), so it keeps honest users out and hides other senders' posts. */
const CHANNELS = [
  { id: "main",     room: MAIN_ROOM_ID,   label: "main",     icon: "#", hint: "Everyone" },
  { id: "verified", room: "ch-verified",  label: "verified", icon: "\u2713", hint: "Verified accounts only", verified: true },
  { id: "mods",     room: "ch-mods",      label: "mods",     icon: "\uD83D\uDEE1\uFE0F", hint: "Mods and above", minRank: ROLES.mod.rank },
  { id: "admins",   room: "ch-admins",    label: "admins",   icon: "\u2694\uFE0F", hint: "Admins and above", minRank: ROLES.admin.rank },
  { id: "owners",   room: "ch-owners",    label: "owners",   icon: "\uD83D\uDC51", hint: "Owner and Co-Owner", minRank: ROLES.coowner.rank },
  { id: "announce", room: "ch-announce",  label: "announcements", icon: "\uD83D\uDCE2", hint: "Announcements from admins", hidden: true, announce: true }
];
let activeChannelId = "main";
const CHANNELS_OPEN_KEY = "vusChannelsOpen";
function activeChannel() { return CHANNELS.find(c => c.id === activeChannelId) || CHANNELS[0]; }
function verifiedOf(id) { return window.VUS_DM && window.VUS_DM.verifiedCached ? window.VUS_DM.verifiedCached(id) : false; }
function channelStateFor(ch, loginId) {
  if (!ch || ch.id === "main") return true;
  if (!loginId) return false;
  if (ch.announce) return true;
  if (ch.verified) return verifiedOf(loginId);
  if (ch.minRank) return rankOfLoginId(loginId) >= ch.minRank;
  return true;
}
function channelAllowedFor(ch, loginId) { return channelStateFor(ch, loginId) === true; }
function paintVerifiedTag(el) {
  const id = el.dataset.vid, v = verifiedOf(id);
  if (v === true) { el.classList.add("on"); return; }
  if (v === false || !window.VUS_DM || !window.VUS_DM.isVerified) return;
  window.VUS_DM.isVerified(id).then(ok => {
    document.querySelectorAll('.verified-tag[data-vid="' + id + '"]').forEach(t => t.classList.toggle("on", ok));
    regateChannelMessages(); renderChannelList();
  });
}
function gateChannelEl(el, loginId) {
  const ch = activeChannel();
  if (activeChannelId === null || ch.id === "main") { el.classList.remove("chan-hidden"); return; }
  const st = channelStateFor(ch, loginId);
  el.classList.toggle("chan-hidden", st !== true);
  if (st === undefined && window.VUS_DM) window.VUS_DM.isVerified(loginId).then(() => regateChannelMessages());
}
function regateChannelMessages() {
  document.querySelectorAll("#messages .msg[data-sender-id]").forEach(el => {
    if (el.classList.contains("mine")) return;
    gateChannelEl(el, el.dataset.senderId);
  });
}
const channelCounts = {};
let channelCountRefs = [];
function watchChannelCounts() {
  if (channelCountRefs.length || !ChatBackend._db) return;
  CHANNELS.forEach(ch => {
    if (ch.hidden) return;
    const ref = ChatBackend._db.ref("rooms/" + ch.room + "/presence");
    ref.on("value", snap => { const n = snap.numChildren(); if (channelCounts[ch.id] !== n) { channelCounts[ch.id] = n; renderChannelList(); } });
    channelCountRefs.push(ref);
  });
}
function stopChannelCounts() { channelCountRefs.forEach(r => { try { r.off("value"); } catch (e) {} }); channelCountRefs = []; Object.keys(channelCounts).forEach(k => delete channelCounts[k]); }
function renderChannelList() {
  const list = document.getElementById("channelsList");
  if (!list) return;
  if (myLoginId) watchChannelCounts();
  if (myLoginId && window.VUS_DM && verifiedOf(myLoginId) === undefined) window.VUS_DM.isVerified(myLoginId).then(() => renderChannelList());
  list.replaceChildren();
  CHANNELS.forEach(ch => {
    if (ch.hidden) return;
    const ok = channelStateFor(ch, myLoginId) === true;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "channel-row" + (ch.id === activeChannelId ? " active" : "") + (ok ? "" : " locked");
    b.dataset.channel = ch.id;
    b.title = ok ? ch.hint : ch.hint + " \u2014 locked";
    const ic = document.createElement("span"); ic.className = "channel-ic"; ic.textContent = ch.icon;
    const nm = document.createElement("span"); nm.className = "channel-name"; nm.textContent = ch.label;
    b.append(ic, nm);
    if (ok && channelCounts[ch.id] > 0) { const ct = document.createElement("span"); ct.className = "channel-count"; ct.title = channelCounts[ch.id] + " online"; ct.textContent = channelCounts[ch.id]; b.appendChild(ct); }
    if (!ok) { const lk = document.createElement("span"); lk.className = "channel-lock"; lk.textContent = "\uD83D\uDD12"; b.appendChild(lk); }
    b.addEventListener("click", () => openChannel(ch.id));
    list.appendChild(b);
  });
}
function paintChannelsUi() {
  renderChannelList();
  paintAnnounceUi();
  const t = document.getElementById("hdrTitleText");
  if (t) t.textContent = activeChannelId ? (activeChannelId === "main" ? "VUS Chat" : (activeChannel().announce ? "📢 Announcements" : activeChannel().label)) : (currentRoomMeta && currentRoomMeta.name ? currentRoomMeta.name : "Room");
  regateChannelMessages();
}
async function openChannel(id) {
  const ch = CHANNELS.find(c => c.id === id);
  if (!ch || !myName) return;
  if (id !== "main" && channelStateFor(ch, myLoginId) !== true) {
    if (ch.verified && verifiedOf(myLoginId) === undefined && window.VUS_DM) await window.VUS_DM.isVerified(myLoginId);
    if (channelStateFor(ch, myLoginId) !== true) {
      showComposerNotice(ch.verified ? "The verified channel is only for accounts linked to a verified MZK email (Settings \u2192 MZK)." : ch.hint + " can use #" + ch.label + ".");
      renderChannelList();
      return;
    }
  }
  if (id === "main") { await switchToMainRoom(); return; }
  if (activeChannelId === id && currentRoomCode === null) return;
  teardownCurrentRoomMetaWatch();
  currentRoomCode = null;
  currentRoomMeta = null;
  activeChannelId = id;
  ChatBackend.bindToRoom(ch.room);
  const joined = await claimSpotInCurrentRoom(!!ch.announce);
  if (joined && joined.ok === false && joined.reason !== "switched") {
    showComposerNotice("Couldn't join #" + ch.label + (joined.reason === "banned" ? " (you're banned)." : "."));
    await switchToMainRoom();
    return;
  }
  watchMyTimeout();
  attachRoomListeners();
  $messages.innerHTML = "";
  messageCount = 0;
  $emptyState.style.display = "flex";
  $roomTopBar.style.display = "none";
  clearInterval(topBarCountdownTimer);
  paintChannelsUi();
}
function onRolesChangedForChannels() {
  renderChannelList();
  const ch = activeChannel();
  if (activeChannelId && activeChannelId !== "main" && channelStateFor(ch, myLoginId) === false) { showComposerNotice("You no longer have access to #" + ch.label + "."); switchToMainRoom(); return; }
  regateChannelMessages();
}
function setChannelsOpen(open) {
  const shell = document.getElementById("appShell");
  if (shell) shell.classList.toggle("channels-closed", !open);
  try { localStorage.setItem(CHANNELS_OPEN_KEY, open ? "1" : "0"); } catch (e) {}
}
(function initChannelsUi() {
  let open = true;
  try { if (localStorage.getItem(CHANNELS_OPEN_KEY) === "0") open = false; } catch (e) {}
  setChannelsOpen(open);
  const tg = document.getElementById("channelsToggleBtn"), cl = document.getElementById("channelsCloseBtn");
  const flip = () => setChannelsOpen(document.getElementById("appShell").classList.contains("channels-closed"));
  if (tg) tg.addEventListener("click", flip);
  if (cl) cl.addEventListener("click", () => setChannelsOpen(false));
  renderChannelList();
})();

window.VUS_CHAT = {
  channels: { list: CHANNELS, open: openChannel, active: () => activeChannelId },
  getPrefsState, restorePrefsState,
  _idleFor(ms) { lastActivityAt = Date.now() - ms; afkCheck(false); },
  _annHash: annHash,
  _wheelSlices() { return lastWheel ? lastWheel.slices.map(x => ({ id: x.it.id, a0: x.a0, w: x.w })) : null; },
  _crateProg(m, ms) { const p = progFor(); p.msgs = m; p.ms = ms; saveProg(); crateTick(true); },
  cosmFor: async id => { try { const p = await ChatBackend.getProfile(id); const c = cosmFields(p && p.cosm); if (!c.ring && p && p.color && p.color.ring) c.ring = p.color.ring; return c; } catch (e) { return {}; } },
  tagEl, applyRingTo,
  staffActionsFor, runStaffAction, roleActionsFor, runRoleAction,
  ringFor: async id => { try { const col = await ChatBackend.getNameColor(id); return (col && col.ring) || ""; } catch (e) { return ""; } }, timeoutLimitsForRank, banLimitsForRank,
  isMuted, toggleMute,
  getRolesFor(loginId) {
    const id = String(loginId || "");
    return Object.values(ROLES)
      .filter(r => !r.implicit && roleIdHolders[r.id] && roleIdHolders[r.id].has(id) && roleAttested(r.id, id))
      .sort((a, b) => b.rank - a.rank)
      .map(r => ({ id: r.id, label: r.label, icon: r.icon }));
  }
};

init();

})();
