# VUS D.C site review (2026-11-22)

Scope: all front-end files (`Chat-DM.html`, `chat.js`, `dm.js`, `dev.js`, `slm.js`, `quests.js`, `games.js`, `bots.js`, `style.css`), `vus-chat-rules.json`, `vus-dm-rules.json`, `vus-SLM-rules.json`, and the Vercel API (`api/`).
Method: syntax check on every JS file (all pass), both rules files parse, a read of every rule, and searches through `chat.js` / `dm.js` for XSS, secrets, and ticket handling. I did not play-test the UI, and I can't see the live database, so anything marked "verify" depends on what is set live.
No file was changed except notes (this file and the `HANDOFF.md` log). No secrets were read or copied.

Priority: **P0** = anyone can break accounts or read private data now, **P1** fix soon, **P2** worthwhile, **P3** polish.

---

## P0 - Account and DM security (`vus-dm-rules.json` + `dm.js`)

Root cause: the password is checked **in the browser**, but the database rules can't see that check. The rules only know the anonymous Firebase uid, and every browser gets one. So rules that say "only the owner can ..." are only as strong as who can become "owner".

1. **Any account can be taken over.**
   `users/$key/ownerUid` is `.write: auth != null`, so any visitor can overwrite it on any account. `dm.js` does exactly this on login (`if (cur !== uid) await ref.set(uid)`). Once someone is the owner, the rules let them set `password` and `username`.
2. **Every account's password hash is public.**
   `users/$key` is `.read: true`, and IDs can be looked up through `idIndex/$id` (`.read: true`, 6 digits) and `usernameIndex`. The `password` field comes with it. PBKDF2 hashes can be cracked offline; any remaining plain-text password is exposed directly.
3. **Anyone can overwrite legacy plain-text passwords.**
   The first clause of `password .write` lets any visitor replace a non-`pbkdf2$` password with a `pbkdf2$...` string of their own.
4. **DMs are public and forgeable.**
   `dms/$thread/messages` and `groupChats` are `.read: true`. A message may be created with either participant's `fromAccountKey`, and any message can be edited by anyone as long as `fromAccountKey` stays the same. Group chats: anyone can delete a group (`!newData.exists()`), add themselves to `members`, or rewrite `ownerAccountKey`.
5. **Anyone can edit anyone's profile and lists.**
   `avatar`, `banner`, `bio`, `friends`, `friendRequests*`, `blockedUsers`, `pinned*`, `groups`, `lastSeen`, `presence`, `typing`, `reads` are all `.write: true`. For example, anyone can clear a person's block list (safety issue) or change their avatar.

**Real fix:** make the Vercel API verify the password and hand back a Firebase **custom token** whose uid is the account key (`admin.auth().createCustomToken(key)`). Then rules can say `auth.uid === $key` for profile/list writes, `auth.uid === newData.child('fromAccountKey').val()` for messages, and so on. Move `password` to a path that is not client-readable (for example `userSecrets/$key`, `.read: false`). `api/_lib.js` already has `passwordGate` and `accountById` to build on.
Trade-off: `HANDOFF.md` says many players can't reach Vercel. Those players couldn't log in at all with a Vercel-only login, so decide whether to accept that, add a second host, or keep a lower-security fallback for chat only.

**Smaller interim fixes (rules only, no new login):**
- `ownerUid .write: auth != null && (!data.exists() || data.val() === auth.uid)`. This stops overwriting an existing owner. It breaks "log in from a new browser", so add an owner/staff reset flow first.
- Remove the legacy-password clause from `password .write` after migrating every account to `pbkdf2$`.
- Only allow edits of a message when its sender matches, and block member self-adds to groups.

## P0/P1 - Chat database rules (`vus-chat-rules.json`)

6. **Verify that ticket enforcement is switched on.** The message rule only requires a ticket if `config/tokensRequiredSince` exists and is in the past (`api/auth/session.js` says it is "switched on separately"). If that value is not set live, anyone can post under any ID and name.
7. **The VUS AI account (#299816) can be impersonated.** The message rule has a hard-coded exception: `loginId === '299816'` in room `ch-ai` needs no ticket, so anyone can post as it. Better: let the AI post only through the server (`api/bot/send.js` style) and remove the exception.
8. **`botTokens` is `.read: true`.** That publishes the salt and hash of every DEV token. They are 256-bit random so they can't realistically be cracked, but nothing should be public here. Check what `dev.js` actually reads; if it only needs `gen`/`rotatedAt`, make the rest unreadable.
9. **Open writes on shared data:** `userProfiles/$id`, `roomsMeta/$code`, `deviceLinks/$h/$id`, `accountDevices/$id/$h`, `rooms/$room/leaveEvents`, `leaveFlushLock`, cooldown paths, `reactions` are all `.write: true`. Anyone can edit anyone's profile/cosmetics, rewrite or delete someone's room, and fake device links. If bans use device links, someone could link an innocent account to a banned device (check how `chat.js` uses them).
10. **Device-to-account links are readable by everyone** (`accountDevices`, `deviceLinks`, `bannedDevices`). That is a privacy leak; consider server-only.
11. **Verify `config/staffEnforced` is `true`.** `bannedDevices .write` is open to everyone when it isn't.
12. **Good:** tickets are spent correctly. `chat.js` sends the message and the ticket deletion in one multi-path update, so a ticket can't be replayed. Coin rules for message income, welcome bundle and quests are tight (2 coins/message, 2 s gap, 500/hour).

## P1 - API (`api/`)

13. **Anyone can lock out any account.** The lockout is per ID (`botAttempts/<id>`, 5 tries, 10 minutes), so an attacker can keep any 6-digit ID locked out of login and DEV token rotation. Add a per-IP counter and/or ignore the lock for a valid existing login token.
14. **The lockout counter is racy.** It reads and then writes, so parallel requests can try far more than 5 passwords. Use `ref.transaction()`.
15. **Bans and mutes are only hidden client-side** (`send.js` comment). A modified client ignores that. `ticket.js` should refuse tickets to banned/muted IDs and the rules should check the same list.
16. **Nickname impersonation (`ticket.js`).** Only `toLowerCase()` and trim are applied, so look-alikes (full-width letters, Cyrillic/Greek homoglyphs, zero-width and bidi characters) get through. Normalize with NFKC, strip control/zero-width/bidi characters, compare a "skeleton". Also the reserved-username check is skipped for names containing `. # $ [ ] /`; check how `usernameIndex` keys are built so such names can't equal someone's username.
17. **Legacy plain-text passwords still accepted (`_lib.js` `verifyPassword`).** Re-hash on successful login and then remove the fallback.

## P2

18. Nickname claims last 30 min from the last ticket request, so one account can hold a name forever by requesting tickets. Consider one claimed nickname per account.
19. `ticket.js` costs about 6 DB round trips per message and removes expired tickets one at a time; the "6 unused tickets" check is read-then-write. Use one multi-path `update()` and a transaction.
20. No per-IP rate limits on `/api/auth/session`, `/api/chat/ticket`, `/api/dev/rotate`.
21. Login tokens never expire and there is no logout / "sign out everywhere". Changing the password should delete `sessTokens/<id>`.
22. `pbkdf2Sync` blocks the Node event loop; use async `crypto.pbkdf2` and cap the iteration count read from the stored hash.
23. SLM cards sent by bots aren't verified: the share ID isn't checked to exist, `l`/`n` can lie, `n` can be a non-integer, `exp` can be in the past or far future. Strip bidi characters from the SLM `name` (filename spoofing).
24. Invisible-only text (`\u200b`) passes the empty check in `send.js`.
25. **Scripts load from GitHub `refs/heads/main` at runtime with no integrity check** (`Chat-DM.html` loader). Whoever controls that repo controls every user's browser, and half-pushed states are served live (which is why "rules first, scripts last" matters). Pin to a commit SHA, turn on 2FA for the GitHub account, and add a Content-Security-Policy meta tag. The Firebase SDK scripts also have no SRI hashes.
26. `Chat-DM.html` viewport has `maximum-scale=1.0`, which blocks pinch-zoom (accessibility). Remove it.

## P3

27. `/api/ping` is public and shows Node version, env var names and expected project IDs. Gate it or remove it in production. CORS is `*` on the password endpoints (fine for bearer calls; `session` and `rotate` could allow only your own site). 405 responses lack an `Allow: POST` header. `botAttempts` is used for normal logins too; rename. Leftover blank comment lines in `session.js`.
28. `dm.js` ~line 3960 puts `e.message` into `innerHTML` unescaped; use `esc()`.
29. `ticket.js` duplicates the token check in `_lib.js` `verifyLogin`; use the shared helper.
30. `HANDOFF.md` step 1 says Firebase may refuse the chat rules as too large (~69 KB; now ~71 KB). As far as I know the Realtime Database rules limit is 256 KB, so size is probably not the problem; the earlier failure was the `numChildren` method.
31. `staff-accounts.json` and `staff-tool/` live in the same folder as the files you push. Add a `.gitignore` (or move them out) so they can never be pushed by accident.
32. The chess/checkers engine exists in both `games.js` and `api/game.js` and must stay identical. A simple Node test that extracts both engines and compares them (or tests the same positions against both) would catch drift automatically.
33. `chat.js` is ~12,500 lines (~660 KB) and `dm.js` ~4,400 lines. Splitting into modules would make fixes like these safer.

## Checked and fine

- XSS: user text goes through `esc()` before every `innerHTML` use I read (message bubbles, replies, room cards, command list, audit log, links). `linkify` only builds `https://` links with `rel="noopener noreferrer nofollow"`. No `localStorage` writes of passwords or tokens found. No obvious XSS found, but I did not trace every one of the ~70 `innerHTML` sites by hand.
- Syntax: `chat.js`, `dm.js`, `dev.js`, `slm.js`, `quests.js`, `games.js`, `bots.js`, `api/game.js` and `_lib.js` all pass `node --check`; both rules JSON files parse.
- SLM rules (`vus-SLM-rules.json`): sensible (6-character IDs, 3-hour expiry enforced, delete only with the matching hash).
- Firebase config values in the front end are public by design.

## Suggested order

1. Decide on the login redesign (items 1-5). It is the only real fix for the P0 group.
2. Meanwhile, do the quick rule fixes: items 3, 7, 8, 11 and (if you accept the reset-flow cost) the `ownerUid` rule.
3. Check items 6 and 11 in the Firebase console today.
4. Then API items 13-17, then the rest.
