# VUS D.C

Browser chat + DM app (chat, channels, DMs, shop, crates, coins, quests, 1v1 crate games). Plain HTML/JS/CSS front end, Firebase Realtime Database back end, small Vercel API in `api/`.

Full file map, quest system details and the current to-do list are in the handoff file:

@HANDOFF.md

## Working rules
- `Chat-DM.html` loads `slm.js`, `dm.js`, `dev.js`, `chat.js`, `quests.js`, `games.js` from GitHub raw (`Cra-Z-Gaming/VUS`, folder `Chat-DM/`). Local edits do nothing until the owner pushes them. Firebase rules do nothing until the owner publishes them. Say which of the two is needed at the end of every task.
- Quest numbers (rewards, goals, reset times, login amounts) exist twice: in `quests.js` and in `vus-chat-rules.json`. Always change both.
- Players can write to Firebase directly, so every reward must be enforced in the rules, not only in the client.
- `chat.js` is about 650 KB: use grep and line ranges, never read it whole.
- `vus-chat-rules.json` has a few huge single lines. Use small exact-substring edits, then check it still parses (`node -e "JSON.parse(require('fs').readFileSync('vus-chat-rules.json','utf8'))"`). Run `node --check` on any JS file you edit.
- Rules cannot be tested against the live database. For rule changes, write a small Node simulator (mock `data` / `newData` / `root`, evaluate the rule strings) and test both the allowed and the cheating cases.
- Never put secrets, tokens or `staff-accounts.json` contents into notes, commits or replies.
- Ask before large or irreversible changes. Show the plan first for new minigames or features.
- Gift crates (`gc`) are deliberately off. Do not add them unless the owner asks.

## When you finish a task
Update "Current status" and "Session log" in `HANDOFF.md` so the next session starts with the right picture.
