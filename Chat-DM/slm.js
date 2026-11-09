/* SLM (ShareLargeMessages) core. Loaded before dm.js / chat.js.
   Exposes window.VUS_SLM = { offer, offerFile, card, create, fetchShare, unlock, destroy, previewOf }.
   Shares live in the separate "large-code" Firebase project. Needs firebase-app-compat and
   firebase-database-compat to be loaded first. The viewer is written into a blank window,
   so nothing has to be hosted. */
(function () {
  "use strict";
  var CFG = { apiKey: "AIzaSyBlfI1YDXg8hdoEAqcFKIdzmYJy-EZ8C8", authDomain: "large-code.firebaseapp.com", databaseURL: "https://large-code-default-rtdb.firebaseio.com/", projectId: "large-code", appId: "1:394088772356:web:a829fc27fb5ee57fae1651" };
  var DURATION = 3 * 60 * 60 * 1000, MAX_LEN = 200000, MAX_FILE = 1500000, MAX_STORED = 3000000, PBKDF2_ITER = 150000;
  var TEXT_EXT = /^(txt|md|markdown|json|csv|tsv|xml|html|htm|xhtml|css|js|mjs|ts|jsx|tsx|py|java|c|h|cpp|hpp|cs|go|rs|rb|php|sh|bat|ps1|sql|yml|yaml|toml|ini|cfg|conf|log|svg|lua|kt|swift|vue|svelte)$/i;
  var WEB_EXT = /^(html|htm|xhtml|svg)$/i;   // these can be opened as a page (sandboxed)

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
  function fmtSize(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
  function fileLabel(name, ext) { return (name || "message") + "." + (ext || "txt"); }
  function toBlob(content, pub) { return pub.b64 ? new Blob([unb64(content)], { type: pub.mime || "application/octet-stream" }) : new Blob([content], { type: pub.mime || "text/plain" }); }
  function saveBlob(blob, filename) {
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  // Web files run inside a sandboxed frame with no access to this site (no cookies, storage or opener).
  function openWeb(html) {
    var w = window.open("", "_blank");
    if (!w) { alert("Allow pop-ups to open shared pages."); return; }
    w.document.open();
    w.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Shared page</title><style>html,body{margin:0;height:100%;background:#fff;font-family:Arial,sans-serif}.b{background:#7c2d12;color:#ffedd5;font-size:12px;padding:5px 10px;height:26px;box-sizing:border-box}iframe{border:0;width:100%;height:calc(100% - 26px);display:block}</style></head><body><div class="b">\u26A0 Shared page from another user. It runs in a sandbox, so only interact with it if you trust it.</div></body></html>');
    w.document.close();
    var f = w.document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals");   // no allow-same-origin on purpose
    f.srcdoc = html; w.document.body.appendChild(f);
  }

  // Uploads the share. meta (files only): { name, ext, mime, b64, size }. Returns { id, delCode, expiresAt, locked, n }.
  async function create(body, password, meta) {
    meta = meta || {};
    if (!body || body.length > MAX_STORED) throw new Error("That is too large to share.");
    var locked = !!password, now = Date.now();
    var stored = locked ? await lock(body, password) : body;
    var delCode = rnd(10, "ABCDEFGHJKMNPQRSTUVWXYZ23456789"), delHash = await sha(delCode);
    var pub = { code: stored, protected: locked, createdAt: now, expiresAt: now + DURATION };
    if (meta.name) pub.name = meta.name;
    if (meta.ext) pub.ext = meta.ext;
    if (meta.mime) pub.mime = meta.mime;
    if (meta.b64) pub.b64 = true;
    for (var i = 0; i < 6; i++) {
      var id = rnd(6, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
      try {
        await db.ref("shares/" + id).set({ pub: pub, delHash: delHash });
        return { id: id, delCode: delCode.slice(0, 5) + "-" + delCode.slice(5), expiresAt: now + DURATION, locked: locked, n: meta.size || body.length };
      } catch (e) { if (!/permission/i.test(String(e && (e.code || e.message)))) throw e; }   // an ID collision is refused by the rules: try another
    }
    throw new Error("Couldn't create the share. Try again.");
  }
  // Returns the public part { code, protected, expiresAt, name?, ext?, mime?, b64? } or null if missing / expired / deleted.
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
  // Calls onGone() when a share that has not expired yet disappears (deleted). Returns a stop function.
  function watchGone(slm, onGone) {
    if (!slm.id || Date.now() >= Number(slm.exp)) return function () {};
    var ref = db.ref("shares/" + slm.id + "/pub/expiresAt"), live = true;
    var gone = function () { if (live && Date.now() < Number(slm.exp)) onGone(); };
    var h = ref.on("value", function (s) { if (!s.exists()) gone(); }, gone);   // an error means the rules refuse the read: deleted
    return function () { live = false; try { ref.off("value", h); } catch (e) {} };
  }
  // For the buttons on a card: fetch, ask for the code if locked, then hand back the content.
  async function quickContent(id) {
    var s = await fetchShare(id);
    if (!s) { alert("This share is no longer available."); return null; }
    var content = s.code;
    if (s.protected) {
      var pw = prompt("This share is locked. Enter the 4-digit code:");
      if (!pw) return null;
      try { content = await unlock(s.code, pw.trim()); } catch (e) { alert("Incorrect code."); return null; }
    }
    return { pub: s, content: content };
  }

  function css() {
    if (document.getElementById("slmCss")) return;
    var s = document.createElement("style"); s.id = "slmCss";
    s.textContent = ".slm-card{position:relative;cursor:pointer;min-width:200px;max-width:340px;text-align:left;padding-right:4px}.slm-card .slm-t{font-weight:700;font-size:13px;opacity:.9;margin:0 56px 6px 0;word-break:break-word}.slm-card pre{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit;font-size:13.5px;opacity:.95}.slm-card .slm-f{margin-top:8px;font-size:12px;opacity:.7}.slm-card.slm-gone{opacity:.55;cursor:default}.slm-act{position:absolute;top:-2px;right:-2px;display:flex;gap:4px}.slm-act button{border:0;border-radius:6px;background:rgba(255,255,255,.14);color:inherit;cursor:pointer;font-size:14px;padding:3px 7px}.slm-act button:hover{background:rgba(255,255,255,.28)}" +
      ".slm-ov{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100000;font-family:Arial,sans-serif}.slm-box{background:#1e293b;color:#f1f5f9;border:1.5px solid #334155;border-radius:12px;padding:18px;width:min(420px,92vw)}.slm-box h3{margin:0 0 8px}.slm-box p{margin:6px 0;font-size:14px;color:#cbd5e1}.slm-box input[type=password],.slm-box input[type=text]{width:100%;box-sizing:border-box;padding:8px;margin:6px 0;border-radius:8px;border:1.5px solid #334155;background:#0f172a;color:#f1f5f9}.slm-row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}.slm-box button{padding:8px 14px;border-radius:8px;border:0;cursor:pointer;background:#334155;color:#fff}.slm-box button.p{background:#16a34a}.slm-box button:disabled{opacity:.5}.slm-code{font:700 22px monospace;letter-spacing:2px;text-align:center;background:#0f172a;padding:10px;border-radius:8px;margin:8px 0}.slm-err{color:#f87171;font-size:13px;min-height:16px}";
    document.head.appendChild(s);
  }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  // The card drawn in a chat / DM bubble. slm = { id, l, n, exp, name?, ext? }; text = the preview stored on the message.
  function card(slm, text) {
    css();
    var isFile = !!slm.ext, label = fileLabel(slm.name, slm.ext);
    var c = el("div", "slm-card"), t = el("div", "slm-t"), pre = el("pre"), f = el("div", "slm-f"), act = el("div", "slm-act");
    var body = String(text || "");
    if (isFile) body = body.split("\n").slice(1).join("\n");   // the first line of a file message is its name
    pre.textContent = body; if (!body) pre.style.display = "none";
    c.append(t, pre, f, act);
    var expired = Date.now() >= Number(slm.exp), stop = function () {}, timer = null;
    function end() { stop(); if (timer) clearInterval(timer); }
    function paintLive() {
      t.textContent = isFile ? "\uD83D\uDCCE " + label + " \u00B7 " + fmtSize(Number(slm.n)) : "\uD83D\uDCC4 Large message \u00B7 " + Number(slm.n).toLocaleString() + " characters";
      f.textContent = "Click to open in a new tab";
    }
    function paintGone(why) {
      end(); c.classList.add("slm-gone"); act.style.display = "none"; c.onclick = null;
      if (why === "deleted") { t.textContent = "\uD83D\uDDD1\uFE0F This shared message was deleted"; pre.style.display = "none"; f.textContent = ""; }
      else f.textContent = "Expired";
    }
    paintLive();
    if (expired) { paintGone("expired"); return c; }
    var dl = el("button", "", "\u2B07"); dl.title = "Download";
    dl.onclick = async function (e) { e.stopPropagation(); var r = await quickContent(slm.id); if (r) saveBlob(toBlob(r.content, r.pub), fileLabel(r.pub.name, r.pub.ext)); };
    act.appendChild(dl);
    if (isFile && WEB_EXT.test(slm.ext)) {
      var op = el("button", "", "\u2197"); op.title = "Open as a web page in a new tab";
      op.onclick = async function (e) { e.stopPropagation(); var r = await quickContent(slm.id); if (r && !r.pub.b64) openWeb(r.content); };
      act.appendChild(op);
    }
    c.onclick = function () { openViewer(slm.id); };
    stop = watchGone(slm, function () { paintGone("deleted"); });
    timer = setInterval(function () {
      if (!c.isConnected) return end();
      if (Date.now() >= Number(slm.exp)) paintGone("expired");
    }, 30000);
    return c;
  }

  // ── The viewer, written into a blank window (works from about:blank, nothing to host) ──
  var VIEW_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared Message</title><style>*{box-sizing:border-box}body{font-family:Arial,sans-serif;max-width:900px;margin:30px auto;padding:0 15px;background:#111;color:#eee}textarea,input{width:100%;background:#1b1b1b;color:#eee;border:1px solid #444;border-radius:6px;padding:10px;margin:5px 0}textarea{min-height:400px;font:14px monospace;resize:vertical}button{padding:10px 14px;margin:5px 6px 5px 0;border-radius:5px;border:1px solid #444;background:#333;color:#fff;cursor:pointer}button:hover{background:#444}.hidden{display:none!important}.status{min-height:20px;margin-top:8px;color:#aaa}.status.error{color:#ff6b6b}.status.success{color:#6bcb77}.meta{font-size:12px;color:#888;margin:6px 0}.countdown{font-family:monospace;color:#ffb347}details{margin-top:28px;border-top:1px solid #333;padding-top:12px}summary{cursor:pointer;color:#aaa}#media img,#media video{max-width:100%;max-height:70vh;display:block;margin:8px 0}#media audio{width:100%;margin:8px 0}.file{font-size:15px;margin:10px 0}</style></head><body><h1 id="title">Shared Message</h1><div id="status" class="status"></div><div id="pwRow" class="hidden"><p>This message is locked.</p><input id="pwInput" type="password" inputmode="numeric" maxlength="4" placeholder="4-digit code"><button id="unlockBtn">Unlock</button></div><div id="result" class="hidden"><div class="meta">Expires in: <span id="countdown" class="countdown"></span></div><div id="fileInfo" class="file hidden"></div><div id="media"></div><textarea id="text" readonly></textarea><button id="copyBtn">Copy</button><button id="dlBtn">Download</button><button id="openBtn" class="hidden">Open as web page</button><details><summary>Delete this share</summary><p class="meta">Only people with the delete code can delete it.</p><input id="delInput" placeholder="Delete code (XXXXX-XXXXX)" maxlength="11"><button id="delBtn">Delete</button></details></div></body></html>`;

  function openViewer(id) {
    var w = window.open("", "_blank");   // no "noopener": the viewer's logic runs from this page
    if (!w) { alert("Allow pop-ups to open shared messages."); return; }
    w.document.open(); w.document.write(VIEW_HTML); w.document.close();
    var d = w.document, $ = function (i) { return d.getElementById(i); }, cur = null, timer = null, mediaUrl = null;
    var status = function (m, t) { $("status").textContent = m; $("status").className = "status " + (t || ""); };
    d.title = "Shared message " + id;
    function show(content, pub) {
      var isBin = !!pub.b64, fname = fileLabel(pub.name, pub.ext);
      $("pwRow").classList.add("hidden"); $("result").classList.remove("hidden");
      $("title").textContent = pub.ext ? fname : "Shared Message";
      $("fileInfo").classList.toggle("hidden", !pub.ext);
      $("media").textContent = "";
      if (mediaUrl) { URL.revokeObjectURL(mediaUrl); mediaUrl = null; }
      if (isBin) {
        $("text").classList.add("hidden"); $("copyBtn").classList.add("hidden");
        var blob = toBlob(content, pub); $("fileInfo").textContent = "\uD83D\uDCCE " + fname + " \u00B7 " + fmtSize(blob.size);
        var m = /^(image|video|audio)\//.exec(pub.mime || "");
        if (m) { mediaUrl = URL.createObjectURL(blob); var node = d.createElement(m[1] === "image" ? "img" : m[1]); node.src = mediaUrl; if (m[1] !== "image") node.controls = true; $("media").appendChild(node); }
      } else {
        $("text").classList.remove("hidden"); $("copyBtn").classList.remove("hidden"); $("text").value = content;
        if (pub.ext) $("fileInfo").textContent = "\uD83D\uDCCE " + fname + " \u00B7 " + fmtSize(content.length);
      }
      $("openBtn").classList.toggle("hidden", !(pub.ext && !isBin && WEB_EXT.test(pub.ext)));
      cur = { content: content, pub: pub, name: fname };
      status("Loaded.", "success");
      clearInterval(timer);
      var tick = function () {
        var ms = pub.expiresAt - Date.now();
        if (w.closed) return clearInterval(timer);
        if (ms <= 0) { clearInterval(timer); $("countdown").textContent = "expired"; $("text").value = ""; $("media").textContent = ""; return status("This share just expired.", "error"); }
        var s = Math.floor(ms / 1000); $("countdown").textContent = Math.floor(s / 3600) + "h " + Math.floor(s % 3600 / 60) + "m " + s % 60 + "s";
      };
      tick(); timer = setInterval(tick, 1000);
    }
    var pending = null;
    $("pwInput").oninput = function (e) { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4); };
    $("unlockBtn").onclick = async function () {
      try { show(await unlock(pending.code, $("pwInput").value), pending); } catch (e) { status("Incorrect code.", "error"); }
    };
    $("pwInput").onkeydown = function (e) { if (e.key === "Enter") $("unlockBtn").click(); };
    $("copyBtn").onclick = function () { w.navigator.clipboard.writeText($("text").value).then(function () { $("copyBtn").textContent = "Copied!"; setTimeout(function () { $("copyBtn").textContent = "Copy"; }, 1500); }, function () { $("text").select(); }); };
    $("dlBtn").onclick = function () { if (cur) saveBlob(toBlob(cur.content, cur.pub), cur.name); };
    $("openBtn").onclick = function () { if (cur) openWeb(cur.content); };
    $("delBtn").onclick = async function () {
      if (!w.confirm("Delete this share permanently?")) return;
      try { await destroy(id, $("delInput").value); clearInterval(timer); cur = null; $("text").value = ""; $("media").textContent = ""; $("result").classList.add("hidden"); status("Share deleted.", "success"); }
      catch (e) { status("Wrong delete code.", "error"); }
    };
    status("Loading\u2026");
    fetchShare(id).then(function (s) {
      if (!s) return status("Share not found, expired, or deleted.", "error");
      pending = s;
      if (s.protected) { $("pwRow").classList.remove("hidden"); status(""); $("pwInput").focus(); } else show(s.code, s);
    });
  }

  var busy = false;
  // Shared by offer() and offerFile(): builds the dialog, handles the lock option and the delete-code screen.
  // opts.title / opts.intro / opts.titleField (a name box) / opts.build(name) -> Promise<{ body, meta, previewFn }>
  function dialog(opts) {
    return new Promise(function (resolve) {
      if (busy) return resolve(null);
      busy = true; css();
      var ov = el("div", "slm-ov"), box = el("div", "slm-box"); ov.appendChild(box);
      var close = function () { busy = false; ov.remove(); };
      var step1 = function () {
        box.textContent = "";
        box.appendChild(el("h3", "", opts.title));
        box.appendChild(el("p", "", opts.intro));
        var err = el("div", "slm-err"), row = el("div", "slm-row"), no = el("button", "", "Cancel");
        no.onclick = function () { close(); resolve(null); };
        if (opts.blocked) { err.textContent = opts.blocked; row.appendChild(no); box.append(err, row); return; }
        var nameIn = null;
        if (opts.nameDefault != null) {
          nameIn = document.createElement("input"); nameIn.type = "text"; nameIn.maxLength = 100; nameIn.value = opts.nameDefault; nameIn.placeholder = "Title";
          box.appendChild(el("p", "", "Title" + (opts.extLabel ? " (extension " + opts.extLabel + " is kept)" : "")));
          box.appendChild(nameIn);
        }
        var lk = el("label"); lk.style.cssText = "display:block;margin:8px 0;font-size:14px";
        var cb = document.createElement("input"); cb.type = "checkbox"; lk.append(cb, " Lock with a 4-digit code");
        var pw = document.createElement("input"); pw.type = "password"; pw.inputMode = "numeric"; pw.maxLength = 4; pw.placeholder = "4-digit code"; pw.style.display = "none";
        cb.onchange = function () { pw.style.display = cb.checked ? "block" : "none"; };
        pw.oninput = function () { pw.value = pw.value.replace(/\D/g, "").slice(0, 4); };
        var go = el("button", "p", opts.goLabel || "Send as SLM");
        go.onclick = async function () {
          if (cb.checked && !/^\d{4}$/.test(pw.value)) { err.textContent = "Enter a 4-digit code."; return; }
          go.disabled = no.disabled = true; err.textContent = "Uploading\u2026";
          try {
            var nm = nameIn ? nameIn.value.replace(/[\u0000-\u001f\\\/]/g, "").trim().slice(0, 100) || opts.nameDefault || "file" : "";
            var b = await opts.build(nm);
            var r = await create(b.body, cb.checked ? pw.value : "", b.meta);
            var slm = { id: r.id, l: r.locked, n: r.n, exp: r.expiresAt };
            if (b.meta && b.meta.ext) { slm.name = b.meta.name; slm.ext = b.meta.ext; }
            resolve({ slm: slm, previewText: b.previewFn(r.locked) });
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

  // Over-limit typed text: resolves { slm, previewText } to send, or null if cancelled.
  function offer(text, opts) {
    opts = opts || {};
    return dialog({
      title: "Message too long",
      intro: "That message is " + text.length.toLocaleString() + " characters (limit " + (opts.limit || 500) + "). Send it as a Shared Large Message? Everyone can open it from a short preview. It expires in 3 hours.",
      blocked: text.length > MAX_LEN ? "Too long even for SLM (max " + MAX_LEN.toLocaleString() + " characters)." : "",
      build: async function () { return { body: text, meta: null, previewFn: function (locked) { return previewOf(text, locked); } }; }
    });
  }
  // A picked or dropped file (html, text, pdf, zip, anything up to 1.5 MB): resolves { slm, previewText } or null.
  function offerFile(file) {
    var m = /\.([A-Za-z0-9]{1,12})$/.exec(file.name || ""), ext = (m ? m[1] : "bin").toLowerCase();
    var base = String(file.name || "file").replace(/\.[^.]*$/, "").replace(/[\u0000-\u001f\\\/]/g, "").trim().slice(0, 100) || "file";
    var isText = TEXT_EXT.test(ext) || /^text\//.test(file.type || "");
    return dialog({
      title: "Send file as SLM",
      intro: file.name + " \u00B7 " + fmtSize(file.size) + ". Everyone can open or download it from the card. It expires in 3 hours.",
      blocked: file.size > MAX_FILE ? "That file is too large (max " + fmtSize(MAX_FILE) + ")." : (file.size === 0 ? "That file is empty." : ""),
      nameDefault: base, extLabel: "." + ext, goLabel: "Send file",
      build: async function (name) {
        var body = isText ? await file.text() : b64(new Uint8Array(await file.arrayBuffer()));
        if (!body) throw new Error("That file is empty.");
        var meta = { name: name, ext: ext, mime: String(file.type || "").slice(0, 100) || undefined, b64: !isText, size: file.size };
        var label = "\uD83D\uDCCE " + fileLabel(name, ext);
        return { body: body, meta: meta, previewFn: function (locked) { return isText && !locked ? label + "\n" + previewOf(body, false) : label; } };
      }
    });
  }

  window.VUS_SLM = { offer: offer, offerFile: offerFile, card: card, create: create, fetchShare: fetchShare, unlock: unlock, destroy: destroy, previewOf: previewOf };
})();
