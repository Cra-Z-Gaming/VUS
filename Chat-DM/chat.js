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
  adminTempban: { min: 60000, max: ADMIN_MUTE_MAX_MS }, // Admin: 1 week
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
  return rank >= ROLES.coowner.rank ? TIME_LIMITS.tempban : TIME_LIMITS.adminTempban;
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
    this._timeoutsRef = this._db.ref("rooms/" + roomId + "/timeouts");
    this._modRetimeoutRef = this._db.ref("rooms/" + roomId + "/modRetimeoutCooldowns");
    this._commandHistoryRef = this._db.ref("rooms/" + roomId + "/commandHistory");
    this._editsRef = this._db.ref("rooms/" + roomId + "/edits");
    this._reactionsRef = this._db.ref("rooms/" + roomId + "/reactions");
  },

  detachAllListeners() {
    if (this._ref) this._ref.off();
    if (this._typingRef) this._typingRef.off();
    if (this._presenceRef) this._presenceRef.off();
    if (this._leaveEventsRef) this._leaveEventsRef.off();
    if (this._editsRef) this._editsRef.off();
    if (this._timeoutsRef) this._timeoutsRef.off();
    if (this._reactionsRef) this._reactionsRef.off();
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

  async sendImage(name, dataUrl, loginId) {
    const color = await this.getNameColor(loginId);
    return this._ref.push({
      name: name,
      ...(loginId ? { loginId: String(loginId) } : {}),
      imageData: dataUrl,
      ts: firebase.database.ServerValue.TIMESTAMP,
      ...(color ? { bubble: color.bubble, textColor: color.text } : {})
    });
  },

  async send(name, text, mention, loginId, replyTo) {
    const color = await this.getNameColor(loginId);
    const data = {
      name: name,
      ...(loginId ? { loginId: String(loginId) } : {}),
      text: text,
      ts: firebase.database.ServerValue.TIMESTAMP,
      ...(mention ? { mention: mention.name + (mention.silent ? SILENT_MENTION_MARK : "") } : {}),
      ...(color ? { bubble: color.bubble, textColor: color.text } : {}),
      ...(replyTo ? { replyTo } : {})
    };
    try { return await this._ref.push(data); }
    catch (e) {
      // The database rules may not know about replies yet: still deliver the message.
      if (replyTo && isPermissionDenied(e)) {
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

  async claimColor(loginId, bubble, text) {
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
      color: { bubble, text, changedAt: firebase.database.ServerValue.TIMESTAMP }
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
    const ban = await this.getBan(loginId);
    if (ban) return { ok: false, reason: "banned", ban };

    const presenceSnapshot = await this._presenceRef.get();
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
      this._myPresenceRef.remove();
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
        joinedAt: (v && typeof v === "object") ? (v.joinedAt || null) : null
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
    return byRank >= ROLES.admin.rank && byRank > targetRank;
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

  async banUser(loginId, username, byLoginId, durationMs) {
    if (!loginId) throw new Error("Missing login ID");
    // Server time, not this device's clock (see _serverOffset above).
    await this.issue("actions", { k: "ban", t: loginId, d: durationMs || 0 });
    const expiresAt = durationMs ? (await this._serverNow()) + durationMs : 0;
    await this._bansRef.child(this._safeKey(String(loginId))).set({
      loginId: String(loginId),
      username: username || "Unknown",
      byLoginId: byLoginId ? String(byLoginId) : null,
      bannedAt: firebase.database.ServerValue.TIMESTAMP,
      ...(expiresAt ? { expiresAt } : {})
    });
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
  async setTimeout_(targetLoginId, durationMs, byLoginId) {
    await this.issue("actions", { k: "mute", t: targetLoginId, d: durationMs });
    const serverNow = await this._serverNow();
    await this._timeoutsRef.child(this._safeKey(String(targetLoginId))).set({
      expiresAt: serverNow + durationMs,
      by: byLoginId ? String(byLoginId) : null
    });
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
const chatPrefs = { autoScroll: true, showJoinLeave: true, peerVerify: true, textSize: "l", bubbleSize: "normal", bold: false };
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
}
applyAppearance();
let myTimeoutRemainingMs = 0; // live, kept in sync by watchMyTimeout()
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
function currentMessageCooldownMs() { return ROLE_MESSAGE_COOLDOWNS_MS[myRoleId()] ?? ROLE_MESSAGE_COOLDOWNS_MS.unranked; }
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
  if (!/^\d{6}$/.test(by) || !/^\d{6}$/.test(t) || by === t) return false;
  if (requireOnline && !presenceIds().includes(by)) return false;
  const byRank = rankOfLoginId(by), tRank = rankOfLoginId(t), d = Number(r.d) || 0;
  switch (r.k) {
    case "mute": return byRank >= ROLES.mod.rank && tRank < byRank && !isProtected(t) && d > 0 && d <= timeoutLimitsForRank(byRank).max + 1000;
    case "ban":
      if (byRank < ROLES.admin.rank || tRank >= byRank || tRank >= ROLES.coowner.rank || isProtected(t)) return false;
      return d === 0 ? byRank >= ROLES.crown.rank : d <= banLimitsForRank(byRank).max + 1000;
    case "kick": return (byRank >= ROLES.admin.rank && tRank < byRank) || kickByRoomOwner(by);
    case "image": return byRank >= ROLES.admin.rank && tRank < byRank;
    case "role": case "unrole": {
      const rr = ROLES[r.v];
      return !!rr && (r.v === "mod" || r.v === "normie") && byRank >= ROLES.admin.rank && rr.rank < byRank && tRank < byRank;
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
  return byRank >= ROLES.admin.rank && byRank > tRank && tRank < ROLES.coowner.rank && !isProtected(targetId);
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
/* ══════════ Replies, edits, reactions ══════════ */
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const msgEls = new Map();            // message id -> { el, bubble, reactRow, loginId, ts, isImage, mention, text }
const pendingEdits = {};             // edits that arrived before their message did
const reactionsByMsg = {};           // message id -> { emoji: { loginId: true } }
let replyingTo = null;               // { id, name, text }
let editingMsgId = null;
let lastReactAt = 0, lastEditAt = 0;
const EMOJI_KEY_OK = /^[^.$#\[\]\/\u0000-\u001f]{1,16}$/;
function validEmojiKey(k) { return typeof k === "string" && EMOJI_KEY_OK.test(k) && /\p{Extended_Pictographic}/u.test(k); }
function snippetOf(m) { return m.isImage ? "\uD83D\uDCF7 Image" : String(m.text || "").slice(0, 80); }

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
  $msgInput.value = m.text || "";
  autosizeInput(); updateCharCounter(); updateReplyBar();
  $msgInput.focus();
}
function cancelEdit(keepText) {
  if (!editingMsgId) return;
  editingMsgId = null;
  if (!keepText) { $msgInput.value = ""; autosizeInput(); updateCharCounter(); }
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
  if (m.mention) {
    const chip = document.createElement("span");
    chip.className = "mention-chip-inline";
    chip.textContent = "@" + mentionTargetOf(m.mention);
    m.bubble.appendChild(chip);
    m.bubble.appendChild(document.createTextNode(" " + text));
  } else m.bubble.appendChild(document.createTextNode(text));
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
    pill.addEventListener("click", () => reactTo(id, emoji));
    m.reactRow.appendChild(pill);
  });
}
function onReactions(id, val) {
  if (val) reactionsByMsg[id] = val; else delete reactionsByMsg[id];
  renderReactions(id);
}
async function reactTo(id, emoji) {
  if (!myLoginId || !validEmojiKey(emoji)) return;
  if (myTimeoutRemainingMs > 0) { showComposerNotice("You're muted for " + formatCountdown(myTimeoutRemainingMs) + " more."); return; }
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
  if (!msg.loginId || !msg.ts || msg.ts < liveSince || !rolesReady) return false;
  const id = String(msg.loginId);
  const role = effectiveRoleForLoginId(id);
  const table = msg.imageData ? ROLE_IMAGE_COOLDOWNS_MS : ROLE_MESSAGE_COOLDOWNS_MS;
  const cd = table[role] != null ? table[role] : 10000;
  const prev = lastAccepted[id];
  if (prev) {
    const gap = msg.ts - prev.ts;
    const captionAfterImage = prev.image && !msg.imageData && gap < 2500;   // an image and its caption go out together
    if (!captionAfterImage && gap < cd - RATE_TOLERANCE_MS) return true;     // too soon for their role: not accepted, doesn't reset their timer
  }
  lastAccepted[id] = { ts: msg.ts, image: !!msg.imageData };
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
  const t = String(text || "").toLowerCase();
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

function renderMessage(msg) {
  $emptyState.style.display = "none";

  if (msg.system) {
    const sysEl = document.createElement("div");
    sysEl.className = "msg system" + ((Array.isArray(msg.leftNames) || /^.{1,60} joined$/.test(String(msg.text || "")) || / left$/.test(String(msg.text || ""))) ? " sys-joinleave" : "");
    const sysBubble = document.createElement("div");
    sysBubble.className = "msg-bubble";
    sysBubble.textContent = msg.text;
    sysEl.appendChild(sysBubble);
    $messages.appendChild(sysEl);
    messageCount++;
    if (autoScroll && stickToBottom) scrollToBottom();

    // If the chat just posted a "left" message for the name THIS tab is
    // currently using, our presence is already gone server-side (someone/
    // something else triggered it — a stray duplicate session, a kick,
    // etc). Don't let this tab keep acting like it's still joined — drop
    // it back to "Continue as X?" so rejoining is deliberate.
    const leftIsMe = Array.isArray(msg.leftNames)
      ? msg.leftNames.some(n => ChatBackend._safeKey(n) === ChatBackend._safeKey(myName))
      : msg.text === myName + " left";
    if (myName && leftIsMe && $chatScreen.style.display !== "none") {
      forceReturnToJoinScreen("You were disconnected from the chat.");
    }
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
    trackNewAccountBurst(msg);
    if (!hiddenForMe && msg.loginId && isMuted(msg.loginId)) hiddenForMe = true;
    // No real login id or no name = not a real account (forged client): hidden for everyone else.
    if (!/^\d{6}$/.test(String(msg.loginId || "")) || !String(msg.name || "").trim()) { el.classList.add("anon-hidden"); hiddenForMe = true; }
    else {
      needsVerify = true;
      if (msg.imageData) el.classList.add("anon-hidden");   // images stay hidden until the sender is confirmed
    }
  }

  const avEl = document.createElement("div");
  avEl.className = "msg-av";
  avEl.title = "View profile";
  paintAvatar(avEl, msg.loginId, msg.name);
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
  } else if (msg.mention) {
    const chip = document.createElement("span");
    chip.className = "mention-chip-inline";
    chip.textContent = "@" + mentionTargetOf(msg.mention);
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

  if (msg.replyTo && typeof msg.replyTo === "object" && !msg.imageData) {
    const q = document.createElement("div");
    q.className = "msg-reply";
    const qn = document.createElement("b");
    qn.textContent = String(msg.replyTo.name || "Someone").slice(0, 40);
    q.append("\u21A9 ", qn, document.createTextNode("  " + String(msg.replyTo.text || "").slice(0, 100)));
    if (msg.replyTo.id) q.addEventListener("click", () => jumpToMessage(String(msg.replyTo.id)));
    el.appendChild(q);
  }
  el.appendChild(bubble);
  const reactRow = document.createElement("div");
  reactRow.className = "msg-reactions";
  el.appendChild(reactRow);
  if (msg.id) {
    msgEls.set(String(msg.id), { el, bubble, reactRow, loginId: String(msg.loginId || ""), ts: Number(msg.ts) || 0, isImage: !!msg.imageData, mention: msg.mention || "" , text: msg.text || "" });
    el.appendChild(buildMessageActions(msg, mine));
    el.addEventListener("click", (ev) => {
      if (!(window.matchMedia && window.matchMedia("(hover: none)").matches)) return;
      if (ev.target.closest("button,.msg-av,.msg-meta-name,img,a")) return;
      document.querySelectorAll(".msg.touch-active").forEach(x => { if (x !== el) x.classList.remove("touch-active"); });
      el.classList.toggle("touch-active");
    });
  }
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
    if (!hiddenForMe && !el.classList.contains("anon-hidden") && msg.mention && mentionTargetOf(msg.mention) === myName && msg.name !== myName && !(msg.loginId && isMuted(msg.loginId))) {
      el.classList.add("mentions-me");
      if (!isSilentMention(msg.mention)) triggerIncomingPing(msg.name, msg.text);
    }
  };
  if (needsVerify && window.VUS_DM && window.VUS_DM.verifySender) {
    window.VUS_DM.verifySender(msg.loginId, msg.name).then(async r => {
      // Text: hidden only if the id isn't a real account. Images: the account must be real, the name must match it,
      // and the sender must actually have image access (rank above Normie, or granted by a higher-up).
      let bad = !r.ok || (msg.imageData && !r.nameMatches);
      if (!bad && msg.imageData && !(await senderMayPostImages(String(msg.loginId)))) bad = true;
      if (bad && !(r.unknown && !msg.imageData)) { el.classList.add("anon-hidden"); }
      else { el.classList.remove("anon-hidden"); firePing(); }
      if (autoScroll && stickToBottom) scrollToBottom();
    }).catch(() => { if (msg.imageData) el.classList.add("anon-hidden"); else firePing(); });
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
  ChatBackend.detachAllListeners();
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
function updateSendButtonState() {
  const elapsed = Date.now() - lastSentAt;
  const remaining = currentMessageCooldownMs() - elapsed;
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
  myTimeoutRemainingMs = eff;
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
  $banReason.textContent = "Your account was removed from VUS Chat by staff.";
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
  { name: "/mute", args: "time username",             minRank: ROLES.mod.rank,
    desc: rank => "Mute someone for a while (" + limitsText(timeoutLimitsForRank(rank)) + ").", insert: "/mute " },
  { name: "/kick",    args: "username",               minRank: ROLES.admin.rank,
    desc: "Remove a user from the current private room.", insert: "/kick " },
  { name: "/ban",     args: "username or ID",         minRank: ROLES.admin.rank,
    desc: "Ban the account ID, so a new name won't get around it. A 6-digit ID works even if they're offline.", insert: "/ban " },
  { name: "/tempban", args: "time username or ID",    minRank: ROLES.admin.rank,
    desc: () => "Ban the account ID for a while (" + limitsText(banLimitsForRank(myRank())) + ").", insert: "/tempban " },
  { name: "/grant",   args: "rank perm|time username", minRank: ROLES.admin.rank,
    desc: () => "Give a rank below yours. perm = permanent, or a time (" + limitsText(TIME_LIMITS.tempGrant) + "). Ranks: normie, mod, admin, coowner.", insert: "/grant " },
  { name: "/remove",  args: "rank username",          minRank: ROLES.admin.rank,
    desc: "Take away a rank below yours.", insert: "/remove " },
  { name: "/image",   args: "on|off username",        minRank: ROLES.admin.rank,
    desc: "Give or take away image access for someone below your rank.", insert: "/image " },
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
  if (rank >= ROLES.admin.rank) {
    out.push({ id: "tempban", label: "Temp ban…" });
    if (rank >= ROLES.crown.rank) out.push({ id: "ban", label: "Ban" });
    if (currentRoomCode) out.push({ id: "kick", label: "Kick from room" });
  }
  return out;
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
    const target = await resolveModerationTarget(parts.slice(2).join(" "));
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
    await ChatBackend.setTimeout_(target.loginId, durationMs, myLoginId);
    if (isJustMod) watchModIssuedTimeoutExpiry(myLoginId, target.loginId);
    showComposerNotice("Muted " + target.name + " for " + formatCountdown(durationMs) + ".");
    return true;
  }

  // ── /ban and /tempban: ALWAYS act on the account ID ──
  if (command === "/ban" || command === "/tempban") {
    let durationMs = 0;
    let nameParts;
    if (command === "/tempban") {
      if (parts.length < 3) {
        showComposerNotice("Use /tempban time username, such as /tempban 2h alex (" + limitsText(banLimitsForRank(myRank())) + ").");
        return true;
      }
      durationMs = parseModerationDuration(parts[1]);
      const problem = checkDurationLimits(durationMs, banLimitsForRank(myRank()));
      if (problem) { showComposerNotice(problem); return true; }
      nameParts = parts.slice(2);
    } else {
      if (parts.length < 2) { showComposerNotice("Use /ban username, or /ban 123456 (account ID)."); return true; }
      nameParts = parts.slice(1);
    }
    const target = await resolveModerationTarget(nameParts.join(" "), { allowOfflineId: true });
    if (!target) {
      showComposerNotice("Couldn't find that user. Use their exact username or a real 6-digit account ID.");
      return true;
    }
    if (!guardModerationTarget(target, "ban")) return true;
    openBanConfirm(target, durationMs);
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
    const target = await resolveModerationTarget(parts.slice(2).join(" "));
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
    const target = await resolveModerationTarget(nameParts.join(" "));
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

  const mentionTarget = currentMentionTarget;

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
  if (myTimeoutRemainingMs > 0) {
    showComposerNotice("You're muted for " + formatCountdown(myTimeoutRemainingMs) + " more.");
    return;
  }
  if (editingMsgId) { await commitEdit(text); return; }
  // Text and images each respect their own per-rank delay. Tell the person how
  // long is left instead of silently swallowing the Enter key.
  const textWait = currentMessageCooldownMs() - (Date.now() - lastSentAt);
  if (!pendingImageDataUrl && textWait > 0) {
    showComposerNotice("Slow down — wait " + Math.ceil(textWait / 1000) + "s before sending again (your rank's delay is " + Math.round(currentMessageCooldownMs() / 1000) + "s).");
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

    ChatBackend.sendImage(myName, imageToSend, myLoginId)
      .then(() => {
        if (text) {
          return ChatBackend.send(myName, text, null, myLoginId, currentReplyPayload());
        }
      })
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

  if (!text && !mentionTarget) return;

  if (mentionTarget && !currentMentionSound) {
    // mention only: no sound, so no cooldown
    finalizeSend(text, { name: mentionTarget, silent: true });
    return;
  }
  if (mentionTarget) {
    $sendBtn.disabled = true;
    ChatBackend.tryStartAtPingCooldown(mentionTarget).then(result => {
      $sendBtn.disabled = false;
      if (!result.ok) {
        const secs = Math.ceil(result.remainingMs / 1000);
        showComposerNotice(mentionTarget + " was just pinged — wait " + secs + "s before pinging them again.");
        return;
      }
      finalizeSend(text, { name: mentionTarget });
    }).catch(() => {
      $sendBtn.disabled = false;
      showComposerNotice("Couldn't check ping cooldown — try again.");
    });
    return;
  }

  finalizeSend(text, null);
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

function clearPendingImage() {
  pendingImageDataUrl = null;
  $pendingImageBar.style.display = "none";
  $pendingImagePreview.src = "";
}

function stageImageFile(file) {
  if (!canPostImages()) return;

  if (!file) return;
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
      $uploadImageBtn.textContent = "📎 Image";
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
  $uploadImageBtn.style.display = canPostImages() ? "inline-block" : "none";
  if (!canPostImages()) clearPendingImage();
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
    wrap.appendChild(row);
  };

  toggle("Auto scroll", "Keeps the newest message in view", () => autoScroll, v => setAutoScroll(v));
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
    wrap.appendChild(row);
  };
  toggle("Peer verification", verifyFlagOn ? "Checks that bans, mutes and grants come from someone allowed to do them" : "Off in this room until the Owner runs /verify on", () => chatPrefs.peerVerify !== false, v => {
    chatPrefs.peerVerify = v; saveChatPrefs(); scheduleVerifyRefresh();
  });
  { const r = document.createElement("button"); r.type = "button"; r.className = "cs-row"; r.innerHTML = '<span class="cs-label">Open Verification panel<small>See who is verified and what was approved or rejected</small></span>'; r.addEventListener("click", e => { e.stopPropagation(); if (window.VUS_UI && window.VUS_UI.closeSettings) window.VUS_UI.closeSettings(); openVerifyPanel(); }); wrap.appendChild(r); }
  choice("Text size", [["s", "Small"], ["m", "Medium"], ["l", "Large"], ["xl", "Huge"]], () => chatPrefs.textSize, v => { chatPrefs.textSize = v; saveChatPrefs(); applyAppearance(); keepPinned(); });
  choice("Bubble size", [["compact", "Compact"], ["normal", "Normal"], ["roomy", "Roomy"]], () => chatPrefs.bubbleSize, v => { chatPrefs.bubbleSize = v; saveChatPrefs(); applyAppearance(); keepPinned(); });
  toggle("Bold text", "Easier to read", () => !!chatPrefs.bold, v => { chatPrefs.bold = v; saveChatPrefs(); applyAppearance(); keepPinned(); });

  const action = (label, onClick, danger) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cs-action" + (danger ? " danger" : "");
    b.textContent = label;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(b); });
    wrap.appendChild(b);
    return b;
  };
  const rem = getPingYouRemainingMs();
  const pingBtn = action(rem > 0 ? "\uD83D\uDD14 Ping Devs (" + Math.ceil(rem / 1000) + "s)" : "\uD83D\uDD14 Ping Devs", () => {
    if (getPingYouRemainingMs() > 0) return;
    closeClearPanel();
    $pingYouBtn.click();
  });
  if (rem > 0) pingBtn.disabled = true;
  action("Clear chat on my screen", () => { $clearChatBtn.click(); closeClearPanel(); }, true);

  const divider = document.createElement("div");
  divider.style.cssText = "height:1px;background:#334155;margin:10px 0";
  wrap.appendChild(divider);
  container.appendChild(wrap);
}

async function renderModMenu() {
  $globalClearPanel.innerHTML = "";
  $globalClearPanel.style.width = "260px";

  renderChatSettings($globalClearPanel);
  renderPreCodeActions($globalClearPanel);

  const showColor = myRank() >= COLOR_MIN_RANK;
  if (!showColor) {
    const lockedColor = document.createElement("div");
    lockedColor.textContent = "Bubble colors unlock at " + ROLES.normie.icon + " " + ROLES.normie.label + ".";
    lockedColor.style.cssText = "color:#64748b;font-size:12.5px;line-height:1.4;margin-bottom:6px";
    $globalClearPanel.appendChild(lockedColor);
  }
  if (showColor) {
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
      const result = await ChatBackend.claimColor(myLoginId, pendingBubble, pendingText);
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
  addPanelButton("\uD83D\uDCD6 Rank guide", () => { closeClearPanel(); openRankGuide(); });
  if (rank >= ROSTER_MIN_RANK)       addPanelButton("\uD83D\uDC65 Rank roster", () => { closeClearPanel(); openRoster(); });
  if (rank >= ROLES.crown.rank)      addPanelButton("👑 Owner Menu", () => { closeClearPanel(); openOwnerMenu(); });
  else if (rank >= ROLES.admin.rank) addPanelButton("🛡️ Admin Menu", () => { closeClearPanel(); openAdminMenuStaff(); });
  else if (rank >= ROLES.mod.rank)   addPanelButton("🧩 Mod Menu", () => { closeClearPanel(); openModMenuStaff(); });

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

function openBanConfirm(target, durationMs) {
  if (!durationMs && myRank() < ROLES.crown.rank) {
    showComposerNotice("Permanent bans are Owner-only. Use a temporary ban (" + limitsText(banLimitsForRank(myRank())) + ").");
    return;
  }
  if (durationMs) {
    const problem = checkDurationLimits(durationMs, banLimitsForRank(myRank()));
    if (problem) { showComposerNotice(problem); return; }
  }
  pendingBanTarget = target;
  pendingBanDurationMs = durationMs;
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
    await ChatBackend.banUser(target.loginId, target.name, myLoginId, durationMs);
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
  $ownerMenuSubtitle.textContent = "Online now. Press Refresh to update the list. Mutes only (" + limitsText(TIME_LIMITS.modTimeout) + ").";
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
  hist.addEventListener("toggle", () => { staffHistoryOpen = hist.open; if (hist.open) loadHistory(); });
  hist.open = staffHistoryOpen;
  if (staffHistoryOpen) loadHistory();
  $ownerMenuCommands.appendChild(hist);
}

function closeOwnerMenu() {
  $ownerMenuOverlay.style.display = "none";
}

$ownerMenuCloseBtn.addEventListener("click", closeOwnerMenu);
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
  const grantable = Object.values(ROLES).filter(r => !r.implicit && r.id !== "crown" && r.id !== "coowner" && r.rank < role.rank);
  const canGrant = role.rank >= ROLES.admin.rank && grantable.length > 0;
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
  if (menu) lines.push(["Menu", menu + (role.id === "mod" ? " (mutes only)" : "") + " in Settings."]);
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
  banBtn.title = loginId ? "Ban login ID #" + loginId + " permanently" : "This user has not supplied a login ID";
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
    listBtn.addEventListener("click", openModListMenu);
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
      openBanConfirm({ name: banTarget.name, loginId: banTarget.loginId }, totalMs);
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
    await ChatBackend.setTimeout_(pendingTimeoutTarget.loginId, totalMs, myLoginId);
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

let currentMentionTarget = null;
let mentionDropdownOpen = false;
let mentionTriggerCharIndex = -1;
let mentionDropdownMode = "mention";

const $mentionSoundBtn = document.getElementById("mentionSoundBtn");
const $mentionCancelBtn = document.getElementById("mentionCancelBtn");
let currentMentionSound = false;   // "mention only" is the default; the bell turns sound on for this one mention

function paintMentionSound() {
  $mentionSoundBtn.textContent = currentMentionSound ? "\uD83D\uDD14 Ping" : "\uD83D\uDD15 Silent";
  $mentionSoundBtn.classList.toggle("on", currentMentionSound);
  $mentionSoundBtn.title = currentMentionSound
    ? "Plays a sound and a pop-up for them (30s limit per person). Click for mention only."
    : "Mentions them without a sound (no limit). Click to ping with sound.";
}

function clearMention() {
  currentMentionTarget = null;
  currentMentionSound = false;
  $mentionChip.style.display = "none";
  $mentionChip.textContent = "";
  $mentionSoundBtn.style.display = "none";
  $mentionCancelBtn.style.display = "none";
}

function setMention(name) {
  currentMentionTarget = name;
  currentMentionSound = false;
  $mentionChip.textContent = "@" + name;
  $mentionChip.style.display = "inline-flex";
  $mentionSoundBtn.style.display = "inline-flex";
  $mentionCancelBtn.style.display = "inline-flex";
  paintMentionSound();
}
$mentionSoundBtn.addEventListener("click", (e) => { e.stopPropagation(); currentMentionSound = !currentMentionSound; paintMentionSound(); $msgInput.focus(); });
$mentionCancelBtn.addEventListener("click", (e) => { e.stopPropagation(); clearMention(); $msgInput.focus(); });

function closeMentionDropdown() {
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

function renderMentionDropdown() {
  $mentionDropdown.innerHTML = "";
  addMentionCancelRow();

  const candidates = latestPresenceList
    .map(e => e.name)
    .filter(name => name !== myName)
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
  mentionDropdownMode = "mention";
  mentionTriggerCharIndex = triggerIndex;
  mentionDropdownOpen = true;
  $mentionDropdown.style.display = "block";
  renderMentionDropdown();
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

$mentionChip.addEventListener("click", (e) => {
  e.stopPropagation();
  openMentionDropdown(-1);
});

document.addEventListener("click", (e) => {
  if (mentionDropdownOpen && !$mentionDropdown.contains(e.target) && e.target !== $mentionChip) {
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
  setTimeout(renderRailRooms, 0);
}, true);

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

async function switchToMainRoom() {
  if (currentRoomCode === null) return;

  teardownCurrentRoomMetaWatch();
  currentRoomCode = null;
  currentRoomMeta = null;
  ChatBackend.bindToRoom(MAIN_ROOM_ID);
  if (myName) await ChatBackend.claimPresence(myName, false, myLoginId);
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
    byId[id || ("name:" + entry.name)] = { id, name: entry.name, online: true, joinedAt: entry.joinedAt || 0 };
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
      dot.className = "member-dot";
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
  Object.keys(pendingEdits).forEach(k => delete pendingEdits[k]);
  Object.keys(reactionsByMsg).forEach(k => delete reactionsByMsg[k]);
  replyingTo = null; editingMsgId = null; updateReplyBar();
  Object.keys(timeoutsAll).forEach(k => delete timeoutsAll[k]);
  ChatBackend.watchAllTimeouts((id, val) => { if (val) timeoutsAll[id] = val; else delete timeoutsAll[id]; refreshSilencedMessages(); });
  ChatBackend.watchEdits(applyEdit);
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
    });
  });
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
  ChatBackend.watchRecs("actions", onRec);
  ChatBackend.watchRecs("grants", onRec);
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
window.VUS_CHAT = {
  staffActionsFor, runStaffAction, timeoutLimitsForRank, banLimitsForRank,
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
