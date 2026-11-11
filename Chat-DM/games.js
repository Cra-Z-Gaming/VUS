/* Games: 1v1 minigames you can bet crates on (Tic-Tac-Toe, Rock Paper Scissors, Connect 4). A new icon in the left
   rail opens a panel that fills everything except the sidebar.
   Two layers:
     Secure  - the server (api/game.js) runs the game and holds the bets. Needs the server to be reachable.
     Direct  - no server: both players' browsers share a move log in Firebase and work out the result themselves.
               It works anywhere Firebase works, but a determined cheater can fake it (including crates). */
(function () {
  "use strict";
  var API = window.VUS_API_BASE || "https://vus-orcin.vercel.app";
  var BETS = [1, 2, 3, 5, 10];
  var ORDER = ["ttt", "rps", "c4"];
  var NAMES = { ttt: "Tic-Tac-Toe", rps: "Rock Paper Scissors", c4: "Connect 4" };
  var RULES = {
    ttt: "Best of 3: first to win 2 rounds. A drawn round is replayed. 5 minutes per match: when time is up the player ahead wins; if tied you get 3 extra minutes, then everyone is refunded.",
    rps: "Best of 3: first to win 2 rounds. Both players pick in secret and the picks are revealed together. A tie is replayed. 3 minutes per match: when time is up the player ahead wins; if tied you get 2 extra minutes, then everyone is refunded.",
    c4: "One game: get 4 in a row (across, up or diagonally). 8 minutes per game; if nobody has won by then, or the board fills up, you get 3 extra minutes and then everyone is refunded."
  };
  // ── pure game logic (used by Direct mode; the server has its own copy for Secure mode) ──
  var CFG = { ttt: { win: 2, ms: 300000, extra: 180000 }, rps: { win: 2, ms: 180000, extra: 120000 }, c4: { win: 1, ms: 480000, extra: 180000 } };
  var GRACE = 15000, WAIT_STALE = 30000, REVEAL_MS = 20000, BEAT_MS = 4000;
  var LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  var PICKS = ["rock", "paper", "scissors"], BEATS = { rock: "scissors", scissors: "paper", paper: "rock" };
  function other(s) { return s === "a" ? "b" : "a"; }

  var K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256hex(str) {   // small synchronous SHA-256 (used for the Rock Paper Scissors commitments)
    var b = Array.prototype.slice.call(new TextEncoder().encode(str)), l = b.length, i, j;
    b.push(0x80); while (b.length % 64 !== 56) b.push(0);
    var hi = Math.floor(l * 8 / 4294967296), lo = (l * 8) >>> 0;
    [hi, lo].forEach(function (x) { b.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255); });
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], w = new Array(64);
    function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (i = 0; i < b.length; i += 64) {
      for (j = 0; j < 16; j++) w[j] = (b[i + 4 * j] << 24) | (b[i + 4 * j + 1] << 16) | (b[i + 4 * j + 2] << 8) | b[i + 4 * j + 3];
      for (j = 16; j < 64; j++) { var s0 = rr(w[j - 15], 7) ^ rr(w[j - 15], 18) ^ (w[j - 15] >>> 3), s1 = rr(w[j - 2], 17) ^ rr(w[j - 2], 19) ^ (w[j - 2] >>> 10); w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0; }
      var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (j = 0; j < 64; j++) {
        var S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K256[j] + w[j]) | 0;
        var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22), mj = (a & bb) ^ (a & c) ^ (bb & c), t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      H = [(H[0] + a) | 0, (H[1] + bb) | 0, (H[2] + c) | 0, (H[3] + d) | 0, (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0];
    }
    return H.map(function (x) { return ("00000000" + (x >>> 0).toString(16)).slice(-8); }).join("");
  }
  function lineWinner(board) { for (var i = 0; i < 8; i++) { var L = LINES[i]; if (board[L[0]] !== "_" && board[L[0]] === board[L[1]] && board[L[0]] === board[L[2]]) return board[L[0]]; } return null; }
  function c4Win(board, idx) {
    var r0 = Math.floor(idx / 7), c0 = idx % 7, m = board[idx], D = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (var d = 0; d < 4; d++) {
      var cells = [idx];
      [1, -1].forEach(function (s) { var r = r0 + D[d][0] * s, c = c0 + D[d][1] * s; while (r >= 0 && r < 6 && c >= 0 && c < 7 && board[r * 7 + c] === m) { cells.push(r * 7 + c); r += D[d][0] * s; c += D[d][1] * s; } });
      if (cells.length >= 4) return cells;
    }
    return null;
  }
  function rpsWin(pa, pb) { return pa === pb ? null : BEATS[pa] === pb ? "a" : "b"; }

  // Turns a Direct game record (players + move log) into the same shape the server sends for Secure games.
  // Everything here is deterministic, so both players' browsers always agree.
  function derive(g) {
    var type = g.type, cfg = CFG[type] || CFG.ttt, bet = g.bet;
    var st = { mode: "direct", type: type, bet: bet, created: g.created, p: { a: g.a, b: g.b || null }, seen: g.seen || {}, paid: g.paid || {}, status: "waiting", score: { a: 0, b: 0 }, round: 1, draws: 0, starter: "a", turn: "a", overtime: false, deadline: 0, startT: 0, result: null, pay: null, winCells: null, lastRound: null, tBoth: 0, rv: { a: false, b: false } };
    if (type === "ttt") st.board = "_________"; else if (type === "c4") st.board = "_".repeat(42); else { st.rn = 1; st.picked = { a: false, b: false }; delete st.turn; }
    function nm(s) { return (st.p[s] && st.p[s].name) || "Player"; }
    function finish(kind, w, t, leaver) {
      var who = w ? nm(w) : "", msgs = {
        score: who + " won" + (cfg.win > 1 ? " the match " + Math.max(st.score.a, st.score.b) + "-" + Math.min(st.score.a, st.score.b) : "") + ".",
        forfeit: nm(leaver || other(w || "a")) + " left the game. " + who + " wins the bet.",
        disconnect: nm(leaver || other(w || "a")) + " was disconnected for 15 seconds. " + who + " wins the bet.",
        bothleft: "Both players disconnected at the same time. Everyone got their crates back.",
        timeout: "Time ran out. " + who + " wins with the most games.",
        "timeout-refund": "The timer ran out with no winner. Everyone got their crates back. Make or join a new game.",
        draw: "It's a draw. Everyone got their crates back.",
        cancel: "The game was cancelled. Your crates were returned."
      };
      st.status = "done";
      st.result = { kind: kind, winner: w || null, msg: msgs[kind] || "The game ended.", at: t };
      st.pay = w ? (function () { var o = {}; o[w] = bet * 2; o[other(w)] = 0; return o; })() : st.p.b ? { a: bet, b: bet } : { a: bet, b: 0 };
    }
    var C = {}, R = {};   // Rock Paper Scissors commitments / reveals per round
    function rpsRound(winner, pa, pb, t) {
      st.lastRound = { winner: winner, a: pa, b: pb, round: st.round, at: t };
      if (winner) { st.score[winner]++; if (st.score[winner] >= cfg.win) { finish("score", winner, t); return; } st.round++; } else st.draws++;
      st.rn++; st.picked = { a: false, b: false }; st.rv = { a: false, b: false }; st.tBoth = 0;
    }
    var keys = Object.keys(g.log || {}).sort();
    for (var i = 0; i < keys.length && st.status !== "done"; i++) {
      var e = g.log[keys[i]]; if (!e || typeof e !== "object") continue;
      if (e.k === "start") { if (!st.startT && g.b) { st.status = "playing"; st.startT = e.t; st.deadline = e.t + cfg.ms; } continue; }
      if (e.k === "end") {
        if (st.status === "waiting") { if (e.kind === "cancel") finish("cancel", null, e.t); continue; }
        if (e.kind === "forfeit" || e.kind === "disconnect") { if (e.w === "a" || e.w === "b") finish(e.kind, e.w, e.t); }
        else if (e.kind === "timeout") { if ((e.w === "a" || e.w === "b") && e.t >= st.deadline) finish("timeout", e.w, e.t); }
        else if (e.kind === "bothleft" || e.kind === "timeout-refund") finish(e.kind, null, e.t);
        continue;
      }
      if (st.status !== "playing") continue;
      if (e.k === "ot") { if (!st.overtime && st.score.a === st.score.b && e.t >= st.deadline) { st.overtime = true; st.deadline = st.startT + cfg.ms + cfg.extra; } continue; }
      if (e.s !== "a" && e.s !== "b" && e.k !== "rl") continue;
      if (type === "rps") {
        var cr = C[st.rn] = C[st.rn] || {}, rr = R[st.rn] = R[st.rn] || {};
        if (e.k === "c") { if (cr[e.s] || typeof e.h !== "string") continue; cr[e.s] = e.h; st.picked[e.s] = true; if (cr.a && cr.b) st.tBoth = e.t; }
        else if (e.k === "r") {
          if (!cr[e.s] || rr[e.s] || !(cr.a && cr.b) || PICKS.indexOf(e.p) < 0 || sha256hex(e.p + ":" + e.z) !== cr[e.s]) continue;
          rr[e.s] = e.p; st.rv[e.s] = true;
          if (rr.a && rr.b) rpsRound(rpsWin(rr.a, rr.b), rr.a, rr.b, e.t);
        } else if (e.k === "rl") {   // a player refused to reveal: the one who did wins the round
          if ((e.w !== "a" && e.w !== "b") || !st.tBoth || e.t - st.tBoth < REVEAL_MS || !rr[e.w] || rr[other(e.w)]) continue;
          rpsRound(e.w, rr.a || "?", rr.b || "?", e.t);
        }
        continue;
      }
      if (e.k !== "m" || st.turn !== e.s || !Number.isInteger(e.c)) continue;
      if (type === "ttt") {
        if (e.c < 0 || e.c > 8 || st.board[e.c] !== "_") continue;
        st.board = st.board.slice(0, e.c) + (e.s === st.starter ? "X" : "O") + st.board.slice(e.c + 1);
        if (lineWinner(st.board)) {
          st.score[e.s]++; st.lastRound = { winner: e.s, round: st.round, at: e.t };
          if (st.score[e.s] >= cfg.win) { finish("score", e.s, e.t); continue; }
          st.round++; st.starter = other(st.starter); st.board = "_________"; st.turn = st.starter;
        } else if (st.board.indexOf("_") < 0) { st.draws++; st.lastRound = { winner: null, round: st.round, at: e.t }; st.starter = other(st.starter); st.board = "_________"; st.turn = st.starter; }
        else st.turn = other(e.s);
      } else {   // Connect 4
        if (e.c < 0 || e.c > 6) continue;
        var row = -1; for (var r = 5; r >= 0; r--) if (st.board[r * 7 + e.c] === "_") { row = r; break; }
        if (row < 0) continue;
        var idx = row * 7 + e.c; st.board = st.board.slice(0, idx) + (e.s === st.starter ? "R" : "Y") + st.board.slice(idx + 1);
        var cells = c4Win(st.board, idx);
        if (cells) { st.winCells = cells; st.score[e.s]++; finish("score", e.s, e.t); }
        else if (st.board.indexOf("_") < 0) finish("draw", null, e.t);
        else st.turn = other(e.s);
      }
    }
    return st;
  }
  window.VUS_GAMES = { derive: derive, sha256hex: sha256hex };

  var shell = document.getElementById("appShell"), rail = document.getElementById("rail"), navCol = document.getElementById("navCol");
  if (!shell || !rail) return;

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function chat() { return window.VUS_CHAT || {}; }
  function me() { return chat().myId ? String(chat().myId() || "") : ""; }
  function myName() { return chat().myName ? String(chat().myName() || "Player").slice(0, 40) : "Player"; }
  function stock() { return chat().crateStock ? Math.max(0, Number(chat().crateStock()) || 0) : 0; }
  function now() { return chat().srvNow ? chat().srvNow() : Date.now(); }
  function crates(n) { return n + (n === 1 ? " crate" : " crates"); }
  function db() { return chat().db ? chat().db() : null; }
  function TS() { return firebase.database.ServerValue.TIMESTAMP; }

  var css = document.createElement("style");
  css.textContent = "#gamesPane{display:none;flex-direction:column;flex:1;min-width:0;overflow:auto;background:#0f172a;color:#e2e8f0;padding:22px;box-sizing:border-box;font-family:inherit}" +
    "#appShell.mode-games > *:not(#navCol):not(#navBackdrop):not(#gamesPane):not(.chat-modal-overlay):not(#pingToast){display:none !important}#appShell.mode-games #gamesPane{display:flex}" +
    ".gm-wrap{max-width:760px;width:100%;margin:0 auto}.gm-h{display:flex;align-items:center;gap:10px;margin:0 0 14px}.gm-h h2{margin:0;font-size:22px;flex:1}.gm-stock{background:#1e293b;border:1.5px solid #334155;border-radius:999px;padding:6px 14px;font-size:14px}" +
    ".gm-card{background:#1e293b;border:1.5px solid #334155;border-radius:14px;padding:16px;margin:0 0 14px}.gm-card h3{margin:0 0 10px;font-size:16px}.gm-note{font-size:13.5px;color:#94a3b8;line-height:1.5;margin:6px 0}.gm-tag{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;padding:1px 8px;margin-left:6px;vertical-align:middle}.gm-tag.s{background:#14532d;color:#bbf7d0}.gm-tag.d{background:#78350f;color:#fde68a}" +
    ".gm-bets{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.gm-bet,.gm-btn{padding:9px 16px;border-radius:10px;border:1.5px solid #334155;background:#0f172a;color:#e2e8f0;cursor:pointer;font-size:15px;font-weight:600}.gm-bet.on{background:#16a34a;border-color:#16a34a;color:#fff}.gm-btn.p{background:#16a34a;border-color:#16a34a;color:#fff}.gm-btn.d{background:#b91c1c;border-color:#b91c1c;color:#fff}.gm-btn:disabled,.gm-bet:disabled{opacity:.45;cursor:not-allowed}" +
    ".gm-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid #334155}.gm-row:first-of-type{border-top:0}.gm-row .grow{flex:1;min-width:0}.gm-row b{display:block}.gm-row span{font-size:13px;color:#94a3b8}" +
    ".gm-err{background:#7f1d1d;border:1.5px solid #b91c1c;color:#fecaca;border-radius:10px;padding:10px 14px;margin:0 0 12px;font-size:14px;display:none}.gm-err.on{display:block}" +
    ".gm-top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px}.gm-pl{font-size:18px;font-weight:700}.gm-pl.me{color:#4ade80}.gm-score{font-size:30px;font-weight:800;letter-spacing:2px}.gm-timer{font:700 16px monospace;background:#0f172a;border:1.5px solid #334155;border-radius:10px;padding:6px 12px;display:inline-block}.gm-timer.ot{color:#fbbf24;border-color:#fbbf24}" +
    ".gm-board{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:min(340px,86vw);margin:14px auto}.gm-cell{aspect-ratio:1;border-radius:12px;border:2px solid #334155;background:#0f172a;color:#e2e8f0;font-size:min(14vw,58px);font-weight:800;cursor:pointer;line-height:1}.gm-cell:disabled{cursor:default}.gm-cell.X{color:#38bdf8}.gm-cell.O{color:#fb7185}.gm-cell.can:hover{background:#1e293b}" +
    ".gm-c4{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;width:min(440px,92vw);margin:14px auto;background:#1d4ed8;padding:10px;border-radius:14px}.gm-disc{aspect-ratio:1;border-radius:50%;border:0;background:#0f172a;cursor:pointer;padding:0}.gm-disc:disabled{cursor:default}.gm-disc.R{background:#ef4444}.gm-disc.Y{background:#facc15}.gm-disc.can:hover{background:#334155}.gm-disc.win{box-shadow:0 0 0 4px #fff inset}" +
    ".gm-rps{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin:14px 0}.gm-rpsb{width:min(30vw,130px);padding:14px 6px;border-radius:14px;border:2px solid #334155;background:#0f172a;color:#e2e8f0;cursor:pointer;font-size:14px;font-weight:700}.gm-rpsb span{display:block;font-size:44px;line-height:1.1;margin-bottom:4px}.gm-rpsb.can:hover{background:#334155}.gm-rpsb.mine{border-color:#4ade80}.gm-rpsb:disabled{cursor:default;opacity:.7}" +
    ".gm-status{text-align:center;font-size:17px;font-weight:700;min-height:26px;margin:6px 0}.gm-banner{text-align:center;font-size:15px;color:#fbbf24;min-height:20px}.gm-done{text-align:center}.gm-done h3{font-size:22px;margin:0 0 8px}.gm-center{text-align:center}.gm-sel{padding:8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1.5px solid #334155;font-size:15px}";
  document.head.appendChild(css);

  // ── rail button + panel ──
  var pane = el("div"); pane.id = "gamesPane"; shell.appendChild(pane);
  var btn = el("button", "rail-nav-btn"); btn.id = "navPlay"; btn.type = "button"; btn.title = "Games"; btn.setAttribute("aria-label", "Games");
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 10.5v4M5 12.5h4"/><circle cx="16" cy="11.5" r="1"/><circle cx="18.5" cy="14" r="1"/></svg>';
  var anchor = document.getElementById("navCrate");
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling); else rail.appendChild(btn);

  var open = false, prevActive = [];
  function openPane() {
    if (open) return; open = true;
    prevActive = Array.prototype.slice.call(rail.querySelectorAll(".rail-nav-btn.active, .rail-room.active"));
    prevActive.forEach(function (b) { b.classList.remove("active"); });
    shell.classList.add("mode-games"); btn.classList.add("active");
    btn.style.color = ""; btn.title = "Games";
    probe(false).then(function () { if (open) { lastSig = ""; onGames(); } });
    sweep(); startListening(); render();
  }
  function closePane() {
    if (!open) return; open = false;
    shell.classList.remove("mode-games"); btn.classList.remove("active");
    prevActive.forEach(function (b) { b.classList.add("active"); }); prevActive = [];
  }
  btn.addEventListener("click", function () { if (open) closePane(); else openPane(); });
  // Clicking anything else in the sidebar returns to normal (capture phase: runs before their own handlers).
  if (navCol) navCol.addEventListener("click", function (e) { if (open && !btn.contains(e.target)) closePane(); }, true);

  // ── is the game server reachable? ──
  var serverUp = null, probeAt = 0, modePref = "auto";
  try { modePref = localStorage.getItem("vus_games_mode") || "auto"; } catch (e) {}
  async function probe(force) {
    if (!force && serverUp !== null && Date.now() - probeAt < 60000) return serverUp;
    probeAt = Date.now();
    try {
      var c = new AbortController(), t = setTimeout(function () { c.abort(); }, 4000);
      var r = await fetch(API + "/api/ping", { signal: c.signal, cache: "no-store" }); clearTimeout(t);
      var j = await r.json(); serverUp = !!(j && j.ok && j.firebaseAdmin === "installed" && j.FIREBASE_CHAT_SA === "OK");
    } catch (e) { serverUp = false; }
    return serverUp;
  }
  function createMode() { return modePref === "direct" ? "direct" : modePref === "secure" ? "secure" : (serverUp ? "secure" : "direct"); }

  // ── talking to the server (Secure mode) ──
  var errBox = null;
  function showErr(msg) { if (!errBox) return; errBox.textContent = msg || ""; errBox.classList.toggle("on", !!msg); }
  async function call(action, body, retried) {
    var id = me();
    if (!id) throw new Error("Log in to play.");
    var tok = await window.VUS_AUTH.loginToken(id, !!retried);
    if (!tok) throw new Error("Playing for crates needs a one-time password confirmation.");
    var r;
    try { r = await fetch(API + "/api/game", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify(Object.assign({ action: action }, body || {})) }); }
    catch (e) { serverUp = false; throw new Error("Couldn't reach the game server. Try Direct mode (it works without the server)."); }
    var text = await r.text(), j = null; try { j = JSON.parse(text); } catch (e) {}
    if (!j) throw new Error("The game server isn't answering properly (HTTP " + r.status + "). Open " + API + "/api/ping.");
    if (r.status === 401 && !retried && (j.code === "INVALID_TOKEN" || j.code === "MISSING_TOKEN")) return call(action, body, true);
    if (!j.ok) { var m = j.error || "Request failed."; if (j.hint) m += " " + j.hint; throw new Error(m); }
    return j;
  }
  async function sweep() { if (serverUp === false) return; try { await fetch(API + "/api/game", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sweep" }) }); } catch (e) {} }

  // ── Direct mode: crates and moves go straight to Firebase ──
  function friendly(e) {
    var m = String(e && (e.message || e.code) || e);
    return /permission/i.test(m) ? "Direct mode isn't switched on yet: the database rules need to be published." : m;
  }
  async function adjustG(id, delta) { await db().ref("crateGames/" + id).transaction(function (v) { return (Number(v) || 0) + delta; }); }
  function sideIn(raw) { var id = me(); return raw && raw.a && raw.a.id === id ? "a" : raw && raw.b && raw.b.id === id ? "b" : null; }
  async function append(gid, entry, stillOk) {   // add one entry to the game's log (retrying if the other player wrote first)
    for (var i = 0; i < 6; i++) {
      var raw = pgames[gid], n = raw && raw.log ? Object.keys(raw.log).length : 0;
      if (raw && stillOk && !stillOk(derive(raw), raw)) return false;
      var e = Object.assign({}, entry, { t: TS() });
      try { await db().ref("pg/" + gid + "/log/" + ("000" + n).slice(-4)).set(e); return true; }
      catch (err) { if (!/permission/i.test(String(err && (err.code || err.message)))) throw err; var s = await db().ref("pg/" + gid).get(); pgames[gid] = s.val(); }
    }
    return false;
  }
  async function dCreate(type, bet) {
    if (stock() < bet) throw new Error("You don't have " + crates(bet) + " to bet.");
    await adjustG(me(), -bet);
    try {
      var ref = db().ref("pg").push();
      await ref.set({ type: type, bet: bet, created: TS(), a: { id: me(), name: myName() }, seen: { a: TS() }, v: 1 });
      return { gid: ref.key, mode: "direct" };
    } catch (e) { await adjustG(me(), bet); throw new Error(friendly(e)); }
  }
  async function dJoin(gid) {
    var raw = pgames[gid]; if (!raw || derive(raw).status !== "waiting") throw new Error("That game is no longer open.");
    if (raw.a.id === me()) throw new Error("You can't join your own game.");
    if (stock() < raw.bet) throw new Error("You need " + crates(raw.bet) + " to join.");
    await adjustG(me(), -raw.bet);
    var up = {}; up["pg/" + gid + "/b"] = { id: me(), name: myName() }; up["pg/" + gid + "/log/0000"] = { k: "start", t: TS() }; up["pg/" + gid + "/seen/b"] = TS();
    try { await db().ref().update(up); return { gid: gid, mode: "direct" }; }
    catch (e) { await adjustG(me(), raw.bet); throw new Error(/permission/i.test(String(e && (e.code || e.message))) ? "Someone else just joined that game." : friendly(e)); }
  }
  function dLeave(gid) {
    var raw = pgames[gid], side = sideIn(raw), st = raw && derive(raw); if (!side || !st) return;
    if (st.status === "waiting") return append(gid, { k: "end", s: "x", kind: "cancel" }, function (x) { return x.status === "waiting"; });
    return append(gid, { k: "end", s: side, kind: "forfeit", w: other(side) }, function (x) { return x.status === "playing"; });
  }
  function dMove(gid, c) {
    var side = sideIn(pgames[gid]);
    return append(gid, { k: "m", s: side, c: c }, function (x) { return x.status === "playing" && x.turn === side; });
  }
  var commits = {};
  try { commits = JSON.parse(localStorage.getItem("vus_games_commits") || "{}") || {}; } catch (e) { commits = {}; }
  function saveCommits() { try { localStorage.setItem("vus_games_commits", JSON.stringify(commits)); } catch (e) {} }
  function dPick(gid, p) {   // commit to a pick without showing it; the reveal is sent automatically once both have committed
    var raw = pgames[gid], side = sideIn(raw), st = raw && derive(raw);
    if (!st || st.status !== "playing" || st.picked[side]) return;
    var z = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(8)), function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    commits[gid + ":" + st.rn] = { p: p, z: z }; saveCommits();
    return append(gid, { k: "c", s: side, h: sha256hex(p + ":" + z) }, function (x) { return x.status === "playing" && !x.picked[side]; });
  }
  async function claim(gid, raw, side, st) {   // collect my winnings / refund exactly once
    var tx = await db().ref("pg/" + gid + "/paid/" + side).transaction(function (v) { return v === null ? true : undefined; });
    if (!tx.committed || tx.snapshot.val() !== true) return;
    var amt = (st.pay && st.pay[side]) || 0;
    if (amt > 0) await adjustG(me(), amt);
  }
  var lastBeat = 0, ticking = false;
  async function directTick(gid) {   // runs every second while I'm in a Direct game
    if (ticking) return; ticking = true;
    try {
      var raw = pgames[gid], side = sideIn(raw); if (!raw || !side) return;
      var st = derive(raw), t = now(), opp = other(side), seen = raw.seen || {};
      if (st.status === "done") return;
      if (st.status === "playing") {
        var sMe = seen[side] || 0, sOpp = seen[opp] || 0;
        if (t - sOpp > GRACE) {   // the other player went quiet (judged with the old "seen" times, before I refresh mine)
          if (t - sMe > GRACE) {
            if (Math.abs(sMe - sOpp) <= GRACE) return void append(gid, { k: "end", s: "x", kind: "bothleft" }, function (x) { return x.status === "playing"; });
            return void append(gid, { k: "end", s: "x", kind: "disconnect", w: sMe < sOpp ? opp : side }, function (x) { return x.status === "playing"; });
          }
          return void append(gid, { k: "end", s: "x", kind: "disconnect", w: side }, function (x) { return x.status === "playing"; });
        }
        if (t >= st.deadline) {
          if (st.score.a !== st.score.b) append(gid, { k: "end", s: "x", kind: "timeout", w: st.score.a > st.score.b ? "a" : "b" }, function (x) { return x.status === "playing" && x.score.a !== x.score.b; });
          else if (!st.overtime) append(gid, { k: "ot", s: "x" }, function (x) { return x.status === "playing" && !x.overtime; });
          else append(gid, { k: "end", s: "x", kind: "timeout-refund" }, function (x) { return x.status === "playing" && x.overtime; });
        }
        if (st.type === "rps") {
          var c = commits[gid + ":" + st.rn];
          if (st.picked.a && st.picked.b && !st.rv[side] && c) append(gid, { k: "r", s: side, p: c.p, z: c.z }, function (x) { return x.status === "playing" && !x.rv[side]; });
          if (st.tBoth && t - st.tBoth > REVEAL_MS && st.rv[side] && !st.rv[opp]) append(gid, { k: "rl", s: "x", w: side }, function (x) { return x.status === "playing" && x.rv[side] && !x.rv[opp]; });
        }
      }
      if (t - lastBeat > BEAT_MS) { lastBeat = t; db().ref("pg/" + gid + "/seen/" + side).set(TS()).catch(function () {}); }
    } catch (e) {} finally { ticking = false; }
  }
  function directHousekeeping() {   // tidy games nobody is looking after, and collect anything I'm owed
    var t = now();
    Object.keys(pgames).forEach(function (gid) {
      var raw = pgames[gid]; if (!raw || !raw.a) return;
      var st = derive(raw), side = sideIn(raw), seen = raw.seen || {};
      if (st.status === "done") {
        if (side && !(raw.paid && raw.paid[side])) claim(gid, raw, side, st).catch(function () {});
        return;
      }
      if (st.status === "waiting" && t - (seen.a || raw.created || 0) > WAIT_STALE && side !== "a") append(gid, { k: "end", s: "x", kind: "cancel" }, function (x) { return x.status === "waiting"; }).catch(function () {});
      if (st.status === "playing" && t - (seen.a || 0) > GRACE && t - (seen.b || 0) > GRACE && gid !== myGid) {
        var da = seen.a || 0, dbb = seen.b || 0;
        append(gid, Math.abs(da - dbb) <= GRACE ? { k: "end", s: "x", kind: "bothleft" } : { k: "end", s: "x", kind: "disconnect", w: da < dbb ? "b" : "a" }, function (x) { return x.status === "playing"; }).catch(function () {});
      }
    });
  }

  // ── game state (live from the database) ──
  var games = {}, pgames = {}, listenRef = null, pgRef = null, myGid = "", myMode = "", loop = null, lastId = "", lastSig = "", myPicks = {}, lastPing = 0;
  function startListening() {
    var d = db(); if (!d) return;
    if (!listenRef) { listenRef = d.ref("games"); listenRef.on("value", function (s) { games = s.val() || {}; onGames(); }, function () {}); }
    if (!pgRef) { pgRef = d.ref("pg"); pgRef.on("value", function (s) { pgames = s.val() || {}; directHousekeeping(); onGames(); }, function () {}); }
  }
  function viewOf(gid, mode) { return mode === "direct" ? (pgames[gid] ? derive(pgames[gid]) : null) : (games[gid] || null); }
  function findMine() {   // a game I'm still playing (finished ones stay on screen until I click back)
    var id = me(), found = null;
    Object.keys(games).forEach(function (k) {
      var g = games[k]; if (!g || !g.p || g.status === "done") return;
      if ((g.p.a && g.p.a.id === id) || (g.p.b && g.p.b.id === id)) found = { gid: k, mode: "secure" };
    });
    Object.keys(pgames).forEach(function (k) {
      var r = pgames[k]; if (!r || !r.a || !sideIn(r)) return;
      if (derive(r).status !== "done") found = { gid: k, mode: "direct" };
    });
    return found;
  }
  function onGames() {
    var mine = findMine();
    if (mine && (mine.gid !== myGid || mine.mode !== myMode)) { myGid = mine.gid; myMode = mine.mode; startLoop(); }
    if (myGid && !viewOf(myGid, myMode)) { myGid = ""; stopLoop(); }
    badge();
    if (!open) return;
    // only redraw when something you can see changed (the players' heartbeats change the data every few seconds)
    var g = myGid ? viewOf(myGid, myMode) : null;
    var waiting = waitingList().map(function (w) { return [w.gid, w.mode, w.type, w.bet, w.host]; });
    var sig = JSON.stringify([me(), stock(), serverUp, modePref, myGid, g ? [g.status, g.board, g.turn, g.score, g.round, g.rn, g.picked, g.draws, g.result, g.overtime, g.deadline, g.lastRound, g.winCells, g.p] : waiting]);
    if (sig !== lastSig) { lastSig = sig; render(); }
  }
  function badge() { var g = myGid ? viewOf(myGid, myMode) : null; btn.style.color = g && g.status !== "done" ? "#4ade80" : ""; }
  function waitingList() {
    var out = [], t = now();
    Object.keys(games).forEach(function (k) { var g = games[k]; if (g && g.status === "waiting" && g.p && g.p.a) out.push({ gid: k, mode: "secure", type: g.type || "ttt", bet: g.bet, host: g.p.a.name, created: g.created || 0 }); });
    Object.keys(pgames).forEach(function (k) {
      var r = pgames[k]; if (!r || !r.a) return;
      var st = derive(r); if (st.status !== "waiting" || t - ((r.seen && r.seen.a) || r.created || 0) > WAIT_STALE) return;
      out.push({ gid: k, mode: "direct", type: r.type, bet: r.bet, host: r.a.name, created: r.created || 0 });
    });
    return out.sort(function (a, b) { return b.created - a.created; });
  }
  // While you are in a game the other side needs to hear from you every few seconds, even if you are looking at the chat.
  function startLoop() { stopLoop(); loop = setInterval(function () { tick(); }, 1000); }
  function stopLoop() { if (loop) clearInterval(loop); loop = null; }
  function tick() {
    var g = myGid ? viewOf(myGid, myMode) : null;
    if (!g || g.status === "done" || !me()) return;
    if (myMode === "direct") { directTick(myGid); return; }
    if (Date.now() - lastPing < 4000 || !window.VUS_AUTH || !window.VUS_AUTH.hasToken(me())) return;   // never pop up a password box for a heartbeat
    lastPing = Date.now(); call("ping", { gid: myGid }).catch(function () {});
  }
  // Make sure we find a game we were already in (after a reload) even before the panel is opened.
  setInterval(function () {
    var id = me();
    if (!id) return;
    if (!listenRef || !pgRef) startListening();
    if (id !== lastId) { lastId = id; myGid = ""; myMode = ""; stopLoop(); onGames(); }
    if (serverUp === null) probe(false);
  }, 2000);

  // ── drawing ──
  var picked = 0, selGame = "ttt", busy = false;
  function render() {
    if (!open) return;
    pane.textContent = "";
    var wrap = el("div", "gm-wrap"); pane.appendChild(wrap);
    var h = el("div", "gm-h"); h.appendChild(el("h2", "", "\uD83C\uDFAE Games"));
    h.appendChild(el("div", "gm-stock", me() ? "\uD83D\uDCE6 " + crates(stock()) : "Not logged in")); wrap.appendChild(h);
    errBox = el("div", "gm-err"); wrap.appendChild(errBox);
    if (!me()) { wrap.appendChild(el("div", "gm-note", "Log in to play games.")); return; }
    var g = myGid ? viewOf(myGid, myMode) : null;
    if (g) renderGame(wrap, g); else renderLobby(wrap);
  }

  function renderLobby(wrap) {
    var have = stock(), opts = BETS.filter(function (b) { return b <= have; });   // only amounts you actually have
    if (opts.indexOf(picked) < 0) picked = opts.length ? opts[0] : 0;
    var c = el("div", "gm-card"); c.appendChild(el("h3", "", "Create a game"));
    var sel = document.createElement("select"); sel.className = "gm-sel";
    ORDER.forEach(function (k) { var o = document.createElement("option"); o.value = k; o.textContent = NAMES[k]; sel.appendChild(o); });
    sel.value = selGame; sel.onchange = function () { selGame = sel.value; render(); }; c.appendChild(sel);
    c.appendChild(el("div", "gm-note", RULES[selGame]));
    // which layer
    var ms = document.createElement("select"); ms.className = "gm-sel"; ms.style.marginLeft = "8px";
    [["auto", "Mode: automatic"], ["secure", "Mode: Secure (server)"], ["direct", "Mode: Direct (no server)"]].forEach(function (m) { var o = document.createElement("option"); o.value = m[0]; o.textContent = m[1]; ms.appendChild(o); });
    ms.value = modePref; ms.onchange = function () { modePref = ms.value; try { localStorage.setItem("vus_games_mode", modePref); } catch (e) {} if (modePref !== "direct") probe(true).then(function () { lastSig = ""; onGames(); }); render(); };
    c.appendChild(ms);
    var cm = createMode();
    c.appendChild(el("div", "gm-note", (serverUp === null ? "Checking the game server\u2026 " : serverUp ? "Game server reachable. " : "Game server not reachable from here. ") +
      (cm === "secure" ? "This game will be Secure: the server runs it, so it can't be cheated." : "This game will be Direct: it works without the server, but it relies on both players' browsers, so a determined cheater could fake results or crates.")));
    if (!opts.length) {
      c.appendChild(el("div", "gm-note", "You need at least 1 crate to play. A new crate can be earned every hour by chatting."));
    } else {
      c.appendChild(el("div", "gm-note", "Pick how many crates to bet. The winner takes both bets. Leaving, or being disconnected for 15 seconds, gives your bet to the other player."));
      var bets = el("div", "gm-bets");
      opts.forEach(function (n) { var b = el("button", "gm-bet" + (n === picked ? " on" : ""), n + "x"); b.type = "button"; b.onclick = function () { picked = n; render(); }; bets.appendChild(b); });
      c.appendChild(bets);
      var go = el("button", "gm-btn p", "Create game (" + crates(picked) + ")"); go.type = "button"; go.disabled = busy || (cm === "secure" && serverUp === false);
      go.onclick = function () { act(function () { return cm === "direct" ? dCreate(selGame, picked) : call("create", { game: selGame, bet: picked }).then(function (r) { return { gid: r.gid, mode: "secure" }; }); }); };
      c.appendChild(go);
    }
    wrap.appendChild(c);

    var list = waitingList().filter(function (w) { return !(me() && ((games[w.gid] && games[w.gid].p.a.id === me()) || (pgames[w.gid] && pgames[w.gid].a.id === me()))); });
    var l = el("div", "gm-card"); l.appendChild(el("h3", "", "Open games"));
    if (!list.length) l.appendChild(el("div", "gm-note", "No open games right now. Create one and wait for someone to join."));
    list.forEach(function (w) {
      var row = el("div", "gm-row"), info = el("div", "grow"), b = el("b", "", w.host);
      b.appendChild(el("span", "gm-tag " + (w.mode === "secure" ? "s" : "d"), w.mode === "secure" ? "Secure" : "Direct"));
      info.appendChild(b); info.appendChild(el("span", "", (NAMES[w.type] || "Game") + " \u00B7 bet " + w.bet + "x (" + crates(w.bet) + ")"));
      var needServer = w.mode === "secure" && serverUp === false;
      var j = el("button", "gm-btn p", needServer ? "Server needed" : have >= w.bet ? "Join" : "Need " + w.bet); j.type = "button"; j.disabled = busy || needServer || have < w.bet;
      j.onclick = function () { act(function () { return w.mode === "direct" ? dJoin(w.gid) : call("join", { gid: w.gid }).then(function (r) { return { gid: r.gid, mode: "secure" }; }); }); };
      row.append(info, j); l.appendChild(row);
    });
    wrap.appendChild(l);
  }

  async function act(fn) {
    if (busy) return; busy = true; showErr(""); render();
    try { var r = await fn(); if (r && r.gid) { myGid = r.gid; myMode = r.mode || myMode; startLoop(); } }
    catch (e) { busy = false; render(); showErr(friendly(e) || "Something went wrong."); return; }
    busy = false; render();
  }

  function fmt(ms) { ms = Math.max(0, ms); var s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
  var timerEl = null;
  var ICON = { rock: "\u270A", paper: "\u270B", scissors: "\u270C\uFE0F", "?": "\u2753" }, LABEL = { rock: "Rock", paper: "Paper", scissors: "Scissors" };
  function doMove(g, payload) { return g.mode === "direct" ? dMove(myGid, payload.cell !== undefined ? payload.cell : payload.col) : call("move", Object.assign({ gid: myGid }, payload)); }

  function tttBoard(g, mineTurn, live) {
    var board = el("div", "gm-board");
    for (var i = 0; i < 9; i++) (function (i) {
      var v = g.board[i], c = el("button", "gm-cell" + (v !== "_" ? " " + v : "") + (live && mineTurn && v === "_" ? " can" : ""), v === "_" ? "" : v);
      c.type = "button"; c.disabled = !live || !mineTurn || v !== "_" || busy;
      c.onclick = function () { act(function () { return doMove(g, { cell: i }); }); };
      board.appendChild(c);
    })(i);
    return board;
  }
  function c4Board(g, mineTurn, live) {
    var board = el("div", "gm-c4"), wins = g.winCells || [];
    for (var i = 0; i < 42; i++) (function (i) {
      var v = g.board[i], col = i % 7;
      var d = el("button", "gm-disc" + (v !== "_" ? " " + v : "") + (live && mineTurn && v === "_" ? " can" : "") + (wins.indexOf(i) >= 0 ? " win" : ""));
      d.type = "button"; d.disabled = !live || !mineTurn || busy; d.title = "Column " + (col + 1);
      d.onclick = function () { act(function () { return doMove(g, { col: col }); }); };
      board.appendChild(d);
    })(i);
    return board;
  }

  function renderGame(wrap, g) {
    var id = me(), side = g.p.a && g.p.a.id === id ? "a" : "b", opp = side === "a" ? "b" : "a", type = g.type || "ttt";
    var top = el("div", "gm-top");
    var left = el("div"); left.appendChild(el("div", "gm-pl me", g.p[side].name + " (you)"));
    var mid = el("div", "gm-center"), sc = g.score || { a: 0, b: 0 };
    mid.appendChild(el("div", "gm-score", type === "c4" ? "vs" : sc[side] + " \u2013 " + sc[opp]));
    var sub = el("div", "gm-note", (NAMES[type] || "Game") + " \u00B7 bet " + g.bet + "x each \u00B7 pot " + crates(g.bet * 2));
    sub.appendChild(el("span", "gm-tag " + (g.mode === "direct" ? "d" : "s"), g.mode === "direct" ? "Direct" : "Secure")); mid.appendChild(sub);
    var right = el("div"); right.style.textAlign = "right"; right.appendChild(el("div", "gm-pl", g.p[opp] ? g.p[opp].name : "Waiting\u2026"));
    top.append(left, mid, right); wrap.appendChild(top);

    var card = el("div", "gm-card");
    if (g.status === "waiting") {
      card.appendChild(el("div", "gm-status", "Waiting for someone to join\u2026"));
      card.appendChild(el("div", "gm-note gm-center", "Your bet of " + crates(g.bet) + " is held until the game ends. Keep this tab open. Cancelling gives it back."));
      var cancel = el("button", "gm-btn d", "Cancel game"); cancel.type = "button"; var cw = el("div", "gm-center"); cw.appendChild(cancel); card.appendChild(cw);
      cancel.onclick = function () { act(function () { return g.mode === "direct" ? dLeave(myGid) : call("leave", { gid: myGid }); }); };
    } else if (g.status === "playing") {
      timerEl = el("div", "gm-timer"); var tw = el("div", "gm-center"); tw.appendChild(timerEl); card.appendChild(tw);
      var oppName = g.p[opp].name, lr = g.lastRound, banner = "";
      if (type === "rps") {
        var mine = g.picked && g.picked[side], oppPicked = g.picked && g.picked[opp], c = (commits[myGid + ":" + g.rn] || {}).p || myPicks[myGid + ":" + g.rn];
        card.appendChild(el("div", "gm-status", mine ? "Locked in! Waiting for " + oppName + "\u2026" : oppPicked ? oppName + " has picked. Your turn!" : "Pick one!"));
        var row = el("div", "gm-rps");
        ["rock", "paper", "scissors"].forEach(function (p) {
          var b = el("button", "gm-rpsb" + (!mine ? " can" : "") + (mine && c === p ? " mine" : "")); b.type = "button"; b.disabled = !!mine || busy;
          b.appendChild(el("span", "", ICON[p])); b.appendChild(document.createTextNode(LABEL[p]));
          b.onclick = function () { myPicks[myGid + ":" + g.rn] = p; act(function () { return g.mode === "direct" ? dPick(myGid, p) : call("move", { gid: myGid, pick: p }); }); };
          row.appendChild(b);
        });
        card.appendChild(row);
        if (lr) banner = "Last round: you " + ICON[lr[side]] + " vs " + oppName + " " + ICON[lr[opp]] + " \u2014 " + (lr.winner ? (lr.winner === side ? "you won it!" : oppName + " won it.") : "a tie, replaying.");
      } else {
        var mineTurn = g.turn === side, markName = type === "c4" ? (side === g.starter ? "Red" : "Yellow") : (side === g.starter ? "X" : "O");
        card.appendChild(el("div", "gm-status", mineTurn ? "Your turn (" + markName + ")" : oppName + "'s turn"));
        card.appendChild(type === "c4" ? c4Board(g, mineTurn, true) : tttBoard(g, mineTurn, true));
        if (type === "ttt" && lr && now() - lr.at < 4000) banner = lr.winner ? g.p[lr.winner].name + " won round " + lr.round + "!" : "Round " + lr.round + " was a draw. Replaying.";
      }
      card.appendChild(el("div", "gm-banner", banner));
      card.appendChild(el("div", "gm-note gm-center", (type === "c4" ? "One game" : "Round " + g.round) + (g.draws ? " \u00B7 " + g.draws + (g.draws === 1 ? " tie" : " ties") : "") + ". Keep this tab open: if you are disconnected for 15 seconds your bet goes to " + oppName + "."));
      var lv = el("button", "gm-btn d", "Leave game"); lv.type = "button"; var lw = el("div", "gm-center"); lw.appendChild(lv); card.appendChild(lw);
      lv.onclick = function () { if (confirm("Leave this game? Your bet of " + crates(g.bet) + " goes to " + oppName + ".")) act(function () { return g.mode === "direct" ? dLeave(myGid) : call("leave", { gid: myGid }); }); };
      paintTimer(g);
    } else {   // done
      var r = g.result || {}, won = r.winner === side, refund = !r.winner;
      var d = el("div", "gm-done");
      d.appendChild(el("h3", "", refund ? "\uD83D\uDD01 Refunded" : won ? "\uD83C\uDF89 You won " + crates(g.bet * 2) + "!" : "You lost " + crates(g.bet)));
      d.appendChild(el("div", "gm-note", r.msg || "The game ended."));
      if (type === "rps" && g.lastRound && g.lastRound.a) d.appendChild(el("div", "gm-banner", "Final round: you " + ICON[g.lastRound[side]] + " vs " + g.p[opp].name + " " + ICON[g.lastRound[opp]]));
      if (type === "c4" && g.board) d.appendChild(c4Board(g, false, false));
      if (type === "ttt" && g.board) d.appendChild(tttBoard(g, false, false));
      var back = el("button", "gm-btn p", "Back to games"); back.type = "button"; back.onclick = function () { myGid = ""; myMode = ""; stopLoop(); showErr(""); lastSig = ""; render(); };
      d.appendChild(back); card.appendChild(d);
    }
    wrap.appendChild(card);
  }
  function paintTimer(g) {
    if (!timerEl) return;
    var left = (g.deadline || 0) - now();
    timerEl.textContent = (g.overtime ? "Overtime " : "Time left ") + fmt(left);
    timerEl.classList.toggle("ot", !!g.overtime);
  }
  setInterval(function () { var g = myGid ? viewOf(myGid, myMode) : null; if (open && g && g.status === "playing") paintTimer(g); }, 500);

  // A finished result should also be noticed when the panel is closed.
  var shown = {};
  setInterval(function () {
    var g = myGid ? viewOf(myGid, myMode) : null; if (!g || g.status !== "done" || shown[myGid] || open) return;
    shown[myGid] = true; btn.style.color = "#fbbf24"; btn.title = "Games: your game ended. Click to see the result.";
  }, 1500);
})();
