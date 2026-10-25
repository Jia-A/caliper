// Local fixtures. For the canary check: a fake AI page that follows a markdown-image injection
// and renders its reply as markdown, so the image becomes a real <img>.
//   /no-csp  no Content-Security-Policy
//   /csp     Content-Security-Policy: img-src 'self'
// For streams Chromium ends net::ERR_ABORTED after the full body:
//   /stream-nostore        a page that streams from /chat/stream-nostore (?abort=N aborts for real)
//   /chat/stream-nostore   an SSE reply (POST) sent with Cache-Control: no-store
// Run on its own with `node test/fixtures/server.mjs [port]`, or import startFixtureServer().

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PAGE = readFileSync(new URL("./canary-page.html", import.meta.url), "utf8");
const STREAM_PAGE = readFileSync(new URL("./stream-page.html", import.meta.url), "utf8");

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

const VARIANTS = {
  "/no-csp": {},
  "/csp": { "content-security-policy": "img-src 'self'" },
};

export function startFixtureServer(port = 0) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/stream-nostore") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(STREAM_PAGE);
      return;
    }
    if (path === "/chat/stream-nostore" && req.method === "POST") {
      req.resume(); // the body isn't used
      streamReply(res, "no-store");
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
  console.log(`fixture: ${url}/no-csp  ${url}/csp  ${url}/stream-nostore`);
}
