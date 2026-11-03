// A plain node:http server (one process, no dependencies) with delays we control, so Caliper's
// server timings can be checked against known true values.
//   GET  /                   a page with a Generate button and an #output textarea
//   POST /api/generate       waits DB_MS (the stand-in "database"), sends its headers, then the
//                            stand-in "model" streams CHUNKS SSE events: the first FIRST_CHUNK_MS
//                            after the headers, the rest CHUNK_GAP_MS apart
//   GET  /__example/stamps   this server's own count of /api/generate requests and the
//                            x-caliper-run id each one carried (the token is never kept or shown)
// Each /api/generate request also prints one line. Listens on 127.0.0.1 only.
// Not wired to caliper-timings yet.
// Run with `node examples/node-memory/server.mjs` (PORT=8790 by default).

import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const HOST = "127.0.0.1";
const DB_MS = 300;
const FIRST_CHUNK_MS = 100;
const CHUNK_GAP_MS = 100;
const CHUNKS = 5;

const port = Number(process.env.PORT ?? 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT must be a whole number from 1 to 65535, got "${process.env.PORT}".`);
  process.exit(1);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>node-memory example</title>
</head>
<body>
<button id="generate">Generate</button>
<label for="output">Output</label>
<textarea id="output" rows="8" cols="60" readonly></textarea>
<script>
  const output = document.getElementById("output");
  document.getElementById("generate").addEventListener("click", async () => {
    output.value = "";
    const res = await fetch("/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const events = buffer.split("\\n\\n");
      buffer = events.pop();
      for (const event of events) output.value += JSON.parse(event.replace(/^data: /, "")).t;
    }
  });
</script>
</body>
</html>
`;

// Counted here, on the server's side, not taken from Caliper's output.
const stamps = { generate: 0, unmarked: 0, byRun: {} };

function count(req) {
  stamps.generate++;
  const run = req.headers["x-caliper-run"];
  if (run === undefined) {
    stamps.unmarked++;
    console.log(`generate #${stamps.generate}: unmarked`);
    return;
  }
  stamps.byRun[run] = (stamps.byRun[run] ?? 0) + 1;
  const token = req.headers["x-caliper-token"] === undefined ? "no x-caliper-token" : "x-caliper-token present";
  console.log(`generate #${stamps.generate}: x-caliper-run ${run} (${token}; ${stamps.byRun[run]} for this id)`);
}

async function generate(req, res) {
  req.resume(); // the body isn't used
  await sleep(DB_MS); // stand-in database
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  res.flushHeaders();
  for (let i = 1; i <= CHUNKS; i++) {
    await sleep(i === 1 ? FIRST_CHUNK_MS : CHUNK_GAP_MS); // stand-in model
    if (res.destroyed) return; // the page left
    res.write(`data: ${JSON.stringify({ t: `Chunk ${i} of ${CHUNKS}. ` })}\n\n`);
  }
  res.end();
}

const server = createServer((req, res) => {
  let path;
  try {
    path = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    res.writeHead(400, { "content-type": "text/plain" }).end("bad request URL");
    return;
  }
  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PAGE);
  } else if (req.method === "POST" && path === "/api/generate") {
    count(req);
    void generate(req, res);
  } else if (req.method === "GET" && path === "/__example/stamps") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(stamps));
  } else {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
});

server.listen(port, HOST, () => console.log(`node-memory example on http://${HOST}:${port}/`));

process.on("SIGINT", () => {
  console.log(`stamps: ${JSON.stringify(stamps)}`);
  process.exit(0);
});
