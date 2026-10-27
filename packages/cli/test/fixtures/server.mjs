// Local fixtures. For the canary check: a fake AI page that follows a markdown-image injection
// and renders its reply as markdown, so the image becomes a real <img>.
//   /no-csp  no Content-Security-Policy
//   /csp     Content-Security-Policy: img-src 'self'
// For streams Chromium ends net::ERR_ABORTED after the full body:
//   /stream-nostore        a page that streams from /chat/stream-nostore (?abort=N aborts for real)
//   /chat/stream-nostore   an SSE reply (POST) sent with Cache-Control: no-store
// For chat-style triggers: a fake chat app that shows a "Thinking…" placeholder, then streams.
//   /chat         the page (?stream=nostore streams from /chat/stream-nostore)
//   /chat/stream  its SSE reply (POST)
// For a fast side-call next to a slow streamed reply (queue-style apps):
//   /sidecall           the page
//   /sidecall/predict   the side-call (POST, JSON after ~200 ms; renders your message + a placeholder)
//   /sidecall/stream    the reply (GET SSE: a status event at once, tokens after SIDECALL_WAIT_MS)
// For an icon-only send button (no accessible name; Enter doesn't send):
//   /icon         the page (streams from /chat/stream)
// Run on its own with `node test/fixtures/server.mjs [port]`, or import startFixtureServer().

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PAGE = readFileSync(new URL("./canary-page.html", import.meta.url), "utf8");
const STREAM_PAGE = readFileSync(new URL("./stream-page.html", import.meta.url), "utf8");
const CHAT_PAGE = readFileSync(new URL("./chat-page.html", import.meta.url), "utf8");
const SIDECALL_PAGE = readFileSync(new URL("./sidecall-page.html", import.meta.url), "utf8");
const ICON_PAGE = readFileSync(new URL("./icon-page.html", import.meta.url), "utf8");

// The streamed reply: headers at once, the first token after a pause, then a token every 60 ms.
const REPLY = "Hello! Here is **a streamed reply**, one token at a time.\n\nIt ends here.".split(/(?<= )/);
const FIRST_TOKEN_MS = 300;
const TOKEN_MS = 60;

async function streamReply(res, cacheControl) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": cacheControl });
  res.flushHeaders();
  await sleep(FIRST_TOKEN_MS);
  for (const t of REPLY) {
    if (res.destroyed) return; // the page aborted
    res.write(`data: ${JSON.stringify({ t })}\n\n`);
    await sleep(TOKEN_MS);
  }
  res.end("data: [DONE]\n\n");
}

export const SIDECALL_WAIT_MS = 2500; // the reply's first token, after the stream opens
// The reply can't be done before its last token: the side-call, the wait, then every token.
export const SIDECALL_MIN_DONE_MS = 200 + SIDECALL_WAIT_MS + (REPLY.length - 1) * TOKEN_MS;

async function sidecallPredict(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  await sleep(200);
  const { prompt } = JSON.parse(body || "{}");
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
  res.end(JSON.stringify({ messages: [{ role: "user", text: prompt ?? "" }] }));
}

async function sidecallStream(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(`data: ${JSON.stringify({ status: "queued" })}\n\n`);
  await sleep(SIDECALL_WAIT_MS);
  for (const t of REPLY) {
    if (res.destroyed) return;
    res.write(`data: ${JSON.stringify({ t })}\n\n`);
    await sleep(TOKEN_MS);
  }
  res.end();
}

const PAGES = { "/stream-nostore": STREAM_PAGE, "/chat": CHAT_PAGE, "/sidecall": SIDECALL_PAGE, "/icon": ICON_PAGE };
const STREAMS = { "/chat/stream": "no-cache", "/chat/stream-nostore": "no-store" };

const VARIANTS = {
  "/no-csp": {},
  "/csp": { "content-security-policy": "img-src 'self'" },
};

export function startFixtureServer(port = 0) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (PAGES[path]) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGES[path]);
      return;
    }
    if (STREAMS[path] && req.method === "POST") {
      req.resume(); // the body isn't used
      streamReply(res, STREAMS[path]);
      return;
    }
    if (path === "/sidecall/predict" && req.method === "POST") {
      sidecallPredict(req, res);
      return;
    }
    if (path === "/sidecall/stream") {
      sidecallStream(res);
      return;
    }
    const headers = VARIANTS[path];
    if (!headers) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(PAGE);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startFixtureServer(Number(process.argv[2] ?? 0));
  console.log(`fixture: ${url}/no-csp  ${url}/csp  ${url}/stream-nostore  ${url}/chat  ${url}/sidecall  ${url}/icon`);
}
