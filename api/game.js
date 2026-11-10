// POST /api/game   Authorization: Bearer <login token>   { action, ... }
// The server runs every game, so nobody can fake a win, a move, or a bet. Bets are held in escrow:
// crates are taken from each player when they create/join, and paid out when the match ends.
//   create { game:"ttt"|"rps"|"c4", bet }   join { gid }   move { gid, cell | col | pick }   ping { gid }   leave { gid }   sweep {}
// Game state lives in games/<gid> (public read, only this server can write). Crates are crateClaims/<id>.n.
// Rock-Paper-Scissors picks are kept secret in gamePicks/<gid> (nobody can read it) until both players have picked.
const { admin, chatDb, fail, cors, readBody, accountById, verifyLogin } = require("./_lib");

const GAMES = {
  ttt: { name: "Tic-Tac-Toe", win: 2, ms: 5 * 60 * 1000, extra: 3 * 60 * 1000 },      // first to 2 rounds
  rps: { name: "Rock Paper Scissors", win: 2, ms: 3 * 60 * 1000, extra: 2 * 60 * 1000 },   // first to 2 rounds
  c4:  { name: "Connect 4", win: 1, ms: 8 * 60 * 1000, extra: 3 * 60 * 1000 }          // one game
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
const rpsWinner = (pa, pb) => (pa === pb ? null : BEATS[pa] === pb ? "a" : "b");

// Ends a game and records who gets what. winner = "a" | "b" | null (refund). leaver = the side that left, if any.
function settle(g, kind, winner, now, leaver) {
  const bet = g.bet, who = winner ? nameOf(g, winner) : "";
  const msgs = {
    score: who + " won" + (GAMES[g.type].win > 1 && g.score ? " the match " + Math.max(g.score.a, g.score.b) + "-" + Math.min(g.score.a, g.score.b) : "") + ".",
    forfeit: nameOf(g, leaver) + " left the game. " + who + " wins the bet.",
    disconnect: nameOf(g, leaver) + " was disconnected for 15 seconds. " + who + " wins the bet.",
    bothleft: "Both players disconnected at the same time. Everyone got their crates back.",
    timeout: "Time ran out. " + who + " wins with the most games.",
    "timeout-refund": "The timer ran out with no winner. Everyone got their crates back. Make or join a new game.",
    draw: "It's a draw. Everyone got their crates back.",
    cancel: "The game was cancelled. Your crates were returned."
  };
  g.status = "done";
  g.result = { kind, winner: winner || null, msg: msgs[kind] || "The game ended.", at: now };
  g.pay = winner ? { [winner]: bet * 2, [other(winner)]: 0 } : g.p.b ? { a: bet, b: bet } : { a: bet, b: 0 };
  g.paid = false;
}

function startGame(g, now) {
  const cfg = GAMES[g.type];
  Object.assign(g, { status: "playing", startedAt: now, deadline: now + cfg.ms, overtime: false, score: { a: 0, b: 0 }, round: 1, draws: 0, starter: "a", turn: "a" });
  if (g.type === "ttt") g.board = EMPTY9;
  else if (g.type === "c4") g.board = EMPTY42;
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

// One move in tic-tac-toe or Connect 4. Returns {} or an error.
function applyMove(g, side, b, now) {
  const cfg = GAMES[g.type];
  if (g.turn !== side) return err(409, "NOT_YOUR_TURN", "It's not your turn.");
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
      await ref.set({ type: b.game, status: "waiting", bet, created: now, p: { a: { id, name: acct.account.username } }, seen: { a: now }, v: 2 });
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
      return err(400, "UNKNOWN_ACTION", "Unknown action.", { actions: ["create", "join", "move", "ping", "leave", "sweep"] });
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
