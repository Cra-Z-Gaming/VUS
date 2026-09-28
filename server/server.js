import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { extname, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const API_TOKEN = process.env.VUS_CHAT_TOKEN || randomBytes(32).toString("hex");
const MAX_MESSAGES = 200;
const MAX_BODY_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 10 * 1000;
const RATE_LIMIT = 8;

const messages = [];
const eventClients = new Set();
const requestWindows = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg"
};

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function sendEvent(response, event, value) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function broadcast(event, value) {
  for (const response of eventClients) sendEvent(response, event, value);
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!total) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function cleanMessage(input) {
  const name = String(input.name || "").trim().slice(0, 40);
  const text = String(input.text || "").trim().slice(0, 500);
  if (!name || !text) return null;
  return { name, text, ts: Date.now() };
}

function requestAddress(request) {
  return request.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    request.socket.remoteAddress || "unknown";
}

function isRateLimited(request) {
  const now = Date.now();
  const key = requestAddress(request);
  const recent = (requestWindows.get(key) || []).filter(ts => now - ts < RATE_WINDOW_MS);
  recent.push(now);
  requestWindows.set(key, recent);
  return recent.length > RATE_LIMIT;
}

function authorizeWrite(request, response) {
  const origin = request.headers.origin;
  const expectedOrigin = `http://${HOST}:${PORT}`;
  if (origin && origin !== expectedOrigin && origin !== "null") {
    sendJson(response, 403, { error: "Origin is not allowed" });
    return false;
  }
  if (request.headers.authorization !== `Bearer ${API_TOKEN}`) {
    sendJson(response, 401, { error: "Authentication required" });
    return false;
  }
  if (isRateLimited(request)) {
    sendJson(response, 429, { error: "Too many messages; try again shortly" });
    return false;
  }
  return true;
}

async function serveFile(request, response, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(ROOT, "." + decodeURIComponent(requestedPath));
  const rootRelativePath = relative(ROOT, filePath);
  if (rootRelativePath.startsWith("..") || rootRelativePath.includes(".." + "/")) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "File not found" });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  response.setHeader("Access-Control-Allow-Origin", `http://${HOST}:${PORT}`);
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "vus-local-server", messages: messages.length });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/messages") {
    sendJson(response, 200, messages);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    response.write(": connected\n\n");
    eventClients.add(response);
    request.on("close", () => eventClients.delete(response));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/messages") {
    if (!authorizeWrite(request, response)) return;
    try {
      const message = cleanMessage(await readJsonBody(request));
      if (!message) {
        sendJson(response, 400, { error: "name and text are required" });
        return;
      }
      messages.push(message);
      while (messages.length > MAX_MESSAGES) messages.shift();
      broadcast("message", message);
      sendJson(response, 201, message);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Invalid JSON" });
    }
    return;
  }

  if (request.method === "GET") {
    await serveFile(request, response, normalize(url.pathname));
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
});

server.listen(PORT, HOST, () => {
  console.log(`VUS local server running at http://${HOST}:${PORT}`);
  console.log(`Serving files from ${ROOT}`);
  if (!process.env.VUS_CHAT_TOKEN) {
    console.log(`VUS chat API token (keep private): ${API_TOKEN}`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const response of eventClients) response.end();
    server.close(() => process.exit(0));
  });
}
