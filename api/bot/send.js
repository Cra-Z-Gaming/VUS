// POST /api/bot/send   Authorization: Bearer <DEV token>
//   { "text": "hello" }                                   -> a text message
//   { "text": "preview", "slm": { id, l, n, exp, ... } }   -> a shared large message (SLM) card
// Bots can only send text and SLM (no images, GIFs, videos or polls). The message ALWAYS carries bot:true
// (the "(Bot)" tag); only this server can write that field.
const { admin, MAIN_ROOM, chatDb, sha256, safeEq, cors, readBody, accountById } = require("../_lib");

function cleanSlm(s) {
  if (!s || typeof s !== "object") return null;
  const id = String(s.id || "");
  if (!/^[A-Z0-9]{6}$/.test(id) || typeof s.l !== "boolean" || typeof s.n !== "number" || typeof s.exp !== "number") return false;
  if (s.n < 1 || s.n > 3000000) return false;
  const out = { id, l: s.l, n: s.n, exp: s.exp };
  if (s.ext !== undefined) {
    if (!/^[A-Za-z0-9]{1,12}$/.test(String(s.ext))) return false;
    out.ext = String(s.ext);
    out.name = String(s.name || "file").replace(/[\u0000-\u001f]/g, "").slice(0, 100) || "file";
  }
  return out;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });
  try {
    const m = /^Bearer\s+(vus_(\d{6})_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || "");
    if (!m) return res.status(401).json({ ok: false, error: "Missing or malformed token." });
    const token = m[1], id = m[2], db = chatDb();

    const rec = (await db.ref("botTokens/" + id).get()).val();
    if (!rec || !rec.salt || !safeEq(sha256(rec.salt + token), rec.hash)) return res.status(401).json({ ok: false, error: "Invalid token." });

    const b = readBody(req);
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text || text.length > 500) return res.status(400).json({ ok: false, error: "text must be 1-500 characters." });
    const slm = b.slm === undefined ? null : cleanSlm(b.slm);
    if (slm === false) return res.status(400).json({ ok: false, error: "slm is not valid." });
    const extra = Object.keys(b).filter((k) => k !== "text" && k !== "slm");
    if (extra.length) return res.status(400).json({ ok: false, error: "Bots can only send text and slm." });

    const found = await accountById(id);
    if (!found) return res.status(401).json({ ok: false, error: "Invalid token." });

    // Muting or banning the main account stops its bot too (the bot is the same ID).
    const now = Date.now();
    const [ban, mute] = await Promise.all([
      db.ref("rooms/" + MAIN_ROOM + "/bannedUsers/" + id).get(),
      db.ref("rooms/" + MAIN_ROOM + "/timeouts/" + id).get()
    ]);
    const bn = ban.val(), t = mute.val();
    if (bn && (!bn.expiresAt || Number(bn.expiresAt) > now)) return res.status(403).json({ ok: false, error: "This account is banned from chat." });
    if (t && Number(t.expiresAt) > now) return res.status(403).json({ ok: false, error: "This account is muted." });

    const tx = await db.ref("botLast/" + id).transaction((v) => (v && now - v < 2000 ? undefined : now));
    if (!tx.committed) return res.status(429).json({ ok: false, error: "Slow down: 1 message per 2 seconds." });

    const ref = await db.ref("rooms/" + MAIN_ROOM + "/messages").push({
      name: found.account.username, loginId: id, text, ts: admin.database.ServerValue.TIMESTAMP, bot: true,
      ...(slm ? { slm } : {})
    });
    return res.json({ ok: true, id: ref.key });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
};
