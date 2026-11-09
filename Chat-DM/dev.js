/* DEV tab (Settings > DEV): your personal API token, rotation, and the bots you muted.
   The token itself is created by the server (/api/dev/rotate) after it checks your password,
   and only a salted SHA-256 hash of it is ever stored. */
(function () {
  "use strict";
  var API = window.VUS_API_BASE || "https://vus-orcin.vercel.app";
  var CHAT_DB = "https://vus-chat-default-rtdb.firebaseio.com";

  // ── Login tokens + one-time message tickets. chat.js asks for a ticket for every message it sends. ──
  var TKEY = "vus_chat_token_v1", tbuf = [], refilling = false;
  function readTokens() { try { return JSON.parse(localStorage.getItem(TKEY) || "{}") || {}; } catch (e) { return {}; } }
  function getToken(id) { return readTokens()[String(id)] || ""; }
  function setToken(id, t) { var o = readTokens(); if (t) o[String(id)] = t; else delete o[String(id)]; try { localStorage.setItem(TKEY, JSON.stringify(o)); } catch (e) {} }
  async function obtain(id, password) {   // called by dm.js right after a successful login
    var r = await fetch(API + "/api/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: String(id), password: password }) });
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok || !j.ok) throw new Error(j.error || "Couldn't get a login token (" + r.status + ").");
    setToken(id, j.token); tbuf = []; return true;
  }
  async function fetchTicket(id) {
    var tok = getToken(id);
    if (!tok) throw new Error("NO_TOKEN");
    var r;
    try { r = await fetch(API + "/api/chat/ticket", { method: "POST", headers: { Authorization: "Bearer " + tok } }); } catch (e) { throw new Error("OFFLINE"); }
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (r.status === 401) { setToken(id, ""); throw new Error("NO_TOKEN"); }
    if (!r.ok || !j.ok) throw new Error(j.error || "Couldn't get permission to send.");
    return { t: j.ticket, at: Date.now() };
  }
  function refill(id) {   // keep two tickets ready so sending feels instant
    if (refilling) return; refilling = true;
    (async function () { try { while (tbuf.length < 2) tbuf.push(await fetchTicket(id)); } catch (e) {} refilling = false; })();
  }
  async function ticket(id) {
    var now = Date.now(); tbuf = tbuf.filter(function (x) { return now - x.at < 80000; });
    var x = tbuf.shift() || await fetchTicket(id);
    refill(id);
    return x.t;
  }
  window.VUS_AUTH = { obtain: obtain, ticket: ticket, hasToken: function (id) { return !!getToken(id); } };
  window.addEventListener("vus:logout", function () { try { localStorage.removeItem(TKEY); } catch (e) {} tbuf = []; });
  var pane = document.getElementById("paneDev");
  if (!pane) return;

  var st = document.createElement("style");
  st.textContent = ".dev-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:14px;margin:0 0 12px}.dev-card h4{margin:0 0 8px;font-size:15px}.dev-card p,.dev-card li{font-size:13px;opacity:.85;line-height:1.5;margin:4px 0}.dev-card ul{margin:6px 0 0 18px;padding:0}.dev-card input[type=password],.dev-card input[type=text]{width:100%;box-sizing:border-box;padding:9px;margin:6px 0;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.25);color:inherit;font-family:monospace}.dev-card button{padding:8px 14px;margin:6px 8px 0 0;border:0;border-radius:8px;cursor:pointer;background:#334155;color:#fff}.dev-card button.p{background:#16a34a}.dev-card button.d{background:#b91c1c}.dev-card button:disabled{opacity:.5}.dev-card pre{white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.3);padding:10px;border-radius:8px;font-size:12px;margin:8px 0 0}.dev-err{color:#f87171;font-size:13px;min-height:16px}.dev-ok{color:#4ade80;font-size:13px}.dev-mono{font-family:monospace;font-size:12px;word-break:break-all;opacity:.8}";
  document.head.appendChild(st);

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function session() { return window.VUS_DM && window.VUS_DM.getSession ? window.VUS_DM.getSession() : null; }
  async function tokenInfo(id) {
    try { var r = await fetch(CHAT_DB + "/botTokens/" + id + ".json", { cache: "no-store" }); return r.ok ? await r.json() : null; } catch (e) { return null; }
  }
  async function call(body) {
    var r = await fetch(API + "/api/dev/rotate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok || !j.ok) throw new Error(j.error || "Request failed (" + r.status + ")");
    return j;
  }

  async function render() {
    pane.textContent = "";
    var sess = session();
    var top = el("div", "dev-card"); top.appendChild(el("h4", "", "Developer API"));
    if (!sess) { top.appendChild(el("p", "", "Log in to create an API token.")); pane.appendChild(top); return; }
    top.appendChild(el("p", "", "Scripts can post to the main chat as you using a personal token. Every message sent this way always shows a (Bot) tag. Your ID is " + sess.id + " and it stays the same when you rotate the token, so anyone who muted your bot stays muted."));
    pane.appendChild(top);

    var card = el("div", "dev-card"); card.appendChild(el("h4", "", "Your token"));
    var line = el("p", "", "Checking\u2026"); card.appendChild(line);
    var meta = el("div", "dev-mono"); card.appendChild(meta);
    var pw = document.createElement("input"); pw.type = "password"; pw.placeholder = "Your account password (needed to create, rotate or revoke)"; pw.autocomplete = "current-password";
    var err = el("div", "dev-err"), out = el("div");
    var go = el("button", "p", "Generate token"), rev = el("button", "d", "Revoke token");
    card.append(pw, go, rev, err, out); pane.appendChild(card);

    var info = await tokenInfo(sess.id);
    if (info) {
      line.textContent = "Token active \u00B7 version " + info.gen + " \u00B7 last rotated " + new Date(info.rotatedAt).toLocaleString();
      meta.textContent = "Stored as salted SHA-256 (safe to be public) \u2014 salt " + info.salt + " \u00B7 hash " + info.hash;
      go.textContent = "Rotate token (old one stops working)";
    } else { line.textContent = "No token yet."; rev.style.display = "none"; }

    async function run(body) {
      if (!pw.value) { err.textContent = "Enter your password."; return; }
      go.disabled = rev.disabled = true; err.textContent = "Working\u2026"; out.textContent = "";
      try {
        var j = await call(Object.assign({ id: String(sess.id), password: pw.value }, body));
        pw.value = ""; err.textContent = "";
        if (j.revoked) { await render(); var ok = el("div", "dev-ok", "Token revoked. Scripts using it can no longer post."); pane.insertBefore(ok, pane.children[1]); return; }
        var box = document.createElement("input"); box.type = "text"; box.readOnly = true; box.value = j.token; box.onfocus = function () { box.select(); };
        var cp = el("button", "", "Copy token"); cp.onclick = function () { navigator.clipboard.writeText(j.token).then(function () { cp.textContent = "Copied!"; }, function () { box.select(); }); };
        out.append(el("p", "dev-ok", "New token (version " + j.gen + "). Copy it now: it is only shown once, and any older token stopped working."), box, cp);
        line.textContent = "Token active \u00B7 version " + j.gen; go.textContent = "Rotate token (old one stops working)"; rev.style.display = "";
        var again = await tokenInfo(sess.id); if (again) meta.textContent = "Stored as salted SHA-256 (safe to be public) \u2014 salt " + again.salt + " \u00B7 hash " + again.hash;
      } catch (e) { err.textContent = e.message || "Something went wrong."; }
      go.disabled = rev.disabled = false;
    }
    go.onclick = function () { run({}); };
    rev.onclick = function () { if (confirm("Revoke your token? Scripts using it will stop working.")) run({ revoke: true }); };

    var docs = el("div", "dev-card"); docs.appendChild(el("h4", "", "Send a message"));
    docs.appendChild(el("pre", "", "curl -X POST " + API + "/api/bot/send \\\n  -H \"Authorization: Bearer YOUR_TOKEN\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"text\":\"Hello from my bot\"}'"));
    var ul = document.createElement("ul");
    ["Messages are 1\u2013500 characters, one every 2 seconds, in the main chat. Bots can send text and shared large messages (SLM) only: no images, GIFs or videos.", "A wrong or old token is refused. Keep your token secret and rotate it if it leaks.", "If your account is muted or banned, your bot is muted too."].forEach(function (t) { ul.appendChild(el("li", "", t)); });
    docs.appendChild(ul); pane.appendChild(docs);

    var mutes = window.VUS_CHAT && window.VUS_CHAT.botMutedList ? window.VUS_CHAT.botMutedList() : {}, ids = Object.keys(mutes);
    var mc = el("div", "dev-card"); mc.appendChild(el("h4", "", "Bots you muted"));
    if (!ids.length) mc.appendChild(el("p", "", "None. Hover a bot message in chat and use the \uD83E\uDD16 button to mute that bot."));
    ids.forEach(function (bid) {
      var row = el("p", "", (mutes[bid] && mutes[bid].name ? mutes[bid].name : "Someone") + " (ID " + bid + ") ");
      var un = el("button", "", "Unmute"); un.onclick = function () { window.VUS_CHAT.toggleBotMute(bid); render(); };
      row.appendChild(un); mc.appendChild(row);
    });
    pane.appendChild(mc);
  }

  window.addEventListener("vus:settings-tab", function (ev) { if (ev.detail && ev.detail.tab === "dev") render(); });
})();
