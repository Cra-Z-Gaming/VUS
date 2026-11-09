// Shared helpers for the VUS API (Vercel serverless functions). Files starting with "_" are not routes.
const admin = require("firebase-admin");
const crypto = require("crypto");

const MAIN_ROOM = "vus-hub-main";

// One admin app per Firebase project. The service-account JSON lives in Vercel environment variables.
function app(name, envVar, databaseURL) {
  const existing = admin.apps.find((a) => a && a.name === name);
  if (existing) return existing;
  return admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env[envVar])), databaseURL }, name);
}
const chatDb = () => app("chat", "FIREBASE_CHAT_SA", "https://vus-chat-default-rtdb.firebaseio.com").database();
const dmDb = () => app("dm", "FIREBASE_DM_SA", "https://vus-dm-default-rtdb.firebaseio.com").database();

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}
function readBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

// Looks the account up by its 6-digit ID: { key, account } or null.
async function accountById(id) {
  const db = dmDb();
  const key = (await db.ref("idIndex/" + id).get()).val();
  if (!key) return null;
  const account = (await db.ref("users/" + key).get()).val();
  return account ? { key, account } : null;
}

// Same scheme as dm.js: "pbkdf2$<iterations>$<salt b64>$<hash b64>" (older plain-text passwords still compare).
function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const p = stored.split("$");
  if (p[0] !== "pbkdf2" || p.length !== 4) return safeEq(stored, password);
  const bits = crypto.pbkdf2Sync(password, Buffer.from(p[2], "base64"), parseInt(p[1], 10), 32, "sha256");
  return safeEq(bits.toString("base64"), p[3]);
}

module.exports = { admin, crypto, MAIN_ROOM, chatDb, dmDb, sha256, safeEq, cors, readBody, accountById, verifyPassword };
