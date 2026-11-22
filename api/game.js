// POST /api/game   Authorization: Bearer <login token>   { action, ... }
// The server runs every game, so nobody can fake a win, a move, or a bet. Bets are held in escrow:
// crates are taken from each player when they create/join, and paid out when the match ends.
//   create { game:"ttt"|"rps"|"c4"|"ck"|"ch", bet, opt }   (opt is only for chess: { tm: seconds each, pm: seconds per move or 0, c: "white"|"black"|"random" })   join { gid }   move { gid, cell | col | pick | from+to }   stop { gid }   ping { gid }   leave { gid }   sweep {}
// Game state lives in games/<gid> (public read, only this server can write). Crates are crateClaims/<id>.n.
// Rock-Paper-Scissors picks are kept secret in gamePicks/<gid> (nobody can read it) until both players have picked.
const { admin, chatDb, fail, cors, readBody, accountById, verifyLogin } = require("./_lib");

const GAMES = {
  ttt: { name: "Tic-Tac-Toe", win: 2, ms: 5 * 60 * 1000, extra: 3 * 60 * 1000 },      // first to 2 rounds
  rps: { name: "Rock Paper Scissors", win: 2, ms: 3 * 60 * 1000, extra: 2 * 60 * 1000 },   // first to 2 rounds
  c4:  { name: "Connect 4", win: 1, ms: 8 * 60 * 1000, extra: 3 * 60 * 1000 },         // one game
  ck:  { name: "Checkers", win: 1, ms: 10 * 60 * 1000, extra: 3 * 60 * 1000 },   // one game; when time is up the side with more pieces wins
  ch:  { name: "Chess", win: 1, ms: 0, extra: 0 }   // one game; no overall timer: each player has a clock (g.clock) and the host may set a per-move limit (g.pm)
};
const BETS = [1, 2, 3, 5, 10];
const GRACE = 15000;                 // a player who is silent this long has disconnected
const WAIT_STALE = 30000;            // an open game whose host went away is cancelled
const KEEP_DONE = 10 * 60 * 1000;
const EMPTY9 = "_________", EMPTY42 = "_".repeat(42);
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const PICKS = ["rock", "paper", "scissors"], BEATS = { rock: "scissors", scissors: "paper", paper: "rock" };

const other = (s) => (s === "a" ? "b" : "a");
const nameOf = (g, s) => (g.p && g.p[s] && g.p[s].name) || "Player";
function lineWinner(board) {
  for (const [a, b, c] of LINES) if (board[a] !== "_" && board[a] === board[b] && board[a] === board[c]) return board[a];
  return null;
}
// Connect 4: the cells of a line of 4+ through the piece just placed at idx (7 columns x 6 rows), or null.
function c4Win(board, idx) {
  const r0 = Math.floor(idx / 7), c0 = idx % 7, m = board[idx];
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const cells = [idx];
    for (const s of [1, -1]) {
      let r = r0 + dr * s, c = c0 + dc * s;
      while (r >= 0 && r < 6 && c >= 0 && c < 7 && board[r * 7 + c] === m) { cells.push(r * 7 + c); r += dr * s; c += dc * s; }
    }
    if (cells.length >= 4) return cells;
  }
  return null;
}
  // ── Checkers (8x8) ──
  // The board is 64 characters, index = row*8 + col, row 0 is the top. Only the dark squares ((row+col) odd) are used.
  // "_" empty, "a"/"b" = a man of side a / b, "A"/"B" = a king. Side a (red) starts at the bottom and moves up, side b (black) starts at the top and moves down.
  // Men step 1 square diagonally forward and may only go backward by JUMPING (capturing). Kings step or jump 1 square in any diagonal direction.
  // Jumping is never forced, and after a jump the same piece may keep jumping or stop. Reaching the far row crowns a man and ends the turn.
  var CK_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var CK_START = (function () { var s = ""; for (var i = 0; i < 64; i++) { var r = i >> 3; s += ((r + (i & 7)) % 2 === 1 && r !== 3 && r !== 4) ? (r < 3 ? "b" : "a") : "_"; } return s; })();
  function ckSide(ch) { return ch === "a" || ch === "A" ? "a" : ch === "b" || ch === "B" ? "b" : null; }
  function ckJumpsFrom(board, i) {   // every capture the piece on square i could make (any direction, for men and kings)
    var side = ckSide(board[i]), out = [], r = i >> 3, c = i & 7;
    if (!side) return out;
    CK_DIRS.forEach(function (d) {
      var r2 = r + 2 * d[0], c2 = c + 2 * d[1];
      if (r2 < 0 || r2 > 7 || c2 < 0 || c2 > 7) return;
      var x = (r + d[0]) * 8 + c + d[1], t = r2 * 8 + c2, mid = board[x];
      if (board[t] === "_" && mid !== "_" && ckSide(mid) !== side) out.push({ f: i, t: t, x: x });
    });
    return out;
  }
  function ckStepsFrom(board, i) {   // plain one-square moves (men: forward only)
    var ch = board[i], side = ckSide(ch), out = [], r = i >> 3, c = i & 7;
    if (!side) return out;
    var king = ch !== ch.toLowerCase(), fwd = side === "a" ? -1 : 1;
    CK_DIRS.forEach(function (d) {
      if (!king && d[0] !== fwd) return;
      var r1 = r + d[0], c1 = c + d[1];
      if (r1 < 0 || r1 > 7 || c1 < 0 || c1 > 7 || board[r1 * 8 + c1] !== "_") return;
      out.push({ f: i, t: r1 * 8 + c1, x: -1 });
    });
    return out;
  }
  function ckMoves(board, side, chain) {   // all legal moves for a side; while a jump chain is open (chain >= 0) only that piece's jumps
    if (chain >= 0) return ckSide(board[chain]) === side ? ckJumpsFrom(board, chain) : [];
    var out = [];
    for (var i = 0; i < 64; i++) if (ckSide(board[i]) === side) out = out.concat(ckJumpsFrom(board, i), ckStepsFrom(board, i));
    return out;
  }
  function ckFind(board, side, chain, f, t) { var m = ckMoves(board, side, chain); for (var i = 0; i < m.length; i++) if (m[i].f === f && m[i].t === t) return m[i]; return null; }
  function ckApply(board, mv) {   // plays a move that is known to be legal -> { board, chain } (chain = square that may keep jumping, or -1)
    var a = board.split(""), ch = a[mv.f], side = ckSide(ch), crowned = false;
    a[mv.f] = "_"; if (mv.x >= 0) a[mv.x] = "_";
    if (ch === ch.toLowerCase() && (side === "a" ? (mv.t >> 3) === 0 : (mv.t >> 3) === 7)) { ch = ch.toUpperCase(); crowned = true; }
    a[mv.t] = ch;
    var nb = a.join("");
    return { board: nb, chain: mv.x >= 0 && !crowned && ckJumpsFrom(nb, mv.t).length ? mv.t : -1 };
  }
  function ckCount(board) { var n = { a: 0, b: 0 }; for (var i = 0; i < 64; i++) { var s = ckSide(board[i]); if (s) n[s]++; } return n; }

  // ── Chess ──
  // The board is 64 characters, index = row*8 + col, row 0 is rank 8 (the top, as White sees it). "_" empty, UPPERCASE = White (PNBRQK), lowercase = Black.
  // Standard rules: castling, en passant, promotion, check and checkmate. Stalemate, a dead position, the same position 3 times and 50 moves
  // without a capture or pawn move are draws. Each player has their own clock; the host can also limit the time for each move.
  // g.white = the side (a = host) that plays White. g.clock = ms left per side as of g.turnT; g.deadline = when the side to move runs out (clock or per-move limit).
  // This logic is a copy of the one in games.js (Direct mode): keep them identical.
  var CH_START = "rnbqkbnrpppppppp" + "_".repeat(32) + "PPPPPPPPRNBQKBNR";
  var CH_TM = [180, 300, 600, 900, 1800], CH_PM = [0, 15, 30, 60, 120];
  var CH_N = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  var CH_K = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  var CH_B = [[-1, -1], [-1, 1], [1, -1], [1, 1]], CH_R = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  var CH_DRAW = {
    stalemate: "Stalemate: the player to move has no legal move but is not in check. It's a draw. Everyone got their crates back.",
    dead: "Neither side has enough pieces left to checkmate. It's a draw. Everyone got their crates back.",
    fifty: "50 moves went by with no capture or pawn move. It's a draw. Everyone got their crates back.",
    rep: "The same position came up 3 times. It's a draw. Everyone got their crates back."
  };
  function chMakeOpt(o) {   // the host's choices (validated) -> { tm, pm, w } where w = the side that plays White
    o = o || {};
    var tm = CH_TM.indexOf(Number(o.tm)) >= 0 ? Number(o.tm) : 600, pm = CH_PM.indexOf(Number(o.pm)) >= 0 ? Number(o.pm) : 0;
    return { tm: tm, pm: pm, w: o.c === "white" ? "a" : o.c === "black" ? "b" : (Math.random() < 0.5 ? "a" : "b") };
  }
  function chCol(ch) { return ch === "_" ? null : ch === ch.toUpperCase() ? "w" : "b"; }
  function chMv(f, t, p, e, k) { return { f: f, t: t, p: p || "", e: !!e, k: k || "" }; }   // p = promotion piece, e = en passant capture, k = "k"/"q" for castling
  function chAdd(out, f, t, promo) { if (promo) out.push(chMv(f, t, "q"), chMv(f, t, "r"), chMv(f, t, "b"), chMv(f, t, "n")); else out.push(chMv(f, t)); }
  function chAttacked(b, sq, by) {   // is square sq attacked by a piece of colour `by`?
    var r = sq >> 3, c = sq & 7, w = by === "w", i, d, rr, cc, x, pr = w ? r + 1 : r - 1, pw = w ? "P" : "p";
    if (pr >= 0 && pr < 8) { if (c > 0 && b[pr * 8 + c - 1] === pw) return true; if (c < 7 && b[pr * 8 + c + 1] === pw) return true; }
    for (i = 0; i < 8; i++) {
      rr = r + CH_N[i][0]; cc = c + CH_N[i][1];
      if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === (w ? "N" : "n")) return true;
      rr = r + CH_K[i][0]; cc = c + CH_K[i][1];
      if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === (w ? "K" : "k")) return true;
    }
    for (i = 0; i < 8; i++) {   // 0-3 diagonals (bishop or queen), 4-7 straight lines (rook or queen)
      d = i < 4 ? CH_B[i] : CH_R[i - 4]; rr = r + d[0]; cc = c + d[1];
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
        x = b[rr * 8 + cc];
        if (x !== "_") { if (x === (w ? "Q" : "q") || x === (i < 4 ? (w ? "B" : "b") : (w ? "R" : "r"))) return true; break; }
        rr += d[0]; cc += d[1];
      }
    }
    return false;
  }
  function chPseudo(S, col) {   // moves that follow the piece rules (they may still leave the own king in check)
    var b = S.board, out = [], w = col === "w", opp = w ? "b" : "w", i, j, r, c, rr, cc, x, t, ch, d, offs, dirs, dir, r1, promo;
    for (i = 0; i < 64; i++) {
      ch = b[i]; if (ch === "_" || chCol(ch) !== col) continue;
      r = i >> 3; c = i & 7; t = ch.toLowerCase();
      if (t === "p") {
        dir = w ? -1 : 1; r1 = r + dir; promo = r1 === (w ? 0 : 7);
        if (r1 < 0 || r1 > 7) continue;
        if (b[r1 * 8 + c] === "_") {
          chAdd(out, i, r1 * 8 + c, promo);
          if (r === (w ? 6 : 1) && b[(r + 2 * dir) * 8 + c] === "_") out.push(chMv(i, (r + 2 * dir) * 8 + c));
        }
        for (d = -1; d <= 1; d += 2) {
          cc = c + d; if (cc < 0 || cc > 7) continue;
          x = b[r1 * 8 + cc];
          if (x !== "_" && chCol(x) === opp) chAdd(out, i, r1 * 8 + cc, promo);
          else if (x === "_" && S.ep === r1 * 8 + cc) out.push(chMv(i, r1 * 8 + cc, "", true));
        }
      } else if (t === "n" || t === "k") {
        offs = t === "n" ? CH_N : CH_K;
        for (j = 0; j < 8; j++) {
          rr = r + offs[j][0]; cc = c + offs[j][1]; if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
          x = b[rr * 8 + cc]; if (x === "_" || chCol(x) === opp) out.push(chMv(i, rr * 8 + cc));
        }
      } else {
        dirs = t === "b" ? CH_B : t === "r" ? CH_R : CH_B.concat(CH_R);
        for (j = 0; j < dirs.length; j++) {
          rr = r + dirs[j][0]; cc = c + dirs[j][1];
          while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
            x = b[rr * 8 + cc];
            if (x === "_") out.push(chMv(i, rr * 8 + cc));
            else { if (chCol(x) === opp) out.push(chMv(i, rr * 8 + cc)); break; }
            rr += dirs[j][0]; cc += dirs[j][1];
          }
        }
      }
    }
    var ks = w ? 60 : 4, rights = S.cast || "";   // castling: king and rook still home, empty squares between, king not in check and not passing an attacked square
    if (b[ks] === (w ? "K" : "k") && !chAttacked(b, ks, opp)) {
      if (rights.indexOf(w ? "K" : "k") >= 0 && b[ks + 1] === "_" && b[ks + 2] === "_" && b[ks + 3] === (w ? "R" : "r") && !chAttacked(b, ks + 1, opp) && !chAttacked(b, ks + 2, opp)) out.push(chMv(ks, ks + 2, "", false, "k"));
      if (rights.indexOf(w ? "Q" : "q") >= 0 && b[ks - 1] === "_" && b[ks - 2] === "_" && b[ks - 3] === "_" && b[ks - 4] === (w ? "R" : "r") && !chAttacked(b, ks - 1, opp) && !chAttacked(b, ks - 2, opp)) out.push(chMv(ks, ks - 2, "", false, "q"));
    }
    return out;
  }
  function chApply(S, mv) {   // plays a move that is known to be legal -> the new position { board, cast, ep, half }
    var a = S.board.split(""), ch = a[mv.f], w = ch === ch.toUpperCase(), cap = a[mv.t], pawn = ch.toLowerCase() === "p", cast = S.cast || "", ep = -1;
    a[mv.f] = "_";
    if (mv.e) a[(mv.f >> 3) * 8 + (mv.t & 7)] = "_";
    a[mv.t] = mv.p ? (w ? mv.p.toUpperCase() : mv.p.toLowerCase()) : ch;
    if (mv.k === "k") { a[mv.f + 1] = a[mv.f + 3]; a[mv.f + 3] = "_"; }
    else if (mv.k === "q") { a[mv.f - 1] = a[mv.f - 4]; a[mv.f - 4] = "_"; }
    if (pawn && Math.abs(mv.t - mv.f) === 16) ep = (mv.f + mv.t) / 2;
    [[4, "kq"], [60, "KQ"], [0, "q"], [7, "k"], [56, "Q"], [63, "K"]].forEach(function (z) { if (mv.f === z[0] || mv.t === z[0]) for (var q = 0; q < z[1].length; q++) cast = cast.split(z[1].charAt(q)).join(""); });
    return { board: a.join(""), cast: cast, ep: ep, half: pawn || cap !== "_" ? 0 : (S.half || 0) + 1 };
  }
  function chKing(b, col) { return b.indexOf(col === "w" ? "K" : "k"); }
  function chInCheck(S, col) { var k = chKing(S.board, col); return k >= 0 && chAttacked(S.board, k, col === "w" ? "b" : "w"); }
  function chSafe(S, col, mv) { return !chInCheck(chApply(S, mv), col); }   // does the move leave my own king safe?
  function chHasMove(S, col) { var ps = chPseudo(S, col); for (var i = 0; i < ps.length; i++) if (chSafe(S, col, ps[i])) return true; return false; }
  function chFind(S, col, f, t, p) {   // the legal move f -> t (a promotion without a valid piece becomes a queen), or null
    var ps = chPseudo(S, col), pick = null, i, m;
    for (i = 0; i < ps.length; i++) {
      m = ps[i]; if (m.f !== f || m.t !== t) continue;
      if (m.p) { if (m.p === p) return chSafe(S, col, m) ? m : null; if (m.p === "q") pick = m; }
      else return chSafe(S, col, m) ? m : null;
    }
    return pick && chSafe(S, col, pick) ? pick : null;
  }
  function chDead(b) {   // neither side could ever checkmate: K vs K, K + one minor piece vs K, or only bishops that all stand on one colour
    var minors = [], i, ch, t;
    for (i = 0; i < 64; i++) {
      ch = b[i]; if (ch === "_") continue; t = ch.toLowerCase(); if (t === "k") continue;
      if (t === "p" || t === "r" || t === "q") return false;
      minors.push({ t: t, sq: ((i >> 3) + (i & 7)) % 2 });
    }
    if (minors.length <= 1) return true;
    for (i = 0; i < minors.length; i++) if (minors[i].t !== "b" || minors[i].sq !== minors[0].sq) return false;
    return true;
  }
  function chCanMate(b, col) {   // could this colour ever checkmate? (used when the other side runs out of time)
    var n = 0, i, ch, t;
    for (i = 0; i < 64; i++) {
      ch = b[i]; if (ch === "_" || chCol(ch) !== col) continue; t = ch.toLowerCase(); if (t === "k") continue;
      if (t === "p" || t === "r" || t === "q") return true;
      n++;
    }
    return n >= 2;
  }
  function chKey(S, col) {   // identifies a position for the repetition rule (col = side to move; en passant only counts when it is really possible)
    var ep = -1;
    if (S.ep >= 0) {
      var r = S.ep >> 3, c = S.ep & 7, pw = col === "w" ? "P" : "p", rr = col === "w" ? r + 1 : r - 1;
      if (rr >= 0 && rr < 8 && ((c > 0 && S.board[rr * 8 + c - 1] === pw) || (c < 7 && S.board[rr * 8 + c + 1] === pw))) ep = S.ep;
    }
    return S.board + col + (S.cast || "-") + ep;
  }
  function chAfter(S, mover, hist) {   // S = the position after `mover` moved. hist counts the positions seen so far (updated here). -> { check, over }
    var opp = mover === "w" ? "b" : "w", check = chInCheck(S, opp), k;
    if (!chHasMove(S, opp)) return { check: check, over: check ? "mate" : "stalemate" };
    if (chDead(S.board)) return { check: check, over: "dead" };
    if (S.half >= 100) return { check: check, over: "fifty" };
    k = chKey(S, opp); hist[k] = (hist[k] || 0) + 1;
    return { check: check, over: hist[k] >= 3 ? "rep" : null };
  }
  function chDeadline(x) { return x.turnT + Math.min(x.clock[x.turn], x.pm ? x.pm * 1000 : 1e15); }   // when the side to move runs out of time (total clock or per-move limit)
  function chTimeout(g, now) {   // the side to move ran out of time: the other side wins, unless it could never checkmate
    var l = g.turn, w = other(l), perMove = g.pm && g.pm * 1000 < g.clock[l];
    if (!chCanMate(g.board, w === g.white ? "w" : "b")) settle(g, "draw", null, now, null, nameOf(g, l) + " ran out of time, but " + nameOf(g, w) + " can't checkmate with the pieces left. It's a draw. Everyone got their crates back.");
    else settle(g, "timeout", w, now, null, perMove ? nameOf(g, l) + " took too long to move (" + g.pm + " second limit). " + nameOf(g, w) + " wins the bet." : nameOf(g, l) + " ran out of time. " + nameOf(g, w) + " wins the bet.");
  }

// After a checkers move (or a "stop"): if no jump chain is open the turn passes, and the game ends when the other side has nothing left or can't move.
function ckAfter(g, side, now) {
  if (g.chain >= 0) return {};
  const nx = other(side);
  if (g.score[nx] === 0 || ckMoves(g.board, nx, -1).length === 0) settle(g, "score", side, now);
  else g.turn = nx;
  return {};
}
const rpsWinner = (pa, pb) => (pa === pb ? null : BEATS[pa] === pb ? "a" : "b");

// Ends a game and records who gets what. winner = "a" | "b" | null (refund). leaver = the side that left, if any.
function settle(g, kind, winner, now, leaver, msg) {
  const bet = g.bet, who = winner ? nameOf(g, winner) : "";
  const msgs = {
    score: who + " won" + (GAMES[g.type].win > 1 && g.score ? " the match " + Math.max(g.score.a, g.score.b) + "-" + Math.min(g.score.a, g.score.b) : "") + ".",
    forfeit: nameOf(g, leaver) + " left the game. " + who + " wins the bet.",
    disconnect: nameOf(g, leaver) + " was disconnected for 15 seconds. " + who + " wins the bet.",
    bothleft: "Both players disconnected at the same time. Everyone got their crates back.",
    timeout: "Time ran out. " + who + (g.type === "ck" ? " wins with the most pieces." : " wins with the most games."),
    "timeout-refund": "The timer ran out with no winner. Everyone got their crates back. Make or join a new game.",
    draw: "It's a draw. Everyone got their crates back.",
    cancel: "The game was cancelled. Your crates were returned."
  };
  g.status = "done";
  g.result = { kind, winner: winner || null, msg: msg || msgs[kind] || "The game ended.", at: now };
  g.pay = winner ? { [winner]: bet * 2, [other(winner)]: 0 } : g.p.b ? { a: bet, b: bet } : { a: bet, b: 0 };
  g.paid = false;
}

function startGame(g, now) {
  const cfg = GAMES[g.type];
  Object.assign(g, { status: "playing", startedAt: now, deadline: now + cfg.ms, overtime: false, score: { a: 0, b: 0 }, round: 1, draws: 0, starter: "a", turn: "a" });
  if (g.type === "ttt") g.board = EMPTY9;
  else if (g.type === "c4") g.board = EMPTY42;
  else if (g.type === "ck") { g.board = CK_START; g.chain = -1; g.score = { a: 12, b: 12 }; }
  else if (g.type === "ch") {
    const o = g.opt || {};
    Object.assign(g, { board: CH_START, cast: "KQkq", ep: -1, half: 0, white: o.w, starter: o.w, turn: o.w, tm: o.tm, pm: o.pm, clock: { a: o.tm * 1000, b: o.tm * 1000 }, turnT: now, inCheck: false, hist: { [chKey({ board: CH_START, cast: "KQkq", ep: -1 }, "w")]: 1 } });
    g.deadline = chDeadline(g);
  }
  else { g.rn = 1; g.picked = { a: false, b: false }; delete g.turn; }
}

// Disconnects and timers. Called before every change, using the "seen" times from before this request.
function evaluate(g, now) {
  if (g.status === "waiting") {
    if (now - (g.seen.a || g.created) > WAIT_STALE) settle(g, "cancel", null, now);
    return;
  }
  if (g.status !== "playing") return;
  const sa = now - (g.seen.a || 0) > GRACE, sb = now - (g.seen.b || 0) > GRACE;
  if (sa && sb) {   // both silent: whoever went quiet first lost, unless it was at about the same time
    const da = g.seen.a || 0, db = g.seen.b || 0;
    if (Math.abs(da - db) <= GRACE) settle(g, "bothleft", null, now);
    else if (da < db) settle(g, "disconnect", "b", now, "a");
    else settle(g, "disconnect", "a", now, "b");
    return;
  }
  if (sa) return settle(g, "disconnect", "b", now, "a");
  if (sb) return settle(g, "disconnect", "a", now, "b");
  if (g.type === "ch") { if (now >= g.deadline) chTimeout(g, now); return; }   // chess: per-player clocks instead of one game timer
  if (now >= g.deadline) {
    if (g.score.a !== g.score.b) settle(g, "timeout", g.score.a > g.score.b ? "a" : "b", now);
    else if (!g.overtime) { g.overtime = true; g.deadline = Math.max(now, g.deadline) + GAMES[g.type].extra; }
    else settle(g, "timeout-refund", null, now);
  }
}

// ── database helpers ──
// Transactions can first run on an empty local copy; returning the same null value makes the server retry with the real one.
async function mutate(db, gid, fn) {
  let verdict = null;
  const tx = await db.ref("games/" + gid).transaction((g) => {
    verdict = null;
    if (g === null) return g;
    const copy = JSON.parse(JSON.stringify(g));
    if (!copy.seen) copy.seen = {};
    const r = fn(copy);
    if (r && r.error) { verdict = r; return; }
    verdict = r || {};
    return copy;
  });
  return { committed: tx.committed, verdict, game: tx.snapshot.val() };
}
async function takeCrates(db, id, n) {
  let ok = false;
  const tx = await db.ref("crateClaims/" + id).transaction((v) => {
    ok = false;
    if (v === null) return v;
    const have = Number(v.n) || 0, opened = Number(v.o) || 0;
    if (have - opened < n) return;
    v.n = have - n; ok = true; return v;
  });
  return tx.committed && ok && tx.snapshot.exists();
}
async function credit(db, id, n) {
  await db.ref("crateClaims/" + id).transaction((v) => {
    if (v === null) return v;
    v.n = (Number(v.n) || 0) + n; return v;
  });
}
async function stockOf(db, id) {
  const v = (await db.ref("crateClaims/" + id).get()).val() || {};
  return Math.max(0, (Number(v.n) || 0) - (Number(v.o) || 0));
}
// One game at a time per player.
async function lockPlayer(db, id, now) {
  const ref = db.ref("activeGame/" + id), cur = (await ref.get()).val();
  if (cur) {
    const g = cur.g && cur.g !== "pending" ? (await db.ref("games/" + cur.g).get()).val() : null;
    const stale = cur.g === "pending" ? now - (cur.at || 0) > 15000 : !g || g.status === "done";
    if (!stale) return false;
    await ref.remove();
  }
  const tx = await ref.transaction((v) => (v === null ? { g: "pending", at: now } : undefined));
  return tx.committed && !!tx.snapshot.val();
}
const setActive = (db, id, gid, now) => db.ref("activeGame/" + id).set({ g: gid, at: now });
const unlock = (db, id) => db.ref("activeGame/" + id).remove();

// Pays out a finished game exactly once.
async function payout(db, gid) {
  const flag = await db.ref("games/" + gid + "/paid").transaction((v) => (v === null ? v : v === false ? true : undefined));
  if (!(flag.committed && flag.snapshot.val() === true)) return;
  const g = (await db.ref("games/" + gid).get()).val();
  try {
    for (const s of ["a", "b"]) {
      if (!g.p[s]) continue;
      if (g.pay && g.pay[s] > 0) await credit(db, g.p[s].id, g.pay[s]);
      const act = (await db.ref("activeGame/" + g.p[s].id).get()).val();
      if (act && act.g === gid) await unlock(db, g.p[s].id);
    }
    await db.ref("gamePicks/" + gid).remove();
  } catch (e) { await db.ref("games/" + gid + "/paid").set(false); throw e; }
}
const sideOf = (g, id) => (g.p.a && g.p.a.id === id ? "a" : g.p.b && g.p.b.id === id ? "b" : null);
const err = (status, code, error, extra) => ({ error: { status, code, error, extra } });

// Checkers: after a jump you may stop instead of jumping again.
function applyStop(g, side, now) {
  if (g.type !== "ck") return err(400, "NOT_CHECKERS", "Only checkers has a stop action.");
  if (g.turn !== side) return err(409, "NOT_YOUR_TURN", "It's not your turn.");
  if (!(g.chain >= 0)) return err(409, "NO_CHAIN", "You have no jump to stop.");
  g.chain = -1;
  return ckAfter(g, side, now);
}

// One move in tic-tac-toe, Connect 4 or Checkers. Returns {} or an error.
function applyMove(g, side, b, now) {
  const cfg = GAMES[g.type];
  if (g.turn !== side) return err(409, "NOT_YOUR_TURN", "It's not your turn.");
  if (g.type === "ck") {   // Checkers: move a piece from one square to another (0-63, row*8+col)
    const f = Number(b.from), t = Number(b.to);
    if (!Number.isInteger(f) || !Number.isInteger(t) || f < 0 || f > 63 || t < 0 || t > 63) return err(400, "BAD_SQUARE", "from and to must be whole numbers from 0 to 63.");
    const mv = ckFind(g.board, side, g.chain, f, t);
    if (!mv) return err(409, "BAD_MOVE", "That move isn't allowed.");
    const ra = ckApply(g.board, mv);
    g.board = ra.board; g.chain = ra.chain; g.lastMove = { f: mv.f, t: mv.t, x: mv.x }; g.score = ckCount(g.board);
    return ckAfter(g, side, now);
  }
  if (g.type === "ch") {   // Chess: move a piece from one square to another (0-63, row*8+col); promo = q, r, b or n (default q)
    const f = Number(b.from), t = Number(b.to);
    if (!Number.isInteger(f) || !Number.isInteger(t) || f < 0 || f > 63 || t < 0 || t > 63) return err(400, "BAD_SQUARE", "from and to must be whole numbers from 0 to 63.");
    const col = side === g.white ? "w" : "b", S = { board: g.board, cast: g.cast || "", ep: g.ep == null ? -1 : g.ep, half: g.half || 0 };
    const mv = chFind(S, col, f, t, String(b.promo || ""));
    if (!mv) return err(409, "BAD_MOVE", "That move isn't allowed.");
    g.clock[side] = Math.max(0, g.clock[side] - (now - g.turnT));
    const nx = chApply(S, mv);
    g.board = nx.board; g.cast = nx.cast; g.ep = nx.ep; g.half = nx.half; g.lastMove = { f: mv.f, t: mv.t };
    if (!g.hist) g.hist = {};
    const after = chAfter(nx, col, g.hist);
    g.inCheck = after.check;
    if (after.over === "mate") settle(g, "score", side, now, null, "Checkmate! " + nameOf(g, side) + " wins.");
    else if (after.over) settle(g, "draw", null, now, null, CH_DRAW[after.over]);
    else { g.turn = other(side); g.turnT = now; g.deadline = chDeadline(g); }
    return {};
  }
  if (g.type === "ttt") {
    const cell = Number(b.cell);
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) return err(400, "BAD_CELL", "cell must be a whole number from 0 to 8.");
    if (g.board[cell] !== "_") return err(409, "CELL_TAKEN", "That square is already taken.");
    const mark = side === g.starter ? "X" : "O";
    g.board = g.board.slice(0, cell) + mark + g.board.slice(cell + 1);
    if (lineWinner(g.board)) {
      g.score[side]++; g.lastBoard = g.board; g.lastRound = { winner: side, round: g.round, at: now };
      if (g.score[side] >= cfg.win) { settle(g, "score", side, now); return {}; }
      g.round++; g.starter = other(g.starter); g.board = EMPTY9; g.turn = g.starter;
    } else if (!g.board.includes("_")) {   // a drawn round is replayed
      g.draws = (g.draws || 0) + 1; g.lastBoard = g.board; g.lastRound = { winner: null, round: g.round, at: now };
      g.starter = other(g.starter); g.board = EMPTY9; g.turn = g.starter;
    } else g.turn = other(side);
    return {};
  }
  // Connect 4: drop a piece in a column
  const col = Number(b.col);
  if (!Number.isInteger(col) || col < 0 || col > 6) return err(400, "BAD_COLUMN", "col must be a whole number from 0 to 6.");
  let row = -1;
  for (let r = 5; r >= 0; r--) if (g.board[r * 7 + col] === "_") { row = r; break; }
  if (row < 0) return err(409, "COLUMN_FULL", "That column is full.");
  const idx = row * 7 + col, mark = side === g.starter ? "R" : "Y";
  g.board = g.board.slice(0, idx) + mark + g.board.slice(idx + 1);
  const cells = c4Win(g.board, idx);
  if (cells) { g.winCells = cells; g.score[side]++; settle(g, "score", side, now); }
  else if (!g.board.includes("_")) settle(g, "draw", null, now);
  else g.turn = other(side);
  return {};
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return fail(res, 405, "METHOD_NOT_ALLOWED", "Use POST.");
  try {
    const b = readBody(req), db = chatDb(), now = Date.now(), action = String(b.action || "");
    if (b.__badJson) return fail(res, 400, "BAD_JSON", "The request body is not valid JSON.");

    // Anyone may ask the server to tidy up stale games (disconnects, timers, unpaid results). It is rate-limited.
    if (action === "sweep") {
      const gate = await db.ref("gamesMeta/sweepAt").transaction((v) => (v === null || now - v > 8000 ? now : undefined));
      if (!gate.committed || gate.snapshot.val() !== now) return res.json({ ok: true, skipped: true });
      const all = (await db.ref("games").get()).val() || {};
      for (const gid of Object.keys(all)) {
        const g = all[gid];
        if (g.status === "done") {
          if (g.paid === false) await payout(db, gid);
          else if (now - ((g.result && g.result.at) || 0) > KEEP_DONE) await db.ref("games/" + gid).remove();
        } else {
          await mutate(db, gid, (x) => { evaluate(x, now); });
          const x = (await db.ref("games/" + gid).get()).val();
          if (x && x.status === "done") await payout(db, gid);
        }
      }
      return res.json({ ok: true });
    }

    const who = await verifyLogin(req, db);
    if (who.fail) return fail(res, ...who.fail);
    const id = who.id;

    if (action === "create") {
      const bet = Number(b.bet);
      if (!GAMES[b.game]) return fail(res, 400, "UNKNOWN_GAME", "That game isn't available.", { games: Object.keys(GAMES) });
      if (!BETS.includes(bet)) return fail(res, 400, "BAD_BET", "Bets can be 1, 2, 3, 5 or 10 crates.", { allowed: BETS });
      const acct = await accountById(id);
      if (!acct) return fail(res, 401, "ACCOUNT_NOT_FOUND", "That account no longer exists.");
      if (!(await lockPlayer(db, id, now))) return fail(res, 409, "ALREADY_PLAYING", "You are already in a game.", { hint: "Finish or leave it first." });
      if (!(await takeCrates(db, id, bet))) {
        await unlock(db, id);
        return fail(res, 402, "NOT_ENOUGH_CRATES", "You don't have " + bet + " crate" + (bet === 1 ? "" : "s") + " to bet.", { have: await stockOf(db, id), bet });
      }
      const ref = db.ref("games").push();
      await ref.set(Object.assign({ type: b.game, status: "waiting", bet, created: now, p: { a: { id, name: acct.account.username } }, seen: { a: now }, v: 2 }, b.game === "ch" ? { opt: chMakeOpt(b.opt) } : {}));
      await setActive(db, id, ref.key, now);
      return res.json({ ok: true, gid: ref.key });
    }

    const gid = String(b.gid || "");
    if (!/^[-\w]{10,30}$/.test(gid)) return fail(res, 400, "BAD_GAME_ID", "Missing or invalid game ID.");

    if (action === "join") {
      const g0 = (await db.ref("games/" + gid).get()).val();
      if (!g0) return fail(res, 404, "GAME_NOT_FOUND", "That game no longer exists.");
      if (g0.status !== "waiting") return fail(res, 409, "GAME_NOT_OPEN", "That game already started or ended.");
      if (g0.p.a.id === id) return fail(res, 409, "OWN_GAME", "You can't join your own game.");
      const acct = await accountById(id);
      if (!acct) return fail(res, 401, "ACCOUNT_NOT_FOUND", "That account no longer exists.");
      if (!(await lockPlayer(db, id, now))) return fail(res, 409, "ALREADY_PLAYING", "You are already in a game.", { hint: "Finish or leave it first." });
      if (!(await takeCrates(db, id, g0.bet))) {
        await unlock(db, id);
        return fail(res, 402, "NOT_ENOUGH_CRATES", "You need " + g0.bet + " crate" + (g0.bet === 1 ? "" : "s") + " to join.", { have: await stockOf(db, id), bet: g0.bet });
      }
      const r = await mutate(db, gid, (g) => {
        evaluate(g, now);
        if (g.status !== "waiting") return err(409, "GAME_NOT_OPEN", "That game already started or ended.");
        if (g.p.b) return err(409, "GAME_FULL", "Someone else just joined.");
        g.p.b = { id, name: acct.account.username };
        g.seen.b = now;
        startGame(g, now);
      });
      if (!r.committed || (r.verdict && r.verdict.error)) {   // lost the race: give the crates back
        await credit(db, id, g0.bet); await unlock(db, id);
        const e = (r.verdict && r.verdict.error) || {};
        const gg = (await db.ref("games/" + gid).get()).val();
        if (gg && gg.status === "done") await payout(db, gid);
        return fail(res, e.status || 409, e.code || "GAME_NOT_OPEN", e.error || "That game is no longer open.");
      }
      await setActive(db, id, gid, now);
      return res.json({ ok: true, gid });
    }

    // Rock-Paper-Scissors: record the secret pick first, then resolve the round if the other pick is in too.
    if (action === "move") {
      const g0 = (await db.ref("games/" + gid).get()).val();
      if (g0 && g0.type === "rps" && g0.p) {
        const side0 = sideOf(g0, id);
        if (!side0) return fail(res, 403, "NOT_IN_GAME", "You are not a player in this game.");
        if (g0.status === "done") return res.json({ ok: true, status: "done", result: g0.result || null });
        if (g0.status !== "playing") return fail(res, 409, "NOT_STARTED", "The game hasn't started yet.");
        const pick = String(b.pick || "");
        if (!PICKS.includes(pick)) return fail(res, 400, "BAD_PICK", "pick must be rock, paper or scissors.", { allowed: PICKS });
        const rn = g0.rn;
        const mine = await db.ref("gamePicks/" + gid + "/" + rn + "/" + side0).transaction((v) => (v === null ? pick : undefined));
        if (!mine.committed) return fail(res, 409, "ALREADY_PICKED", "You already picked this round. Wait for the other player.");
        const op = (await db.ref("gamePicks/" + gid + "/" + rn + "/" + other(side0)).get()).val();
        const r = await mutate(db, gid, (g) => {
          const s = sideOf(g, id);
          if (!s) return err(403, "NOT_IN_GAME", "You are not a player in this game.");
          evaluate(g, now);
          if (g.status === "done") return {};
          g.seen[s] = now;
          if (g.rn !== rn) return {};                 // this round was already resolved by the other player's request
          g.picked = g.picked || { a: false, b: false };
          g.picked[s] = true;
          if (op) {
            const pa = s === "a" ? pick : op, pb = s === "a" ? op : pick, w = rpsWinner(pa, pb);
            g.lastRound = { winner: w, a: pa, b: pb, round: g.round, at: now };
            if (w) { g.score[w]++; if (g.score[w] >= GAMES.rps.win) { settle(g, "score", w, now); return {}; } g.round++; }
            else g.draws = (g.draws || 0) + 1;
            g.rn++; g.picked = { a: false, b: false };
            g.resolvedRn = rn;
          }
          return {};
        });
        if (!r.game) return fail(res, 404, "GAME_NOT_FOUND", "That game no longer exists.");
        if (r.verdict && r.verdict.error) { const e = r.verdict.error; return fail(res, e.status, e.code, e.error, e.extra); }
        if (r.game.status === "done") await payout(db, gid);
        else if (r.game.resolvedRn) db.ref("gamePicks/" + gid + "/" + r.game.resolvedRn).remove().catch(() => {});
        return res.json({ ok: true, status: r.game.status, result: r.game.result || null });
      }
    }

    // everything else acts on a game this player is in
    const r = await mutate(db, gid, (g) => {
      const side = sideOf(g, id);
      if (!side) return err(403, "NOT_IN_GAME", "You are not a player in this game.");
      evaluate(g, now);                     // judge disconnects with the old "seen" times first
      if (g.status === "done") return {};
      if (action === "ping") { g.seen[side] = now; return {}; }
      if (action === "leave") {
        if (g.status === "waiting") settle(g, "cancel", null, now);
        else settle(g, "forfeit", other(side), now, side);
        return {};
      }
      if (action === "move") {
        g.seen[side] = now;
        if (g.status !== "playing") return err(409, "NOT_STARTED", "The game hasn't started yet.");
        return applyMove(g, side, b, now);
      }
      if (action === "stop") {
        g.seen[side] = now;
        if (g.status !== "playing") return err(409, "NOT_STARTED", "The game hasn't started yet.");
        return applyStop(g, side, now);
      }
      return err(400, "UNKNOWN_ACTION", "Unknown action.", { actions: ["create", "join", "move", "stop", "ping", "leave", "sweep"] });
    });
    if (!r.game) return fail(res, 404, "GAME_NOT_FOUND", "That game no longer exists.");
    if (r.verdict && r.verdict.error) { const e = r.verdict.error; return fail(res, e.status, e.code, e.error, e.extra); }
    if (r.game.status === "done") await payout(db, gid);
    return res.json({ ok: true, status: r.game.status, result: r.game.result || null });
  } catch (e) {
    console.error(e);
    return fail(res, 500, e && e.config ? "SERVER_CONFIG" : "SERVER_ERROR", e && e.config ? e.message : "Something went wrong on the server.", e && e.config ? {} : { hint: "Open /api/ping to check the server setup." });
  }
};
