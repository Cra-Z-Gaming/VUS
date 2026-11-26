# VUS D.C – handoff for Claude

Start a new chat with: "Read E:\Claude\VUS D.C\HANDOFF.md first, then help me with ...". Working rules are in `CLAUDE.md` (it loads this file). At the end of a session, update "Status" and "Log" below.
Last updated: 2026-11-25.

## What this project is
Browser chat + DM web app (main chat, channels, DMs, shop, crates, coins, tags/bubbles, quests, 1v1 crate games with bot practice).
- Front end: plain HTML/JS/CSS. `Chat-DM.html` loads `slm.js`, `dm.js`, `dev.js`, `chat.js`, `quests.js`, `games.js` from GitHub raw (`Cra-Z-Gaming/VUS`, folder `Chat-DM/`). `games.js` loads `bots.js` itself. **Local edits do nothing until pushed to GitHub.**
- Back end: Firebase Realtime Database (rules in `vus-chat-rules.json`, `vus-dm-rules.json`, `vus-SLM-rules.json`) plus a small Vercel API in `api/` (`game.js` = server-run "secure" games, `auth/`, `bot/`, `chat/` tickets, `dev/`, `ping.js`). `package.json` only needs `firebase-admin`.
- Many players can't reach Vercel, so some features have a less secure "direct" Firebase fallback (e.g. `pg/` games). The owner accepts that.

## Files
| File | What it is |
|---|---|
| `Chat-DM.html` | main page, left rail (Quests button + red dot `questRailDot`), script loader |
| `chat.js` (~660 KB) | chat, coins, shop, crates, cosmetics, /commands, moderation. Never read whole: copy to Claude's computer and grep |
| `dm.js` | DMs, accounts (`VUS_DM.getAccountCreatedAt`) |
| `quests.js` | daily/weekly quests, login reward, welcome bundle, game counting |
| `games.js` | 1v1 games (ttt, rps, c4, checkers, chess) + practice mode, reports finished real games to `quests.js` |
| `bots.js` | practice bots for all 5 games (`window.VUS_BOTS`), loaded by `games.js` on first practice game |
| `slm.js`, `SLM.html`, `vus-SLM-rules.json` | ShareLargeMessages extension |
| `dev.js`, `staff-tool/`, `staff-accounts.json` | staff/dev tools (never copy secrets into notes, chats or GitHub) |
| `style.css` | all styling (`.quest-*` at the end) |
| `games.txt` | launcher games list, format `[Title](https://raw-link)` |
| `version` | number file (43), untouched; unknown what reads it |
| `_bot-work/` | `smoke.js` + `smoke-harness.html`: browser test for practice mode. The other notes files there are merged into this file and can be deleted |

## Status / to do
Publish and push order: **rules first, scripts last.**
1. [ ] Publish `vus-chat-rules.json` in Firebase (quests, checkers, chess, Rainbow pack, `tag-owna`). If Firebase refuses it as too large (~69 KB now), minify it.
2. [ ] Deploy `api/game.js` to Vercel (Secure checkers and chess).
3. [ ] Push to GitHub `Chat-DM/`: `quests.js`, `games.js`, `bots.js`, `chat.js`, `style.css`.
4. [ ] Live tests with test accounts: each quest claim, Friendly Duel after two 1v1 games, welcome bundle on a fresh account, buy the Rainbow Pack (cloud puffs, fading text, ring, tag; try a very long and a very short message), Direct + Secure checkers and chess games (capture, chain + stop, crowning, promotion picker, clocks, move limit, resign).
5. [ ] Practice mode live checks: a human move in checkers and chess, a full chess game, the waiting-screen "Play the bot instead" button (needs two accounts), phone layout.
6. [ ] Check the "Hide online list" tab hides on Games, DMs, login and ban screens (fix pushed with `chat.js` + `style.css`).
7. [ ] Check whether the Yin & Yang bubble still turns text-effect text black (wanted: bubble must not affect text when a text effect is equipped).
8. Optional: gift crates back on; more ways to earn coins (owner is open to ideas).

## Idea backlog (owner's ideas, written down 2026-11-23, NOT started)
Owner said: write these down for later if not done now. Show a plan before building the big ones (tag royalties, Head Admin).
1. **Inactivity pause (15 min):** after 15 minutes of inactivity, stop counting time online (profile "Time active") and the quest session timer (Stick Around: `qss/qhb/qsd`). The quest timer is also enforced in the rules, so check both `chat.js` and `vus-chat-rules.json`.
2. **Bug: crate quests mostly don't work** (Crate Cracker daily, Crate Hoarder weekly). Look at the `qcdk/qcd/qcwk/qcw` baselines and the claim rules. Checked 2026-11-23 by reading only: `quests.js`, `chat.js` and `vus-chat-rules.json` agree (day/week keys, baseline = `o - sc`, claim needs `o - sc - qcd >= goal`), so no cause found yet. Need the exact symptom (progress stuck? claim refused? which message?) or a live test.
3. **Bug: crates bought in the shop can't be opened from the shop.** Weird, find out why (buying seems to work, opening from the shop does not). Checked 2026-11-23 by reading only: `buyShop` -> `settleShopCrates` and the `crateClaims` rules match, and the shop's "Open crates" button just calls `closeShop(); openCrateModal();`. No cause found yet; need the exact symptom (button does nothing? crate screen says 0 crates? error text?).
4. **New tags:** good boy / bad boy / good girl / bad girl (style, price and how to get them not decided).
5. **UI: move Reply, Reaction and Edit buttons closer to the message** without overlapping the message text (if possible).
6. **Tag royalties (new idea, uses /give):** the owner of a tag (someone who can /give it) earns 2 coins for every 5 (or 10) seconds that someone has that tag equipped AND is online. Royalties go into a separate bank (not the owner's real coin balance) and are credited even when the tag owner is offline. When the owner comes online they claim it automatically (or manually: undecided). Example: 2 people wearing my tag online for 10 seconds = 8 coins for me (so 2 coins per person per 5 s). Cheating rule (decided, keep it simple): if the person wearing the tag is in the tag owner's possible alts, the owner gets no reward for that person. Open points: 5 s or 10 s tick, auto or manual claim, enforcing it in the rules (players write to Firebase directly, so the royalty must be validated there), and not hammering the database.
7. **New role: Head Admin** (above Admin, under Co-Owner): same as Admin, plus can grant Mod, and has a 1 second message delay. Channel emoji: 🗿. Needs: role list/order in `chat.js`, rules (who can grant what), message delay, emoji.
   Scoped 2026-11-23, plan shown to owner, WAITING for his OK. Ranks are never compared as numbers in `chat.js` (always `ROLES.x.rank`), so the new rank is `headadmin` = 4, Co-owner 5, Owner 6. Touch list: `chat.js` (ROLES table; message + image cooldown tables 1000 ms; `canGrantRole` mod -> headadmin and up; the role lists near the `["crown", "coowner", "admin", "mod", "normie"]` loop and the `ROLES=[["verified"...` list in the embedded page; rank guide `byHand`/`grantable`; `isAdminHolder`-style helpers), `style.css` (`.headadmin-bubble`, `.role-headadmin` member list + profile card colours), `vus-chat-rules.json` (new `roleIds/headadmin` node set by hand, `headadmin` added wherever staff role `admin` is accepted (3 places) and to the `roleIds/mod` write rule), plus the staff tool / `dev.js` / `staff-accounts.json` (not read yet: needs the new role name, never copy secrets). Decisions needed: bubble colour, can Head Admin unban (default no, same as Admin), and Head Admin set by hand in the Firebase console like Co-owner (default yes).
8. **Polls: DONE 2026-11-23 (needs publish + push).** Polls now allow up to 10 options (admins and above, the only ones who can start polls). `chat.js`: `POLL_MAX_OPTIONS = 10` (menu, `pollShapeOk`, /poll text). Rules: poll option numbers 0-9 and `pollVotes` up to 9. The poll window already scrolls (`max-height: 90vh`). Not live-tested.

## Quests (built 2026-11-21)
Coins live in `coins/<id>` (`n` = balance). Daily reset 12:00 PM Eastern (17:00 UTC), weekly Saturday 12:00 PM Eastern. Messages earn 2 coins each (max one per 2 s, 500 per hour).

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

Welcome bundle: accounts created on/after 2026-11-21 get 50 coins once per account and once per browser (`starterDevices/<browser hash>`).
Fields on `coins/<id>`: `qdk/qdm/qwk/qwm` message counters (chat.js, written with the coin), `qss/qhb/qsd` session timer, `qcdk/qcd/qcwk/qcw` crate baselines, `qgl/qgt/qgdk/qgd/qgwk/qgw` game counters (quests.js; any counter change needs a new real game id in `qgl`), `qc` + `qp/<quest>` claim, `sb/sbh` welcome bundle.
**Gift crates are deliberately OFF** (no `gc` field in the rules, no crate rewards, no starter crates). To bring them back: add `gc` to the rules (claim/starter branches), set `STARTER_CRATES` and add `crates:` to the quests in `quests.js`. `chat.js` `crateStock()` already reads `gc`.

## 1v1 games (`games.js`, `api/game.js`)
- Games: tic-tac-toe `ttt`, rock-paper-scissors `rps`, connect 4 `c4`, checkers `ck`, chess `ch` (dice, memory, battleship were rejected). Bets 1x/2x/3x/5x/10x. Disconnect 15 s = other player wins; 5-minute limit then overtime/refund. Direct mode `pg/`, Secure mode `games/` via `api/game.js`.
- `derive(g)` turns a raw Direct game record (log of moves) into the view the UI uses.
- **Checkers** (8x8): men step forward only, go backward only by capturing; captures never forced; after a jump the piece may keep jumping or stop (`stop` / log kind `st`); reaching the far row crowns and ends the turn; win by capturing everything or leaving the opponent no legal move; 10 min, then more pieces wins, tie = 3 min overtime then refund.
- **Chess**: board = 64-char string (uppercase White, lowercase Black). Full rules incl. castling, en passant, promotion (player picks), check/mate/stalemate, dead position, threefold repetition, 50-move rule. Each player has a clock (3/5/10/15/30 min, host's choice), optional per-move limit (none/15 s/30 s/1 min/2 min), colour White/Black/random. Timeout = loss unless the other side could never mate (then draw). Leaving = resign. The engine exists twice (`games.js` and `api/game.js`): keep them identical. Rules (`pg`) allow type `ch`, an `opt` object `{tm,pm,w}` and promotion letters q/r/b/n in log field `p`; checkers log entries use field `f`.
- Mobile pass done (2026-11-21): ☰ menu button on phones (<= 720 px), no sideways scroll, 44 px tap targets.

## Practice mode against bots (built 2026-11-22)
- Practice games are local: kept in browser memory, never written to Firebase, no bet, never reported to quests (`questScan` only walks `pgames`/`games`). The record has the Direct-game shape, so `derive()` and the normal board screens are reused. Human = side `a`, bot = side `b`.
- `games.js` pieces: `loadBots` (fetches `bots.js` from GitHub raw via a Blob script), `lgames`/`lview`/`lAppend`/`lAct`/`lPick`/`lLeave`/`lDrop` (local store), `lChoose`/`lFallback`/`lBotMove`/`lPlan` (bot driver; invalid bot move falls back to a legal one; 3 stuck tries stop the game), `localTick` (clock, overtime, RPS reveals), `startPractice`, `waitToBot`, `renderPractice` (lobby card). `dMove`/`dMoveCk`/`dStop`/`dPick`/`dLeave`, `directTick`, `viewOf` and `onGames` route to the local store when `lgames[gid]` exists. `renderGame` has practice labels, Leave, Play again, result heading and the waiting-screen "Play the bot instead" button.
- `bots.js` (`window.VUS_BOTS`, levels 0/1/2 = Easy/Normal/Hard, uses the engine export `window.VUS_GAMES.E` at the end of the engine section of `games.js`: keep that list in sync with what the bots call): `ttt(board,mark,lvl)`, `rps(hist,lvl)`, `c4(board,mark,lvl)`, `ck(board,side,chain,lvl)` (move object, or null = stop jumping), `ch(S,col,hist,lvl)` (move object or null).
  - Checkers: alpha-beta, Easy depth 2 / Normal 6 (250 ms) / Hard 16 (900 ms). Chess: alpha-beta, quiescence, check extension, piece-square tables, small opening book; Easy depth 2 (120 ms), Normal 4 (600 ms), Hard 9 (1.5 s).
- Tests: bot engines were tested in Node by copying the engine code from `games.js` into a sandbox (self-play, mate-in-one, K+Q/K+R endings, no illegal moves). Whole UI: `_bot-work/smoke.js` (Playwright, instructions in its header). Harness pitfall: wait ~2.6 s after load before starting a game, because the app's 2 s id check resets `myGid` once on first run.

## Other features (status not re-verified)
- "Impossible" crate (100 coins, ~99% refund of 20 coins, 1/10000 per prize) and an "Impossible" rarity tier above Legendary.
- Shop bundles: Yin & Yang Pack (1000), a Dragon bundle (3000), Rainbow Pack (2000: `shp-tag-prism`, `shp-bub-cloud`, `shp-ring-rainbow`, `shp-fx-rainbow`; CSS in `style.css` after the Dragon block; the ring is also sold alone for 500). Pieces/prices live in `chat.js` (CRATE_ITEMS + BUNDLES) and the rules (`sh/$k`, `crateInv`).
- `/give`: owners of a tag can grant it. `tag-jih` only by #177601, `tag-special` #581824, `tag-div` #185920, `tag-owna` ("owna approved", `/give tag_owna`) #822414, `tag-bb` ("BB", `/give tag_BB`) #328760 (enforced in `tagGrants` rules).
- Chat security (tickets / token requirement against impersonation): `rules/tickets`, `config/tokensRequiredSince`, `api/chat/`.
- "Hide online list" tab (`#membersToggleBtn.dock`, a fixed element on `<body>`): `chat.js` `wireMembersToggle` sets `body.members-dock-off` unless the chat screen is really showing; `style.css` hides it outside plain chat mode.

## Log
- 2026-11-25 (later): `/remove tag_<name> <name|#ID|@name>` for tag owners (same tags as /give; the existing `/remove normie|mod` for staff still works). `chat.js`: `removeTagFrom()` next to `giveTagTo()`, `/remove` entry now `only` = mod+ or tag owner. It deletes the tag from `crateInv/<id>/items`, deletes `tagGrants/<id>/<tag>` (so the wearer can't put it back) and clears `userProfiles/<id>/cosm/tag`; old messages keep the stored tag name but stop showing it (tags only show while the sender owns them; other people's open chats may keep showing it until reload). Rules: new `tagRemovals/<id>/<tag>` ({by: granter, ts: now}); `crateInv` items and `tagGrants` can be deleted only while that record is under 60 s old. A new grantable tag must now be added in 3 rule places (`tagGrants`, `tagRemovals`, `crateInv`) plus `TAG_GRANTS`. Tested the rules in a Node simulator (14 cases pass), `node --check chat.js` OK, not live. Needs: publish `vus-chat-rules.json`, then push `chat.js`.
- 2026-11-26: Bank tab / tag royalties REBUILT (all in `chat.js`, no `bank.js`). Rules (`vus-chat-rules.json`): new `tagBank/<owner>` node (`e` total earned, `lt`/`lw` last tick + wearer, `tags/<tag>` per tag, `w/<wearer>/{t,g}` rate limit) and a claim branch + `ry` field on `coins/<id>`. A wearer's browser writes one multi-path update every ~10 s (+2 to `e` and the tag counter; rules allow one tick per wearer per 9 s, only for the tag they really wear and own, never for the owner). Claim = leaf writes `coins/<id>/n` += (e - ry) and `coins/<id>/ry` = e (a whole-record write fails the `bw` check). `chat.js`: `royTick` (wearer side, skips AFK and possible alts, retries when another wearer ticked first, rests 60 s after 4 refusals), Bank rail button after Quests (`ensureBankBtn`, only shown to tag owners), Bank window (`openBank`/`paintBank`: ready coins, per-tag online wearers and coins/s, Claim), `claimRoyalties`. `style.css`: `.bank-row`, `.bank-rate`. A new grantable tag must now be added in 4 rule places (`tagGrants`, `tagRemovals`, `crateInv`, `tagBank/$owner/w/$wearer/g`) plus `TAG_GRANTS`. Rules tested in a Node simulator (tick, replay, forged, delete and double-claim cases all pass), `node --check chat.js` OK, not live. Owner = first id in `granters`. Needs: publish `vus-chat-rules.json`, then push `chat.js` and `style.css`; then live test with two accounts (wearer online 30 s, owner claims, owner offline case).
- 2026-11-25: fixed Secure 1v1 refusing bets ("You don't have 1 crate to bet" with crates in stock): `api/game.js` only counted `crateClaims` n - o. It now counts n - o + `coins/<id>/gc` + `crateGames`, and moves bets/winnings through `crateGames`. Added `tag-bb` (only #328760). Checked in Node (syntax, rules JSON, mock tests), not live. Needs: publish `vus-chat-rules.json`, then deploy `api/game.js`, then push `chat.js` and `style.css`.
- 2026-11-23: wrote the idea backlog above. Poll limit raised from 4 to 10 options (`chat.js` + `vus-chat-rules.json`, both checked: JSON parses, `node --check` OK). Looked into the crate quest and shop-crate bugs by reading only: no cause found, need the exact symptoms. Needs: publish `vus-chat-rules.json` (rules first), then push `chat.js` (plus the files already waiting in the to-do list).
- 2026-11-22: practice mode + `bots.js` built, verified in headless Chromium (3 simple games played to the end, chess/checkers start, 0 quest reports). Fixed the "Hide online list" tab showing on Games/join/ban screens. Merged `BOT-MODE-NOTES.md` and `_bot-work/PROGRESS.md` into this file; rules moved to `CLAUDE.md`. Needs: push `games.js`, `bots.js`, `chat.js`, `style.css`.
- 2026-11-21: mobile pass for the Games panel; Chess added; Checkers added (both need rules published first, `api/game.js` deployed, `games.js` pushed last); Rainbow Pack + `tag-owna` added (rules once failed with "No such method 'numChildren'", fixed); quests audit, rules and `quests.js` updated, gift crates left out on purpose, `games.txt` typo fixed.
