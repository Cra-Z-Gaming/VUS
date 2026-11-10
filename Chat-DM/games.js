/* Games: 1v1 minigames you can bet crates on (Tic-Tac-Toe, Rock Paper Scissors, Connect 4). A new icon in the left
   rail opens a panel that fills everything except the sidebar. The server (api/game.js) runs every game and holds
   the bets, so this file only shows what the server says and sends your clicks. */
(function () {
  "use strict";
  var API = window.VUS_API_BASE || "https://vus-orcin.vercel.app";
  var BETS = [1, 2, 3, 5, 10];
  var ORDER = ["ttt", "rps", "c4"];
  var NAMES = { ttt: "Tic-Tac-Toe", rps: "Rock Paper Scissors", c4: "Connect 4" };
  var RULES = {
    ttt: "Best of 3: first to win 2 rounds. A drawn round is replayed. 5 minutes per match: when time is up the player ahead wins; if tied you get 3 extra minutes, then everyone is refunded.",
    rps: "Best of 3: first to win 2 rounds. Both players pick in secret and the server reveals them together. A tie is replayed. 3 minutes per match: when time is up the player ahead wins; if tied you get 2 extra minutes, then everyone is refunded.",
    c4: "One game: get 4 in a row (across, up or diagonally). 8 minutes per game; if nobody has won by then, or the board fills up, you get 3 extra minutes and then everyone is refunded."
  };
  var shell = document.getElementById("appShell"), rail = document.getElementById("rail"), navCol = document.getElementById("navCol");
  if (!shell || !rail) return;

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function chat() { return window.VUS_CHAT || {}; }
  function me() { return chat().myId ? String(chat().myId() || "") : ""; }
  function stock() { return chat().crateStock ? Math.max(0, Number(chat().crateStock()) || 0) : 0; }
  function now() { return chat().srvNow ? chat().srvNow() : Date.now(); }
  function crates(n) { return n + (n === 1 ? " crate" : " crates"); }

  var css = document.createElement("style");
  css.textContent = "#gamesPane{display:none;flex-direction:column;flex:1;min-width:0;overflow:auto;background:#0f172a;color:#e2e8f0;padding:22px;box-sizing:border-box;font-family:inherit}" +
    "#appShell.mode-games > *:not(#navCol):not(#navBackdrop):not(#gamesPane):not(.chat-modal-overlay):not(#pingToast){display:none !important}#appShell.mode-games #gamesPane{display:flex}" +
    ".gm-wrap{max-width:760px;width:100%;margin:0 auto}.gm-h{display:flex;align-items:center;gap:10px;margin:0 0 14px}.gm-h h2{margin:0;font-size:22px;flex:1}.gm-stock{background:#1e293b;border:1.5px solid #334155;border-radius:999px;padding:6px 14px;font-size:14px}" +
    ".gm-card{background:#1e293b;border:1.5px solid #334155;border-radius:14px;padding:16px;margin:0 0 14px}.gm-card h3{margin:0 0 10px;font-size:16px}.gm-note{font-size:13.5px;color:#94a3b8;line-height:1.5;margin:6px 0}" +
    ".gm-bets{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.gm-bet,.gm-btn{padding:9px 16px;border-radius:10px;border:1.5px solid #334155;background:#0f172a;color:#e2e8f0;cursor:pointer;font-size:15px;font-weight:600}.gm-bet.on{background:#16a34a;border-color:#16a34a;color:#fff}.gm-btn.p{background:#16a34a;border-color:#16a34a;color:#fff}.gm-btn.d{background:#b91c1c;border-color:#b91c1c;color:#fff}.gm-btn:disabled,.gm-bet:disabled{opacity:.45;cursor:not-allowed}" +
    ".gm-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid #334155}.gm-row:first-of-type{border-top:0}.gm-row .grow{flex:1;min-width:0}.gm-row b{display:block}.gm-row span{font-size:13px;color:#94a3b8}" +
    ".gm-err{background:#7f1d1d;border:1.5px solid #b91c1c;color:#fecaca;border-radius:10px;padding:10px 14px;margin:0 0 12px;font-size:14px;display:none}.gm-err.on{display:block}" +
    ".gm-top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px}.gm-pl{font-size:18px;font-weight:700}.gm-pl.me{color:#4ade80}.gm-score{font-size:30px;font-weight:800;letter-spacing:2px}.gm-timer{font:700 16px monospace;background:#0f172a;border:1.5px solid #334155;border-radius:10px;padding:6px 12px;display:inline-block}.gm-timer.ot{color:#fbbf24;border-color:#fbbf24}" +
    ".gm-board{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:min(340px,86vw);margin:14px auto}.gm-cell{aspect-ratio:1;border-radius:12px;border:2px solid #334155;background:#0f172a;color:#e2e8f0;font-size:min(14vw,58px);font-weight:800;cursor:pointer;line-height:1}.gm-cell:disabled{cursor:default}.gm-cell.X{color:#38bdf8}.gm-cell.O{color:#fb7185}.gm-cell.can:hover{background:#1e293b}" +
    ".gm-c4{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;width:min(440px,92vw);margin:14px auto;background:#1d4ed8;padding:10px;border-radius:14px}.gm-disc{aspect-ratio:1;border-radius:50%;border:0;background:#0f172a;cursor:pointer;padding:0}.gm-disc:disabled{cursor:default}.gm-disc.R{background:#ef4444}.gm-disc.Y{background:#facc15}.gm-disc.can:hover{background:#334155}.gm-disc.win{box-shadow:0 0 0 4px #fff inset}" +
    ".gm-rps{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin:14px 0}.gm-rpsb{width:min(30vw,130px);padding:14px 6px;border-radius:14px;border:2px solid #334155;background:#0f172a;color:#e2e8f0;cursor:pointer;font-size:14px;font-weight:700}.gm-rpsb span{display:block;font-size:44px;line-height:1.1;margin-bottom:4px}.gm-rpsb.can:hover{background:#334155}.gm-rpsb.mine{border-color:#4ade80}.gm-rpsb:disabled{cursor:default;opacity:.7}" +
    ".gm-status{text-align:center;font-size:17px;font-weight:700;min-height:26px;margin:6px 0}.gm-banner{text-align:center;font-size:15px;color:#fbbf24;min-height:20px}.gm-done{text-align:center}.gm-done h3{font-size:22px;margin:0 0 8px}.gm-center{text-align:center}";
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

  // ── talking to the server ──
  var errBox = null;
  function showErr(msg) { if (!errBox) return; errBox.textContent = msg || ""; errBox.classList.toggle("on", !!msg); }
  async function call(action, body, retried) {
    var id = me();
    if (!id) throw new Error("Log in to play.");
    var tok = await window.VUS_AUTH.loginToken(id, !!retried);
    if (!tok) throw new Error("Playing for crates needs a one-time password confirmation.");
    var r;
    try { r = await fetch(API + "/api/game", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify(Object.assign({ action: action }, body || {})) }); }
    catch (e) { throw new Error("Couldn't reach the game server. Check your connection."); }
    var text = await r.text(), j = null; try { j = JSON.parse(text); } catch (e) {}
    if (!j) throw new Error("The game server isn't answering properly (HTTP " + r.status + "). Open " + API + "/api/ping.");
    if (r.status === 401 && !retried && (j.code === "INVALID_TOKEN" || j.code === "MISSING_TOKEN")) return call(action, body, true);
    if (!j.ok) { var m = j.error || "Request failed."; if (j.hint) m += " " + j.hint; throw new Error(m); }
    return j;
  }
  async function sweep() { try { await fetch(API + "/api/game", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sweep" }) }); } catch (e) {} }

  // ── game state (live from the database) ──
  var games = {}, listenRef = null, myGid = "", beat = null, lastId = "", lastSig = "", myPicks = {};
  function db() { return chat().db ? chat().db() : null; }
  function startListening() {
    var d = db(); if (!d || listenRef) return;
    listenRef = d.ref("games");
    listenRef.on("value", function (s) { games = s.val() || {}; onGames(); }, function () {});
  }
  function findMine() {   // a game I'm still playing (finished ones stay on screen until I click back)
    var id = me(), found = "";
    Object.keys(games).forEach(function (k) {
      var g = games[k]; if (!g || !g.p || g.status === "done") return;
      if ((g.p.a && g.p.a.id === id) || (g.p.b && g.p.b.id === id)) found = k;
    });
    return found;
  }
  function onGames() {
    var mine = findMine();
    if (mine && mine !== myGid) { myGid = mine; startBeat(); }
    if (myGid && !games[myGid]) { myGid = ""; stopBeat(); }
    badge();
    if (!open) return;
    // only redraw when something you can see changed (the players' heartbeats change the data every few seconds)
    var g = myGid ? games[myGid] : null;
    var waiting = Object.keys(games).filter(function (k) { return games[k] && games[k].status === "waiting"; }).map(function (k) { return [k, games[k].type, games[k].bet, games[k].p && games[k].p.a && games[k].p.a.name]; });
    var sig = JSON.stringify([me(), stock(), myGid, g ? [g.status, g.board, g.turn, g.score, g.round, g.rn, g.picked, g.draws, g.result, g.overtime, g.deadline, g.lastRound, g.winCells, g.p] : waiting]);
    if (sig !== lastSig) { lastSig = sig; render(); }
  }
  function badge() { var g = games[myGid]; btn.style.color = g && g.status !== "done" ? "#4ade80" : ""; }
  // While you are in a game the server needs to hear from you every few seconds, even if you are looking at the chat.
  function startBeat() {
    stopBeat();
    beat = setInterval(function () {
      var g = games[myGid];
      if (!g || g.status === "done" || !me() || !window.VUS_AUTH || !window.VUS_AUTH.hasToken(me())) return;   // never pop up a password box for a heartbeat
      call("ping", { gid: myGid }).catch(function () {});
    }, 4000);
  }
  function stopBeat() { if (beat) clearInterval(beat); beat = null; }
  // Make sure we find a game we were already in (after a reload) even before the panel is opened.
  setInterval(function () {
    var id = me();
    if (!id) return;
    if (!listenRef) startListening();
    if (id !== lastId) { lastId = id; myGid = ""; stopBeat(); onGames(); }
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
    var g = myGid ? games[myGid] : null;
    if (g) renderGame(wrap, g); else renderLobby(wrap);
  }

  function renderLobby(wrap) {
    var have = stock(), opts = BETS.filter(function (b) { return b <= have; });   // only amounts you actually have
    if (opts.indexOf(picked) < 0) picked = opts.length ? opts[0] : 0;
    var c = el("div", "gm-card"); c.appendChild(el("h3", "", "Create a game"));
    var sel = document.createElement("select"); sel.style.cssText = "padding:8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1.5px solid #334155;font-size:15px";
    ORDER.forEach(function (k) { var o = document.createElement("option"); o.value = k; o.textContent = NAMES[k]; sel.appendChild(o); });
    sel.value = selGame; sel.onchange = function () { selGame = sel.value; render(); }; c.appendChild(sel);
    c.appendChild(el("div", "gm-note", RULES[selGame]));
    if (!opts.length) {
      c.appendChild(el("div", "gm-note", "You need at least 1 crate to play. A new crate can be earned every 3 hours by chatting."));
    } else {
      c.appendChild(el("div", "gm-note", "Pick how many crates to bet. The winner takes both bets. Leaving, or being disconnected for 15 seconds, gives your bet to the other player."));
      var bets = el("div", "gm-bets");
      opts.forEach(function (n) { var b = el("button", "gm-bet" + (n === picked ? " on" : ""), n + "x"); b.type = "button"; b.onclick = function () { picked = n; render(); }; bets.appendChild(b); });
      c.appendChild(bets);
      var go = el("button", "gm-btn p", "Create game (" + crates(picked) + ")"); go.type = "button"; go.disabled = busy;
      go.onclick = function () { act(function () { return call("create", { game: selGame, bet: picked }); }); };
      c.appendChild(go);
    }
    wrap.appendChild(c);

    var open2 = Object.keys(games).map(function (k) { return [k, games[k]]; }).filter(function (p) { return p[1] && p[1].status === "waiting" && p[1].p && p[1].p.a; }).sort(function (a, b) { return (b[1].created || 0) - (a[1].created || 0); });
    var l = el("div", "gm-card"); l.appendChild(el("h3", "", "Open games"));
    if (!open2.length) l.appendChild(el("div", "gm-note", "No open games right now. Create one and wait for someone to join."));
    open2.forEach(function (p) {
      var gg = p[1], row = el("div", "gm-row"), info = el("div", "grow");
      info.appendChild(el("b", "", gg.p.a.name)); info.appendChild(el("span", "", (NAMES[gg.type] || "Game") + " \u00B7 bet " + gg.bet + "x (" + crates(gg.bet) + ")"));
      var j = el("button", "gm-btn p", have >= gg.bet ? "Join" : "Need " + gg.bet); j.type = "button"; j.disabled = busy || have < gg.bet;
      j.onclick = function () { act(function () { return call("join", { gid: p[0] }); }); };
      row.append(info, j); l.appendChild(row);
    });
    wrap.appendChild(l);
  }

  async function act(fn) {
    if (busy) return; busy = true; showErr(""); render();
    try { var r = await fn(); if (r && r.gid) { myGid = r.gid; startBeat(); } }
    catch (e) { busy = false; render(); showErr(e.message || "Something went wrong."); return; }
    busy = false; render();
  }

  function fmt(ms) { ms = Math.max(0, ms); var s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
  var timerEl = null;
  var ICON = { rock: "\u270A", paper: "\u270B", scissors: "\u270C\uFE0F" }, LABEL = { rock: "Rock", paper: "Paper", scissors: "Scissors" };

  function tttBoard(g, mineTurn, live) {
    var board = el("div", "gm-board");
    for (var i = 0; i < 9; i++) (function (i) {
      var v = g.board[i], c = el("button", "gm-cell" + (v !== "_" ? " " + v : "") + (live && mineTurn && v === "_" ? " can" : ""), v === "_" ? "" : v);
      c.type = "button"; c.disabled = !live || !mineTurn || v !== "_" || busy;
      c.onclick = function () { act(function () { return call("move", { gid: myGid, cell: i }); }); };
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
      d.onclick = function () { act(function () { return call("move", { gid: myGid, col: col }); }); };
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
    mid.appendChild(el("div", "gm-note", (NAMES[type] || "Game") + " \u00B7 bet " + g.bet + "x each \u00B7 pot " + crates(g.bet * 2)));
    var right = el("div"); right.style.textAlign = "right"; right.appendChild(el("div", "gm-pl", g.p[opp] ? g.p[opp].name : "Waiting\u2026"));
    top.append(left, mid, right); wrap.appendChild(top);

    var card = el("div", "gm-card");
    if (g.status === "waiting") {
      card.appendChild(el("div", "gm-status", "Waiting for someone to join\u2026"));
      card.appendChild(el("div", "gm-note gm-center", "Your bet of " + crates(g.bet) + " is held until the game ends. Keep this tab open. Cancelling gives it back."));
      var cancel = el("button", "gm-btn d", "Cancel game"); cancel.type = "button"; var cw = el("div", "gm-center"); cw.appendChild(cancel); card.appendChild(cw);
      cancel.onclick = function () { act(function () { return call("leave", { gid: myGid }); }); };
    } else if (g.status === "playing") {
      timerEl = el("div", "gm-timer"); var tw = el("div", "gm-center"); tw.appendChild(timerEl); card.appendChild(tw);
      var oppName = g.p[opp].name, lr = g.lastRound, banner = "";
      if (type === "rps") {
        var mine = g.picked && g.picked[side], oppPicked = g.picked && g.picked[opp], mineChoice = myPicks[myGid + ":" + g.rn];
        card.appendChild(el("div", "gm-status", mine ? "Locked in! Waiting for " + oppName + "\u2026" : oppPicked ? oppName + " has picked. Your turn!" : "Pick one!"));
        var row = el("div", "gm-rps");
        ["rock", "paper", "scissors"].forEach(function (p) {
          var b = el("button", "gm-rpsb" + (!mine ? " can" : "") + (mine && mineChoice === p ? " mine" : "")); b.type = "button"; b.disabled = !!mine || busy;
          b.appendChild(el("span", "", ICON[p])); b.appendChild(document.createTextNode(LABEL[p]));
          b.onclick = function () { myPicks[myGid + ":" + g.rn] = p; act(function () { return call("move", { gid: myGid, pick: p }); }); };
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
      lv.onclick = function () { if (confirm("Leave this game? Your bet of " + crates(g.bet) + " goes to " + oppName + ".")) act(function () { return call("leave", { gid: myGid }); }); };
      paintTimer(g);
    } else {   // done
      var r = g.result || {}, won = r.winner === side, refund = !r.winner;
      var d = el("div", "gm-done");
      d.appendChild(el("h3", "", refund ? "\uD83D\uDD01 Refunded" : won ? "\uD83C\uDF89 You won " + crates(g.bet * 2) + "!" : "You lost " + crates(g.bet)));
      d.appendChild(el("div", "gm-note", r.msg || "The game ended."));
      if (type === "rps" && g.lastRound && g.lastRound.a) d.appendChild(el("div", "gm-banner", "Final round: you " + ICON[g.lastRound[side]] + " vs " + g.p[opp].name + " " + ICON[g.lastRound[opp]]));
      if (type === "c4" && g.board) d.appendChild(c4Board(g, false, false));
      if (type === "ttt" && g.board) d.appendChild(tttBoard(g, false, false));
      var back = el("button", "gm-btn p", "Back to games"); back.type = "button"; back.onclick = function () { myGid = ""; stopBeat(); showErr(""); lastSig = ""; render(); };
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
  setInterval(function () { var g = games[myGid]; if (open && g && g.status === "playing") paintTimer(g); }, 500);

  // A finished result should also be noticed when the panel is closed.
  var shown = {};
  setInterval(function () {
    var g = games[myGid]; if (!g || g.status !== "done" || shown[myGid] || open) return;
    shown[myGid] = true; btn.style.color = "#fbbf24"; btn.title = "Games: your game ended. Click to see the result.";
  }, 1500);
})();
