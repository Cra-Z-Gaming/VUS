# VUS D.C – handoff for Claude

Read this first when starting a new chat about this project, then continue from "Current status".
Last updated: 2026-11-21 (end of the quests session).

## What this project is
VUS D.C is a browser chat + DM web app (main chat, channels, DMs, shop, crates, coins, tags/bubbles, 1v1 crate games, quests).
- Front end: plain HTML/JS/CSS. `Chat-DM.html` loads its scripts from GitHub raw (`Cra-Z-Gaming/VUS`, folder `Chat-DM/`): `slm.js`, `dm.js`, `dev.js`, `chat.js`, `quests.js`, `games.js`. **Local edits do nothing until they are pushed to GitHub.**
- Back end: Firebase Realtime Database (rules in `vus-chat-rules.json`, `vus-dm-rules.json`, `vus-SLM-rules.json`) plus a small Vercel API in `api/` (`game.js` = server-run "secure" 1v1 games, `auth/`, `bot/`, `chat/` tickets, `dev/`, `ping.js`). `package.json` only needs `firebase-admin`.
- Folder: `E:\Claude\VUS D.C` (Claude can also reach `E:\Claude` and `E:\VUSL Git`).
- Many players cannot reach the Vercel server, so several features have a less secure "direct" Firebase fallback (e.g. `pg/` games). The owner accepts that trade-off.

## Files
| File | What it is |
|---|---|
| `Chat-DM.html` | main page, left rail (Quests button + red dot `questRailDot`), script loader |
| `chat.js` (~650 KB) | chat, coins, shop, crates, cosmetics, /commands, moderation. Too big to read whole: copy it to Claude's computer and grep |
| `dm.js` | DMs, accounts (`VUS_DM.getAccountCreatedAt`) |
| `quests.js` | daily/weekly quests, login reward, welcome bundle, game counting |
| `games.js` | 1v1 crate-betting games (tic-tac-toe, rock-paper-scissors, connect 4, checkers, chess), reports finished games to `quests.js` |
| `slm.js`, `SLM.html`, `vus-SLM-rules.json` | ShareLargeMessages extension |
| `dev.js`, `staff-tool/`, `staff-accounts.json` | staff/dev tools (do not copy secrets into notes or chats) |
| `style.css` | all styling (`.quest-*` classes at the end) |
| `games.txt` | list of launcher games, format `[Title](https://raw-link)` |
| `version` | number file (43), left untouched; not checked what reads it |

## Golden rules for working here
1. **Rules and client are two copies of the same numbers.** Quest rewards, goals, reset times and login amounts live in `quests.js` AND in `vus-chat-rules.json`. Change both, always.
2. After editing `vus-chat-rules.json` the owner must **publish it in Firebase**; after editing a JS file the owner must **push it to GitHub**. Say so at the end of a task.
3. `vus-chat-rules.json` has a few giant single lines (the `coins/$id` `.write` rule is ~14 KB). Edit with small exact substring replacements, then copy the file back (`copy_file_user_to_claude`) and diff/validate it. Never retype the whole file.
4. Firebase rules cannot be tested against the live database from here. Last session a Node simulator (mock `data`/`newData`/`root`, evaluates the rule strings) was used: 101 cases passed. It lived only in Claude's temporary workspace and is not saved. Rebuild it if needed.
5. Security mindset: players can write to Firebase directly, so every reward must be enforced by the rules, not just by the client.
6. Ask before large or irreversible changes. Show the plan for new minigames/features first.

## Quests system (built 2026-11-21)
Coins live in `coins/<id>` (`n` = balance). Resets: daily at 12:00 PM Eastern (17:00 UTC), weekly Saturday 12:00 PM Eastern. Messages earn **2 coins** each (max one per 2 s, 500 per hour).

| Quest | Goal | Reward |
|---|---|---|
| Daily Login | claim once a day | Mon 100, Tue 25, Wed 25, Thu 50, Fri 100, Sat 150, Sun 200 |
| Chatterbox | 50 messages | 150 |
| Stick Around | 20 min in one session | 100 |
| Crate Cracker | open 2 crates | 75 |
| Friendly Duel | finish 2 1v1 games | 75 |
| Daily Sweep | claim all daily quests (not Login) | 100 |
| Crate Hoarder (weekly) | open 10 crates | 250 |
| Marathon Chatter (weekly) | 500 messages | 400 |
| Arena Regular (weekly) | finish 5 1v1 games | 200 |
| Weekly Sweep | claim all weekly quests | 300 |

Welcome bundle: brand-new accounts (created on/after 2026-11-21) get **50 coins** once per account and once per browser (`starterDevices/<browser hash>`).

Fields on `coins/<id>` and who writes them: `qdk/qdm/qwk/qwm` message counters (chat.js, with the coin), `qss/qhb/qsd` session timer, `qcdk/qcd/qcwk/qcw` crate baselines, `qgl/qgt/qgdk/qgd/qgwk/qgw` game counters (quests.js; any counter change must come with a new real game id in `qgl`), `qc` + `qp/<quest>` claim, `sb/sbh` welcome bundle.

**Gift crates are deliberately OFF.** The owner chose to skip the `gc` (gift crate) field. So no crate rewards on game quests and no starter crates. To bring them back: add `gc` to the rules (and the claim/starter branches), then set `STARTER_CRATES` and add `crates:` to the quests in `quests.js`. `chat.js` `crateStock()` already reads `gc`.

## Other recent features (details in the code; status not re-verified)
- 1v1 crate games: bets 1x/2x/3x/5x/10x, disconnect = 15 s then the other player wins, 5-minute limit then overtime/refund. Games: tic-tac-toe, rock-paper-scissors, connect 4 (dice, memory, battleship were rejected). Direct mode `pg/`, secure mode `games/` via `api/game.js`.
- "Impossible" crate (100 coins, ~99% refund of 20 coins, 1/10000 per prize) and an "Impossible" rarity tier above Legendary.
- Shop bundles: Yin & Yang Pack (1000 coins), a Dragon bundle (3000) and the Rainbow Pack (2000: `shp-tag-prism` "🌈Prism", `shp-bub-cloud` cloud bubble, the existing `shp-ring-rainbow`, `shp-fx-rainbow` fading rainbow text effect) exist in the rules and `chat.js`; their CSS is in `style.css` after the Dragon block. The Rainbow ring is still sold alone for 500 in the Rings tab too.
- `/give` command: owners of a tag can grant it. `tag-jih` only by #177601, `tag-special` only by #581824, `tag-div` only by #185920, `tag-owna` ("owna approved", `/give tag_owna`) only by #822414 (enforced in the `tagGrants` rules; publish the rules and push `chat.js` + `style.css` for it to work).
- Chat security work (tickets / token requirement against impersonation) is in `rules/tickets`, `config/tokensRequiredSince`, `api/chat/`.
- Reported bug, status unknown: the Yin & Yang bubble turned text-effect text black; wanted: the bubble must not affect text when a text effect is equipped.

## Current status / what needs doing
Done in the Rainbow Pack session (2026-11-21): new bundle `shp-bundle-rainbow` (2000 coins) added in `chat.js` (CRATE_ITEMS + BUNDLES), `style.css` and `vus-chat-rules.json` (price in coins `sh/$k`, pieces in the `crateInv` rule). Rules file checked: parses, no `numChildren` left, only real Firebase rule methods. Not yet tested in the live app: [ ] publish the rules, [ ] push `chat.js` AND `style.css`, [ ] buy the pack with a test account (cloud puffs, fading text, ring and tag all show; check a very long and a very short message).

Done last session: rules now cover all 10 quests, game counters and the welcome bundle; `quests.js` stripped of crate rewards; `games.txt` typo fixed.

To do, in order:
1. [ ] Publish the new `vus-chat-rules.json` in Firebase.
2. [ ] Push the new `quests.js` to GitHub (rules first, then the script).
3. [ ] Test with a test account: claim each quest type, play two 1v1 games and watch Friendly Duel progress, create a fresh account for the welcome bundle.
4. [ ] Watch the rules file size: it grew from ~62 KB to ~69 KB (compact JSON ~57 KB). If Firebase refuses it as too large, minify it.
5. [ ] Optional: decide whether to turn gift crates back on (see above).
6. [ ] Optional: more ways for players to earn coins (the owner is open to ideas; example ideas so far: quests, login streak, 1v1 games).
7. [ ] Check whether the Yin & Yang text-effect bug is fixed.

## Checkers (added 2026-11-21, later session)
New 1v1 game `ck` (8x8) in `games.js` (Direct mode + UI), `api/game.js` (Secure mode, actions `move {from,to}` and `stop`) and `vus-chat-rules.json` (`pg` type allows `ck`, log entries get field `f`, `c` up to 63). Rules: men step forward only and may go backward only by capturing; captures never forced; after a jump the piece may keep jumping or stop (`stop` / log kind `st`); reaching the far row crowns and ends the turn; win by capturing everything or leaving the opponent no legal move; 10 min, then more pieces wins, tie = 3 min overtime then refund. Checked with Node tests for the rules, server logic and a jsdom UI smoke test (not saved). NOT yet tested live: [ ] publish rules in Firebase, [ ] deploy `api/game.js` to Vercel, [ ] push `games.js` to GitHub (rules first, script last), [ ] play a Direct and a Secure checkers game with two accounts (capture, optional capture, chain + stop, crowning, win).

## Chess (added 2026-11-21, latest session)
New 1v1 game `ch` in `games.js` (Direct mode + UI), `api/game.js` (Secure mode, same `move {from,to,promo}` action) and `vus-chat-rules.json` (`pg` now allows type `ch`, an `opt` object `{tm, pm, w}` and promotion letters q/r/b/n in log field `p`). Board = 64-char string, uppercase White, lowercase Black. Full rules: castling, en passant, promotion (player picks), check/checkmate, stalemate, dead position, threefold repetition, 50-move rule. Each player has their own clock (3/5/10/15/30 min chosen by the host) and the host may add a per-move limit (none/15 s/30 s/1 min/2 min) and pick White/Black/random. Timeout = loss, except a draw if the other side could never checkmate. Leaving = resign. The engine exists twice (`games.js` and `api/game.js`): keep them identical. Tested in Claude's temporary workspace: move-count (perft) tests on 6 standard positions for the client engine and 4 for the server copy all match; 32 game-log tests (mate, illegal moves, clocks, flag, per-move limit, repetition, promotion, stalemate, castling, en passant) pass. NOT yet tested live: [ ] publish rules in Firebase FIRST (without them Direct-mode chess is refused), [ ] deploy `api/game.js` to Vercel, [ ] push `games.js` to GitHub (last), [ ] play a Direct and a Secure chess game with two accounts (both colours, promotion picker, clocks, move limit, resign).

## Session log
- 2026-11-21 (mobile pass): `games.js` only. Games panel now has a ☰ menu button (phones, width <= 720 px) that opens the sidebar drawer through the app's own `.mobile-menu-btn` handler in `dm.js`; before, the panel hid every menu button so portrait users were stuck. Also: no sideways scrolling (boards sized to the panel width and, on short screens, its height), centered boards, compact header on landscape phones, 44 px tap targets on touch, scroll position kept while the screen redraws, confirm popup fits narrow screens. Checked in headless Chromium at 360x640, 390x844, 844x390, 768x1024 and 1280x800 for all 5 games + lobby (no overflow, drawer opens, tapping Chat leaves Games). Needs: push `games.js` to GitHub; no rules or server change.
- 2026-11-21 (latest): added Chess to the 1v1 games (see the Chess section above); fixed a garbled comment in `api/game.js`; the rules needed the `ch` type, `opt` and promotion letters.
- 2026-11-21 (later still): added Checkers to the 1v1 games (see the Checkers section above).
- 2026-11-21: quests audit (rules were out of date), rules + `quests.js` updated, gift crates left out on purpose, `games.txt` fixed.
- 2026-11-21 (later): Firebase refused the rules with "Line 90: No such method/property 'numChildren'" (the old test simulator had accepted it); the rules file on disk is fixed. Added the Rainbow Pack bundle (see above). Also added the grant-only tag "owna approved" (`tag-owna`, only #822414 can give it) in `chat.js`, `style.css` and the rules.

## How the owner starts a new chat
"Read E:\Claude\VUS D.C\HANDOFF.md first, then help me with ...". At the end of a session ask Claude to update "Current status" and "Session log" in this file.
