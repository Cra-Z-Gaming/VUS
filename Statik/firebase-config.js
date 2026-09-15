// Firebase config for the "vus-static" project.
// Compat SDK style (no bundler/import needed) — loaded via the
// raw.githubusercontent fetch-and-inject pattern in index.html.
const firebaseConfig = {
  apiKey: "AIzaSyB4jCgU3rD5wDhOSJaGCAXC4ESIIuhFa0E",
  authDomain: "vus-static.firebaseapp.com",
  projectId: "vus-static",
  storageBucket: "vus-static.firebasestorage.app",
  messagingSenderId: "1056211291218",
  appId: "1:1056211291218:web:9e8e9c5874264ed78fe38b"
  // measurementId omitted — Analytics requires the modular SDK (import-based),
  // which conflicts with the compat <script src> approach used here.
  // Firestore + Storage don't need it.
};

firebase.initializeApp(firebaseConfig);
