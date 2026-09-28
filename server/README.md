# VUS Local Server

This is a local-only Node server for developing VUS without opening HTML files directly.

## Start

```sh
cd server
npm start
```

Open `http://127.0.0.1:8787/` in a browser.

The server prints a private API token when it starts. Keep it out of public
HTML and pass it as `Authorization: Bearer <token>` for message writes. A
custom token can be supplied with `VUS_CHAT_TOKEN`. Requests from the VUS
`about:blank` launcher are allowed only when they also have this token.

## Endpoints

- `GET /api/health` checks that the server is running.
- `GET /api/messages` returns the in-memory chat messages.
- `POST /api/messages` accepts `{ "name": "...", "text": "..." }` with the bearer token.
- `GET /api/events` streams new messages using Server-Sent Events.

Messages are intentionally stored in memory and disappear when the server stops. The existing `VUS-Chat` page still uses Firebase; this server provides a protected local backend foundation without changing the production chat connection yet. For the live site, Firebase rules or a deployed authenticated backend must enforce identity server-side; a browser build check alone cannot stop modded clients.
