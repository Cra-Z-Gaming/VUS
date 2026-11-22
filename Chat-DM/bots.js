/* VUS practice bots for the Games panel: Tic-Tac-Toe, Rock Paper Scissors, Connect 4, Checkers, Chess.
   games.js loads this file the first time someone starts a practice game. It needs window.VUS_GAMES.E (the rule engines inside games.js).
   Each bot is a plain function: give it the position, get a move back. Levels: 0 = Easy, 1 = Normal, 2 = Hard. Nothing here touches the database. */
(function () {
  "use strict";
  var E = window.VUS_GAMES && window.VUS_GAMES.E;
  if (!E) return;
  var INF = 1e9, MATE = 100000, BOTS = {};
  function rnd(n) { return Math.floor(Math.random() * n); }
  function pickOne(a) { return a[rnd(a.length)]; }
  function clock() { return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(); }

  // ── Tic-Tac-Toe ── board = 9 chars of X / O / _ ; mark = the bot's mark. Returns a cell 0-8 (or -1 if the board is full).
  function tttScores(board, mark) {   // value of every empty cell for the bot with perfect play afterwards: +1 win, 0 draw, -1 loss
    var foe = mark === "X" ? "O" : "X", memo = {}, out = {}, i;
    function val(b, turn) {
      var w = E.lineWinner(b); if (w) return w === mark ? 1 : -1;
      if (b.indexOf("_") < 0) return 0;
      var key = b + turn, m = memo[key]; if (m !== undefined) return m;
      var best = turn === mark ? -2 : 2, v, j;
      for (j = 0; j < 9; j++) if (b[j] === "_") {
        v = val(b.slice(0, j) + turn + b.slice(j + 1), turn === mark ? foe : mark);
        if (turn === mark ? v > best : v < best) best = v;
      }
      memo[key] = best; return best;
    }
    for (i = 0; i < 9; i++) if (board[i] === "_") out[i] = val(board.slice(0, i) + mark + board.slice(i + 1), foe);
    return out;
  }
  function ttt(board, mark, lvl) {
    var sc = tttScores(board, mark), cells = Object.keys(sc).map(Number), foe = mark === "X" ? "O" : "X", win = [], block = [];
    if (!cells.length) return -1;
    cells.forEach(function (i) {
      if (E.lineWinner(board.slice(0, i) + mark + board.slice(i + 1)) === mark) win.push(i);
      if (E.lineWinner(board.slice(0, i) + foe + board.slice(i + 1)) === foe) block.push(i);
    });
    if (lvl === 0) {   // Easy: usually spots a win, sometimes a block, otherwise plays anywhere
      if (win.length && Math.random() < 0.7) return pickOne(win);
      if (block.length && Math.random() < 0.5) return pickOne(block);
      return pickOne(cells);
    }
    if (lvl === 1 && Math.random() < 0.35) return pickOne(cells);   // Normal: plays perfectly most of the time, slips now and then
    var top = Math.max.apply(null, cells.map(function (i) { return sc[i]; }));
    return pickOne(cells.filter(function (i) { return sc[i] === top; }));
  }
  BOTS.ttt = ttt;

  // ── Rock Paper Scissors ── hist = the finished rounds so far, each { me: pick, foe: pick } from the bot's point of view. Returns "rock" | "paper" | "scissors".
  var RPS = ["rock", "paper", "scissors"], BEAT = { rock: "paper", paper: "scissors", scissors: "rock" };   // BEAT[x] = the pick that beats x
  function favourite(cnt) {   // the one pick that was played most, or null when nothing stands out
    var top = Math.max(cnt.rock, cnt.paper, cnt.scissors), c = RPS.filter(function (p) { return cnt[p] === top; });
    return top > 0 && c.length === 1 ? c[0] : null;
  }
  function rps(hist, lvl) {
    var n = hist.length, guess = null, cnt, i, last;
    if (lvl === 0 || n === 0) return pickOne(RPS);
    last = hist[n - 1];
    if (lvl === 2 && n >= 2) {   // Hard: what did they play the last time the same pair of picks came up?
      cnt = { rock: 0, paper: 0, scissors: 0 };
      for (i = 0; i < n - 1; i++) if (hist[i].me === last.me && hist[i].foe === last.foe) cnt[hist[i + 1].foe]++;
      guess = favourite(cnt);
    }
    if (!guess) { cnt = { rock: 0, paper: 0, scissors: 0 }; hist.forEach(function (h) { cnt[h.foe]++; }); guess = favourite(cnt); }
    if (!guess && lvl === 2) guess = BEAT[last.me];   // people often answer the bot's last pick with whatever beats it
    if (!guess) return pickOne(RPS);
    return Math.random() < (lvl === 2 ? 0.75 : 0.4) ? BEAT[guess] : pickOne(RPS);
  }
  BOTS.rps = rps;

  // ── Connect 4 ── board = 42 chars of R / Y / _ (row 0 on top, index = row * 7 + column); mark = the bot's colour. Returns a column 0-6 (or -1 if the board is full).
  var C4_ORDER = [3, 2, 4, 1, 5, 0, 6], C4_DR = [0, 1, 1, 1], C4_DC = [1, 0, 1, -1];
  var C4_LINES = (function () {   // every line of four cells on the board (69 of them)
    var out = [], r, c, d;
    function line(r0, c0, d0) { return [0, 1, 2, 3].map(function (k) { return (r0 + k * C4_DR[d0]) * 7 + c0 + k * C4_DC[d0]; }); }
    for (r = 0; r < 6; r++) for (c = 0; c < 7; c++) for (d = 0; d < 4; d++) {
      var r2 = r + 3 * C4_DR[d], c2 = c + 3 * C4_DC[d];
      if (r2 <= 5 && c2 >= 0 && c2 <= 6) out.push(line(r, c, d));
    }
    return out;
  })();
  function c4(board, mark, lvl) {
    var b = new Int8Array(42), free = [0, 0, 0, 0, 0, 0, 0], i, c, r, nodes = 0, stop = false, deadline = INF, t0 = clock();
    for (i = 0; i < 42; i++) b[i] = board[i] === "_" ? 0 : board[i] === mark ? 1 : -1;
    for (c = 0; c < 7; c++) { free[c] = -1; for (r = 5; r >= 0; r--) if (b[r * 7 + c] === 0) { free[c] = r; break; } }   // free[c] = row where the next disc lands
    var open = C4_ORDER.filter(function (x) { return free[x] >= 0; });
    if (!open.length) return -1;
    function four(idx, col) {   // does the disc just placed on idx complete four in a row?
      var r0 = (idx / 7) | 0, c0 = idx % 7, d, n, rr, cc;
      for (d = 0; d < 4; d++) {
        n = 1; rr = r0 + C4_DR[d]; cc = c0 + C4_DC[d];
        while (rr >= 0 && rr < 6 && cc >= 0 && cc < 7 && b[rr * 7 + cc] === col) { n++; rr += C4_DR[d]; cc += C4_DC[d]; }
        rr = r0 - C4_DR[d]; cc = c0 - C4_DC[d];
        while (rr >= 0 && rr < 6 && cc >= 0 && cc < 7 && b[rr * 7 + cc] === col) { n++; rr -= C4_DR[d]; cc -= C4_DC[d]; }
        if (n >= 4) return true;
      }
      return false;
    }
    function ev() {   // how good the position is for the bot: open lines of 2 and 3 count, the middle column helps
      var s = 0, w, k, L, m, o, v, q;
      for (w = 0; w < C4_LINES.length; w++) {
        L = C4_LINES[w]; m = 0; o = 0;
        for (k = 0; k < 4; k++) { v = b[L[k]]; if (v === 1) m++; else if (v === -1) o++; }
        if (!o) s += m === 3 ? 8 : m === 2 ? 2 : 0; else if (!m) s -= o === 3 ? 8 : o === 2 ? 2 : 0;
      }
      for (q = 0; q < 6; q++) s += 3 * b[q * 7 + 3];
      return s;
    }
    function nm(depth, alpha, beta, color, ply) {   // value for the player `color` who is to move
      if ((++nodes & 255) === 0 && clock() > deadline) stop = true;
      if (stop) return 0;
      var best = -INF, any = false, k, cc, rr, idx, v;
      for (k = 0; k < 7; k++) {
        cc = C4_ORDER[k]; rr = free[cc]; if (rr < 0) continue;
        any = true; idx = rr * 7 + cc; b[idx] = color; free[cc]--;
        v = four(idx, color) ? MATE - ply : depth <= 1 ? color * ev() : -nm(depth - 1, -beta, -alpha, -color, ply + 1);
        free[cc]++; b[idx] = 0;
        if (stop) return 0;
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
      }
      return any ? best : 0;
    }
    var maxD = [2, 5, 12][lvl], ms = [60, 250, 900][lvl], scores = {}, d, k, cc, idx, v, cur, vals, mx;
    if (lvl === 0) {   // Easy: usually takes a win, often blocks, sometimes just drops a disc anywhere
      for (k = 0; k < open.length; k++) { cc = open[k]; idx = free[cc] * 7 + cc; b[idx] = 1; v = four(idx, 1); b[idx] = 0; if (v && Math.random() < 0.8) return cc; }
      for (k = 0; k < open.length; k++) { cc = open[k]; idx = free[cc] * 7 + cc; b[idx] = -1; v = four(idx, -1); b[idx] = 0; if (v && Math.random() < 0.6) return cc; }
      if (Math.random() < 0.3) return pickOne(open);
    }
    for (d = 1; d <= maxD; d++) {   // look 1 move ahead, then 2, 3 ... until the time budget runs out; keep the last complete answer
      deadline = d === 1 ? INF : t0 + ms; cur = {};
      for (k = 0; k < open.length; k++) {
        cc = open[k]; idx = free[cc] * 7 + cc; b[idx] = 1; free[cc]--;
        v = four(idx, 1) ? MATE : d <= 1 ? ev() : -nm(d - 1, -INF, INF, -1, 1);
        free[cc]++; b[idx] = 0;
        if (stop) break;
        cur[cc] = v;
      }
      if (stop) break;
      scores = cur;
      vals = open.map(function (x) { return cur[x]; }); mx = Math.max.apply(null, vals);
      if (mx >= MATE - 100 || mx <= 100 - MATE) break;   // a forced win or a forced loss: looking deeper changes nothing
    }
    var keys = open.filter(function (x) { return scores[x] !== undefined; });
    if (!keys.length) return pickOne(open);
    var top = Math.max.apply(null, keys.map(function (x) { return scores[x]; })), margin = lvl === 2 ? 0 : lvl === 1 ? 10 : 40;
    return pickOne(keys.filter(function (x) { return scores[x] >= top - margin; }));
  }
  BOTS.c4 = c4;

  /*@@NEXT@@*/
  window.VUS_BOTS = BOTS;
})();
