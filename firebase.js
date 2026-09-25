// ===================== firebase.js =====================
// Centralized Firebase connection + Realtime Database online-presence tracking
// for VUS Hub.
//
// This file is intentionally written as plain browser JS so it can run in
// about:blank windows and stricter HTML viewers (like Sektor) without relying
// on ESM imports or blob-wrapped module execution, which can be blocked by
// sandbox/CSP restrictions.

(function () {
  const firebaseLib = window.firebase;
  const firebaseConfig = {
    apiKey: "AIzaSyAhpEABjoL5CBxoRL7J7aMQVbmMgcGP91I",
    authDomain: "vus-hub.firebaseapp.com",
    databaseURL: "https://vus-hub-default-rtdb.firebaseio.com",
    projectId: "vus-hub",
    storageBucket: "vus-hub.firebasestorage.app",
    messagingSenderId: "360824166401",
    appId: "1:360824166401:web:c4f4770f6ac43552e7c800"
  };

  function firebaseAvailable() {
    return !!(firebaseLib && firebaseLib.apps && firebaseLib.database && firebaseLib.database());
  }

  const app = firebaseAvailable() && firebaseLib.apps.length ? firebaseLib.apps[0] : (firebaseLib && firebaseLib.initializeApp ? firebaseLib.initializeApp(firebaseConfig) : null);
  const db = app && firebaseLib && firebaseLib.database ? firebaseLib.database(app) : null;

  if (!firebaseAvailable()) {
    console.warn("VUS Hub: Firebase compat SDK not available; running in offline fallback mode.");
  }

  // ===================== PRESENCE TRACKING =====================
  // Realtime Database structure:
  //   /presence/{connectionId} -> true while connected, auto-removed on disconnect
  const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  const ACTIVITY_EVENTS = ["click", "keydown", "touchstart", "scroll", "mousemove"];
  let currentCount = 0;
  const countListeners = new Set();

  function notifyCountListeners(count) {
    currentCount = count;
    countListeners.forEach(fn => {
      try { fn(count); } catch (e) { /* ignore listener errors */ }
    });
  }

  function startPresence() {
    if (!firebaseAvailable() || window.__vusHubPresenceStarted) return;
    window.__vusHubPresenceStarted = true;

    const presenceListRef = db.ref("presence");
    const connectedRef = db.ref(".info/connected");
    let myPresenceRef = null;
    let idleTimer = null;

    function registerPresence() {
      myPresenceRef = presenceListRef.push();
      myPresenceRef.onDisconnect().remove();
      myPresenceRef.set({
        online: true,
        since: firebaseLib.database.ServerValue.TIMESTAMP
      });
    }

    function markIdle() {
      if (myPresenceRef) {
        myPresenceRef.set(null);
        myPresenceRef = null;
      }
    }

    function resetIdleTimer() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(markIdle, IDLE_TIMEOUT_MS);
      if (!myPresenceRef) registerPresence();
    }

    connectedRef.on("value", (snap) => {
      if (snap.val() === false) return;
      if (myPresenceRef) return;
      registerPresence();
    });

    ACTIVITY_EVENTS.forEach(evt => {
      document.addEventListener(evt, resetIdleTimer, { passive: true });
    });

    resetIdleTimer();
  }

  let presenceListenerStarted = false;

  function ensurePresenceListener() {
    if (!firebaseAvailable() || presenceListenerStarted) return;
    presenceListenerStarted = true;
    const presenceListRef = db.ref("presence");
    presenceListRef.on("value", (snap) => {
      const val = snap.val();
      const count = val ? Object.keys(val).length : 0;
      notifyCountListeners(count);
    });
  }

  function onOnlineCount(callback) {
    if (!callback || typeof callback !== "function") return () => {};
    if (!firebaseAvailable()) {
      callback(0);
      return () => {};
    }

    countListeners.add(callback);
    callback(currentCount);
    ensurePresenceListener();
    return () => countListeners.delete(callback);
  }

  // ===================== HOURLY VISIT ANALYTICS =====================
  function dayKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  const ANALYTICS_CHECK_INTERVAL_MS = 60 * 1000;
  const ANALYTICS_QUALIFY_MS = 60 * 1000;

  function incrementHourlyVisit(date) {
    if (!firebaseAvailable()) return;
    const key = dayKey(date);
    const hour = date.getHours();
    const hourRef = db.ref(`analytics/${key}/${hour}`);
    hourRef.transaction((current) => (current || 0) + 1).catch((err) => {
      console.error("VUS Hub: analytics write failed:", err);
    });
  }

  function startAnalyticsTracking() {
    if (!firebaseAvailable() || window.__vusHubAnalyticsStarted) return;
    window.__vusHubAnalyticsStarted = true;

    const loggedHours = new Set();
    function logCurrentHourIfNeeded() {
      const now = new Date();
      const marker = `${dayKey(now)}:${now.getHours()}`;
      if (loggedHours.has(marker)) return;
      loggedHours.add(marker);
      incrementHourlyVisit(now);
    }

    setTimeout(() => {
      logCurrentHourIfNeeded();
      setInterval(logCurrentHourIfNeeded, ANALYTICS_CHECK_INTERVAL_MS);
    }, ANALYTICS_QUALIFY_MS);
  }

  async function getHourlyVisits(dateKey) {
    const key = dateKey || dayKey(new Date());
    if (!firebaseAvailable()) return new Array(24).fill(0);
    const snap = await db.ref(`analytics/${key}`).get();
    const val = snap.val() || {};
    const hours = new Array(24).fill(0);
    for (let h = 0; h < 24; h++) {
      hours[h] = val[h] || 0;
    }
    return hours;
  }

  function watchHourlyVisits(dateKey, callback) {
    if (!firebaseAvailable()) {
      callback(new Array(24).fill(0));
      return () => {};
    }
    const dayRef = db.ref(`analytics/${dateKey}`);
    return dayRef.on("value", (snap) => {
      const val = snap.val() || {};
      const hours = new Array(24).fill(0);
      for (let h = 0; h < 24; h++) {
        hours[h] = typeof val[h] === "number" ? val[h] : 0;
      }
      callback(hours);
    });
  }

  async function getAnalyticsDayKeys() {
    if (!firebaseAvailable()) return [];
    const snap = await db.ref("analytics").get();
    const val = snap.val() || {};
    return Object.keys(val).sort().reverse();
  }

  // ===================== APP CLICK ANALYTICS =====================
  function sanitizeAppKey(name) {
    return encodeURIComponent(name || "unknown").replace(/[.#$/\[\]%]/g, "_");
  }

  function trackAppClick(appName) {
    if (!appName || !firebaseAvailable()) return;
    const key = dayKey(new Date());
    const safeName = sanitizeAppKey(appName);

    const clickRef = db.ref(`analytics/${key}/clicks/${safeName}`);
    clickRef.transaction((current) => {
      const entry = current || { name: appName, count: 0 };
      return { name: appName, count: (entry.count || 0) + 1 };
    }).catch((err) => console.error("VUS Hub: click tracking write failed:", err));

    const allTimeRef = db.ref(`allTimeClicks/${safeName}`);
    allTimeRef.transaction((current) => {
      const entry = current || { name: appName, count: 0 };
      return { name: appName, count: (entry.count || 0) + 1 };
    }).catch((err) => console.error("VUS Hub: all-time click tracking write failed:", err));
  }

  async function getAppClicks(dateKey) {
    const key = dateKey || dayKey(new Date());
    if (!firebaseAvailable()) return [];
    const snap = await db.ref(`analytics/${key}/clicks`).get();
    const val = snap.val() || {};
    return Object.values(val)
      .filter(entry => entry && entry.name)
      .sort((a, b) => b.count - a.count);
  }

  function watchAppClicks(dateKey, callback) {
    if (!firebaseAvailable()) {
      callback([]);
      return () => {};
    }
    const clicksRef = db.ref(`analytics/${dateKey}/clicks`);
    return clicksRef.on("value", (snap) => {
      const val = snap.val() || {};
      const clicks = Object.values(val)
        .filter(entry => entry && entry.name)
        .sort((a, b) => b.count - a.count);
      callback(clicks);
    });
  }

  async function getAllTimeClicks() {
    if (!firebaseAvailable()) return [];
    const snap = await db.ref("allTimeClicks").get();
    const val = snap.val() || {};
    return Object.values(val)
      .filter(entry => entry && entry.name)
      .sort((a, b) => b.count - a.count);
  }

  function watchAllTimeClicks(callback) {
    if (!firebaseAvailable()) {
      callback([]);
      return () => {};
    }
    const allTimeRef = db.ref("allTimeClicks");
    return allTimeRef.on("value", (snap) => {
      const val = snap.val() || {};
      const clicks = Object.values(val)
        .filter(entry => entry && entry.name)
        .sort((a, b) => b.count - a.count);
      callback(clicks);
    });
  }

  let isTopLevelWindow = false;
  try {
    isTopLevelWindow = window.top === window;
  } catch (e) {
    isTopLevelWindow = false;
  }

  if (isTopLevelWindow) {
    try { startPresence(); } catch (e) { console.error("VUS Hub: failed to start presence tracking:", e); }
    try { startAnalyticsTracking(); } catch (e) { console.error("VUS Hub: failed to start analytics tracking:", e); }
  }

  window.VUSPresence = { onOnlineCount };
  window.VUSAnalytics = {
    getHourlyVisits, watchHourlyVisits,
    getAnalyticsDayKeys,
    getAppClicks, watchAppClicks,
    getAllTimeClicks, watchAllTimeClicks,
    trackAppClick,
    getDayKey: dayKey
  };
})();
