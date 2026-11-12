// POST /api/chat/ticket   Authorization: Bearer <login token>   body (optional): { name }  -> { ok, ticket }
// A ticket is a one-time pass for ONE chat message by this account, and it is also tied to ONE display name.
// The database rules refuse any message that doesn't carry a ticket issued to the same ID, whose name matches the
// name on the ticket. The message write spends the ticket, so a message can't be sent without a valid token,
// nobody can post as another ID, and nobody can post under a name this account doesn't own.
//
// Which names an account may use:
//   - its own username (always),
//   - or a nickname that is not anyone else's username and is not currently claimed by another account.
// Nickname claims live in chat DB nameClaims/<hash of lowercase name> = { id, at } (server-only; clients can't read or write it)
// and lapse after CLAIM_MS without that account asking for a ticket under the name.
const { admin, crypto, chatDb, dmDb, accountById, sha256, safeEq, cors, readBody, fail } = require("../_lib");

const CLAIM_MS = 30 * 60 * 1000;

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });
  try {
    const m = /^Bearer\s+(vss_(\d{6})_([0-9a-f]{8})_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || "");
    if (!m) return res.status(401).json({ ok: false, error: "Missing or malformed token." });
    const token = m[1], id = m[2], tid = m[3], db = chatDb();

    const rec = (await db.ref("sessTokens/" + id + "/" + tid).get()).val();
    if (!rec || !rec.salt || !safeEq(sha256(rec.salt + token), rec.hash)) return res.status(401).json({ ok: false, error: "Invalid token." });

    // Which name is this ticket for? The client says (its chat nickname); default is the account's own username.
    const found = await accountById(id);
    if (!found) return res.status(401).json({ ok: false, error: "Invalid token." });
    const username = String(found.account.username || "");
    const body = readBody(req);
    const name = (typeof body.name === "string" && body.name.trim() ? body.name : username).trim();
    if (!name || name.length > 40) return fail(res, 400, "BAD_NAME", "That name isn't allowed.");
    const lower = name.toLowerCase(), own = lower === username.toLowerCase();
    const now = Date.now();

    if (!own) {
      // someone else's username can never be used as a nickname
      if (!/[.#$\[\]\/]/.test(lower)) {
        const owner = (await dmDb().ref("usernameIndex/" + lower).get()).val();
        if (owner && owner !== found.key) return fail(res, 403, "NAME_RESERVED", "That name belongs to another account.");
      }
    }
    // claim the name (your own username always wins and takes the claim over)
    const claim = await db.ref("nameClaims/" + sha256(lower).slice(0, 32)).transaction((cur) => {
      if (!own && cur && cur.id !== id && now - Number(cur.at || 0) < CLAIM_MS) return; // abort: someone else has it
      return { id, at: now };
    });
    if (!claim.committed) return fail(res, 409, "NAME_IN_USE", "That name is being used by someone else right now.");

    // drop expired tickets, and never let more than 6 sit unused
    const tref = db.ref("tickets/" + id), all = (await tref.get()).val() || {};
    let live = 0;
    for (const k of Object.keys(all)) {
      const t = all[k] && typeof all[k] === "object" ? Number(all[k].t) : Number(all[k]);
      if (!t || now - t > 120000) await tref.child(k).remove(); else live++;
    }
    if (live >= 6) return res.status(429).json({ ok: false, error: "Too many unused tickets. Send a message first." });

    const ticket = crypto.randomBytes(12).toString("base64url");
    await tref.child(ticket).set({ t: admin.database.ServerValue.TIMESTAMP, n: name });
    return res.json({ ok: true, ticket });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e && e.config ? e.message : "Server error." });
  }
};
