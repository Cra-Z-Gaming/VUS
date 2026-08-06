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
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
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

// Auto-start presence tracking only when this module is loaded in the top-level
// document (index.html). home.html loads in an <iframe>, and although it also
// imports this file to read the live count via onOnlineCount(), we don't want
// that second module evaluation to register its own duplicate presence session.
// window.top === window is true only for the outermost page.
try {
  if (window.top === window) {
    startPresence();
    startAnalyticsTracking();
  }
} catch (e) {
  // Cross-origin access to window.top can throw in rare sandboxed setups;
  // default to not starting presence in that case to avoid duplicate sessions.
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
  runTransaction(hourRef, (current) => (current || 0) + 1).catch(() => {
    // Non-critical: a missed analytics tick doesn't affect the live site
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
 * Lists all day keys ("YYYY-MM-DD") that have any recorded analytics data,
 * sorted newest first. Used to populate the admin dashboard's date picker.
 * @returns {Promise<string[]>}
 */
async function getAnalyticsDayKeys() {
  const snap = await get(ref(db, "analytics"));
  const val = snap.val() || {};
  return Object.keys(val).sort().reverse();
}

export { app, db, onOnlineCount, getHourlyVisits, getAnalyticsDayKeys, dayKey as getDayKey };

// Also expose on window for any non-module inline script in index.html that
// wants to read the live count without adding its own <script type="module">.
window.VUSPresence = { onOnlineCount };
window.VUSAnalytics = { getHourlyVisits, getAnalyticsDayKeys, getDayKey: dayKey };
