// POST /api/dev/rotate   { id, password }               -> creates or rotates your API token (shown once)
//                        { id, password, revoke:true } -> deletes it
// The password proves you own the account. The token is stored only as a salted SHA-256 hash.
const { admin, crypto, chatDb, sha256, cors, readBody, accountById, verifyPassword } = require("../_lib");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });
  try {
    const b = readBody(req);
    const id = String(b.id || "").trim(), password = String(b.password || "");
    if (!/^\d{6}$/.test(id) || !password) return res.status(400).json({ ok: false, error: "Send your 6-digit ID and your password." });

    const db = chatDb(), now = Date.now();
    // 5 wrong passwords in a row locks this ID out for 10 minutes
    const triesRef = db.ref("botAttempts/" + id), tries = (await triesRef.get()).val() || {};
    if (tries.until && tries.until > now) return res.status(429).json({ ok: false, error: "Too many wrong passwords. Try again in a few minutes." });

    const found = await accountById(id);
    if (!found || !verifyPassword(password, found.account.password)) {
      const fails = (tries.fails || 0) + 1;
      await triesRef.set(fails >= 5 ? { fails: 0, until: now + 10 * 60 * 1000 } : { fails, until: 0 });
      return res.status(401).json({ ok: false, error: "Incorrect ID or password." });
    }
    await triesRef.remove();

    const ref = db.ref("botTokens/" + id);
    if (b.revoke === true) { await ref.remove(); return res.json({ ok: true, revoked: true }); }

    const prev = (await ref.get()).val() || {};
    // The ID stays the same when the token rotates, so mutes that are keyed by ID keep working.
    const token = "vus_" + id + "_" + crypto.randomBytes(32).toString("base64url");
    const salt = crypto.randomBytes(16).toString("hex");
    const gen = (prev.gen || 0) + 1;
    await ref.set({ salt, hash: sha256(salt + token), gen, rotatedAt: admin.database.ServerValue.TIMESTAMP });
    return res.json({ ok: true, token, gen });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e && e.config ? e.message : "Server error." });
  }
};
