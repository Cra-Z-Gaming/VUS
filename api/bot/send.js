// POST /api/bot/send   Authorization: Bearer <DEV token>
//   { "text": "hello" }                                   -> a text message
//   { "text": "preview", "slm": { id, l, n, exp, ... } }   -> a shared large message (SLM) card
// Bots can only send text and SLM (no images, GIFs, videos or polls). The message ALWAYS carries bot:true
// (the "(Bot)" tag); only this server can write that field.
// Every error looks like { ok:false, code, error, hint? } with a stable "code".
const { admin, MAIN_ROOM, chatDb, sha256, safeEq, cors, readBody, fail, accountById } = require("../_lib");

// Returns { slm } when fine, or { problem } describing exactly what is wrong.
function checkSlm(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return { problem: "slm must be an object like {\"id\":\"ABC123\",\"l\":false,\"n\":1234,\"exp\":1790000000000}." };
  const id = String(s.id || "");
  if (!/^[A-Z0-9]{6}$/.test(id)) return { problem: "slm.id must be the 6-character share ID (capital letters and digits)." };
  if (typeof s.l !== "boolean") return { problem: "slm.l must be true or false (is the share locked?)." };
  if (typeof s.n !== "number" || !(s.n >= 1 && s.n <= 3000000)) return { problem: "slm.n must be a number from 1 to 3000000 (characters or bytes)." };
  if (typeof s.exp !== "number") return { problem: "slm.exp must be a number: the expiry time in milliseconds since 1970." };
  const out = { id, l: s.l, n: s.n, exp: s.exp };
  if (s.ext !== undefined) {
    if (!/^[A-Za-z0-9]{1,12}$/.test(String(s.ext))) return { problem: "slm.ext must be 1-12 letters or digits, like \"html\"." };
    out.ext = String(s.ext);
    out.name = String(s.name || "file").replace(/[\u0000-\u001f]/g, "").slice(0, 100) || "file";
  }
  return { slm: out };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return fail(res, 405, "METHOD_NOT_ALLOWED", "Use POST.", { hint: "Send a POST request with a JSON body." });
  try {
    const auth = String(req.headers.authorization || "").trim();
    if (!auth) return fail(res, 401, "MISSING_TOKEN", "No token was sent.", { hint: "Add the header  Authorization: Bearer <your token>  (get one in Settings > DEV)." });
    const m = /^Bearer\s+(vus_(\d{6})_[A-Za-z0-9_-]{43})$/.exec(auth);
    if (!m) {
      const hint = /^Bearer\s+vss_/.test(auth) ? "That is a login token. The API needs the DEV token from Settings > DEV." :
        !/^Bearer\s/i.test(auth) ? "The header must start with the word Bearer, then a space, then the token." :
        "A DEV token looks like vus_123456_ followed by 43 characters. Copy all of it, with no quotes or spaces.";
      return fail(res, 401, "BAD_TOKEN_FORMAT", "That does not look like a VUS token.", { hint });
    }
    const token = m[1], id = m[2], db = chatDb();

    const rec = (await db.ref("botTokens/" + id).get()).val();
    if (!rec || !rec.salt || !safeEq(sha256(rec.salt + token), rec.hash))
      return fail(res, 401, "INVALID_TOKEN", "This token is not valid.", { hint: "It may be mistyped, rotated (older tokens stop working the moment you rotate) or revoked. Generate a new one in Settings > DEV." });

    const b = readBody(req);
    if (b.__badJson) return fail(res, 400, "BAD_JSON", "The request body is not valid JSON.", { hint: "Send Content-Type: application/json and a body like {\"text\":\"Hello world\"}." });
    if (b.text === undefined || b.text === null) return fail(res, 400, "TEXT_REQUIRED", "The body needs a \"text\" field.", { hint: "Example body: {\"text\":\"Hello world\"}." });
    if (typeof b.text !== "string") return fail(res, 400, "TEXT_NOT_STRING", "\"text\" must be a string.", { got: typeof b.text });
    const text = b.text.trim();
    if (!text) return fail(res, 400, "TEXT_EMPTY", "\"text\" is empty.");
    if (text.length > 500) return fail(res, 400, "TEXT_TOO_LONG", "\"text\" is too long.", { length: text.length, max: 500, hint: "Longer messages can go out as an SLM: upload the text to a share and send the slm card with a short preview in \"text\"." });
    const extra = Object.keys(b).filter((k) => k !== "text" && k !== "slm");
    if (extra.length) return fail(res, 400, "UNKNOWN_FIELDS", "Bots can only send \"text\" and \"slm\".", { fields: extra, hint: "Images, GIFs, videos and polls are not available to bots." });
    let slm = null;
    if (b.slm !== undefined) {
      const r = checkSlm(b.slm);
      if (r.problem) return fail(res, 400, "SLM_INVALID", "\"slm\" is not valid.", { problem: r.problem });
      slm = r.slm;
    }

    const found = await accountById(id);
    if (!found) return fail(res, 401, "ACCOUNT_NOT_FOUND", "The account for this token no longer exists.", { hint: "Create a new token while logged in to an existing account." });

    // Bans and mutes are enforced by the chat itself: everyone's chat hides messages from a verified-muted or
    // banned ID, and the bot is the same ID. A leftover or unverified record must not block the bot here.
    const now = Date.now();
    const tx = await db.ref("botLast/" + id).transaction((v) => (v && now - v < 2000 ? undefined : now));
    if (!tx.committed) {
      const last = Number(tx.snapshot.val()) || now;
      return fail(res, 429, "RATE_LIMITED", "Slow down: 1 message every 2 seconds.", { retryAfterMs: Math.max(100, 2000 - (now - last)) });
    }

    const ref = await db.ref("rooms/" + MAIN_ROOM + "/messages").push({
      name: found.account.username, loginId: id, text, ts: admin.database.ServerValue.TIMESTAMP, bot: true,
      ...(slm ? { slm } : {})
    });
    return res.json({ ok: true, id: ref.key });
  } catch (e) {
    console.error(e);
    return fail(res, 500, e && e.config ? "SERVER_CONFIG" : "SERVER_ERROR", e && e.config ? e.message : "Something went wrong on the server.", e && e.config ? {} : { hint: "Open /api/ping to check the server setup." });
  }
};
