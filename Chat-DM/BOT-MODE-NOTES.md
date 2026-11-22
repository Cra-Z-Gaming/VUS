# VUS D.C – Bot / practice mode: notes from the lost sessions

Saved 2026-11-22 from the log the owner pasted into a new chat ("continue from prev session").
Read this together with HANDOFF.md. HANDOFF.md does not mention bot mode at all yet.

## TL;DR
- Feature being built: a **practice mode against a computer bot** for all 5 1v1 games in `games.js` (tic-tac-toe `ttt`, rock-paper-scissors `rps`, connect 4 `c4`, checkers `ck`, chess `ch`).
- At least two earlier sessions designed it and even wrote the engine code, but **nothing was saved to disk**: the temporary workspace `/home/claude/work` (files `blk_bots.js`, `blk_glue.js`, `bench.js`, patch scripts, `games.orig.js`) is wiped between sessions. Searching `E:\Claude` for `blk_*` found nothing.
- The original wording of the feature request is NOT preserved. Everything under "Design as far as the log shows" is reconstructed from step titles in the log, so confirm details with the owner before relying on them.
- **Rule for every future session: write each finished piece to disk right away** (see "Working method" below). Do not keep code only in the chat or in Claude's temporary workspace.

## State of `games.js` (IMPORTANT, check first)
- Version the earlier sessions worked on: 88,144 bytes (86.08 KB), 1077 lines, LF line endings, `node --check` OK, modified Sat 2026-11-21 23:56:46 Eastern. It had **no bot code** (grep for bot/practice found only localStorage and the chess UI variable `bot`).
- On 2026-11-22 the file on disk is **88,490 bytes**, created/modified Sun 2026-11-22 01:52:58 Eastern. So it was replaced after the log ended (+346 bytes). Who changed it and what changed is **unknown**. It might be a small edit by another session, a partial bot patch, or something the owner did.
- The owner declined a request to copy it to Claude's computer. Next session: ask how to read it (e.g. `read_text_file` in chunks, or search for `practice`, `bot`, `lAppend`), and compare it with the function map below before editing.
- Nothing from the bot work has been pushed or deployed. No rules or Vercel changes are needed for the design below (practice games are local).

## Design as far as the log shows (reconstructed, confirm with owner)
- **Practice games are local**: kept in browser memory, never written to Firebase, so there is no stake, no refund and no server involvement. They are fed through the same `derive()` and the same board renderers as real games.
- **Routing**: when the current game is a practice game, the Direct-mode actions (`dMove`, `dMoveCk`, `dStop`, `dPick`, `dLeave`; `doMove`/`doStop` at ~line 854) go to the local store instead of Firebase. `viewOf(gid, mode)` (~644) needs a local branch.
- **Local store** (names from the log): `lAppend` split into a raw push plus a single post-append hook (the bot reacts there); a cache of the derived state per local game; a guard against bot move loops.
- **Practice games must not count for quests**: `questScan` (~674) reports finished games to `quests.js`; practice games must be excluded.
- **UI**: a "Practice" card in the lobby (`renderLobby`, ~730) with difficulty choices (Easy / Medium / Hard) and independent chess options; a practice note; header stake label and mode tag adapted for practice games; practice-specific Leave and Play again buttons and done-screen heading; a **bot fallback on the waiting screen** (while waiting for an opponent, the player can start a practice game instead; the old waiting game must be dropped without flashing or a join race that forfeits a bet); a "bot instead" leave option.
- **Bot engines** (pure functions, testable in Node):
  - TTT: memoized minimax.
  - RPS: prediction models of the human's picks; Hard counter-picks the predicted move. Commit/reveal flow must be simulated for the bot (timers after each locked pick).
  - Connect 4: negamax with window-scan evaluation, iterative deepening, time budget, depth by difficulty.
  - Checkers: search with quiescence, chain jumps (`stop` option), move ordering, root noise, time checks.
  - Chess: negamax alpha-beta with iterative deepening, quiescence (delta pruning), check extension, killer/MVV move ordering, piece-square tables incl. an endgame king table, a small opening book, root-move noise for Easy, mate detection, draw handling (repetition via `chKey`, dead position via `chDead`), node budget.
  - Safety net: every bot move is validated against the engine; if invalid, fall back to a legal move.
  - Reuse the existing engine functions in `games.js` (`ckMoves`, `ckApply`, `ckCount`, `chLegal`, `chApply`, `chAfter`, `chKey`, `chDead`, `c4Win`, `lineWinner`, `rpsWin`). Do not write a second rules engine.
- Careful with `edit_file`: it uses String.replace semantics, so new text should avoid `$` (the file had exactly 1 `$`).

## Benchmarks measured (Claude's Linux box, Node v22)
Used to size the bots' time budgets, using the existing engines:
- Chess: perft(3) from the start = 8902 nodes in 149 ms (correct). Depth-4 legal-move walk = 197,281 leaves in 433 ms, about 455k leaf nodes/s.
- Checkers: depth-6 walk = 189,345 leaves in 509 ms, about 372k leaves/s.
- Conclusion: the existing chess move generation is fast enough for a modest search in the browser if there is a node/time budget; keep chess Hard to roughly 1 s of thinking and use iterative deepening.

## Map of `games.js` (88,144-byte version; line numbers may have shifted by a few lines now)
- 7 IIFE start; 12 `NAMES`; 13 `RULES`; 21 `CFG` (per-game win/time config); 25 `other(s)`; 28 `sha256hex`.
- Engines: 48 `lineWinner` (ttt); 49 `c4Win`; 65-104 checkers (`ckSide`, `ckJumpsFrom`, `ckStepsFrom`, `ckMoves`, `ckFind`, `ckApply`, `ckCount`); 114-248 chess (`CH_DRAW`, `chOptsOf`, `chCol`, `chMv`, `chAdd`, `chAttacked`, `chPseudo`, `chApply`, `chKing`, `chInCheck`, `chSafe`, `chLegal`, `chHasMove`, `chFind`, `chDead`, `chCanMate`, `chKey`, `chAfter`, `chDeadline`); 249 `rpsWin`.
- 253 `derive(g)`: turns a raw game record into the view the UI uses (log of moves, clocks, status).
- UI helpers 375-406: `el`, `gmConfirm`, `chat()`, `me()`, `myName()`, `stock()` (crates owned), `now()`, `crates()`, `db()`, `TS()`.
- 453 `openPane`, 463 `closePane`, 478 mode preference in localStorage, 489 `createMode`, 493 `showErr`, 511 `friendly`, 521 `sideIn`.
- Direct-mode actions: 556 `dLeave`, 561 `dMove`, 565 `dMoveCk`, 569 `dStop`, 573-575 RPS commits in localStorage, 576 `dPick`, 620 `directHousekeeping`.
- 638 state vars (`games`, `pgames`, `listenRef`, `pgRef`, `myGid`, `myMode`, `loop`, `lastId`, `lastSig`, `myPicks`...); 639 `startListening`; 644 `viewOf`; 645 `findMine`; 657 `onGames`; 673-674 `qLast`/`questScan`; 682 `badge`; 683 `waitingList`; 694-696 `startLoop`/`stopLoop`/`tick`; 714 `render`; 730 `renderLobby`; 777 `liveList`; 790 `renderLiveGames`; 805 `renderSpectate`.
- 851 `fmt`; 853 icons/labels for RPS; 854 `doStop`; 855 `doMove`; 857 `tttBoard`; 867 `c4Board`; 881 `ckBoard`; 909-996 chess UI (`chOpt`, `chCreateOpts`, `chDesc`, `chInfo`, `chLobbyInfo`, `chOptions`, `chRow`, `paintChess`, `chBoard`, `chPlay`, `chSpectate`); 997 `renderGame`; 1062 `paintTimer`; 1072 `shown`; 1077 `})();`.

## Test tools on Claude's side (when the box is fresh)
- Node v22; Python 3.12 with Playwright; Chromium at `/opt/pw-browsers/chromium-1243/chrome-linux64/chrome` (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). No jsdom installed. The temporary workspace is empty at the start of every chat.
- The bench script exposed engine internals by replacing the line `window.VUS_GAMES = { derive: derive, sha256hex: sha256hex };` in a COPY of `games.js` and loading it with `new Function(src)()` and a fake `window`/`document`. Reuse that trick to test bot engines in Node.

## Working method (so this does not get lost a third time)
1. First thing: check `games.js` size and modified time on disk (see "State of games.js") and look for the staging folder below.
2. **Stage work on the owner's disk, not in Claude's workspace**: write each finished block as its own small file in `E:\Claude\VUS D.C\_bot-work\` (for example `bots-ttt-rps.js`, `bots-c4.js`, `bots-ck.js`, `bots-ch.js`, `glue.js`, `lobby-card.js`), with `write_file`, right after it is written. Test each in Node on Claude's side by copying/reading it back, then note "tested" in `_bot-work\PROGRESS.md`.
3. Make a backup of `games.js` (e.g. `games.pre-bot.js` in the same staging folder) before the first edit. Apply edits in small anchored steps; run `node --check` after each.
4. Append a line to this file (or `PROGRESS.md`) after every finished step, not at the end.
5. Do not re-read the whole of `games.js` again: use the map above and read only the ranges needed (`derive`, the Direct-mode actions, `render`/`renderLobby`/`renderGame`).
6. Per HANDOFF.md: show the plan before big features, and finish by telling the owner what must be pushed to GitHub (here: only `games.js`; no rules or Vercel change).

## Progress log
- 2026-11-22: notes saved from the owner's pasted log. No code exists on disk yet. `games.js` found changed (88,490 bytes), contents not yet inspected.
- 2026-11-22 (later, same chat): read the whole of `games.js` via `read_text_file`. The ONLY change since the log is one line: `window.VUS_GAMES = { derive, sha256hex, E: { lineWinner, ckMoves, ckFind, ckApply, ckCount, CK_START, chPseudo, chApply, chInCheck, chLegal, chFind, chAfter, chKey, chDead, CH_START } };   // E = the rule engines, used by the practice bots (bots.js)`. That explains the +346 bytes. There is NO bot/practice UI or local-store code in games.js yet.
- 2026-11-22 (later): a NEW file `E:\Claude\VUS D.C\bots.js` now exists in the project folder (created by one of the other sessions the owner pasted into; it was not there earlier today). So the design moved to a SEPARATE `bots.js` that uses `window.VUS_GAMES.E`. Chat-DM.html's script loader would need a `bots.js` entry and the owner must push `bots.js` to GitHub. Reviewed at ~02:05: `bots.js` (8,995 bytes, written 01:52:56, header says "games.js loads this file the first time someone starts a practice game") contains the Tic-Tac-Toe, Rock Paper Scissors and Connect 4 bots, finished and written as plain functions (`BOTS.ttt(board, mark, lvl)`, `BOTS.rps(hist, lvl)`, `BOTS.c4(board, mark, lvl)`, levels 0/1/2, exposed as `window.VUS_BOTS`). It stops at a `/*@@NEXT@@*/` marker: **Checkers and Chess bots are still missing**. Also still missing in games.js: the loader for bots.js, the local practice-game store, the lobby card and all practice UI. Nothing has been run or tested yet. Status table: `_bot-work/PROGRESS.md`.
- 2026-11-22 02:06: unknown whether the session that wrote bots.js is still running (bots.js untouched for 13 min). Before editing bots.js or games.js again, check their modified times; if they changed, someone else is working, so write new pieces as separate drafts in `_bot-work/` instead.
