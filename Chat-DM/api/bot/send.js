// POST /api/bot/send   Authorization: Bearer <token>   body: { "text": "hello" }
// Posts to the main chat as the token's account. The message ALWAYS carries bot:true (the "(Bot)" tag);
// the database rules stop ordinary clients from writing that field, only this server can.
const { admin, MAIN_ROOM, chatDb, sha256, safeEq, cors, readBody, accountById } = require("../_lib");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });
  try {
    const m = /^Bearer\s+(vus_(\d{6})_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || "");
    if (!m) return res.status(401).json({ ok: false, error: "Missing or malformed token." });
    const token = m[1], id = m[2], db = chatDb();

    const rec = (await db.ref("botTokens/" + id).get()).val();
    if (!rec || !rec.salt || !safeEq(sha256(rec.salt + token), rec.hash)) return res.status(401).json({ ok: false, error: "Invalid token." });

    const text = typeof readBody(req).text === "string" ? readBody(req).text.trim() : "";
    if (!text || text.length > 500) return res.status(400).json({ ok: false, error: "text must be 1-500 characters." });

    const found = await accountById(id);
    if (!found) return res.status(401).json({ ok: false, error: "Invalid token." });

    // Muting or banning the main account stops its bot too (the bot is the same ID).
    const now = Date.now();
    const [ban, mute] = await Promise.all([
      db.ref("rooms/" + MAIN_ROOM + "/bannedUsers/" + id).get(),
      db.ref("rooms/" + MAIN_ROOM + "/timeouts/" + id).get()
    ]);
    const b = ban.val(), t = mute.val();
    if (b && (!b.expiresAt || Number(b.expiresAt) > now)) return res.status(403).json({ ok: false, error: "This account is banned from chat." });
    if (t && Number(t.expiresAt) > now) return res.status(403).json({ ok: false, error: "This account is muted." });

    // one message per 2 seconds per account
    const tx = await db.ref("botLast/" + id).transaction((v) => (v && now - v < 2000 ? undefined : now));
    if (!tx.committed) return res.status(429).json({ ok: false, error: "Slow down: 1 message per 2 seconds." });

    const ref = await db.ref("rooms/" + MAIN_ROOM + "/messages").push({
      name: found.account.username, loginId: id, text, ts: admin.database.ServerValue.TIMESTAMP, bot: true
    });
    return res.json({ ok: true, id: ref.key });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
};
