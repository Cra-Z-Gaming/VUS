/* Games: 1v1 minigames you can bet crates on (Tic-Tac-Toe, Rock Paper Scissors, Connect 4, Checkers, Chess). A new icon in the left
   rail opens a panel that fills everything except the sidebar.
   Two layers:
     Secure  - the server (api/game.js) runs the game and holds the bets. Needs the server to be reachable.
     Direct  - no server: both players' browsers share a move log in Firebase and work out the result themselves.
               It works anywhere Firebase works, but a determined cheater can fake it (including crates). */
(function () {
  "use strict";
  var API = window.VUS_API_BASE || "https://vus-orcin.vercel.app";
  var BETS = [0, 1, 2, 3, 5, 10];   // 0 = a free game: no crates are bet, but it is still a real game (counts for quests)
  // Live game chat (see "Live chat inside a real 1v1 game" below). Declared here so render() can use it at any time.
  var GC_MAX = 200, GC_EVERY = 1200, GC_STALE = 10800000;
  var gc = { gid: "", ref: null, mref: null, conn: null, connFn: null, box: null, log: null, inp: null, last: 0, sweptAt: 0 };
  var ORDER = ["ttt", "rps", "c4", "ck", "ch"];
  var NAMES = { ttt: "Tic-Tac-Toe", rps: "Rock Paper Scissors", c4: "Connect 4", ck: "Checkers", ch: "Chess" };
  var RULES = {
    ttt: "Best of 3: first to win 2 rounds. A drawn round is replayed. 5 minutes per match: when time is up the player ahead wins; if tied you get 3 extra minutes, then everyone is refunded.",
    rps: "Best of 3: first to win 2 rounds. Both players pick in secret and the picks are revealed together. A tie is replayed. 3 minutes per match: when time is up the player ahead wins; if tied you get 2 extra minutes, then everyone is refunded.",
    c4: "One game: get 4 in a row (across, up or diagonally). 8 minutes per game; if nobody has won by then, or the board fills up, you get 3 extra minutes and then everyone is refunded.",
    ck: "One game on an 8×8 board, Red moves first. Pieces step 1 square diagonally forward and can only go backward by jumping an enemy piece. Jumping is never forced, and after a jump you may keep jumping with the same piece or stop. Reach the far row to become a king (steps and jumps 1 square in any diagonal direction; crowning ends your turn). Win by capturing every piece or leaving them with no legal move. 10 minutes per game: when time is up the player with more pieces wins; if tied you get 3 extra minutes, then everyone is refunded.",
    ch: "Standard chess: White moves first, with castling, en passant and promotion (you pick the piece). Checkmate wins. Stalemate, too few pieces to checkmate, the same position 3 times and 50 moves without a capture or pawn move are draws, and everyone is refunded. Each player has their own clock that only runs on their turn; run out of time and you lose (a draw if your opponent can't checkmate). The host can also limit the time for each move. Leaving the game counts as resigning."
  };
  // ── pure game logic (used by Direct mode; the server has its own copy for Secure mode) ──
  var CFG = { ttt: { win: 2, ms: 300000, extra: 180000 }, rps: { win: 2, ms: 180000, extra: 120000 }, c4: { win: 1, ms: 480000, extra: 180000 }, ck: { win: 1, ms: 600000, extra: 180000 }, ch: { win: 1, ms: 0, extra: 0 } };
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
  function chOptsOf(o) { o = o || {}; return { tm: CH_TM.indexOf(o.tm) >= 0 ? o.tm : 600, pm: CH_PM.indexOf(o.pm) >= 0 ? o.pm : 0, w: o.w === "b" ? "b" : "a" }; }   // w = the side (a = host) that plays White
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
  function chLegal(S, col) { return chPseudo(S, col).filter(function (m) { return chSafe(S, col, m); }); }
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
  function rpsWin(pa, pb) { return pa === pb ? null : BEATS[pa] === pb ? "a" : "b"; }

  // Turns a Direct game record (players + move log) into the same shape the server sends for Secure games.
  // Everything here is deterministic, so both players' browsers always agree.
  function derive(g) {
    var type = g.type, cfg = CFG[type] || CFG.ttt, bet = g.bet;
    var st = { mode: "direct", type: type, bet: bet, created: g.created, p: { a: g.a, b: g.b || null }, seen: g.seen || {}, paid: g.paid || {}, status: "waiting", score: { a: 0, b: 0 }, round: 1, draws: 0, starter: "a", turn: "a", overtime: false, deadline: 0, startT: 0, result: null, pay: null, winCells: null, lastRound: null, tBoth: 0, rv: { a: false, b: false } };
    if (type === "ttt") st.board = "_________"; else if (type === "c4") st.board = "_".repeat(42); else if (type === "ck") { st.board = CK_START; st.chain = -1; st.score = { a: 12, b: 12 }; } else if (type === "ch") {
      var cho = chOptsOf(g.opt);
      st.board = CH_START; st.cast = "KQkq"; st.ep = -1; st.half = 0; st.white = cho.w; st.starter = cho.w; st.turn = cho.w; st.tm = cho.tm; st.pm = cho.pm;
      st.clock = { a: cho.tm * 1000, b: cho.tm * 1000 }; st.turnT = 0; st.inCheck = false; st.lastMove = null;
    } else { st.rn = 1; st.picked = { a: false, b: false }; delete st.turn; }
    function nm(s) { return (st.p[s] && st.p[s].name) || "Player"; }
    function finish(kind, w, t, leaver, msgOver) {
      var who = w ? nm(w) : "", msgs = {
        score: who + " won" + (cfg.win > 1 ? " the match " + Math.max(st.score.a, st.score.b) + "-" + Math.min(st.score.a, st.score.b) : "") + ".",
        forfeit: nm(leaver || other(w || "a")) + " left the game. " + who + " wins the bet.",
        disconnect: nm(leaver || other(w || "a")) + " was disconnected for 15 seconds. " + who + " wins the bet.",
        bothleft: "Both players disconnected at the same time. Everyone got their crates back.",
        timeout: "Time ran out. " + who + (type === "ck" ? " wins with the most pieces." : " wins with the most games."),
        "timeout-refund": "The timer ran out with no winner. Everyone got their crates back. Make or join a new game.",
        draw: "It's a draw. Everyone got their crates back.",
        cancel: "The game was cancelled. Your crates were returned."
      };
      st.status = "done";
      st.result = { kind: kind, winner: w || null, msg: msgOver || msgs[kind] || "The game ended.", at: t };
      st.pay = w ? (function () { var o = {}; o[w] = bet * 2; o[other(w)] = 0; return o; })() : st.p.b ? { a: bet, b: bet } : { a: bet, b: 0 };
    }
    var hist = {}; if (type === "ch") hist[chKey({ board: CH_START, cast: "KQkq", ep: -1 }, "w")] = 1;
    function chFlag(w, t) {   // the side to move ran out of time, so w (the other side) wins, unless w could never checkmate
      var l = other(w), perMove = st.pm && st.pm * 1000 < st.clock[l];
      if (!chCanMate(st.board, w === st.white ? "w" : "b")) finish("draw", null, t, null, nm(l) + " ran out of time, but " + nm(w) + " can't checkmate with the pieces left. It's a draw. Everyone got their crates back.");
      else finish("timeout", w, t, null, perMove ? nm(l) + " took too long to move (" + st.pm + " second limit). " + nm(w) + " wins the bet." : nm(l) + " ran out of time. " + nm(w) + " wins the bet.");
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
      if (e.k === "start") { if (!st.startT && g.b) { st.status = "playing"; st.startT = e.t; st.deadline = e.t + cfg.ms; if (type === "ch") { st.turnT = e.t; st.deadline = chDeadline(st); } } continue; }
      if (e.k === "end") {
        if (st.status === "waiting") { if (e.kind === "cancel") finish("cancel", null, e.t); continue; }
        if (e.kind === "forfeit" || e.kind === "disconnect") { if (e.w === "a" || e.w === "b") finish(e.kind, e.w, e.t); }
        else if (e.kind === "timeout") {
          if (type === "ch") { if (e.w === other(st.turn) && e.t >= st.deadline) chFlag(e.w, e.t); }
          else if ((e.w === "a" || e.w === "b") && e.t >= st.deadline) finish("timeout", e.w, e.t);
        }
        else if (e.kind === "bothleft" || e.kind === "timeout-refund") finish(e.kind, null, e.t);
        continue;
      }
      if (st.status !== "playing") continue;
      if (e.k === "ot") { if (type !== "ch" && !st.overtime && st.score.a === st.score.b && e.t >= st.deadline) { st.overtime = true; st.deadline = st.startT + cfg.ms + cfg.extra; } continue; }
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
      if (type === "ck") {   // Checkers: k "m" = a move (f = from square, c = to square), k "st" = stop jumping and end the turn
        if (st.turn !== e.s) continue;
        var ckm = null;
        if (e.k === "m") { if (!Number.isInteger(e.f) || !Number.isInteger(e.c)) continue; ckm = ckFind(st.board, e.s, st.chain, e.f, e.c); if (!ckm) continue; }
        else if (e.k === "st") { if (st.chain < 0) continue; }
        else continue;
        if (ckm) { var ckr = ckApply(st.board, ckm); st.board = ckr.board; st.chain = ckr.chain; st.lastMove = { f: ckm.f, t: ckm.t, x: ckm.x }; st.score = ckCount(st.board); }
        else st.chain = -1;
        if (st.chain < 0) {
          var ckn = other(e.s);
          if (st.score[ckn] === 0 || ckMoves(st.board, ckn, -1).length === 0) finish("score", e.s, e.t);   // captured everything, or the other side can't move
          else st.turn = ckn;
        }
        continue;
      }
      if (type === "ch") {   // Chess: k "m" = a move (f = from square, c = to square, p = promotion piece q/r/b/n)
        if (e.k !== "m" || st.turn !== e.s || !Number.isInteger(e.f) || !Number.isInteger(e.c)) continue;
        if (e.t > st.deadline) { chFlag(other(e.s), e.t); continue; }   // the move came after the clock ran out
        var chc = e.s === st.white ? "w" : "b", chS = { board: st.board, cast: st.cast, ep: st.ep, half: st.half }, chm = chFind(chS, chc, e.f, e.c, e.p);
        if (!chm) continue;
        st.clock[e.s] = Math.max(0, st.clock[e.s] - (e.t - st.turnT));
        var chn = chApply(chS, chm), cha = chAfter(chn, chc, hist);
        st.board = chn.board; st.cast = chn.cast; st.ep = chn.ep; st.half = chn.half; st.lastMove = { f: chm.f, t: chm.t }; st.inCheck = cha.check;
        if (cha.over === "mate") finish("score", e.s, e.t, null, "Checkmate! " + nm(e.s) + " wins.");
        else if (cha.over) finish("draw", null, e.t, null, CH_DRAW[cha.over]);
        else { st.turn = other(e.s); st.turnT = e.t; st.deadline = chDeadline(st); }
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
  window.VUS_GAMES = { derive: derive, sha256hex: sha256hex, E: { lineWinner: lineWinner, ckMoves: ckMoves, ckFind: ckFind, ckApply: ckApply, ckCount: ckCount, CK_START: CK_START, chPseudo: chPseudo, chApply: chApply, chInCheck: chInCheck, chLegal: chLegal, chFind: chFind, chAfter: chAfter, chKey: chKey, chDead: chDead, CH_START: CH_START } };   // E = the rule engines, used by the practice bots (bots.js)

  var shell = document.getElementById("appShell"), rail = document.getElementById("rail"), navCol = document.getElementById("navCol");
  if (!shell || !rail) return;

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  // Custom confirm popup (replaces the browser's confirm()). Enter confirms, Escape cancels.
  function gmConfirm(title, msg, okLabel, onOk) {
    var ov = el("div"); ov.style.cssText = "position:fixed;inset:0;background:rgba(2,6,23,.7);display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px";
    var box = el("div"); box.style.cssText = "background:#1e293b;border:1.5px solid #334155;border-radius:14px;padding:20px;max-width:360px;width:100%;box-sizing:border-box;color:#e2e8f0;text-align:center";
    var ttl = el("h3", "", title); ttl.style.margin = "0 0 8px";
    var p = el("p", "", msg); p.style.cssText = "margin:0 0 16px;color:#94a3b8;font-size:15px";
    var row = el("div"); row.style.cssText = "display:flex;gap:10px;justify-content:center;flex-wrap:wrap";
    var no = el("button", "gm-btn", "Stay"); no.type = "button";
    var yes = el("button", "gm-btn d", okLabel); yes.type = "button";
    function close() { document.removeEventListener("keydown", onKey, true); if (ov.parentNode) ov.parentNode.removeChild(ov); }
    function onKey(e) {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(); onOk(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    }
    no.onclick = close;
    yes.onclick = function () { close(); onOk(); };
    ov.onclick = function (e) { if (e.target === ov) close(); };
    row.appendChild(no); row.appendChild(yes);
    box.appendChild(ttl); box.appendChild(p); box.appendChild(row); ov.appendChild(box);
    document.body.appendChild(ov);
    document.addEventListener("keydown", onKey, true);
    yes.focus();
  }
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
  css.textContent += ".gm-ck{display:grid;grid-template-columns:repeat(8,1fr);width:min(480px,94vw);margin:14px auto;border:4px solid #3b2a1a;border-radius:8px;overflow:hidden}.gm-sq{aspect-ratio:1;padding:0;border:0;display:flex;align-items:center;justify-content:center;position:relative;cursor:default}.gm-sq.lt{background:#f0d9b5}.gm-sq.dk{background:#b58863}.gm-sq.dk.last{background:#c9a94a}.gm-sq.mv,.gm-sq.tg,.gm-sq.tgx{cursor:pointer}.gm-sq.tg::after{content:'';width:28%;height:28%;border-radius:50%;background:rgba(22,163,74,.9);position:absolute}.gm-sq.tgx::after{content:'';width:72%;height:72%;border-radius:50%;border:4px solid #ef4444;box-sizing:border-box;position:absolute}.gm-sq.sel{box-shadow:inset 0 0 0 4px #22c55e}.gm-pc{width:78%;height:78%;border-radius:50%;box-shadow:0 3px 0 rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-size:min(5.6vw,27px);line-height:1;color:#fde68a;box-sizing:border-box}.gm-pc.a{background:#ef4444;border:3px solid #b91c1c}.gm-pc.b{background:#1f2937;border:3px solid #6b7280}.gm-sq.mv .gm-pc{box-shadow:0 3px 0 rgba(0,0,0,.45),0 0 0 3px rgba(34,197,94,.6)}";
  css.textContent += ".gm-cp{font-size:min(9.4vw,46px);line-height:1;display:block;pointer-events:none}.gm-cp.w{color:#fff;text-shadow:0 0 2px #000,0 0 2px #000,1px 1px 1px #000,-1px -1px 1px #000}.gm-cp.b{color:#111;text-shadow:0 0 1px rgba(255,255,255,.5)}.gm-sq.lt.last{background:#e8d56b}.gm-sq.chk{background:#ef4444 !important}.gm-co{position:absolute;font-size:10px;font-weight:700;color:rgba(0,0,0,.55);pointer-events:none;line-height:1}.gm-co.l{top:3px;left:3px}.gm-co.f{bottom:2px;right:3px}.gm-ch-row{display:flex;justify-content:space-between;align-items:center;gap:10px;width:min(480px,94vw);margin:8px auto;font-weight:700}";
  // Phones and small windows: nothing may scroll sideways, boards shrink to fit the width AND the height, and the menu button lets you leave the games panel.
  css.textContent += "#gamesPane{overflow-x:hidden;overflow-y:auto;min-height:0;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}" +
    "#gamesPane button,#gamesPane select{touch-action:manipulation;-webkit-tap-highlight-color:transparent}" +
    ".gm-wrap,.gm-h,.gm-top>div{min-width:0}.gm-card,.gm-c4,.gm-ck,.gm-board,.gm-ch-row{box-sizing:border-box}.gm-card{overflow:hidden}" +
    ".gm-h h2{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gm-stock{white-space:nowrap}" +
    ".gm-pl,.gm-note,.gm-row b,.gm-row span{overflow-wrap:anywhere}.gm-sel{max-width:100%;font-size:16px}" +
    ".gm-board{width:min(340px,100%)}.gm-c4{width:min(440px,100%)}.gm-ck,.gm-ch-row{width:min(480px,100%)}" +
    ".gm-board{grid-template-columns:repeat(3,minmax(0,1fr))}.gm-c4{grid-template-columns:repeat(7,minmax(0,1fr))}.gm-ck{grid-template-columns:repeat(8,minmax(0,1fr))}" +
    ".gm-ch-row>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".gm-rps{flex-wrap:nowrap}.gm-rpsb{flex:1 1 0;width:auto;max-width:130px;min-width:0}" +
    "#gamesPane .mobile-menu-btn{display:none;flex:none;width:44px;height:44px;margin:0 2px 0 -4px;padding:0;border-radius:12px;background:#1e293b;border:1.5px solid #334155;color:#e2e8f0;font-size:22px;line-height:1;align-items:center;justify-content:center;cursor:pointer}" +
    "@supports (width:100dvh){.gm-board{width:min(340px,100%,max(200px,calc(100dvh - 230px)))}.gm-ck,.gm-ch-row{width:min(480px,100%,max(260px,calc(100dvh - 230px)))}}" +
    "@supports (width:1cqw){.gm-ck,.gm-board{container-type:inline-size}.gm-cp{font-size:9.6cqw}.gm-pc{font-size:5.6cqw}.gm-cell{font-size:min(19cqw,58px)}}" +
    "@media (pointer:coarse){.gm-bet,.gm-btn{min-height:44px}.gm-bet{min-width:52px}.gm-sel{min-height:44px}}" +
    "@media (max-width:720px){#gamesPane{padding:max(12px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left))}" +
    "#gamesPane .mobile-menu-btn{display:inline-flex}.gm-h h2{font-size:19px}.gm-card{padding:12px;border-radius:12px}" +
    ".gm-top{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;align-items:start}.gm-top>div{text-align:center !important}.gm-top>.gm-center{grid-column:1/-1;order:3}" +
    ".gm-pl{font-size:16px}.gm-score{font-size:26px}.gm-rpsb span{font-size:36px}.gm-status{font-size:16px}" +
    ".gm-card>.gm-sel{display:block;width:100%;margin:0 0 8px !important}.gm-card label.gm-note{flex:1 1 100%;justify-content:space-between}.gm-card label .gm-sel{flex:1;max-width:60%}}" +
    "@media (max-height:520px) and (min-width:721px){#gamesPane{padding:12px 18px}.gm-card{padding:12px}.gm-top{display:grid;grid-template-columns:1fr auto 1fr;gap:8px 12px;align-items:center;margin:0 0 6px}.gm-top>.gm-center{max-width:380px}.gm-score{font-size:24px}.gm-h{margin:0 0 8px}}";
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
    shell.classList.remove("nav-open");   // on phones: close the sidebar drawer so the games panel is visible
    btn.style.color = ""; btn.title = "Games";
    probe(false).then(function () { if (open) { lastSig = ""; onGames(); } });
    sweep(); startListening(); render();
  }
  function closePane() {
    if (!open) return; open = false;
    shell.classList.remove("mode-games"); btn.classList.remove("active");
    prevActive.forEach(function (b) { b.classList.add("active"); }); prevActive = [];
  }
  btn.addEventListener("click", function () {
    if (!open) openPane();
    else if (shell.classList.contains("nav-open")) shell.classList.remove("nav-open");   // phone drawer is open: just close the drawer and stay in Games
    else closePane();
  });
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
  function friendly(e, what) {   // says WHICH write the database refused, instead of blaming the rules for everything
    var m = String(e && (e.message || e.code) || e);
    if (!/permission/i.test(m)) return m;
    var at = /at (\/[^:\s]+)/.exec(m), path = at ? at[1].replace(/\/\d{4,12}(?=\/|$)/g, "/<id>").replace(/\/-[\w-]{10,}/g, "/<game>") : "";
    return (what || "That") + " was refused by the database" + (path ? " (" + path + ")" : "") + ". Try again; if it keeps happening, report this message.";
  }
  async function adjustG(id, delta) {
    if (!delta) return;   // a free (0x) game moves no crates
    try { await db().ref("crateGames/" + id).transaction(function (v) { return (Number(v) || 0) + delta; }); }
    catch (e) { throw new Error(friendly(e, delta < 0 ? "Taking your bet" : "Returning your crates")); }
  }
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
  async function dCreate(type, bet, opts) {
    if (stock() < bet) throw new Error("You don't have " + crates(bet) + " to bet.");
    await adjustG(me(), -bet);
    try {
      var ref = db().ref("pg").push();
      var rec = { type: type, bet: bet, created: TS(), a: { id: me(), name: myName() }, seen: { a: TS() }, v: 1 };
      if (type === "ch") { var o = opts || {}; rec.opt = { tm: CH_TM.indexOf(o.tm) >= 0 ? o.tm : 600, pm: CH_PM.indexOf(o.pm) >= 0 ? o.pm : 0, w: o.c === "white" ? "a" : o.c === "black" ? "b" : (Math.random() < 0.5 ? "a" : "b") }; }   // w = which side plays White (the host is side a)
      await ref.set(rec);
      return { gid: ref.key, mode: "direct" };
    } catch (e) { await adjustG(me(), bet); throw new Error(friendly(e, "Creating the game")); }
  }
  async function dJoin(gid) {
    var raw = pgames[gid]; if (!raw || derive(raw).status !== "waiting") throw new Error("That game is no longer open.");
    if (raw.a.id === me()) throw new Error("You can't join your own game.");
    if (stock() < raw.bet) throw new Error("You need " + crates(raw.bet) + " to join.");
    await adjustG(me(), -raw.bet);
    var up = {}; up["pg/" + gid + "/b"] = { id: me(), name: myName() }; up["pg/" + gid + "/log/0000"] = { k: "start", t: TS() }; up["pg/" + gid + "/seen/b"] = TS();
    try { await db().ref().update(up); return { gid: gid, mode: "direct" }; }
    catch (e) {
      await adjustG(me(), raw.bet);
      var fresh = null; try { fresh = (await db().ref("pg/" + gid).get()).val(); } catch (e2) {}
      throw new Error(fresh && fresh.b ? "Someone else just joined that game." : friendly(e, "Joining the game"));
    }
  }
  function dLeave(gid) {
    if (lgames[gid]) { lLeave(); return true; }   // a practice game: just walk away
    var raw = pgames[gid], side = sideIn(raw), st = raw && derive(raw); if (!side || !st) return;
    if (st.status === "waiting") return append(gid, { k: "end", s: "x", kind: "cancel" }, function (x) { return x.status === "waiting"; });
    return append(gid, { k: "end", s: side, kind: "forfeit", w: other(side) }, function (x) { return x.status === "playing"; });
  }
  function dMove(gid, c) {
    if (lgames[gid]) return lAct(gid, { k: "m", s: "a", c: c });
    var side = sideIn(pgames[gid]);
    return append(gid, { k: "m", s: side, c: c }, function (x) { return x.status === "playing" && x.turn === side; });
  }
  function dMoveCk(gid, f, t, p) {
    if (lgames[gid]) return lAct(gid, p ? { k: "m", s: "a", f: f, c: t, p: p } : { k: "m", s: "a", f: f, c: t });
    var side = sideIn(pgames[gid]);
    return append(gid, p ? { k: "m", s: side, f: f, c: t, p: p } : { k: "m", s: side, f: f, c: t }, function (x) { return x.status === "playing" && x.turn === side; });
  }
  function dStop(gid) {   // end my turn after a jump instead of jumping again
    if (lgames[gid]) return lAct(gid, { k: "st", s: "a" });
    var side = sideIn(pgames[gid]);
    return append(gid, { k: "st", s: side }, function (x) { return x.status === "playing" && x.turn === side && x.chain >= 0; });
  }
  var commits = {};
  try { commits = JSON.parse(localStorage.getItem("vus_games_commits") || "{}") || {}; } catch (e) { commits = {}; }
  function saveCommits() { try { localStorage.setItem("vus_games_commits", JSON.stringify(commits)); } catch (e) {} }
  function dPick(gid, p) {   // commit to a pick without showing it; the reveal is sent automatically once both have committed
    if (lgames[gid]) return lPick(gid, p);
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
    if (lgames[gid]) return localTick(gid);
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
          if (st.type === "ch") append(gid, { k: "end", s: "x", kind: "timeout", w: other(st.turn) }, function (x) { return x.status === "playing" && x.turn === st.turn && x.turnT === st.turnT; });
          else if (st.score.a !== st.score.b) append(gid, { k: "end", s: "x", kind: "timeout", w: st.score.a > st.score.b ? "a" : "b" }, function (x) { return x.status === "playing" && x.score.a !== x.score.b; });
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
  var games = {}, pgames = {}, listenRef = null, pgRef = null, myGid = "", myMode = "", loop = null, lastId = "", lastSig = "", myPicks = {}, lastPing = 0, spectate = null;
  // ── Practice games against a bot ──
  // A practice game lives only in this browser tab: nothing goes to Firebase or the server, no crates are bet and quests never see it.
  // Its record has the same shape as a Direct game, so derive() and the normal game screens work unchanged. The bot (bots.js, loaded on first use) is always side "b".
  var BOTS_URL = "https://raw.githubusercontent.com/Cra-Z-Gaming/VUS/refs/heads/main/Chat-DM/bots.js", botsP = null;
  var lgames = {}, lviews = {}, lcommits = {}, lTimers = {}, lseq = 0, LVN = ["Easy", "Normal", "Hard"], prOpt = { game: "ttt", lvl: 1, tm: 600, pm: 0, c: "random" };
  function loadBots() {   // bots.js is fetched like the other scripts (raw.githubusercontent.com cannot be used as a plain <script src>)
    if (window.VUS_BOTS) return Promise.resolve();
    if (!botsP) botsP = fetch(BOTS_URL, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }).then(function (t) {
      return new Promise(function (res, rej) {
        var s = document.createElement("script");
        s.src = URL.createObjectURL(new Blob([t], { type: "application/javascript" }));
        s.onload = res; s.onerror = function () { rej(new Error("bots.js did not run")); };
        document.body.appendChild(s);
      });
    }).then(function () { if (!window.VUS_BOTS) throw new Error("bots.js did not start"); }).catch(function (e) {
      botsP = null; throw new Error("The practice bots couldn't be loaded (" + (e && e.message || e) + "). Check your connection and try again.");
    });
    return botsP;
  }
  function pracMsg(s) {   // the normal result texts talk about bets and crates: say the same thing without them
    return String(s || "").replace(" Everyone got their crates back. Make or join a new game.", "").replace(" Everyone got their crates back.", "").replace(" wins the bet.", " wins.");
  }
  function lview(gid) {   // the view derive() gives for a Direct game, remembered until the log grows
    var raw = lgames[gid], n, c, st;
    if (!raw) return null;
    n = Object.keys(raw.log).length; c = lviews[gid];
    if (!c || c.n !== n) {
      st = derive(raw); st.practice = true; st.prac = raw.prac; st.lvl = raw.lvl;
      if (st.result) st.result.msg = raw.stuck ? "The bot ran into a problem, so this practice game was stopped. Leave and start a new one." : pracMsg(st.result.msg);
      c = lviews[gid] = { n: n, st: st };
    }
    return c.st;
  }
  function lAppend(gid, entry, ok) {   // add one entry to a practice game's log (the same entries a Direct game uses)
    var raw = lgames[gid];
    if (!raw || (ok && !ok(lview(gid)))) return false;
    raw.log[("000" + Object.keys(raw.log).length).slice(-4)] = Object.assign({}, entry, { t: now() });
    return true;
  }
  function lAfter(gid) { onGames(); lPlan(gid); }
  function lAct(gid, entry) {   // a move by me (side a)
    var done = lAppend(gid, entry, function (x) { return x.status === "playing" && x.turn === "a" && (entry.k !== "st" || x.chain >= 0); });
    if (done) lAfter(gid);
    return done;
  }
  function lz() { return Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(8)), function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
  function lPick(gid, p) {   // Rock Paper Scissors: lock in my pick (the reveal follows in localTick)
    var st = lview(gid), z, done;
    if (!st || st.status !== "playing" || st.picked.a || PICKS.indexOf(p) < 0) return false;
    z = lz(); lcommits[gid + ":" + st.rn + ":a"] = { p: p, z: z };
    done = lAppend(gid, { k: "c", s: "a", h: sha256hex(p + ":" + z) }, function (x) { return x.status === "playing" && !x.picked.a; });
    if (done) lAfter(gid);
    return done;
  }
  function lDrop(gid) {   // forget a practice game (does nothing for a real game)
    if (!lgames[gid]) return;
    clearTimeout(lTimers[gid]); delete lTimers[gid]; delete lgames[gid]; delete lviews[gid];
    Object.keys(lcommits).forEach(function (k) { if (k.indexOf(gid + ":") === 0) delete lcommits[k]; });
  }
  function lLeave() { lDrop(myGid); myGid = ""; myMode = ""; stopLoop(); showErr(""); lastSig = ""; render(); }
  function lRpsHist(raw) {   // finished Rock Paper Scissors rounds from the bot's point of view: { me: bot's pick, foe: my pick }
    var A = [], Bp = [], keys = Object.keys(raw.log).sort(), out = [], i, e;
    for (i = 0; i < keys.length; i++) { e = raw.log[keys[i]]; if (e && e.k === "r" && PICKS.indexOf(e.p) >= 0) (e.s === "a" ? A : Bp).push(e.p); }
    for (i = 0; i < Math.min(A.length, Bp.length); i++) out.push({ me: Bp[i], foe: A[i] });
    return out;
  }
  function lChessHist(raw) {   // how often each position has come up so far (for the repetition rule), by replaying the moves
    var S = { board: CH_START, cast: "KQkq", ep: -1, half: 0 }, hist = {}, w = chOptsOf(raw.opt).w, keys = Object.keys(raw.log).sort(), i, e, c, m;
    hist[chKey(S, "w")] = 1;
    for (i = 0; i < keys.length; i++) {
      e = raw.log[keys[i]]; if (!e || e.k !== "m" || !Number.isInteger(e.f)) continue;
      c = e.s === w ? "w" : "b"; m = chFind(S, c, e.f, e.c, e.p); if (!m) continue;
      S = chApply(S, m); chAfter(S, c, hist);
    }
    return hist;
  }
  function lSig(st) { return JSON.stringify([st.board, st.turn, st.chain, st.picked, st.rv, st.rn, st.score]); }
  function lCommitB(raw, st, p) {   // the bot locks in a Rock Paper Scissors pick (hidden until both have picked)
    var z = lz();
    if (PICKS.indexOf(p) < 0) p = PICKS[Math.floor(Math.random() * 3)];
    lcommits[raw.gid + ":" + st.rn + ":b"] = { p: p, z: z };
    return { k: "c", s: "b", h: sha256hex(p + ":" + z) };
  }
  function lChoose(raw, st) {   // asks bots.js for the bot's next log entry, or null when it has no valid answer
    var B = window.VUS_BOTS, lvl = raw.lvl, type = st.type, v, m;
    if (!B || !B[type]) return null;
    if (type === "ttt") { v = B.ttt(st.board, st.starter === "b" ? "X" : "O", lvl); return v >= 0 && st.board[v] === "_" ? { k: "m", s: "b", c: v } : null; }
    if (type === "c4") { v = B.c4(st.board, st.starter === "b" ? "R" : "Y", lvl); return v >= 0 && v <= 6 && st.board[v] === "_" ? { k: "m", s: "b", c: v } : null; }
    if (type === "rps") return st.picked.b ? null : lCommitB(raw, st, B.rps(lRpsHist(raw), lvl));
    if (type === "ck") {
      m = B.ck(st.board, "b", st.chain, lvl);
      if (m) return ckFind(st.board, "b", st.chain, m.f, m.t) ? { k: "m", s: "b", f: m.f, c: m.t } : null;
      return st.chain >= 0 ? { k: "st", s: "b" } : null;
    }
    m = B.ch({ board: st.board, cast: st.cast, ep: st.ep, half: st.half }, st.white === "b" ? "w" : "b", lChessHist(raw), lvl);
    return m ? (m.p ? { k: "m", s: "b", f: m.f, c: m.t, p: m.p } : { k: "m", s: "b", f: m.f, c: m.t }) : null;
  }
  function lFallback(raw, st) {   // if the bot fails, play any legal move instead so the game never freezes
    var i, ms, cs;
    if (st.type === "ttt") { i = st.board.indexOf("_"); return i >= 0 ? { k: "m", s: "b", c: i } : null; }
    if (st.type === "c4") { for (i = 0; i < 7; i++) if (st.board[i] === "_") return { k: "m", s: "b", c: i }; return null; }
    if (st.type === "rps") return st.picked.b ? null : lCommitB(raw, st, "rock");
    if (st.type === "ck") { ms = ckMoves(st.board, "b", st.chain); return ms.length ? { k: "m", s: "b", f: ms[0].f, c: ms[0].t } : st.chain >= 0 ? { k: "st", s: "b" } : null; }
    cs = chLegal({ board: st.board, cast: st.cast, ep: st.ep, half: st.half }, st.white === "b" ? "w" : "b");
    return cs.length ? (cs[0].p ? { k: "m", s: "b", f: cs[0].f, c: cs[0].t, p: cs[0].p } : { k: "m", s: "b", f: cs[0].f, c: cs[0].t }) : null;
  }
  function lBotMove(gid) {   // the bot acts now
    var raw = lgames[gid], st = raw && lview(gid), e = null, before, after;
    if (!st || st.status !== "playing") return;
    before = lSig(st);
    try { e = lChoose(raw, st); } catch (err) { e = null; }
    if (!e) { try { e = lFallback(raw, st); } catch (err2) { e = null; } }
    if (e) lAppend(gid, e, function (x) { return x.status === "playing"; });
    after = lview(gid);
    if (after && after.status === "playing" && lSig(after) === before) {   // nothing changed: after 3 tries stop the game instead of looping forever
      raw.fails = (raw.fails || 0) + 1;
      if (raw.fails >= 3) { raw.stuck = true; lAppend(gid, { k: "end", s: "x", kind: "bothleft" }); }
    } else raw.fails = 0;
    lAfter(gid);
  }
  function lPlan(gid) {   // when it is the bot's turn (or it still has to pick), schedule its move a moment from now so it feels natural
    var raw = lgames[gid], st = raw && lview(gid), d;
    if (!st || st.status !== "playing" || raw.stuck || lTimers[gid]) return;
    if (st.type === "rps" ? st.picked.b : st.turn !== "b") return;
    d = { ttt: [450, 500], rps: [600, 900], c4: [500, 600], ck: [600, 600], ch: [350, 450] }[st.type] || [500, 500];
    lTimers[gid] = setTimeout(function () { delete lTimers[gid]; lBotMove(gid); }, d[0] + Math.random() * d[1]);
  }
  function localTick(gid) {   // what directTick does for a real game: the clock, overtime and the Rock Paper Scissors reveals
    var raw = lgames[gid], st = raw && lview(gid), t = now(), did = false;
    if (!st || st.status !== "playing") return;
    if (t >= st.deadline) {
      if (st.type === "ch") did = lAppend(gid, { k: "end", s: "x", kind: "timeout", w: other(st.turn) }, function (x) { return x.status === "playing"; });
      else if (st.score.a !== st.score.b) did = lAppend(gid, { k: "end", s: "x", kind: "timeout", w: st.score.a > st.score.b ? "a" : "b" }, function (x) { return x.status === "playing"; });
      else if (!st.overtime) did = lAppend(gid, { k: "ot", s: "x" }, function (x) { return x.status === "playing" && !x.overtime; });
      else did = lAppend(gid, { k: "end", s: "x", kind: "timeout-refund" }, function (x) { return x.status === "playing" && x.overtime; });
    } else if (st.type === "rps" && st.picked.a && st.picked.b) {
      ["a", "b"].forEach(function (s) {
        var cm = lcommits[gid + ":" + st.rn + ":" + s];
        if (cm && !st.rv[s] && lAppend(gid, { k: "r", s: s, p: cm.p, z: cm.z })) did = true;
      });
    }
    if (did) lAfter(gid);
  }
  async function startPractice(type, lvl, o) {   // o = the chess options { tm, pm, c } (ignored for the other games)
    var oo = o || {}, gid, rec;
    await loadBots();
    if (!window.VUS_BOTS[type]) throw new Error("There is no practice bot for that game yet.");
    if (!LVN[lvl]) lvl = 1;
    gid = "pr" + (++lseq) + "x" + Date.now().toString(36);
    rec = { gid: gid, type: type, bet: 0, created: now(), a: { id: me(), name: myName() }, b: { id: "bot", name: "Bot (" + LVN[lvl] + ")" }, seen: {}, paid: {}, log: { "0000": { k: "start", t: now() } }, practice: true, lvl: lvl, prac: { type: type, lvl: lvl, opt: o || null } };
    if (type === "ch") rec.opt = { tm: oo.tm, pm: oo.pm, w: oo.c === "white" ? "a" : oo.c === "black" ? "b" : (Math.random() < 0.5 ? "a" : "b") };   // w = which side plays White (me = a)
    lgames[gid] = rec;
    lPlan(gid);
    return { gid: gid, mode: "direct" };
  }
  async function waitToBot(g) {   // from the "waiting for someone to join" screen: cancel my open game (bet returned), then play the bot at Normal
    await loadBots();   // download the bots first, so the screen does not flash a "cancelled" result while they load
    var r = await (g.mode === "direct" ? dLeave(myGid) : call("leave", { gid: myGid }));
    if (g.mode === "direct" && r === false) throw new Error("Someone just joined your game, so it is starting. The bot was not started.");
    return startPractice(g.type || "ttt", 1, g.type === "ch" ? { tm: g.tm, pm: g.pm, c: g.white === "a" ? "white" : "black" } : null);
  }
  function openPracticePopup() {   // the practice options live in a popup so they take no room in the lobby
    var ov = el("div"), box = el("div");
    ov.style.cssText = "position:fixed;inset:0;background:rgba(2,6,23,.7);display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px";
    box.style.cssText = "max-width:460px;width:100%;max-height:90vh;overflow:auto;box-sizing:border-box;color:#e2e8f0";
    function close() { document.removeEventListener("keydown", onKey, true); if (ov.parentNode) ov.parentNode.removeChild(ov); }
    function onKey(e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }
    function paint() { box.textContent = ""; renderPractice(box, paint, close); }
    ov.onclick = function (e) { if (e.target === ov) close(); };
    paint(); ov.appendChild(box); document.body.appendChild(ov);
    document.addEventListener("keydown", onKey, true);
  }
  function renderPractice(wrap, repaint, done) {   // the content of the practice popup
    var c = el("div", "gm-card"), row = el("div"), gs = document.createElement("select"), ls = document.createElement("select"), go;
    c.appendChild(el("h3", "", "Practice against a bot"));
    c.appendChild(el("div", "gm-note", "Play the computer for fun or to learn. No crates are bet, nothing is saved, and it does not count for quests. Leaving is free."));
    row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin:8px 0";
    gs.className = "gm-sel"; ls.className = "gm-sel";
    ORDER.forEach(function (k) { var o = document.createElement("option"); o.value = k; o.textContent = NAMES[k]; gs.appendChild(o); });
    LVN.forEach(function (n, i) { var o = document.createElement("option"); o.value = String(i); o.textContent = "Bot level: " + n; ls.appendChild(o); });
    gs.value = prOpt.game; gs.onchange = function () { prOpt.game = gs.value; repaint(); };
    ls.value = String(prOpt.lvl); ls.onchange = function () { prOpt.lvl = Number(ls.value); };
    row.appendChild(gs); row.appendChild(ls); c.appendChild(row);
    c.appendChild(el("div", "gm-note", RULES[prOpt.game]));
    if (prOpt.game === "ch") c.appendChild(chOptions(prOpt));
    go = el("button", "gm-btn p", "Start practice game"); go.type = "button"; go.disabled = busy;
    go.onclick = function () { done(); act(function () { return startPractice(prOpt.game, prOpt.lvl, prOpt.game === "ch" ? { tm: prOpt.tm, pm: prOpt.pm, c: prOpt.c } : null); }); };
    var cn = el("button", "gm-btn", "Cancel"); cn.type = "button"; cn.style.marginLeft = "8px"; cn.onclick = done;
    c.appendChild(go); c.appendChild(cn); wrap.appendChild(c);
  }

  function startListening() {
    var d = db(); if (!d) return;
    if (!listenRef) { listenRef = d.ref("games"); listenRef.on("value", function (s) { games = s.val() || {}; onGames(); }, function () {}); }
    if (!pgRef) { pgRef = d.ref("pg"); pgRef.on("value", function (s) { pgames = s.val() || {}; directHousekeeping(); onGames(); }, function () {}); }
  }
  function viewOf(gid, mode) { if (lgames[gid]) return lview(gid); return mode === "direct" ? (pgames[gid] ? derive(pgames[gid]) : null) : (games[gid] || null); }
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
    var mine = lgames[myGid] ? null : findMine();   // while I'm in a practice game, a real game must not take over the screen
    if (mine && (mine.gid !== myGid || mine.mode !== myMode)) { myGid = mine.gid; myMode = mine.mode; startLoop(); }
    if (myGid && !viewOf(myGid, myMode)) { myGid = ""; stopLoop(); }
    if (spectate && (myGid || !viewOf(spectate.gid, spectate.mode))) spectate = null;   // started playing, or the watched game was removed
    badge(); questScan();
    if (!open) return;
    // only redraw when something you can see changed (the players' heartbeats change the data every few seconds)
    var g = myGid ? viewOf(myGid, myMode) : null;
    var waiting = waitingList().map(function (w) { return [w.gid, w.mode, w.type, w.bet, w.host]; });
    var sg = (!g && spectate) ? viewOf(spectate.gid, spectate.mode) : null;
    var live = liveList().map(function (w) { return [w.gid, w.mode, w.type, w.bet, w.a, w.b, w.score]; });
    var sig = JSON.stringify([me(), stock(), serverUp, modePref, myGid, spectate && spectate.gid, g ? [g.status, g.board, g.turn, g.score, g.round, g.rn, g.picked, g.draws, g.result, g.overtime, g.deadline, g.lastRound, g.winCells, g.p, g.chain, g.lastMove] : sg ? [sg.status, sg.board, sg.turn, sg.score, sg.round, sg.rn, sg.picked, sg.draws, sg.result, sg.overtime, sg.lastRound, sg.winCells, sg.chain, sg.lastMove] : [waiting, live]]);
    if (sig !== lastSig) { lastSig = sig; render(); }
  }
  // Tells the quest tracker (quests.js) about every finished game I played in, with the freshest copy of the record, so it counts once the payout is final.
  var qLast = {};
  function questScan() {
    var Q = window.VUS_QUESTS, id = me(); if (!Q || !Q.gameDone || !id) return;
    var t = Date.now();
    function send(key, gid, mode, raw) { if (t - (qLast[key] || 0) < 4000) return; qLast[key] = t; try { Q.gameDone({ gid: gid, mode: mode, raw: raw }); } catch (e) {} }
    Object.keys(pgames).forEach(function (k) { var r = pgames[k]; if (!r || !r.a || !r.b || !sideIn(r)) return; if (derive(r).status === "done") send("d:" + k, k, "direct", r); });
    Object.keys(games).forEach(function (k) { var g = games[k]; if (!g || !g.p || g.status !== "done") return; if ((g.p.a && g.p.a.id === id) || (g.p.b && g.p.b.id === id)) send("s:" + k, k, "secure", g); });
  }
  setInterval(function () { try { questScan(); } catch (e) {} }, 5000);
  function badge() { var g = myGid ? viewOf(myGid, myMode) : null; btn.style.color = g && g.status !== "done" ? "#4ade80" : ""; }
  function waitingList() {
    var out = [], t = now();
    Object.keys(games).forEach(function (k) { var g = games[k]; if (g && g.status === "waiting" && g.p && g.p.a) out.push({ gid: k, mode: "secure", type: g.type || "ttt", bet: g.bet, host: g.p.a.name, created: g.created || 0, opt: g.opt }); });
    Object.keys(pgames).forEach(function (k) {
      var r = pgames[k]; if (!r || !r.a) return;
      var st = derive(r); if (st.status !== "waiting" || t - ((r.seen && r.seen.a) || r.created || 0) > WAIT_STALE) return;
      out.push({ gid: k, mode: "direct", type: r.type, bet: r.bet, host: r.a.name, created: r.created || 0, opt: r.opt });
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
  var picked = 1, selGame = "ttt", busy = false, lastViewKey = "";
  function render() {
    if (!open) return;
    var viewKey = myGid ? "g" + myGid : spectate ? "s" + spectate.gid : "l", keepY = viewKey === lastViewKey ? pane.scrollTop : 0;   // keep your scroll position while the same screen redraws
    var gcWasFocused = !!(gc.inp && document.activeElement === gc.inp), gcCaret = gcWasFocused ? gc.inp.selectionStart : 0;   // keep typing in the game chat while the screen redraws
    lastViewKey = viewKey; pane.textContent = "";
    requestAnimationFrame(function () { pane.scrollTop = keepY; });
    var wrap = el("div", "gm-wrap"); pane.appendChild(wrap);
    var h = el("div", "gm-h");
    var mb = el("button", "mobile-menu-btn", "\u2630"); mb.type = "button"; mb.setAttribute("aria-label", "Open menu"); h.appendChild(mb);   // phones only: opens the sidebar drawer (the app's own handler does the toggling)
    h.appendChild(el("h2", "", "\uD83C\uDFAE Games"));
    h.appendChild(el("div", "gm-stock", me() ? "\uD83D\uDCE6 " + crates(stock()) : "Not logged in")); wrap.appendChild(h);
    errBox = el("div", "gm-err"); wrap.appendChild(errBox);
    if (!me()) { wrap.appendChild(el("div", "gm-note", "Log in to play games.")); return; }
    var g = myGid ? viewOf(myGid, myMode) : null;
    gcSync(g);
    if (g) renderGame(wrap, g); else if (spectate && viewOf(spectate.gid, spectate.mode)) renderSpectate(wrap, viewOf(spectate.gid, spectate.mode)); else renderLobby(wrap);
    if (gcWasFocused && gc.inp) { gc.inp.focus(); try { gc.inp.setSelectionRange(gcCaret, gcCaret); } catch (e) {} }
  }

  function renderLobby(wrap) {
    gcSweep();
    var have = stock(), opts = BETS.filter(function (b) { return b <= have; });   // only amounts you actually have
    if (opts.indexOf(picked) < 0) picked = opts.length > 1 ? opts[1] : 0;   // 0x is always possible; start on 1x when you have a crate
    var c = el("div", "gm-card"); c.appendChild(el("h3", "", "Create a game"));
    var sel = document.createElement("select"); sel.className = "gm-sel";
    ORDER.forEach(function (k) { var o = document.createElement("option"); o.value = k; o.textContent = NAMES[k]; sel.appendChild(o); });
    sel.value = selGame; sel.onchange = function () { selGame = sel.value; render(); }; c.appendChild(sel);
    c.appendChild(el("div", "gm-note", RULES[selGame]));
    if (selGame === "ch") c.appendChild(chOptions());
    // which layer
    var ms = document.createElement("select"); ms.className = "gm-sel"; ms.style.marginLeft = "8px";
    [["auto", "Mode: automatic"], ["secure", "Mode: Secure (server)"], ["direct", "Mode: Direct (no server)"]].forEach(function (m) { var o = document.createElement("option"); o.value = m[0]; o.textContent = m[1]; ms.appendChild(o); });
    ms.value = modePref; ms.onchange = function () { modePref = ms.value; try { localStorage.setItem("vus_games_mode", modePref); } catch (e) {} if (modePref !== "direct") probe(true).then(function () { lastSig = ""; onGames(); }); render(); };
    c.appendChild(ms);
    var cm = createMode();
    c.appendChild(el("div", "gm-note", (serverUp === null ? "Checking the game server\u2026 " : serverUp ? "Game server reachable. " : "Game server not reachable from here. ") +
      (cm === "secure" ? "This game will be Secure: the server runs it, so it can't be cheated." : "This game will be Direct: it works without the server, but it relies on both players' browsers, so a determined cheater could fake results or crates.")));
    {
      if (opts.length === 1) c.appendChild(el("div", "gm-note", "You have no crates, so only free 0x games are open to you. A new crate can be earned every hour by chatting."));
      c.appendChild(el("div", "gm-note", "Pick how many crates to bet. 0x is a free game: no crates are bet, and it still counts as a real game for quests. Otherwise the winner takes both bets. Leaving, or being disconnected for 15 seconds, gives your bet to the other player."));
      var bets = el("div", "gm-bets");
      opts.forEach(function (n) { var b = el("button", "gm-bet" + (n === picked ? " on" : ""), n + "x"); b.type = "button"; b.onclick = function () { picked = n; render(); }; bets.appendChild(b); });
      c.appendChild(bets);
      var go = el("button", "gm-btn p", picked === 0 ? "Create free game (0x)" : "Create game (" + crates(picked) + ")"); go.type = "button"; go.disabled = busy || (cm === "secure" && serverUp === false);
      go.onclick = function () { act(function () { return cm === "direct" ? dCreate(selGame, picked, chCreateOpts()) : call("create", { game: selGame, bet: picked, opt: chCreateOpts() }).then(function (r) { return { gid: r.gid, mode: "secure" }; }); }); };
      c.appendChild(go);
    }
    var prow = el("div"); prow.style.cssText = "margin-top:12px";   // practice vs a bot lives in a popup so it takes no room here
    var pbtn = el("button", "gm-btn", "\uD83E\uDD16 Practice against a bot"); pbtn.type = "button"; pbtn.disabled = busy; pbtn.onclick = openPracticePopup;
    prow.appendChild(pbtn); c.appendChild(prow);
    wrap.appendChild(c);

    var list = waitingList().filter(function (w) { return !(me() && ((games[w.gid] && games[w.gid].p.a.id === me()) || (pgames[w.gid] && pgames[w.gid].a.id === me()))); });
    var l = el("div", "gm-card"); l.appendChild(el("h3", "", "Open games"));
    if (!list.length) l.appendChild(el("div", "gm-note", "No open games right now. Create one and wait for someone to join."));
    list.forEach(function (w) {
      var row = el("div", "gm-row"), info = el("div", "grow"), b = el("b", "", w.host);
      b.appendChild(el("span", "gm-tag " + (w.mode === "secure" ? "s" : "d"), w.mode === "secure" ? "Secure" : "Direct"));
      info.appendChild(b); info.appendChild(el("span", "", (NAMES[w.type] || "Game") + chLobbyInfo(w) + (w.bet ? " \u00B7 bet " + w.bet + "x (" + crates(w.bet) + ")" : " \u00B7 free game (0x)")));
      var needServer = w.mode === "secure" && serverUp === false;
      var j = el("button", "gm-btn p", needServer ? "Server needed" : have >= w.bet ? "Join" : "Need " + w.bet); j.type = "button"; j.disabled = busy || needServer || have < w.bet;
      j.onclick = function () { act(function () { return w.mode === "direct" ? dJoin(w.gid) : call("join", { gid: w.gid }).then(function (r) { return { gid: r.gid, mode: "secure" }; }); }); };
      row.append(info, j); l.appendChild(row);
    });
    wrap.appendChild(l);
    renderLiveGames(wrap);
  }

  // ── Spectating: anyone can watch a running 1v1 game (read-only). Spectators never write anything. ──
  function liveList() {
    var out = [];
    Object.keys(games).forEach(function (k) {
      var g = games[k];
      if (g && g.status === "playing" && g.p && g.p.a && g.p.b) out.push({ gid: k, mode: "secure", type: g.type || "ttt", bet: g.bet, a: g.p.a.name, b: g.p.b.name, score: g.score || { a: 0, b: 0 }, started: g.startedAt || 0 });
    });
    Object.keys(pgames).forEach(function (k) {
      var r = pgames[k]; if (!r || !r.a || !r.b) return;
      var st = derive(r); if (st.status !== "playing") return;
      out.push({ gid: k, mode: "direct", type: r.type, bet: r.bet, a: r.a.name, b: r.b.name, score: st.score, started: st.startT || 0 });
    });
    return out.sort(function (x, y) { return y.started - x.started; });
  }
  function renderLiveGames(wrap) {
    var list = liveList();
    var c = el("div", "gm-card"); c.appendChild(el("h3", "", "Live games (watch)"));
    if (!list.length) c.appendChild(el("div", "gm-note", "No games are being played right now."));
    list.forEach(function (w) {
      var row = el("div", "gm-row"), info = el("div", "grow"), b = el("b", "", w.a + " vs " + w.b);
      b.appendChild(el("span", "gm-tag " + (w.mode === "secure" ? "s" : "d"), w.mode === "secure" ? "Secure" : "Direct"));
      info.appendChild(b);
      info.appendChild(el("span", "", (NAMES[w.type] || "Game") + " \u00B7 bet " + w.bet + "x" + (w.type === "c4" || w.type === "ch" ? "" : " \u00B7 " + (w.type === "ck" ? "pieces " : "score ") + w.score.a + "\u2013" + w.score.b)));
      var v = el("button", "gm-btn p", "Watch"); v.type = "button";
      v.onclick = function () { spectate = { gid: w.gid, mode: w.mode }; lastSig = ""; showErr(""); render(); };
      row.append(info, v); c.appendChild(row);
    });
    wrap.appendChild(c);
  }
  function renderSpectate(wrap, g) {
    var type = g.type || "ttt", sc = g.score || { a: 0, b: 0 }, A = g.p.a.name, B = g.p.b ? g.p.b.name : "";
    var top = el("div", "gm-top");
    var left = el("div"); left.appendChild(el("div", "gm-pl", A));
    var mid = el("div", "gm-center"); mid.appendChild(el("div", "gm-score", type === "c4" || type === "ch" ? "vs" : sc.a + " \u2013 " + sc.b));
    var sub = el("div", "gm-note", "\uD83D\uDC41 Watching \u00B7 " + (NAMES[type] || "Game") + " \u00B7 pot " + crates(g.bet * 2));
    sub.appendChild(el("span", "gm-tag " + (g.mode === "direct" ? "d" : "s"), g.mode === "direct" ? "Direct" : "Secure")); mid.appendChild(sub);
    var right = el("div"); right.style.textAlign = "right"; right.appendChild(el("div", "gm-pl", B));
    top.append(left, mid, right); wrap.appendChild(top);
    var card = el("div", "gm-card");
    if (g.status === "playing") {
      timerEl = el("div", "gm-timer"); var tw = el("div", "gm-center"); tw.appendChild(timerEl); card.appendChild(tw);
      if (type === "rps") {
        var pk = g.picked || {};
        card.appendChild(el("div", "gm-status", "Round " + g.round + ": " + A + (pk.a ? " has picked" : " is choosing") + ", " + B + (pk.b ? " has picked" : " is choosing")));
        var lr = g.lastRound;
        if (lr && lr.a) card.appendChild(el("div", "gm-banner", "Last round: " + A + " " + ICON[lr.a] + " vs " + B + " " + ICON[lr.b] + " \u2014 " + (lr.winner ? (lr.winner === "a" ? A : B) + " won it." : "a tie.")));
      } else {
        var first = type === "c4" ? ["Red", "Yellow"] : type === "ck" ? ["Red", "Black"] : type === "ch" ? ["White", "Black"] : ["X", "O"], starter = g.starter || "a";
        card.appendChild(el("div", "gm-status", (g.turn === "a" ? A : B) + "'s turn"));
        card.appendChild(type === "ch" ? chSpectate(g) : type === "c4" ? c4Board(g, false, false) : type === "ck" ? ckBoard(g, false, false, "a") : tttBoard(g, false, false));
        card.appendChild(el("div", "gm-note gm-center", first[0] + ": " + (starter === "a" ? A : B) + " \u00B7 " + first[1] + ": " + (starter === "a" ? B : A)));
      }
    } else {
      var r = g.result || {};
      var d = el("div", "gm-done");
      d.appendChild(el("h3", "", r.winner ? (r.winner === "a" ? A : B) + " won!" : "No winner (refunded)"));
      d.appendChild(el("div", "gm-note", r.msg || "The game ended."));
      if (type === "c4" && g.board) d.appendChild(c4Board(g, false, false));
      if (type === "ttt" && g.board) d.appendChild(tttBoard(g, false, false));
      if (type === "ck" && g.board) d.appendChild(ckBoard(g, false, false, "a"));
      if (type === "ch" && g.board) d.appendChild(chBoard(g, false, false, "w"));
      card.appendChild(d);
    }
    var stop = el("button", "gm-btn", "Stop watching"); stop.type = "button"; var sw = el("div", "gm-center"); sw.appendChild(stop); card.appendChild(sw);
    stop.onclick = function () { spectate = null; lastSig = ""; render(); };
    wrap.appendChild(card);
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
  function doStop(g) { return g.mode === "direct" ? dStop(myGid) : call("stop", { gid: myGid }); }
  function doMove(g, payload) { if (payload.from !== undefined) return g.mode === "direct" ? dMoveCk(myGid, payload.from, payload.to, payload.promo) : call("move", { gid: myGid, from: payload.from, to: payload.to, promo: payload.promo }); return g.mode === "direct" ? dMove(myGid, payload.cell !== undefined ? payload.cell : payload.col) : call("move", Object.assign({ gid: myGid }, payload)); }

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

  // Checkers board. view = whose side is at the bottom ("a" or "b"). Click one of your pieces, then a highlighted square.
  var ckSel = -1, ckSelFor = "";
  function ckBoard(g, mineTurn, live, view) {
    var board = el("div", "gm-ck"), key = g.board + ":" + g.turn + ":" + g.chain;
    if (ckSelFor !== key) { ckSel = -1; ckSelFor = key; }
    var chain = g.chain >= 0 ? g.chain : -1, play = live && mineTurn && !busy;
    var moves = play ? ckMoves(g.board, view, chain) : [], movable = {}, targets = {};
    moves.forEach(function (m) { movable[m.f] = true; });
    if (chain >= 0 && play) ckSel = chain;
    if (ckSel >= 0 && !movable[ckSel]) ckSel = -1;
    moves.forEach(function (m) { if (m.f === ckSel) targets[m.t] = m; });
    var lm = g.lastMove || null;
    for (var k = 0; k < 64; k++) (function (i) {
      var r = i >> 3, c = i & 7, dark = (r + c) % 2 === 1, v = g.board[i];
      if (!dark) { board.appendChild(el("div", "gm-sq lt")); return; }
      var cls = "gm-sq dk" + (i === ckSel ? " sel" : "") + (targets[i] ? (targets[i].x >= 0 ? " tgx" : " tg") : "") + (lm && (i === lm.f || i === lm.t) ? " last" : "") + (movable[i] ? " mv" : "");
      var sq = el("button", cls); sq.type = "button"; sq.disabled = !play;
      if (v !== "_") { var pc = el("span", "gm-pc " + ckSide(v), v === v.toUpperCase() ? "♛" : ""); sq.appendChild(pc); }
      sq.onclick = function () {
        if (targets[i]) { var to = i, from = ckSel; ckSel = -1; act(function () { return doMove(g, { from: from, to: to }); }); }
        else if (movable[i]) { ckSel = i === ckSel ? -1 : i; render(); }
        else if (ckSel >= 0 && chain < 0) { ckSel = -1; render(); }
      };
      board.appendChild(sq);
    })(view === "b" ? 63 - k : k);
    return board;
  }

  // ── Chess screen ──
  // Host options live in chOpt while creating a game. On the board: click one of your pieces, then a highlighted square (a pawn reaching the last row asks which piece to promote to).
  var chOpt = { tm: 600, pm: 0, c: "random" }, chClk = null, chSel = -1, chSelFor = "", chPend = null;
  var CH_GLYPH = { k: "\u265A", q: "\u265B", r: "\u265C", b: "\u265D", n: "\u265E", p: "\u265F" };
  function chCreateOpts() { return selGame === "ch" ? { tm: chOpt.tm, pm: chOpt.pm, c: chOpt.c } : null; }
  function chDesc(o) { var s = (o.tm ? o.tm / 60 : 10) + " min each"; if (o.pm) s += ", " + (o.pm >= 60 ? o.pm / 60 + " min" : o.pm + " sec") + " per move"; return s; }
  function chInfo(type, g) { return type === "ch" ? " \u00B7 " + chDesc(g) : ""; }
  function chLobbyInfo(w) { return w.type === "ch" && w.opt ? " \u00B7 " + chDesc(w.opt) + " \u00B7 you play " + (w.opt.w === "a" ? "Black" : "White") : ""; }
  function chOptions(po) {   // po = the options object to edit (the practice card passes its own)
    var O = po || chOpt, box = el("div"); box.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;margin:10px 0";
    function pick(label, vals, cur, onSet) {
      var lb = el("label", "gm-note", label + " "); lb.style.cssText = "margin:0;display:flex;align-items:center;gap:6px";
      var s = document.createElement("select"); s.className = "gm-sel";
      vals.forEach(function (v) { var o = document.createElement("option"); o.value = v[0]; o.textContent = v[1]; s.appendChild(o); });
      s.value = String(cur); s.onchange = function () { onSet(s.value); };
      lb.appendChild(s); box.appendChild(lb);
    }
    pick("Time each:", [[180, "3 min"], [300, "5 min"], [600, "10 min"], [900, "15 min"], [1800, "30 min"]], O.tm, function (v) { O.tm = Number(v); });
    pick("Time per move:", [[0, "No limit"], [15, "15 sec"], [30, "30 sec"], [60, "1 min"], [120, "2 min"]], O.pm, function (v) { O.pm = Number(v); });
    pick("You play:", [["random", "Random"], ["white", "White"], ["black", "Black"]], O.c, function (v) { O.c = v; });
    return box;
  }
  function chRow(name, white, you) {   // a player's name tag and clock
    var row = el("div", "gm-ch-row"), n = el("span", "", name + (you ? " (you)" : "") + " \u00B7 " + (white ? "White" : "Black")), t = el("div", "gm-timer", "--:--");
    row.appendChild(n); row.appendChild(t);
    return { row: row, timer: t };
  }
  function paintChess(g) {
    var t = now(), used = g.status === "playing" && g.turnT ? Math.max(0, t - g.turnT) : 0, clk = g.clock || {};
    if (chClk) ["a", "b"].forEach(function (s) {
      var e = chClk[s]; if (!e) return;
      var run = g.status === "playing" && g.turn === s;
      e.textContent = fmt((clk[s] || 0) - (run ? used : 0)); e.classList.toggle("ot", run);
    });
    if (timerEl) { timerEl.classList.remove("ot"); timerEl.style.display = g.pm && g.status === "playing" ? "" : "none"; if (g.pm) timerEl.textContent = "Move limit " + fmt(g.pm * 1000 - used); }
  }
  function chBoard(g, mineTurn, live, view) {   // view = the colour shown at the bottom ("w" or "b")
    var board = el("div", "gm-ck"), key = g.board + ":" + g.turn + ":" + g.status;
    if (chSelFor !== key) { chSel = -1; chPend = null; chSelFor = key; }
    var play = live && mineTurn && !busy, S = { board: g.board, cast: g.cast || "", ep: g.ep == null ? -1 : g.ep, half: g.half || 0 };
    var moves = play ? chLegal(S, view) : [], movable = {}, targets = {};
    moves.forEach(function (m) { movable[m.f] = true; });
    if (chSel >= 0 && !movable[chSel]) chSel = -1;
    moves.forEach(function (m) { if (m.f === chSel && !targets[m.t]) targets[m.t] = m; });
    var lm = g.lastMove || null, ksq = g.inCheck && g.status === "playing" ? chKing(g.board, g.turn === g.white ? "w" : "b") : -1;
    for (var k = 0; k < 64; k++) (function (i) {
      var r = i >> 3, c = i & 7, v = g.board[i];
      var cls = "gm-sq " + ((r + c) % 2 === 0 ? "lt" : "dk") + (i === chSel ? " sel" : "") + (targets[i] ? (v !== "_" || targets[i].e ? " tgx" : " tg") : "") + (lm && (i === lm.f || i === lm.t) ? " last" : "") + (i === ksq ? " chk" : "") + (movable[i] ? " mv" : "");
      var sq = el("button", cls); sq.type = "button"; sq.disabled = !play;
      if (v !== "_") sq.appendChild(el("span", "gm-cp " + chCol(v), CH_GLYPH[v.toLowerCase()] + "\uFE0E"));
      if (view === "w" ? c === 0 : c === 7) sq.appendChild(el("span", "gm-co l", String(8 - r)));
      if (view === "w" ? r === 7 : r === 0) sq.appendChild(el("span", "gm-co f", "abcdefgh".charAt(c)));
      sq.onclick = function () {
        if (targets[i]) {
          if (targets[i].p) { chPend = { f: chSel, t: i }; render(); return; }
          var from = chSel, to = i; chSel = -1; chPend = null;
          act(function () { return doMove(g, { from: from, to: to }); });
        } else if (movable[i]) { chSel = i === chSel ? -1 : i; chPend = null; render(); }
        else if (chSel >= 0) { chSel = -1; chPend = null; render(); }
      };
      board.appendChild(sq);
    })(view === "b" ? 63 - k : k);
    return board;
  }
  function chPlay(g, mineTurn, side, oppName) {   // clocks + board (+ the promotion choice) for a player
    var opp = other(side), w = el("div"), top = chRow(oppName, g.white === opp, false), bot = chRow(g.p[side].name, g.white === side, true);
    chClk = {}; chClk[opp] = top.timer; chClk[side] = bot.timer;
    w.appendChild(top.row);
    w.appendChild(chBoard(g, mineTurn, true, g.white === side ? "w" : "b"));
    if (chPend && mineTurn) {
      var pr = el("div", "gm-center"); pr.appendChild(el("div", "gm-note gm-center", "Promote to:"));
      [["q", "Queen"], ["r", "Rook"], ["b", "Bishop"], ["n", "Knight"]].forEach(function (p) {
        var b = el("button", "gm-btn", CH_GLYPH[p[0]] + "\uFE0E " + p[1]); b.type = "button"; b.disabled = busy; b.style.margin = "0 4px 6px";
        b.onclick = function () { var pp = chPend; chPend = null; chSel = -1; act(function () { return doMove(g, { from: pp.f, to: pp.t, promo: p[0] }); }); };
        pr.appendChild(b);
      });
      w.appendChild(pr);
    }
    w.appendChild(bot.row);
    paintChess(g);
    return w;
  }
  function chSpectate(g) {   // read-only board with White at the bottom
    var w = el("div"), ws = g.white || "a", bs = other(ws), top = chRow(g.p[bs].name, false, false), bot = chRow(g.p[ws].name, true, false);
    chClk = {}; chClk[bs] = top.timer; chClk[ws] = bot.timer;
    w.appendChild(top.row); w.appendChild(chBoard(g, false, false, "w")); w.appendChild(bot.row);
    paintChess(g);
    return w;
  }

  // ── Live chat inside a real 1v1 game (Direct and Secure; practice games have none). It lives at gchat/<gid>: c = created, p/<id> = who has the game
  //    screen open right now, m/<key> = messages. When the last player leaves the game screen, the whole gchat/<gid> node is deleted. If a tab dies, the
  //    database drops its p/<id> by itself and gcSweep() later removes chats nobody is in. The text goes through the main chat's word filter. ──
  function gcSync(g) {   // render() calls this: follow the game screen I am on
    var want = g && !g.practice && g.p && g.p.a && g.p.b && myGid ? myGid : "";
    if (want === gc.gid) return;
    if (gc.gid) gcLeave();
    if (want) gcJoin(want);
  }
  function gcAdd(m) {
    if (!gc.log || !m) return;
    var mine = String(m.i) === me(), row = el("div"), txt = String(m.x || "").slice(0, GC_MAX), f = chat().maskFiltered;
    row.style.cssText = "margin:2px 0;word-break:break-word";
    var who = el("b", "", mine ? "You" : String(m.n || "Player").slice(0, 40)); who.style.color = mine ? "#4ade80" : "#93c5fd";
    try { if (f) txt = f(txt); } catch (e) {}
    row.appendChild(who); row.appendChild(document.createTextNode(": " + txt)); gc.log.appendChild(row);
    while (gc.log.childNodes.length > 100) gc.log.removeChild(gc.log.firstChild);
    gc.log.scrollTop = gc.log.scrollHeight;
  }
  function gcSend() {
    if (!gc.ref || !gc.inp) return;
    var v = gc.inp.value.replace(/\s+/g, " ").trim().slice(0, GC_MAX), t = Date.now();
    if (!v || t - gc.last < GC_EVERY) return;
    gc.last = t; gc.inp.value = "";
    gc.mref.push({ i: me(), n: myName(), x: v, t: TS() }).catch(function () { gcAdd({ i: "", n: "Chat", x: "Couldn't send that. The newest database rules (gchat) may not be published yet." }); });
  }
  function gcJoin(gid) {
    var d = db(), id = me(); if (!d || !id) return;
    gc.gid = gid; gc.ref = d.ref("gchat/" + gid); gc.mref = gc.ref.child("m");
    var box = el("div", "gm-card"), log = el("div"), row = el("div"), inp = document.createElement("input"), send = el("button", "gm-btn p", "Send");
    box.appendChild(el("h3", "", "\uD83D\uDCAC Game chat"));
    log.style.cssText = "height:150px;overflow:auto;background:#0f172a;border-radius:8px;padding:8px 10px;font-size:14px;color:#e2e8f0;margin:6px 0";
    row.style.cssText = "display:flex;gap:8px";
    inp.type = "text"; inp.maxLength = GC_MAX; inp.placeholder = "Say something to your opponent\u2026"; inp.setAttribute("autocomplete", "off");
    inp.style.cssText = "flex:1;min-width:0;padding:9px 10px;border-radius:8px;border:1.5px solid #334155;background:#0f172a;color:#e2e8f0;font-size:15px";
    send.type = "button"; send.onclick = gcSend;
    inp.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); gcSend(); } });
    row.appendChild(inp); row.appendChild(send);
    box.appendChild(log); box.appendChild(row);
    box.appendChild(el("div", "gm-note", "This chat is deleted when you both leave the game screen."));
    gc.box = box; gc.log = log; gc.inp = inp;
    var pr = gc.ref.child("p/" + id);
    gc.conn = d.ref(".info/connected");   // (re)mark me as here whenever the connection is up; the database un-marks me if my tab dies
    gc.connFn = gc.conn.on("value", function (s) { if (s.val() === true && gc.gid === gid) { try { pr.onDisconnect().remove(); } catch (e) {} pr.set(true).catch(function () {}); } });
    gc.ref.child("c").set(TS()).catch(function () {});   // refused when it already exists: fine
    gc.mref.limitToLast(100).on("child_added", function (s) { if (gc.gid === gid) gcAdd(s.val()); }, function () {});
  }
  function gcLeave() {
    var ref = gc.ref, id = me();
    try { if (gc.mref) gc.mref.off(); } catch (e) {}
    try { if (gc.conn && gc.connFn) gc.conn.off("value", gc.connFn); } catch (e) {}
    gc.gid = ""; gc.ref = null; gc.mref = null; gc.conn = null; gc.connFn = null; gc.box = null; gc.log = null; gc.inp = null;
    if (!ref || !id) return;
    var pr = ref.child("p/" + id);
    try { pr.onDisconnect().cancel(); } catch (e) {}
    // I am off the game screen: take my mark away; if nobody else is marked, delete the whole chat.
    pr.remove().then(function () { return ref.child("p").get(); }).then(function (s) { if (!s.exists()) return ref.remove(); }).catch(function () {});
  }
  function gcSweep() {   // from time to time, remove chats that nobody is in any more (for example after a closed tab)
    var d = db(), t = Date.now(); if (!d || !me() || t - gc.sweptAt < 300000) return; gc.sweptAt = t;
    d.ref("gchat").orderByChild("c").endAt(now() - 600000).limitToFirst(20).get().then(function (s) {
      s.forEach(function (ch) { var v = ch.val() || {}; if (!v.p || Number(v.c) < now() - GC_STALE) ch.ref.remove().catch(function () {}); });
    }).catch(function () {});
  }
  function renderGame(wrap, g) {
    var id = me(), side = g.p.a && g.p.a.id === id ? "a" : "b", opp = side === "a" ? "b" : "a", type = g.type || "ttt";
    var top = el("div", "gm-top");
    var left = el("div"); left.appendChild(el("div", "gm-pl me", g.p[side].name + " (you)"));
    var mid = el("div", "gm-center"), sc = g.score || { a: 0, b: 0 };
    mid.appendChild(el("div", "gm-score", type === "c4" || type === "ch" ? "vs" : sc[side] + " \u2013 " + sc[opp]));
    var sub = el("div", "gm-note", (NAMES[type] || "Game") + chInfo(type, g) + (g.practice ? " \u00B7 vs " + LVN[g.lvl] + " bot \u00B7 no bet" : g.bet ? " \u00B7 bet " + g.bet + "x each \u00B7 pot " + crates(g.bet * 2) : " \u00B7 free game (0x)"));
    sub.appendChild(el("span", "gm-tag " + (g.mode === "direct" ? "d" : "s"), g.practice ? "Practice" : g.mode === "direct" ? "Direct" : "Secure")); mid.appendChild(sub);
    var right = el("div"); right.style.textAlign = "right"; right.appendChild(el("div", "gm-pl", g.p[opp] ? g.p[opp].name : "Waiting\u2026"));
    top.append(left, mid, right); wrap.appendChild(top);

    var card = el("div", "gm-card");
    if (g.status === "waiting") {
      card.appendChild(el("div", "gm-status", "Waiting for someone to join\u2026"));
      card.appendChild(el("div", "gm-note gm-center", g.bet ? "Your bet of " + crates(g.bet) + " is held until the game ends. Keep this tab open. Cancelling gives it back." : "This is a free game: no crates are bet. Keep this tab open."));
      var cancel = el("button", "gm-btn d", "Cancel game"); cancel.type = "button"; var cw = el("div", "gm-center"); cw.appendChild(cancel); card.appendChild(cw);
      cancel.onclick = function () { act(function () { return g.mode === "direct" ? dLeave(myGid) : call("leave", { gid: myGid }); }); };
      var bi = el("button", "gm-btn", "Play the bot instead"); bi.type = "button"; bi.disabled = busy; bi.style.marginLeft = "8px";
      bi.onclick = function () { gmConfirm("Play the bot instead?", "Your open game is cancelled and your bet comes back. You then play a practice game against the bot (Normal level, no bet).", "Play the bot", function () { act(function () { return waitToBot(g); }); }); };
      cw.appendChild(bi);
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
        var mineTurn = g.turn === side, markName = type === "c4" ? (side === g.starter ? "Red" : "Yellow") : type === "ck" ? (side === "a" ? "Red" : "Black") : type === "ch" ? (side === g.white ? "White" : "Black") : (side === g.starter ? "X" : "O");
        var stTxt = mineTurn ? "Your turn (" + markName + ")" : oppName + "'s turn";
        if (type === "ch" && g.inCheck) stTxt += " - check!";
        if (type === "ck" && mineTurn) stTxt = g.chain >= 0 ? "Keep jumping with the highlighted piece, or stop here" : stTxt + (ckMoves(g.board, side, -1).some(function (m) { return m.x >= 0; }) ? " · you can capture (optional)" : "");
        card.appendChild(el("div", "gm-status", stTxt));
        card.appendChild(type === "ch" ? chPlay(g, mineTurn, side, oppName) : type === "c4" ? c4Board(g, mineTurn, true) : type === "ck" ? ckBoard(g, mineTurn, true, side) : tttBoard(g, mineTurn, true));
        if (type === "ck") {
          card.appendChild(el("div", "gm-note gm-center", "You are " + markName + (side === "a" ? " (moving up)" : " (moving down)") + ". The numbers at the top are pieces left."));
          if (mineTurn && g.chain >= 0) { var stp = el("button", "gm-btn", "Stop here (end my turn)"); stp.type = "button"; stp.disabled = busy; stp.onclick = function () { act(function () { return doStop(g); }); }; var stw = el("div", "gm-center"); stw.appendChild(stp); card.appendChild(stw); }
        }
        if (type === "ttt" && lr && now() - lr.at < 4000) banner = lr.winner ? g.p[lr.winner].name + " won round " + lr.round + "!" : "Round " + lr.round + " was a draw. Replaying.";
      }
      card.appendChild(el("div", "gm-banner", banner));
      card.appendChild(el("div", "gm-note gm-center", (type === "c4" || type === "ck" || type === "ch" ? "One game" : "Round " + g.round) + (g.draws ? " \u00B7 " + g.draws + (g.draws === 1 ? " tie" : " ties") : "") + (g.practice ? ". Practice game: nothing is bet and nothing is saved." : ". Keep this tab open: if you are disconnected for 15 seconds your bet goes to " + oppName + ".")));
      var lv = el("button", "gm-btn d", "Leave game"); lv.type = "button"; var lw = el("div", "gm-center"); lw.appendChild(lv); card.appendChild(lw);
      lv.onclick = g.practice ? function () { gmConfirm("Leave this practice game?", "Nothing is bet, so nothing is lost.", "Leave", function () { lLeave(); }); } : function () { gmConfirm("Leave this game?", g.bet ? "Your bet of " + crates(g.bet) + " goes to " + oppName + "." : "This is a free game, so you lose nothing, but " + oppName + " wins.", "Leave game", function () { act(function () { return g.mode === "direct" ? dLeave(myGid) : call("leave", { gid: myGid }); }); }); };
      paintTimer(g);
    } else {   // done
      var r = g.result || {}, won = r.winner === side, refund = !r.winner;
      var d = el("div", "gm-done");
      d.appendChild(el("h3", "", g.practice ? (refund ? "\uD83E\uDD1D Draw" : won ? "\uD83C\uDF89 You beat the bot!" : "The bot won this time") : refund ? (g.bet ? "\uD83D\uDD01 Refunded" : "\uD83E\uDD1D Draw") : won ? "\uD83C\uDF89 You won" + (g.bet ? " " + crates(g.bet * 2) : "") + "!" : "You lost" + (g.bet ? " " + crates(g.bet) : "")));
      d.appendChild(el("div", "gm-note", r.msg || "The game ended."));
      if (type === "rps" && g.lastRound && g.lastRound.a) d.appendChild(el("div", "gm-banner", "Final round: you " + ICON[g.lastRound[side]] + " vs " + g.p[opp].name + " " + ICON[g.lastRound[opp]]));
      if (type === "c4" && g.board) d.appendChild(c4Board(g, false, false));
      if (type === "ttt" && g.board) d.appendChild(tttBoard(g, false, false));
      if (type === "ck" && g.board) d.appendChild(ckBoard(g, false, false, side));
      if (type === "ch" && g.board) d.appendChild(chBoard(g, false, false, g.white === side ? "w" : "b"));
      var back = el("button", "gm-btn p", "Back to games"); back.type = "button"; back.onclick = function () { lDrop(myGid); myGid = ""; myMode = ""; stopLoop(); showErr(""); lastSig = ""; render(); };
      if (g.practice && g.prac) {   // practice games can be replayed with the same settings
        var again = el("button", "gm-btn", "Play again"); again.type = "button"; again.style.marginRight = "8px";
        again.onclick = function () { var pr = g.prac; lDrop(myGid); myGid = ""; myMode = ""; act(function () { return startPractice(pr.type, pr.lvl, pr.opt); }); };
        d.appendChild(again);
      }
      d.appendChild(back); card.appendChild(d);
    }
    wrap.appendChild(card);
    if (gc.box && gc.gid === myGid) { wrap.appendChild(gc.box); gc.log.scrollTop = gc.log.scrollHeight; }   // the live game chat (built once per game, so typing survives redraws)
  }
  function paintTimer(g) {
    if (g.type === "ch") { paintChess(g); return; }
    if (!timerEl) return;
    var left = (g.deadline || 0) - now();
    timerEl.textContent = (g.overtime ? "Overtime " : "Time left ") + fmt(left);
    timerEl.classList.toggle("ot", !!g.overtime);
  }
  setInterval(function () { var g = myGid ? viewOf(myGid, myMode) : (spectate ? viewOf(spectate.gid, spectate.mode) : null); if (open && g && g.status === "playing") paintTimer(g); }, 500);

  // A finished result should also be noticed when the panel is closed.
  var shown = {};
  setInterval(function () {
    var g = myGid ? viewOf(myGid, myMode) : null; if (!g || g.status !== "done" || shown[myGid] || open) return;
    shown[myGid] = true; btn.style.color = "#fbbf24"; btn.title = "Games: your game ended. Click to see the result.";
  }, 1500);
})();
