// ===================== firebase.js =====================
// Centralized Firebase connection + Realtime Database online-presence tracking
// for VUS Hub. Loaded as an ES module (type="module") from index.html so the
// presence tracker runs globally, on every tab, regardless of which Home/Apps/
// Hubs/Tools/Links tab is active. home.html only reads the live count — it does
// not initialize its own Firebase connection or register its own presence node.
//
// Usage:
//   index.html  -> <script type="module" src="firebase.js"></script>
//                  (starts presence tracking automatically on load)
//   home.html   -> import { onOnlineCount } from "./firebase.js";
//                  onOnlineCount(count => { ...update UI... });

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
  onValue,
  onDisconnect,
  set,
  get,
  runTransaction,
  serverTimestamp,
  push
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ---- Placeholder Firebase config ----
// TODO: Replace with real values before deploying, or load from environment/build config.
const firebaseConfig = {
  apiKey: "AIzaSyAhpEABjoL5CBxoRL7J7aMQVbmMgcGP91I",
  authDomain: "vus-hub.firebaseapp.com",
  databaseURL: "https://vus-hub-default-rtdb.firebaseio.com",
  projectId: "vus-hub",
  storageBucket: "vus-hub.firebasestorage.app",
  messagingSenderId: "360824166401",
  appId: "1:360824166401:web:c4f4770f6ac43552e7c800"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ===================== PRESENCE TRACKING =====================
// Realtime Database structure:
//   /presence/{connectionId} -> true while connected, auto-removed on disconnect
// The online count is simply the number of children under /presence.

const presenceListRef = ref(db, "presence");
const connectedRef = ref(db, ".info/connected");

let currentCount = 0;
const countListeners = new Set();

function notifyCountListeners(count) {
  currentCount = count;
  countListeners.forEach(fn => {
    try { fn(count); } catch (e) { /* ignore listener errors */ }
  });
}

/**
 * Starts this tab's presence session: registers a unique connection node under
 * /presence, and configures onDisconnect() so Firebase removes it automatically
 * if the tab closes, loses connection, or crashes (no manual cleanup needed).
 * Safe to call once per page load. Runs from index.html only.
 */
function startPresence() {
  onValue(connectedRef, (snap) => {
    if (snap.val() === false) return;

    // Create a unique node for this browser tab/session
    const myPresenceRef = push(presenceListRef);

    // Remove this node automatically when the connection drops
    onDisconnect(myPresenceRef).remove();

    // Mark this session as online
    set(myPresenceRef, {
      online: true,
      since: serverTimestamp()
    });
  });
}

let presenceListenerStarted = false;

function ensurePresenceListener() {
  if (presenceListenerStarted) return;
  presenceListenerStarted = true;
  onValue(presenceListRef, (snap) => {
    const val = snap.val();
    const count = val ? Object.keys(val).length : 0;
    notifyCountListeners(count);
  });
}

/**
 * Subscribes to live online-count updates. Works from any document that has
 * loaded this module (index.html directly, or home.html via import), since
 * it just listens to the shared /presence list in the database — it does not
 * create a new presence session. Safe to call multiple times; only one
 * underlying Firebase listener is ever registered per page.
 * @param {(count: number) => void} callback
 * @returns {() => void} unsubscribe function (stops this callback only)
 */
function onOnlineCount(callback) {
  countListeners.add(callback);
  // Fire immediately with the last known count, if any
  callback(currentCount);

  ensurePresenceListener();

  return () => {
    countListeners.delete(callback);
  };
}

// ===================== HOURLY VISIT ANALYTICS =====================
// Realtime Database structure:
//   /analytics/{YYYY-MM-DD}/{hour}  -> a running integer count
// A tab only counts once it's been connected for 1+ minute (so brief
// page-loads/bounces don't get logged), then re-checks every minute so a
// long-lived tab logs itself into every new hour it's still open during.
// Multiple tabs from the same or different people each count separately —
// this is a "how many tabs were open" metric, not a unique-visitor count.
// An hour nobody visits simply has no entry at all, which reads back as 0.

function dayKey(date) {
  // Local YYYY-MM-DD, not UTC, so "today" matches the visitor's own day
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const ANALYTICS_CHECK_INTERVAL_MS = 60 * 1000; // re-check every minute
const ANALYTICS_QUALIFY_MS = 60 * 1000; // must be open 1+ minute to count

function incrementHourlyVisit(date) {
  const key = dayKey(date);
  const hour = date.getHours(); // 0-23, local time
  const hourRef = ref(db, `analytics/${key}/${hour}`);
  runTransaction(hourRef, (current) => (current || 0) + 1).catch((err) => {
    // Non-critical to the live site, but still worth surfacing if it happens —
    // a silently-swallowed error here previously hid a real bug for a while.
    console.error("VUS Hub: analytics write failed:", err);
  });
}

/**
 * Starts this tab's analytics session. Waits ANALYTICS_QUALIFY_MS before the
 * first log (so a tab that closes immediately never counts), then logs once
 * per hour boundary crossed while still open, checking every
 * ANALYTICS_CHECK_INTERVAL_MS. Runs from index.html only (top-level window),
 * same guard as startPresence().
 */
function startAnalyticsTracking() {
  const loggedHours = new Set(); // e.g. "2026-08-05:14" — avoids double-logging the same hour from this tab

  function logCurrentHourIfNeeded() {
    const now = new Date();
    const marker = `${dayKey(now)}:${now.getHours()}`;
    if (loggedHours.has(marker)) return;
    loggedHours.add(marker);
    incrementHourlyVisit(now);
  }

  // Qualify after 1 minute connected, then log immediately and start the recurring check
  setTimeout(() => {
    logCurrentHourIfNeeded();
    setInterval(logCurrentHourIfNeeded, ANALYTICS_CHECK_INTERVAL_MS);
  }, ANALYTICS_QUALIFY_MS);
}

/**
 * Reads the 24 hourly visit counts for a given day (defaults to today, local time).
 * Missing hours resolve to 0. Used by the "Dev Info" admin dashboard.
 * @param {string} [dateKey] - "YYYY-MM-DD"; defaults to today
 * @returns {Promise<number[]>} array of 24 numbers, index = hour (0-23)
 */
async function getHourlyVisits(dateKey) {
  const key = dateKey || dayKey(new Date());
  const snap = await get(ref(db, `analytics/${key}`));
  const val = snap.val() || {};
  const hours = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) {
    hours[h] = val[h] || 0;
  }
  return hours;
}

/**
 * Live version of getHourlyVisits(): subscribes to a given day's hourly data
 * and calls back with a fresh 24-length array every time anything under that
 * day changes — no polling, Firebase pushes updates over its existing
 * connection the instant a write happens. Used by the analytics dashboard so
 * bars update in real time as visitors open tabs.
 *
 * Note: /analytics/{date} also has a "clicks" child (see watchAppClicks
 * below) living alongside the numeric hour keys (0-23) — only numeric keys
 * are treated as hour counts here, so click data never leaks into the chart.
 *
 * @param {string} dateKey - "YYYY-MM-DD"
 * @param {(hours: number[]) => void} callback
 * @returns {() => void} unsubscribe function — call when switching away from this day
 */
function watchHourlyVisits(dateKey, callback) {
  const dayRef = ref(db, `analytics/${dateKey}`);
  const unsubscribe = onValue(dayRef, (snap) => {
    const val = snap.val() || {};
    const hours = new Array(24).fill(0);
    for (let h = 0; h < 24; h++) {
      hours[h] = typeof val[h] === "number" ? val[h] : 0;
    }
    callback(hours);
  });
  return unsubscribe;
}

/**
 * Lists all day keys ("YYYY-MM-DD") that have any recorded analytics data,
 * sorted newest first. Used to populate the admin dashboard's date picker.
 * @returns {Promise<string[]>}
 */
async function getAnalyticsDayKeys() {
  const snap = await get(ref(db, "analytics"));
  const val = snap.val() || {};
  return Object.keys(val).sort().reverse();
}

// ===================== APP CLICK ANALYTICS =====================
// Realtime Database structure:
//   /analytics/{YYYY-MM-DD}/clicks/{sanitizedAppName} -> a running integer count
// Incremented once per actual app open (i.e. from openApp() in index.html),
// not just from a tab being open — this tracks what people actually click,
// scoped per day to match the hourly chart's per-day browsing.

// Firebase Realtime Database keys can't contain . # $ [ ] / or control
// characters, and app names may contain any of these (e.g. "about:blank
// Opener", "File + Folder Viewer"). Replace disallowed characters with a
// safe placeholder so every app name maps to a valid, collision-resistant key.
function sanitizeAppKey(name) {
  return encodeURIComponent(name || "unknown").replace(/[.#$/\[\]%]/g, "_");
}

/**
 * Increments today's click count for the given app name, AND the same app's
 * all-time total (used by the "Forever" leaderboard). Call this once per
 * actual app open (from openApp()), not per tab-view. Runs from index.html
 * only — home.html's widget buttons call window.parent.openApp(), which
 * routes through the same index.html instance, so clicks from Home still
 * count correctly without home.html needing its own Firebase connection.
 * @param {string} appName
 */
function trackAppClick(appName) {
  if (!appName) return;
  const key = dayKey(new Date());
  const safeName = sanitizeAppKey(appName);

  const clickRef = ref(db, `analytics/${key}/clicks/${safeName}`);
  runTransaction(clickRef, (current) => {
    const entry = current || { name: appName, count: 0 };
    return { name: appName, count: (entry.count || 0) + 1 };
  }).catch((err) => {
    console.error("VUS Hub: click tracking write failed:", err);
  });

  // Maintained as its own running total (rather than summed from every day's
  // /clicks node on read) so the "Forever" leaderboard stays fast to load no
  // matter how many days of history accumulate.
  const allTimeRef = ref(db, `allTimeClicks/${safeName}`);
  runTransaction(allTimeRef, (current) => {
    const entry = current || { name: appName, count: 0 };
    return { name: appName, count: (entry.count || 0) + 1 };
  }).catch((err) => {
    console.error("VUS Hub: all-time click tracking write failed:", err);
  });
}

/**
 * Reads all app click counts for a given day (defaults to today, local
 * time), sorted most-clicked first. Used by the "Dev Info" admin dashboard.
 * @param {string} [dateKey] - "YYYY-MM-DD"; defaults to today
 * @returns {Promise<{name: string, count: number}[]>}
 */
async function getAppClicks(dateKey) {
  const key = dateKey || dayKey(new Date());
  const snap = await get(ref(db, `analytics/${key}/clicks`));
  const val = snap.val() || {};
  return Object.values(val)
    .filter(entry => entry && entry.name)
    .sort((a, b) => b.count - a.count);
}

/**
 * Live version of getAppClicks(): subscribes to a given day's click counts
 * and calls back with a freshly sorted leaderboard every time any app's
 * count changes that day. Used by the analytics dashboard for real-time
 * updates without polling.
 * @param {string} dateKey - "YYYY-MM-DD"
 * @param {(clicks: {name: string, count: number}[]) => void} callback
 * @returns {() => void} unsubscribe function
 */
function watchAppClicks(dateKey, callback) {
  const clicksRef = ref(db, `analytics/${dateKey}/clicks`);
  const unsubscribe = onValue(clicksRef, (snap) => {
    const val = snap.val() || {};
    const clicks = Object.values(val)
      .filter(entry => entry && entry.name)
      .sort((a, b) => b.count - a.count);
    callback(clicks);
  });
  return unsubscribe;
}

/**
 * Reads all-time app click totals (summed across every day since tracking
 * started), sorted most-clicked first. Backed by a running counter kept in
 * sync by trackAppClick(), so this is a single small read regardless of how
 * many days of history exist.
 * @returns {Promise<{name: string, count: number}[]>}
 */
async function getAllTimeClicks() {
  const snap = await get(ref(db, "allTimeClicks"));
  const val = snap.val() || {};
  return Object.values(val)
    .filter(entry => entry && entry.name)
    .sort((a, b) => b.count - a.count);
}

/**
 * Live version of getAllTimeClicks(): subscribes to the all-time click totals
 * and calls back with a freshly sorted leaderboard whenever any app's
 * all-time count changes, anywhere, ever. Used by the analytics dashboard's
 * "Forever" leaderboard for real-time updates without polling.
 * @param {(clicks: {name: string, count: number}[]) => void} callback
 * @returns {() => void} unsubscribe function
 */
function watchAllTimeClicks(callback) {
  const allTimeRef = ref(db, "allTimeClicks");
  const unsubscribe = onValue(allTimeRef, (snap) => {
    const val = snap.val() || {};
    const clicks = Object.values(val)
      .filter(entry => entry && entry.name)
      .sort((a, b) => b.count - a.count);
    callback(clicks);
  });
  return unsubscribe;
}

// Auto-start presence tracking and analytics only when this module is loaded
// in the top-level document (index.html). home.html loads in an <iframe>,
// and although it also imports this file to read the live count via
// onOnlineCount(), we don't want that second module evaluation to register
// its own duplicate presence session or analytics timer.
// window.top === window is true only for the outermost page.
//
// Presence and analytics are started in separate try/catch blocks so a bug
// in one can never be misreported as a failure in the other (this bit us
// once already — keep them isolated).
let isTopLevelWindow = false;
try {
  isTopLevelWindow = window.top === window;
} catch (e) {
  // Cross-origin access to window.top can throw in rare sandboxed setups;
  // default to false (not top-level) to avoid duplicate sessions.
  isTopLevelWindow = false;
}

if (isTopLevelWindow) {
  try {
    startPresence();
  } catch (e) {
    console.error("VUS Hub: failed to start presence tracking:", e);
  }
  try {
    startAnalyticsTracking();
  } catch (e) {
    console.error("VUS Hub: failed to start analytics tracking:", e);
  }
}

export {
  app, db, onOnlineCount,
  getHourlyVisits, watchHourlyVisits,
  getAnalyticsDayKeys,
  getAppClicks, watchAppClicks,
  getAllTimeClicks, watchAllTimeClicks,
  trackAppClick,
  dayKey as getDayKey
};

// Also expose on window for any non-module inline script in index.html that
// wants to read the live count without adding its own <script type="module">.
window.VUSPresence = { onOnlineCount };
window.VUSAnalytics = {
  getHourlyVisits, watchHourlyVisits,
  getAnalyticsDayKeys,
  getAppClicks, watchAppClicks,
  getAllTimeClicks, watchAllTimeClicks,
  trackAppClick,
  getDayKey: dayKey
};
