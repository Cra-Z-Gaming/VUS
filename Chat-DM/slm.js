/* SLM (ShareLargeMessages) core. Loaded before dm.js / chat.js and by SLM.html.
   Exposes window.VUS_SLM = { offer, card, create, fetchShare, unlock, destroy, previewOf }.
   Shares live in the separate "large-code" Firebase project. Needs the firebase-app-compat
   and firebase-database-compat scripts to be loaded first. */
(function () {
  "use strict";
  var CFG = { apiKey: "AIzaSyBlfI1YDXg8hdoEAqcFKIdzmYJy-EZ8C8", authDomain: "large-code.firebaseapp.com", databaseURL: "https://large-code-default-rtdb.firebaseio.com/", projectId: "large-code", appId: "1:394088772356:web:a829fc27fb5ee57fae1651" };
  var DURATION = 3 * 60 * 60 * 1000, MAX_LEN = 200000, PBKDF2_ITER = 150000;
  var VIEWER = window.SLM_VIEWER_URL || new URL("SLM.html", location.href).href;   // override with window.SLM_VIEWER_URL if the viewer lives elsewhere

  var app = firebase.apps.find(function (a) { return a.name === "slm"; }) || firebase.initializeApp(CFG, "slm");
  var db = app.database();
  var enc = new TextEncoder(), dec = new TextDecoder();

  function b64(u) { var s = "", i; for (i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); }
  function unb64(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
  async function sha(t) { var b = await crypto.subtle.digest("SHA-256", enc.encode(t)); return Array.from(new Uint8Array(b)).map(function (x) { return x.toString(16).padStart(2, "0"); }).join(""); }
  function rnd(n, alphabet) { var r = crypto.getRandomValues(new Uint32Array(n)), s = ""; for (var i = 0; i < n; i++) s += alphabet[r[i] % alphabet.length]; return s; }
  async function keyFor(pw, salt) {
    var m = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, m, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  // A locked share is stored encrypted, so reading the database does not reveal it.
  async function lock(text, pw) {
    var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, await keyFor(pw, salt), enc.encode(text)));
    return b64(salt) + "." + b64(iv) + "." + b64(ct);
  }
  async function unlock(blob, pw) {
    var p = blob.split(".").map(unb64);
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: p[1] }, await keyFor(pw, p[0]), p[2]));
  }

  function previewOf(text, locked) {
    if (locked) return "\uD83D\uDD12 Locked message (" + text.length.toLocaleString() + " characters)";
    var lines = text.split("\n").filter(function (l) { return l.trim(); }).slice(0, 3).join("\n");
    return lines.length > 160 ? lines.slice(0, 160) + "\u2026" : lines + (text.trim().split("\n").length > 3 ? "\n\u2026" : "");
  }

  // Uploads the share. Returns { id, delCode, expiresAt, locked, n }.
  async function create(text, password) {
    if (!text || text.length > MAX_LEN) throw new Error("Message must be 1\u2013" + MAX_LEN.toLocaleString() + " characters.");
    var locked = !!password, now = Date.now();
    var body = locked ? await lock(text, password) : text;
    var delCode = rnd(10, "ABCDEFGHJKMNPQRSTUVWXYZ23456789"), delHash = await sha(delCode);
    for (var i = 0; i < 6; i++) {
      var id = rnd(6, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
      try {
        await db.ref("shares/" + id).set({ pub: { code: body, protected: locked, createdAt: now, expiresAt: now + DURATION }, delHash: delHash });
        return { id: id, delCode: delCode.slice(0, 5) + "-" + delCode.slice(5), expiresAt: now + DURATION, locked: locked, n: text.length };
      } catch (e) { if (!/permission/i.test(String(e && (e.code || e.message)))) throw e; }   // an ID collision is refused by the rules: try another
    }
    throw new Error("Couldn't create the share. Try again.");
  }
  // Returns { code, protected, expiresAt } or null if missing / expired / deleted.
  async function fetchShare(id) {
    var snap;
    try { snap = await db.ref("shares/" + id + "/pub").get(); } catch (e) { snap = null; }
    if (!snap || !snap.exists()) { try { await db.ref("shares/" + id).remove(); } catch (e) {} return null; }   // housekeeping: the rules only allow this for expired / deleted shares
    return snap.val();
  }
  // Deleting needs the delete code; wrong codes are refused by the database rules.
  async function destroy(id, delCode) {
    var h = await sha(String(delCode).toUpperCase().replace(/[^A-Z0-9]/g, ""));
    await db.ref("shares/" + id + "/del/" + h).set(true);
    await db.ref("shares/" + id).remove();
  }

  function css() {
    if (document.getElementById("slmCss")) return;
    var s = document.createElement("style"); s.id = "slmCss";
    s.textContent = ".slm-card{cursor:pointer;min-width:200px;max-width:340px;text-align:left}.slm-card .slm-t{font-weight:700;font-size:13px;opacity:.9;margin-bottom:6px}.slm-card pre{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit;font-size:13.5px;opacity:.95}.slm-card .slm-f{margin-top:8px;font-size:12px;opacity:.7}.slm-card.slm-gone{opacity:.5;cursor:default}" +
      ".slm-ov{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100000;font-family:Arial,sans-serif}.slm-box{background:#1e293b;color:#f1f5f9;border:1.5px solid #334155;border-radius:12px;padding:18px;width:min(420px,92vw)}.slm-box h3{margin:0 0 8px}.slm-box p{margin:6px 0;font-size:14px;color:#cbd5e1}.slm-box input[type=password]{width:100%;box-sizing:border-box;padding:8px;margin:6px 0;border-radius:8px;border:1.5px solid #334155;background:#0f172a;color:#f1f5f9}.slm-row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}.slm-box button{padding:8px 14px;border-radius:8px;border:0;cursor:pointer;background:#334155;color:#fff}.slm-box button.p{background:#16a34a}.slm-code{font:700 22px monospace;letter-spacing:2px;text-align:center;background:#0f172a;padding:10px;border-radius:8px;margin:8px 0}.slm-err{color:#f87171;font-size:13px;min-height:16px}";
    document.head.appendChild(s);
  }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  // The card drawn in a chat / DM bubble. slm = { id, l, n, exp }, text = the preview stored on the message.
  function card(slm, text) {
    css();
    var c = el("div", "slm-card"), gone = Date.now() >= Number(slm.exp);
    c.appendChild(el("div", "slm-t", "\uD83D\uDCC4 Large message \u00B7 " + Number(slm.n).toLocaleString() + " characters"));
    var pre = el("pre", "", String(text || "")); c.appendChild(pre);
    var f = el("div", "slm-f", gone ? "Expired" : "Click to open in a new tab"); c.appendChild(f);
    if (gone) c.classList.add("slm-gone");
    else {
      c.addEventListener("click", function () { window.open(VIEWER + "?id=" + encodeURIComponent(slm.id), "_blank", "noopener"); });
      var t = setInterval(function () { if (!c.isConnected) return clearInterval(t); if (Date.now() >= Number(slm.exp)) { c.classList.add("slm-gone"); f.textContent = "Expired"; clearInterval(t); } }, 30000);
    }
    return c;
  }

  var busy = false;
  // Asks "send as SLM?" for an over-limit message. Resolves { slm, previewText } to send, or null if cancelled.
  function offer(text, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      if (busy) return resolve(null);
      busy = true; css();
      var ov = el("div", "slm-ov"), box = el("div", "slm-box"); ov.appendChild(box);
      var close = function () { busy = false; ov.remove(); };
      var step1 = function () {
        box.textContent = "";
        box.appendChild(el("h3", "", "Message too long"));
        box.appendChild(el("p", "", "That message is " + text.length.toLocaleString() + " characters (limit " + (opts.limit || 500) + "). Send it as a Shared Large Message? Everyone can open it from a short preview. It expires in 3 hours."));
        var lk = el("label"); lk.style.cssText = "display:block;margin:8px 0;font-size:14px";
        var cb = document.createElement("input"); cb.type = "checkbox"; lk.append(cb, " Lock with a 4-digit code");
        var pw = document.createElement("input"); pw.type = "password"; pw.inputMode = "numeric"; pw.maxLength = 4; pw.placeholder = "4-digit code"; pw.style.display = "none";
        cb.onchange = function () { pw.style.display = cb.checked ? "block" : "none"; };
        pw.oninput = function () { pw.value = pw.value.replace(/\D/g, "").slice(0, 4); };
        var err = el("div", "slm-err"), row = el("div", "slm-row");
        var no = el("button", "", "Cancel"), go = el("button", "p", "Send as SLM");
        no.onclick = function () { close(); resolve(null); };
        go.onclick = async function () {
          if (text.length > MAX_LEN) { err.textContent = "Too long even for SLM (max " + MAX_LEN.toLocaleString() + ")."; return; }
          if (cb.checked && !/^\d{4}$/.test(pw.value)) { err.textContent = "Enter a 4-digit code."; return; }
          go.disabled = no.disabled = true; err.textContent = "Uploading\u2026";
          try {
            var r = await create(text, cb.checked ? pw.value : "");
            resolve({ slm: { id: r.id, l: r.locked, n: r.n, exp: r.expiresAt }, previewText: previewOf(text, r.locked) });
            step2(r);
          } catch (e) { err.textContent = "Upload failed: " + (e.message || e); go.disabled = no.disabled = false; }
        };
        row.append(no, go); box.append(lk, pw, err, row);
      };
      var step2 = function (r) {   // shown once: the delete code is never stored anywhere readable
        box.textContent = "";
        box.appendChild(el("h3", "", "Sent \u2713"));
        box.appendChild(el("p", "", "Your delete code (shown once). Anyone with it can delete this share before it expires. Share ID: " + r.id));
        box.appendChild(el("div", "slm-code", r.delCode));
        var row2 = el("div", "slm-row"), cp = el("button", "", "Copy code"), ok = el("button", "p", "Done");
        cp.onclick = function () { navigator.clipboard.writeText(r.delCode).then(function () { cp.textContent = "Copied!"; }, function () {}); };
        ok.onclick = close; row2.append(cp, ok); box.appendChild(row2);
      };
      step1(); document.body.appendChild(ov);
    });
  }

  window.VUS_SLM = { offer: offer, card: card, create: create, fetchShare: fetchShare, unlock: unlock, destroy: destroy, previewOf: previewOf };
})();
