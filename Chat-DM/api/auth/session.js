// POST /api/auth/session   { id, password }  -> a login token for THIS browser (shown to the page once, kept in localStorage).
// Every chat message needs a one-time ticket, and tickets are only given to holders of a valid token.
// Only a salted SHA-256 hash of the token is stored. Each account keeps its 5 newest device tokens.
const { admin, crypto, chatDb, sha256, cors, readBody, passwordGate } = require("../_lib");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });
  try {
    const b = readBody(req), id = String(b.id || "").trim(), password = String(b.password || "");
    const db = chatDb();
    const gate = await passwordGate(db, id, password);
    if (!gate.ok) return res.status(gate.status).json({ ok: false, code: gate.code, error: gate.error });

    const tid = crypto.randomBytes(4).toString("hex");
    const token = "vss_" + id + "_" + tid + "_" + crypto.randomBytes(32).toString("base64url");
    const salt = crypto.randomBytes(16).toString("hex");
    const ref = db.ref("sessTokens/" + id);
    await ref.child(tid).set({ salt, hash: sha256(salt + token), createdAt: admin.database.ServerValue.TIMESTAMP });

    const all = (await ref.get()).val() || {};
    const keys = Object.keys(all).sort((a, c) => (all[a].createdAt || 0) - (all[c].createdAt || 0));
    for (const k of keys.slice(0, Math.max(0, keys.length - 5))) await ref.child(k).remove();

    // Enforcement is switched on separately, in the chat database: set config/tokensRequiredSince (see the setup notes).
    
    return res.json({ ok: true, token });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e && e.config ? e.message : "Server error." });
  }
};
