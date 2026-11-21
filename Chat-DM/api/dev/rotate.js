// POST /api/dev/rotate   { id, password }               -> creates or rotates your DEV API token (shown once)
//                        { id, password, revoke:true } -> deletes it
// The password proves you own the account. The token is stored only as a salted SHA-256 hash.
// Every error looks like { ok:false, code, error, hint? } with a stable "code".
const { admin, crypto, chatDb, sha256, cors, readBody, fail, passwordGate } = require("../_lib");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return fail(res, 405, "METHOD_NOT_ALLOWED", "Use POST.");
  try {
    const b = readBody(req);
    if (b.__badJson) return fail(res, 400, "BAD_JSON", "The request body is not valid JSON.");
    const id = String(b.id || "").trim(), password = String(b.password || "");
    const db = chatDb();
    const gate = await passwordGate(db, id, password);
    if (!gate.ok) {
      const { status, code, error, ...extra } = gate;
      delete extra.ok;
      if (code === "WRONG_CREDENTIALS") extra.hint = "Check your 6-digit ID and your account password. After 5 wrong tries in a row this ID is locked for 10 minutes.";
      return fail(res, status, code, error, extra);
    }

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
    return fail(res, 500, e && e.config ? "SERVER_CONFIG" : "SERVER_ERROR", e && e.config ? e.message : "Something went wrong on the server.", e && e.config ? {} : { hint: "Open /api/ping to check the server setup." });
  }
};
