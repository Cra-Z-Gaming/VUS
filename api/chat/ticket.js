// POST /api/chat/ticket   Authorization: Bearer <login token>   -> { ok, ticket }
// A ticket is a one-time pass for ONE chat message by this account. The database rules refuse any message
// that doesn't carry a ticket issued to the same ID, and the message write spends the ticket, so a message
// can't be sent without a valid token, and nobody can post as another ID.
const { admin, crypto, chatDb, sha256, safeEq, cors } = require("../_lib");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });
  try {
    const m = /^Bearer\s+(vss_(\d{6})_([0-9a-f]{8})_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || "");
    if (!m) return res.status(401).json({ ok: false, error: "Missing or malformed token." });
    const token = m[1], id = m[2], tid = m[3], db = chatDb();

    const rec = (await db.ref("sessTokens/" + id + "/" + tid).get()).val();
    if (!rec || !rec.salt || !safeEq(sha256(rec.salt + token), rec.hash)) return res.status(401).json({ ok: false, error: "Invalid token." });

    // drop expired tickets, and never let more than 6 sit unused
    const now = Date.now(), tref = db.ref("tickets/" + id), all = (await tref.get()).val() || {};
    let live = 0;
    for (const k of Object.keys(all)) {
      if (now - Number(all[k]) > 120000) await tref.child(k).remove(); else live++;
    }
    if (live >= 6) return res.status(429).json({ ok: false, error: "Too many unused tickets. Send a message first." });

    const ticket = crypto.randomBytes(12).toString("base64url");
    await tref.child(ticket).set(admin.database.ServerValue.TIMESTAMP);
    return res.json({ ok: true, ticket });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e && e.config ? e.message : "Server error." });
  }
};
