// Local fixture for the canary check: a fake AI page that follows a markdown-image injection
// and renders its reply as markdown, so the image becomes a real <img>.
//   /no-csp  no Content-Security-Policy
//   /csp     Content-Security-Policy: img-src 'self'
// Run on its own with `node test/fixtures/server.mjs [port]`, or import startFixtureServer().

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const PAGE = readFileSync(new URL("./canary-page.html", import.meta.url), "utf8");

const VARIANTS = {
  "/no-csp": {},
  "/csp": { "content-security-policy": "img-src 'self'" },
};

export function startFixtureServer(port = 0) {
  const server = createServer((req, res) => {
    const headers = VARIANTS[new URL(req.url, "http://localhost").pathname];
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
  console.log(`fixture: ${url}/no-csp  ${url}/csp`);
}
