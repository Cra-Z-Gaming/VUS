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

  // ── Checkers ── board = 64 chars (same layout as games.js); side = the bot's side ("a" or "b"); chain = the square of a jump the bot may keep going with, or -1.
  // Returns the move to play (an object from E.ckMoves: use .f and .t), or null = "stop jumping and end the turn" (also null when there is no move at all).
  function ckEval(board, side) {   // how good the position is for `side`: pieces count most, men gain value as they advance, kings like the middle
    var s = 0, i, ch, sd, r, c, v, adv;
    for (i = 0; i < 64; i++) {
      ch = board[i]; if (ch === "_") continue;
      sd = ch === "a" || ch === "A" ? "a" : "b"; r = i >> 3; c = i & 7;
      if (ch !== ch.toLowerCase()) v = 170 - 2 * (Math.abs(r - 3.5) + Math.abs(c - 3.5));
      else { adv = sd === "a" ? 7 - r : r; v = 100 + 5 * adv + (adv === 0 ? 10 : 0) + (c === 0 || c === 7 ? 3 : 0); }
      s += sd === side ? v : -v;
    }
    return s;
  }
  function ck(board, side, chain, lvl) {
    var foe = side === "a" ? "b" : "a", nodes = 0, stop = false, deadline = INF, t0 = clock();
    function search(bd, sd, ch, depth, alpha, beta, ply) {   // value for the side to move (sd); ch >= 0 means sd is in the middle of a jump chain
      if ((++nodes & 255) === 0 && clock() > deadline) stop = true;
      if (stop) return 0;
      var fo = sd === "a" ? "b" : "a", moves = E.ckMoves(bd, sd, ch), best = -INF, i, m, r, v;
      if (ch < 0 && !moves.length) return -(MATE - ply);   // nothing left to move: the other side has won
      if (ply > 50) return ckEval(bd, sd);
      if (ch < 0 && depth <= 0) {   // out of depth: keep looking only while captures are possible (taking is optional, so standing still is allowed)
        best = ckEval(bd, sd);
        moves = moves.filter(function (x) { return x.x >= 0; });
        if (!moves.length || best >= beta) return best;
        if (best > alpha) alpha = best;
      } else if (moves.length > 1) {   // look at captures first
        moves = moves.filter(function (x) { return x.x >= 0; }).concat(moves.filter(function (x) { return x.x < 0; }));
      }
      for (i = 0; i < moves.length; i++) {
        m = moves[i]; r = E.ckApply(bd, m);
        v = r.chain >= 0 ? search(r.board, sd, r.chain, depth, alpha, beta, ply + 1) : -search(r.board, fo, -1, depth - 1, -beta, -alpha, ply + 1);
        if (stop) return 0;
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) return best;
      }
      if (ch >= 0) {   // after a jump you may also stop
        v = -search(bd, fo, -1, depth - 1, -beta, -alpha, ply + 1);
        if (stop) return 0;
        if (v > best) best = v;
      }
      return best;
    }
    function rootVal(m, dd) {
      var r;
      if (m === null) return -search(board, foe, -1, dd - 1, -INF, INF, 1);
      r = E.ckApply(board, m);
      return r.chain >= 0 ? search(r.board, side, r.chain, dd, -INF, INF, 1) : -search(r.board, foe, -1, dd - 1, -INF, INF, 1);
    }
    var cand = E.ckMoves(board, side, chain), scores = null, maxD = [2, 6, 16][lvl], ms = [40, 250, 900][lvl], margin = [60, 15, 0][lvl], d, k, v, cur, pairs, opts, top, i;
    if (chain >= 0) cand.push(null);
    if (!cand.length) return null;
    if (cand.length === 1) return cand[0];
    for (d = 1; d <= maxD; d++) {   // look 1 move ahead, then 2, 3 ... until the time budget runs out; keep the last complete answer
      deadline = d === 1 ? INF : t0 + ms; cur = [];
      for (k = 0; k < cand.length; k++) { v = rootVal(cand[k], d); if (stop) break; cur.push(v); }
      if (stop) break;
      pairs = cand.map(function (m, j) { return { m: m, v: cur[j] }; }).sort(function (x, y) { return y.v - x.v; });   // best first, so the next round starts with the likely best move
      cand = pairs.map(function (p) { return p.m; }); scores = pairs.map(function (p) { return p.v; });
      if (Math.abs(scores[0]) >= MATE - 100) break;   // a forced win or a forced loss: looking deeper changes nothing
    }
    top = scores[0]; opts = [];
    for (i = 0; i < cand.length; i++) if (scores[i] >= top - margin) opts.push(cand[i]);
    if (lvl === 0 && Math.random() < 0.25) return pickOne(cand);   // Easy: now and then just plays something
    return pickOne(opts);
  }
  BOTS.ck = ck;

  // ── Chess ── S = a position { board, cast, ep, half } exactly as games.js uses it; col = the bot's colour ("w" or "b");
  // hist = how often each position has already come up in the game ({ chKey: count }, {} is fine); lvl 0/1/2.
  // Returns the move to play (an object from E.chLegal: use .f .t .p), or null when there is no legal move.
  var CH_VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  var CH_PST = {   // piece-square tables from White's point of view (row 0 = rank 8); Black reads them mirrored top-to-bottom. e = king in the endgame
    p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
    n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
    b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
    r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
    q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
    k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
    e: [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50]
  };
  var CH_LINES = ["e2e4 e7e5 g1f3 b8c6 f1b5 a7a6", "e2e4 e7e5 g1f3 b8c6 f1c4 g8f6", "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6", "e2e4 e7e6 d2d4 d7d5 b1c3 g8f6", "e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5",
    "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6", "d2d4 g8f6 c2c4 e7e6 g1f3 d7d5", "d2d4 d7d5 g1f3 g8f6 c1f4 e7e6", "g1f3 d7d5 d2d4 g8f6 c2c4 e7e6", "c2c4 e7e5 b1c3 g8f6 g2g3 d7d5"];
  var CH_BOOK = null;
  function chBook(S, col) {   // a few well-known opening lines, so the bot does not open the same way every time; null once the game leaves them
    var list;
    if (!CH_BOOK) {
      CH_BOOK = {};
      CH_LINES.forEach(function (line) {
        var P = { board: E.CH_START, cast: "KQkq", ep: -1, half: 0 }, c = "w", ok = true;
        line.split(" ").forEach(function (s) {
          if (!ok) return;
          var f = (8 - +s[1]) * 8 + s.charCodeAt(0) - 97, t = (8 - +s[3]) * 8 + s.charCodeAt(2) - 97, m = E.chFind(P, c, f, t, ""), key = E.chKey(P, c), pair = f + "," + t;
          if (!m) { ok = false; return; }
          if (!CH_BOOK[key]) CH_BOOK[key] = [];
          if (CH_BOOK[key].indexOf(pair) < 0) CH_BOOK[key].push(pair);
          P = E.chApply(P, m); c = c === "w" ? "b" : "w";
        });
      });
    }
    list = CH_BOOK[E.chKey(S, col)];
    if (!list) return null;
    list = pickOne(list).split(",");
    return E.chFind(S, col, +list[0], +list[1], "");
  }
  function chEval(b, col) {   // how good the board is for `col`, in centipawns (100 = one pawn)
    var s = 0, i, ch, t, w, r, c, ix, np = 0, pawns = 0, rq = 0, minors = 0, wk = 0, bk = 0, wm = 0, bm = 0, endg, strongW, sk, lk, bonus;
    for (i = 0; i < 64; i++) {
      ch = b[i]; if (ch === "_") continue;
      t = ch.toLowerCase(); w = ch !== t; r = i >> 3; c = i & 7;
      if (t === "k") { if (w) wk = i; else bk = i; continue; }
      ix = w ? i : (7 - r) * 8 + c;
      if (w) { s += CH_VAL[t] + CH_PST[t][ix]; wm += CH_VAL[t]; } else { s -= CH_VAL[t] + CH_PST[t][ix]; bm += CH_VAL[t]; }
      if (t === "p") pawns++; else { np += CH_VAL[t]; if (t === "n" || t === "b") minors++; else rq++; }
    }
    if (!pawns && !rq && minors <= 1) return 0;   // too little left to ever checkmate
    endg = np <= 2600;
    s += (endg ? CH_PST.e : CH_PST.k)[wk] - (endg ? CH_PST.e : CH_PST.k)[(7 - (bk >> 3)) * 8 + (bk & 7)];
    if (endg && Math.abs(wm - bm) >= 300) {   // far ahead in the endgame: drive the lone king to the edge and bring the own king close, so the bot can really finish the game
      strongW = wm > bm; sk = strongW ? wk : bk; lk = strongW ? bk : wk;
      bonus = 10 * (Math.abs((lk >> 3) - 3.5) + Math.abs((lk & 7) - 3.5)) + 4 * (14 - Math.abs((sk >> 3) - (lk >> 3)) - Math.abs((sk & 7) - (lk & 7)));
      s += strongW ? bonus : -bonus;
    }
    return col === "w" ? s : -s;
  }
  function ch(S, col, hist, lvl) {
    var other = col === "w" ? "b" : "w", nodes = 0, stop = false, deadline = INF, t0 = clock(), path = [], killers = [], hh = [], i;
    hist = hist || {};
    for (i = 0; i < 4096; i++) hh[i] = 0;
    function order(P, ps, kl) {   // sort score for every move: captures (big victim, small attacker) first, then promotions, killer moves, then moves that worked before
      var j, m, cap, idx;
      for (j = 0; j < ps.length; j++) {
        m = ps[j]; cap = P.board[m.t]; idx = m.f * 64 + m.t;
        if (cap !== "_" || m.e) m.sc = 100000 + (cap === "_" ? 100 : CH_VAL[cap.toLowerCase()]) * 16 - CH_VAL[P.board[m.f].toLowerCase()];
        else if (m.p) m.sc = 90000 + (m.p === "q" ? 800 : 0);
        else if (kl && idx === kl[0]) m.sc = 80000;
        else if (kl && idx === kl[1]) m.sc = 79000;
        else m.sc = hh[idx];
      }
      ps.sort(function (x, y) { return y.sc - x.sc; });
    }
    function qs(P, c, alpha, beta, ply) {   // quiet search: after the set depth, keep looking only at captures so the bot does not stop in the middle of a trade
      if ((++nodes & 255) === 0 && clock() > deadline) stop = true;
      if (stop) return 0;
      var o = c === "w" ? "b" : "w", stand = chEval(P.board, c), best = stand, ps, j, m, nb, v, vic;
      if (stand >= beta || ply > 40) return stand;
      if (stand > alpha) alpha = stand;
      ps = E.chPseudo(P, c); order(P, ps, null);
      for (j = 0; j < ps.length; j++) {
        m = ps[j]; if (m.sc < 90000) break;
        if (m.p && m.p !== "q") continue;
        vic = P.board[m.t] === "_" ? 100 : CH_VAL[P.board[m.t].toLowerCase()];
        if (!m.p && stand + vic + 200 < alpha) continue;   // cannot catch up even after winning this piece
        nb = E.chApply(P, m); if (E.chInCheck(nb, c)) continue;
        v = -qs(nb, o, -beta, -alpha, ply + 1);
        if (stop) return 0;
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
      }
      return best;
    }
    function search(P, c, depth, alpha, beta, ply) {   // value for the side to move (c)
      if ((++nodes & 255) === 0 && clock() > deadline) stop = true;
      if (stop) return 0;
      var o = c === "w" ? "b" : "w", inChk = E.chInCheck(P, c), ps, j, m, nb, v, best = -INF, legal = 0, key, kl, idx, quiet, pushed = false;
      if (P.half >= 100) return 0;   // 50-move rule
      if (P.half >= 4) {   // a position that already came up twice in the game, or earlier on this line, counts as a draw
        key = E.chKey(P, c);
        if ((hist[key] || 0) >= 2 || path.indexOf(key) >= 0) return 0;
        path.push(key); pushed = true;
      }
      if (inChk && ply < 40) depth++;   // when in check look one move deeper
      if (depth <= 0) { v = qs(P, c, alpha, beta, ply); if (pushed) path.pop(); return v; }
      kl = killers[ply] || (killers[ply] = [-1, -1]);
      ps = E.chPseudo(P, c); order(P, ps, kl);
      for (j = 0; j < ps.length; j++) {
        m = ps[j]; nb = E.chApply(P, m);
        if (E.chInCheck(nb, c)) continue;
        legal++;
        quiet = P.board[m.t] === "_" && !m.e && !m.p;
        if (legal > 4 && depth >= 3 && quiet && !inChk && m.sc < 70000) {   // late quiet moves are first looked at a bit less deeply
          v = -search(nb, o, depth - 2, -alpha - 1, -alpha, ply + 1);
          if (v > alpha && !stop) v = -search(nb, o, depth - 1, -beta, -alpha, ply + 1);
        } else v = -search(nb, o, depth - 1, -beta, -alpha, ply + 1);
        if (stop) return 0;
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) {
          if (quiet) { idx = m.f * 64 + m.t; if (kl[0] !== idx) { kl[1] = kl[0]; kl[0] = idx; } hh[idx] = Math.min(50000, hh[idx] + depth * depth); }
          break;
        }
      }
      if (!legal) best = inChk ? -(MATE - ply) : 0;   // checkmate, or stalemate
      if (pushed) path.pop();
      return best;
    }
    var cands = E.chLegal(S, col), scores = null, maxD = [2, 4, 9][lvl], ms = [120, 600, 1500][lvl], margin = [150, 25, 0][lvl], d, k, v, top, lo, cur, pairs, opts, pick;
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    pick = chBook(S, col); if (pick) return pick;
    if (lvl === 0 && Math.random() < 0.2) return pickOne(cands);   // Easy: now and then just plays something
    order(S, cands, null); path.push(E.chKey(S, col));
    for (d = 1; d <= maxD; d++) {   // look 1 move ahead, then 2, 3 ... until the time budget runs out; the last complete round decides
      deadline = d <= 2 ? INF : t0 + ms; cur = []; top = -INF;
      for (k = 0; k < cands.length; k++) {
        lo = k === 0 ? -INF : top - margin - 1;   // only moves that could land within `margin` of the best need an exact value
        v = -search(E.chApply(S, cands[k]), other, d - 1, -INF, -lo, 1);
        if (stop) break;
        cur.push(v); if (v > top) top = v;
      }
      if (stop) break;
      pairs = cands.map(function (m, j) { return { m: m, v: cur[j] }; }).sort(function (x, y) { return y.v - x.v; });   // best first, so the next round starts with the likely best move
      cands = pairs.map(function (p) { return p.m; }); scores = pairs.map(function (p) { return p.v; });
      if (Math.abs(scores[0]) >= MATE - 100) break;   // a forced mate (for or against): looking deeper changes nothing
    }
    top = scores[0]; opts = [];
    for (k = 0; k < cands.length; k++) if (scores[k] >= top - margin) opts.push(cands[k]);
    pick = pickOne(opts);
    return E.chFind(S, col, pick.f, pick.t, pick.p || "q") || pick;
  }
  BOTS.ch = ch;

  /*@@NEXT@@*/
  window.VUS_BOTS = BOTS;
})();
