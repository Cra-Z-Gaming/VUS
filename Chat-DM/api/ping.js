// GET /api/ping  -> a quick health check for the VUS API setup. Shows which pieces are in place; never shows secrets.
module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const out = { ok: true, node: process.version };
  const expect = { FIREBASE_CHAT_SA: "vus-chat", FIREBASE_DM_SA: "vus-dm" };
  for (const k of Object.keys(expect)) {
    if (!process.env[k]) { out[k] = "MISSING (add it in Vercel, then redeploy)"; continue; }
    try {
      const j = JSON.parse(process.env[k]);
      if (!j.client_email || !j.private_key) out[k] = "set, but not a service-account key (needs client_email and private_key)";
      else if (j.project_id !== expect[k]) out[k] = "set, but it is for project \"" + j.project_id + "\" and should be \"" + expect[k] + "\"";
      else out[k] = "OK";
    } catch (e) { out[k] = "set, but not valid JSON (paste the whole file)"; }
  }
  try { require("firebase-admin"); out.firebaseAdmin = "installed"; }
  catch (e) { out.firebaseAdmin = "MISSING: " + String(e.message).split("\n")[0]; }
  res.status(200).json(out);
};
