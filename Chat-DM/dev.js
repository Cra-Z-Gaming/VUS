/* DEV tab (Settings > DEV): your personal API token, send examples in many languages, an error reference,
   and the bots you muted. The token itself is created by the server (/api/dev/rotate) after it checks your
   password, and only a salted SHA-256 hash of it is ever stored. This file also holds the login-token
   helpers chat.js uses when tokens are required (config/tokensRequiredSince). */
(function () {
  "use strict";
  var API = window.VUS_API_BASE || "https://vus-orcin.vercel.app";
  var CHAT_DB = "https://vus-chat-default-rtdb.firebaseio.com";

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  // ── Login tokens + one-time message tickets. chat.js asks for a ticket for every message it sends, but only
  //    while tokens are required; otherwise nothing below does any work. ──
  var TKEY = "vus_chat_token_v1", tbuf = [], refilling = false;
  function readTokens() { try { return JSON.parse(localStorage.getItem(TKEY) || "{}") || {}; } catch (e) { return {}; } }
  function getToken(id) { return readTokens()[String(id)] || ""; }
  function setToken(id, t) { var o = readTokens(); if (t) o[String(id)] = t; else delete o[String(id)]; try { localStorage.setItem(TKEY, JSON.stringify(o)); } catch (e) {} }
  async function obtain(id, password) {
    var r;
    try { r = await fetch(API + "/api/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: String(id), password: password }) }); }
    catch (e) { throw new Error("Couldn't reach the server."); }
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok || !j.ok) throw new Error((j.error || "Couldn't confirm (HTTP " + r.status + ").") + (j.attemptsLeft !== undefined ? " (" + j.attemptsLeft + " tries left.)" : ""));
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
    var x = tbuf.shift();
    if (!x) {
      try { x = await fetchTicket(id); }
      catch (e) {   // no (or a rejected) token on this device: ask for the password once, then carry on
        if (String(e && e.message) !== "NO_TOKEN" || !(await askPassword(id))) throw e;
        x = await fetchTicket(id);
      }
    }
    refill(id);
    return x.t;
  }
  var reqCache = { at: 0, v: false }, asking = null;
  async function required() {
    if (Date.now() - reqCache.at < 60000) return reqCache.v;
    try { var r = await fetch(CHAT_DB + "/config/tokensRequiredSince.json", { cache: "no-store" }); var j = await r.json(); reqCache = { at: Date.now(), v: typeof j === "number" }; } catch (e) {}
    return reqCache.v;
  }
  async function obtainIfRequired(id, password) {   // called at login; silent and harmless when tokens aren't required
    try { if (getToken(id) || !(await required())) return; await obtain(id, password); } catch (e) {}
  }
  function askPassword(id) {   // one small prompt, only for a device that has no token yet while tokens are required
    if (asking) return asking;
    asking = new Promise(function (resolve) {
      var ov = document.createElement("div"); ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100001;font-family:Arial,sans-serif";
      var box = document.createElement("div"); box.style.cssText = "background:#1e293b;color:#f1f5f9;border:1.5px solid #334155;border-radius:12px;padding:18px;width:min(380px,92vw)";
      var h = el("h3", "", "Confirm your password"); h.style.margin = "0 0 8px";
      var p = el("p", "", "Chat needs a one-time confirmation on this device. You won't be asked again."); p.style.cssText = "margin:6px 0;font-size:14px;color:#cbd5e1";
      var pw = document.createElement("input"); pw.type = "password"; pw.placeholder = "Your account password"; pw.autocomplete = "current-password";
      pw.style.cssText = "width:100%;box-sizing:border-box;padding:9px;margin:8px 0;border-radius:8px;border:1.5px solid #334155;background:#0f172a;color:#f1f5f9";
      var err = el("div"); err.style.cssText = "color:#f87171;font-size:13px;min-height:16px";
      var row = el("div"); row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:10px";
      var no = el("button", "", "Cancel"), ok = el("button", "", "Confirm");
      [no, ok].forEach(function (b) { b.style.cssText = "padding:8px 14px;border:0;border-radius:8px;cursor:pointer;color:#fff;background:" + (b === ok ? "#16a34a" : "#334155"); });
      var done = function (v) { ov.remove(); asking = null; resolve(v); };
      no.onclick = function () { done(false); };
      ok.onclick = async function () {
        if (!pw.value) { err.textContent = "Enter your password."; return; }
        ok.disabled = no.disabled = true; err.textContent = "Checking\u2026";
        try { await obtain(id, pw.value); done(true); } catch (e) { err.textContent = e.message || "Couldn't confirm."; ok.disabled = no.disabled = false; }
      };
      pw.onkeydown = function (e) { if (e.key === "Enter") ok.click(); };
      row.append(no, ok); box.append(h, p, pw, err, row); ov.appendChild(box); document.body.appendChild(ov); pw.focus();
    });
    return asking;
  }
  window.VUS_AUTH = { obtain: obtain, obtainIfRequired: obtainIfRequired, ticket: ticket, hasToken: function (id) { return !!getToken(id); } };
  window.addEventListener("vus:logout", function () { try { localStorage.removeItem(TKEY); } catch (e) {} tbuf = []; });

  // ── The DEV tab ──
  var pane = document.getElementById("paneDev");
  if (!pane) return;

  var st = document.createElement("style");
  st.textContent = ".dev-tabs{display:flex;gap:6px;overflow-x:auto;padding:0 0 8px;margin:0 0 10px;border-bottom:1px solid rgba(255,255,255,.12)}.dev-tabs button{flex:0 0 auto;padding:6px 12px;border:1px solid rgba(255,255,255,.15);border-radius:999px;background:transparent;color:inherit;cursor:pointer;font-size:13px;white-space:nowrap}.dev-tabs button.on{background:#334155;border-color:#6366f1}" +
    ".dev-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:14px;margin:0 0 12px}.dev-card h4{margin:0 0 8px;font-size:15px}.dev-card p,.dev-card li{font-size:13px;opacity:.85;line-height:1.5;margin:4px 0}.dev-card ul{margin:6px 0 0 18px;padding:0}.dev-card input[type=password],.dev-card input[type=text]{width:100%;box-sizing:border-box;padding:9px;margin:6px 0;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.25);color:inherit;font-family:monospace}.dev-card button{padding:8px 14px;margin:6px 8px 0 0;border:0;border-radius:8px;cursor:pointer;background:#334155;color:#fff}.dev-card button.p{background:#16a34a}.dev-card button.d{background:#b91c1c}.dev-card button:disabled{opacity:.5}.dev-card pre{white-space:pre;overflow-x:auto;background:rgba(0,0,0,.35);padding:12px;border-radius:8px;font-size:12px;line-height:1.45;margin:8px 0 0;user-select:text}.dev-err{color:#f87171;font-size:13px;min-height:16px;line-height:1.4}.dev-ok{color:#4ade80;font-size:13px}.dev-mono{font-family:monospace;font-size:12px;word-break:break-all;opacity:.8}.dev-warn{color:#fbbf24;font-size:13px}.dev-row{border-top:1px solid rgba(255,255,255,.08);padding:8px 0}.dev-row b{font-family:monospace;font-size:12.5px}.dev-row span{display:block;font-size:12.5px;opacity:.8;margin-top:2px}";
  document.head.appendChild(st);

  function session() { return window.VUS_DM && window.VUS_DM.getSession ? window.VUS_DM.getSession() : null; }
  async function tokenInfo(id) {
    try { var r = await fetch(CHAT_DB + "/botTokens/" + id + ".json", { cache: "no-store" }); return r.ok ? await r.json() : null; } catch (e) { return null; }
  }
  // Turns every failure into a message that says what happened and what to do.
  async function call(body) {
    var r;
    try { r = await fetch(API + "/api/dev/rotate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
    catch (e) { throw new Error("Couldn't reach " + API + ". The site may be offline, the API may not be deployed, or an extension is blocking it. Open " + API + "/api/ping to check."); }
    var text = await r.text(), j = null; try { j = JSON.parse(text); } catch (e) {}
    if (!j) throw new Error(r.status === 404 ? "The API was not found (HTTP 404). The api folder isn't deployed at " + API + "." : "The server crashed (HTTP " + r.status + "). Open " + API + "/api/ping to see what is missing, or look at Vercel > Logs.");
    if (!r.ok || !j.ok) {
      var m = j.error || "Request failed (HTTP " + r.status + ").";
      if (j.hint) m += " " + j.hint;
      if (j.attemptsLeft !== undefined) m += " (" + j.attemptsLeft + " tries left.)";
      if (j.retryAfterMs) m += " Try again in about " + Math.max(1, Math.ceil(j.retryAfterMs / 60000)) + " min.";
      if (j.code) m += " [" + j.code + "]";
      throw new Error(m);
    }
    return j;
  }

  // ── Send examples: "Hello world" in many languages (the token is only a placeholder) ──
  function examples(id) {
    var url = API + "/api/bot/send", tok = "vus_" + (id || "123456") + "_" + "x".repeat(43);
    return [
      { n: "cURL", code: `curl -X POST ${url} \\
  -H "Authorization: Bearer ${tok}" \\
  -H "Content-Type: application/json" \\
  -d '{"text":"Hello world"}'`, note: "Works in macOS and Linux terminals and in Git Bash. In Windows PowerShell use the PowerShell tab." },
      { n: "Python", code: `# pip install requests
import requests

r = requests.post(
    "${url}",
    headers={"Authorization": "Bearer ${tok}"},
    json={"text": "Hello world"},
)
print(r.status_code, r.json())` },
      { n: "Python (no installs)", code: `import json, urllib.request, urllib.error

req = urllib.request.Request(
    "${url}",
    data=json.dumps({"text": "Hello world"}).encode(),
    headers={"Authorization": "Bearer ${tok}", "Content-Type": "application/json"},
)
try:
    print(urllib.request.urlopen(req).read().decode())
except urllib.error.HTTPError as e:
    print(e.code, e.read().decode())   # the error body says what went wrong`, note: "Uses only what ships with Python." },
      { n: "Node.js", code: `// Node 18 or newer. Save as bot.mjs, then run:  node bot.mjs
const res = await fetch("${url}", {
  method: "POST",
  headers: { "Authorization": "Bearer ${tok}", "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Hello world" }),
});
console.log(res.status, await res.json());` },
      { n: "JavaScript (browser)", code: `// Paste into your browser's console (F12) on any page.
fetch("${url}", {
  method: "POST",
  headers: { "Authorization": "Bearer ${tok}", "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Hello world" }),
}).then(r => r.json()).then(console.log);`, warn: "Don't put a real token in a web page other people can open. Anyone who views the page source can use it." },
      { n: "HTML", code: `<!DOCTYPE html>
<html>
<body>
  <button id="go">Say hello</button>
  <pre id="out"></pre>
  <script>
    document.getElementById("go").onclick = async () => {
      const res = await fetch("${url}", {
        method: "POST",
        headers: { "Authorization": "Bearer ${tok}", "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello world" }),
      });
      document.getElementById("out").textContent = res.status + " " + await res.text();
    };
  <\/script>
</body>
</html>`, warn: "Only open this file on your own computer. Never upload it to a public site with a real token in it." },
      { n: "PowerShell", code: `$headers = @{ Authorization = "Bearer ${tok}" }
$body = @{ text = "Hello world" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "${url}" -Headers $headers -ContentType "application/json" -Body $body` },
      { n: "Go", code: `package main

import (
	"fmt"
	"io"
	"net/http"
	"strings"
)

func main() {
	req, _ := http.NewRequest("POST", "${url}", strings.NewReader("{\\"text\\":\\"Hello world\\"}"))
	req.Header.Set("Authorization", "Bearer ${tok}")
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	fmt.Println(res.StatusCode, string(body))
}` },
      { n: "C#", code: `// .NET 6 or newer
using System.Net.Http;
using System.Text;

var http = new HttpClient();
http.DefaultRequestHeaders.Add("Authorization", "Bearer ${tok}");
var res = await http.PostAsync("${url}",
    new StringContent("{\\"text\\":\\"Hello world\\"}", Encoding.UTF8, "application/json"));
Console.WriteLine((int)res.StatusCode + " " + await res.Content.ReadAsStringAsync());` },
      { n: "Java", code: `// Java 11 or newer
import java.net.URI;
import java.net.http.*;

public class Bot {
  public static void main(String[] args) throws Exception {
    HttpRequest req = HttpRequest.newBuilder(URI.create("${url}"))
        .header("Authorization", "Bearer ${tok}")
        .header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString("{\\"text\\":\\"Hello world\\"}"))
        .build();
    HttpResponse<String> res = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());
    System.out.println(res.statusCode() + " " + res.body());
  }
}` },
      { n: "PHP", code: `<?php
$ch = curl_init("${url}");
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => ["Authorization: Bearer ${tok}", "Content-Type: application/json"],
  CURLOPT_POSTFIELDS => json_encode(["text" => "Hello world"]),
  CURLOPT_RETURNTRANSFER => true,
]);
echo curl_exec($ch);` },
      { n: "Ruby", code: `require "net/http"
require "json"

uri = URI("${url}")
req = Net::HTTP::Post.new(uri, "Authorization" => "Bearer ${tok}", "Content-Type" => "application/json")
req.body = { text: "Hello world" }.to_json
res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |h| h.request(req) }
puts res.code, res.body` }
    ];
  }

  // ── Error reference ──
  var ERRORS = [
    ["Sending messages (POST /api/bot/send)", [
      ["401 MISSING_TOKEN", "No Authorization header was sent. Add  Authorization: Bearer <token>."],
      ["401 BAD_TOKEN_FORMAT", "The token is not shaped like vus_123456_ + 43 characters (a login token, quotes, spaces or a missing \"Bearer \" also cause this)."],
      ["401 INVALID_TOKEN", "Well-formed but wrong: mistyped, rotated (older tokens stop at once) or revoked. Generate a new one."],
      ["401 ACCOUNT_NOT_FOUND", "The account behind the token no longer exists."],
      ["400 BAD_JSON", "The body isn't valid JSON, or the Content-Type header is missing."],
      ["400 TEXT_REQUIRED / TEXT_NOT_STRING / TEXT_EMPTY", "\"text\" is missing, not a string, or blank."],
      ["400 TEXT_TOO_LONG", "More than 500 characters (the reply shows your length). Use an SLM for longer text."],
      ["400 UNKNOWN_FIELDS", "Bots can only send \"text\" and \"slm\". The reply lists the extra fields."],
      ["400 SLM_INVALID", "The \"slm\" object is wrong; the reply's \"problem\" says which part."],
      ["405 METHOD_NOT_ALLOWED", "Use POST."],
      ["429 RATE_LIMITED", "One message every 2 seconds. The reply has retryAfterMs and a Retry-After header."]
    ]],
    ["Creating or rotating a token (POST /api/dev/rotate)", [
      ["400 BAD_REQUEST", "Send your 6-digit ID and your password."],
      ["401 WRONG_CREDENTIALS", "Wrong ID or password. The reply says how many tries are left."],
      ["429 LOCKED_OUT", "5 wrong passwords in a row. Wait about 10 minutes."]
    ]],
    ["Server problems (any endpoint)", [
      ["500 SERVER_CONFIG", "The server is missing a Firebase key or has a bad one. The message names it. Add or fix it in Vercel, then redeploy."],
      ["500 SERVER_ERROR", "Something unexpected. Open /api/ping to see what's set up, or check Vercel > Logs."],
      ["HTTP 500, no JSON", "The function crashed before it could answer, usually because firebase-admin isn't installed (package.json missing)."],
      ["HTTP 404", "Wrong address, or the api folder isn't deployed to this site."],
      ["No answer / network error", "The site is offline, the address is wrong, or something is blocking it."]
    ]]
  ];

  // ── Tabs ──
  var body = null, bar = null, current = "token";
  async function renderToken() {
    body.textContent = "";
    var sess = session();
    var top = el("div", "dev-card"); top.appendChild(el("h4", "", "Developer API"));
    if (!sess) { top.appendChild(el("p", "", "Log in to create an API token.")); body.appendChild(top); return; }
    top.appendChild(el("p", "", "Scripts can post to the main chat as you using a personal token. Every message sent this way always shows a (Bot) tag, and bots can send text and shared large messages only. Your ID is " + sess.id + " and it stays the same when you rotate the token, so anyone who muted your bot stays muted. The tabs above have \"Hello world\" examples for many languages."));
    body.appendChild(top);

    var card = el("div", "dev-card"); card.appendChild(el("h4", "", "Your token"));
    var line = el("p", "", "Checking\u2026"); card.appendChild(line);
    var meta = el("div", "dev-mono"); card.appendChild(meta);
    var pw = document.createElement("input"); pw.type = "password"; pw.placeholder = "Your account password (needed to create, rotate or revoke)"; pw.autocomplete = "current-password";
    var err = el("div", "dev-err"), out = el("div");
    var go = el("button", "p", "Generate token"), rev = el("button", "d", "Revoke token");
    card.append(pw, go, rev, err, out); body.appendChild(card);

    var info = await tokenInfo(sess.id);
    if (info) {
      line.textContent = "Token active \u00B7 version " + info.gen + " \u00B7 last rotated " + new Date(info.rotatedAt).toLocaleString();
      meta.textContent = "Stored as salted SHA-256 (safe to be public) \u2014 salt " + info.salt + " \u00B7 hash " + info.hash;
      go.textContent = "Rotate token (old one stops working)";
    } else { line.textContent = "No token yet."; rev.style.display = "none"; }

    async function run(req) {
      if (!pw.value) { err.textContent = "Enter your password."; return; }
      go.disabled = rev.disabled = true; err.textContent = "Working\u2026"; out.textContent = "";
      try {
        var j = await call(Object.assign({ id: String(sess.id), password: pw.value }, req));
        pw.value = ""; err.textContent = "";
        if (j.revoked) { await renderToken(); body.insertBefore(el("div", "dev-ok", "Token revoked. Scripts using it can no longer post."), body.children[1]); return; }
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

    var mutes = window.VUS_CHAT && window.VUS_CHAT.botMutedList ? window.VUS_CHAT.botMutedList() : {}, ids = Object.keys(mutes);
    var mc = el("div", "dev-card"); mc.appendChild(el("h4", "", "Bots you muted"));
    if (!ids.length) mc.appendChild(el("p", "", "None. Hover a bot message in chat and use the \uD83E\uDD16 button to mute that bot."));
    ids.forEach(function (bid) {
      var row = el("p", "", (mutes[bid] && mutes[bid].name ? mutes[bid].name : "Someone") + " (ID " + bid + ") ");
      var un = el("button", "", "Unmute"); un.onclick = function () { window.VUS_CHAT.toggleBotMute(bid); renderToken(); };
      row.appendChild(un); mc.appendChild(row);
    });
    body.appendChild(mc);
  }

  function renderExample(ex) {
    body.textContent = "";
    var c = el("div", "dev-card"); c.appendChild(el("h4", "", ex.n + ": send \u201CHello world\u201D"));
    c.appendChild(el("p", "", "The token in this example is a placeholder. Replace it with your own from the Token tab, and never share or post it."));
    if (ex.note) c.appendChild(el("p", "", ex.note));
    if (ex.warn) c.appendChild(el("p", "dev-warn", "\u26A0 " + ex.warn));
    var pre = el("pre", "", ex.code); c.appendChild(pre);
    var cp = el("button", "", "Copy example"); cp.onclick = function () { navigator.clipboard.writeText(ex.code).then(function () { cp.textContent = "Copied!"; setTimeout(function () { cp.textContent = "Copy example"; }, 1500); }, function () {}); };
    c.appendChild(cp);
    c.appendChild(el("p", "", "A successful call answers {\"ok\":true,\"id\":\"...\"} and the message appears in the main chat with a (Bot) tag. If something is wrong the answer is {\"ok\":false,\"code\":\"...\",\"error\":\"...\",\"hint\":\"...\"}: see the Errors tab."));
    body.appendChild(c);
  }

  function renderErrors() {
    body.textContent = "";
    var intro = el("div", "dev-card"); intro.appendChild(el("h4", "", "Errors"));
    intro.appendChild(el("p", "", "Every error answers { \"ok\": false, \"code\": \"...\", \"error\": \"what happened\", \"hint\": \"what to do\" } and a matching HTTP status. Switch on \"code\" in your script, it never changes. To check the server setup, open " + API + "/api/ping in a browser."));
    body.appendChild(intro);
    ERRORS.forEach(function (g) {
      var c = el("div", "dev-card"); c.appendChild(el("h4", "", g[0]));
      g[1].forEach(function (r) { var row = el("div", "dev-row"); row.appendChild(el("b", "", r[0])); row.appendChild(el("span", "", r[1])); c.appendChild(row); });
      body.appendChild(c);
    });
  }

  function show(k) {
    current = k;
    Array.prototype.forEach.call(bar.children, function (b) { b.classList.toggle("on", b.dataset.k === k); });
    var sess = session();
    if (k === "token") return renderToken();
    if (k === "errors") return renderErrors();
    var ex = examples(sess && sess.id).filter(function (e) { return e.n === k; })[0];
    if (ex) renderExample(ex);
  }

  function render() {
    pane.textContent = "";
    var sess = session();
    bar = el("div", "dev-tabs"); body = el("div");
    var tabs = [["token", "Token"]].concat(examples(sess && sess.id).map(function (e) { return [e.n, e.n]; })).concat([["errors", "Errors"]]);
    tabs.forEach(function (t) { var b = el("button", "", t[1]); b.type = "button"; b.dataset.k = t[0]; b.onclick = function () { show(t[0]); }; bar.appendChild(b); });
    pane.append(bar, body);
    show("token");
  }

  window.addEventListener("vus:settings-tab", function (ev) { if (ev.detail && ev.detail.tab === "dev") render(); });
})();
