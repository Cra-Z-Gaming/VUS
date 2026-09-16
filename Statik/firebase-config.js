// Firebase config for the "vus-static" project — Realtime Database.
// Compat SDK style (no bundler/import needed) — loaded via the
// raw.githubusercontent fetch-and-inject pattern in index.html.
//
// ⚠️ databaseURL is required for Realtime Database and wasn't part of the
// original config you pasted (that was the Firestore-era snippet). Find it
// in Firebase Console -> Realtime Database -> it's shown at the top of the
// Data tab, formatted like https://PROJECT_ID-default-rtdb.REGION.firebasedatabase.app
// Replace the placeholder below with your real one.
const firebaseConfig = {
  apiKey: "AIzaSyB4jCgU3rD5wDhOSJaGCAXC4ESIIuhFa0E",
  authDomain: "vus-static.firebaseapp.com",
  databaseURL: "https://vus-static-default-rtdb.firebaseio.com", // ⚠️ verify this matches your console exactly
  projectId: "vus-static",
  storageBucket: "vus-static.firebasestorage.app",
  messagingSenderId: "1056211291218",
  appId: "1:1056211291218:web:9e8e9c5874264ed78fe38b"
};

firebase.initializeApp(firebaseConfig);
