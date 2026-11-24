# VUS D.C

Browser chat + DM app (chat, DMs, shop, crates, coins, quests, 1v1 crate games, bot practice). Plain HTML/JS/CSS front end, Firebase Realtime Database back end, small Vercel API in `api/`. File map, quest numbers, game rules and the to-do list are in:

@HANDOFF.md

## Working rules
- **Push / publish:** the owner must push JS/CSS/HTML to GitHub (`Cra-Z-Gaming/VUS`, folder `Chat-DM/`) and publish Firebase rules; nothing works before that. Rules first, scripts last. Say which is needed at the end of every task.
- **Two copies of the same numbers:** quest rewards, goals, reset times and login amounts live in `quests.js` AND `vus-chat-rules.json`. Change both. The chess engine lives in `games.js` AND `api/game.js`. Keep them identical.
- **Security:** players can write to Firebase directly, so every reward must be enforced in the rules, not only in the client. Never put secrets, tokens or `staff-accounts.json` contents into notes, commits or replies.
- **Big files:** `chat.js` is ~660 KB: copy it to Claude's computer (`copy_file_user_to_claude`) and grep; never read it whole. `vus-chat-rules.json` has huge single lines: edit with small exact-substring replacements, then check it parses (`node -e "JSON.parse(require('fs').readFileSync('vus-chat-rules.json','utf8'))"`).
- **Checks:** run `node --check` on any JS file you edit. Rules can't be tested against the live database: for rule changes write a small Node simulator (mock `data`/`newData`/`root`) and test allowed and cheating cases. Don't use methods Firebase rules lack (e.g. `numChildren`).
- **Editing:** use small anchored `edit_file` edits (new text must avoid the `$` character: replacement uses String.replace semantics). Save every finished piece to the owner's disk right away; Claude's temporary workspace is wiped between chats.
- **Ask first** before large or irreversible changes; show the plan for new minigames or features. Gift crates (`gc`) stay off unless the owner asks.

## When you finish a task
Update "Status" and "Log" in `HANDOFF.md`.
