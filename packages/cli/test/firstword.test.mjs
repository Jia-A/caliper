// The first word is the first NEW VISIBLE TEXT in the output that isn't your own message
// (caliper-test-3 #11/#12). Runs the built CLI against /avatar, whose reply stream opens with an
// AI SDK-style {"type":"start"} envelope; on it the page swaps your avatar's "Me" fallback for
// an <img> and adds a hidden tooltip. The reply's text comes AVATAR_TEXT_MS later. Fails unless
// every run's first word is that text, shown in the terminal and the HTML report, and neither
// the image, the hidden tooltip nor your bubble's "Me" is counted.
// Run with `npm run test:firstword` (builds first).

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AVATAR_TEXT_MS, startFixtureServer } from "./fixtures/server.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));
const PROMPT = "What's the weather on Mars right now?";
const FIRST_TEXT = "Hello!";

function runBlocks(stdout) {
  return stdout.split(/^(?=run \d)/m).filter((b) => /^run \d/.test(b)).map((b) => b.split(/^cold /m)[0]);
}
const msOf = (block, label) => {
  const m = block.match(new RegExp(`^\\s+${label}\\s+(-?\\d+) ms`, "m"));
  return m ? Number(m[1]) : null;
};
const preReply = (block) => [...block.matchAll(/^\s+\+(\d+) ms {2}(".*")$/gm)].map((m) => JSON.parse(m[2]));

const server = await startFixtureServer();
const dir = mkdtempSync(join(tmpdir(), "caliper-firstword-"));
const report = join(dir, "report.html");
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

let stdout = "";
try {
  const args = [cli, "audit", `${server.url}/avatar`, "--input", "#msg", "--prompt", PROMPT, "--output", "#messages", "--request", "POST /avatar/stream",
    "--runs", "2", "--auth", auth, "--settle-ms", "500", "--timeout", "15000", "--report", report];
  try {
    ({ stdout } = await run(process.execPath, args, { timeout: 120_000 }));
  } catch (err) {
    stdout = err.stdout ?? "";
    console.error(`caliper exited with an error\n${err.stderr ?? err.message}`);
  }

  const blocks = runBlocks(stdout);
  check(blocks.length === 2, `2 runs reported (got ${blocks.length})`);
  for (const block of blocks) {
    const name = block.split("\n")[0].replace(/\s+\d+ ms$/, "").trim();
    const firstWord = msOf(block, "send → first word");
    const firstByte = msOf(block, "send → first body byte");
    // The envelope is the first body byte; the text comes AVATAR_TEXT_MS after it.
    check(firstWord !== null && firstByte !== null && firstWord - firstByte >= AVATAR_TEXT_MS - 100,
      `${name}: first word (${firstWord} ms) is the reply's text, ≥ ${AVATAR_TEXT_MS - 100} ms after the envelope byte (${firstByte} ms)`);
    const shown = block.match(/^\s+first word shows\s+(".*")$/m);
    check(!!shown && JSON.parse(shown[1]).startsWith(FIRST_TEXT), `${name}: the terminal shows the first word's text (got: ${shown?.[1] ?? "no such line"})`);
    const changes = preReply(block);
    check(!changes.some((t) => t.startsWith("<")), `${name}: no element without text (the avatar <img>) is a change (got ${JSON.stringify(changes)})`);
    check(!changes.some((t) => t.includes("Copy message")), `${name}: hidden text (the tooltip) isn't a change`);
    check(!changes.some((t) => t.includes("Me")), `${name}: your bubble, avatar fallback "Me" included, isn't counted`);
  }

  let html = "";
  try {
    html = readFileSync(report, "utf8");
  } catch {}
  check(html.includes(`&quot;${FIRST_TEXT}`), "HTML report shows the first word's text");
} finally {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) console.log(stdout.replace(/^/gm, "     | "));
process.exitCode = failures.length ? 1 : 0;

// Google's example chat app's DOM sequence (gemini-page.html): the reply is timed from its own
// text, and a reply that never comes says which request is still open (caliper-test-3, App 2).
{
  const srv = await startFixtureServer();
  const failed = [];
  const say = (ok, what, out) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) {
      failed.push(what);
      console.log(out.replace(/^/gm, "     | "));
    }
  };
  const audit = async (path, timeout) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [cli, "audit", `${srv.url}${path}`, "--prompt", "Explain how a rainbow forms.", "--output", ".chat-area",
        "--runs", "2", "--auth", auth, "--settle-ms", "500", "--timeout", String(timeout), "--no-report"], { timeout: 120_000 });
      return { code: 0, out: `${stdout}${stderr}` };
    } catch (err) {
      return { code: err.code ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };
  try {
    const ok = await audit("/gemini", 15000);
    const words = [...ok.out.matchAll(/^\s+first word shows\s+(".*")$/gm)].map((m) => JSON.parse(m[1]));
    say(ok.code === 0 && words.length === 2 && words.every((w) => w.startsWith("Hello!")), `gemini page: both runs timed from the reply's text (got ${JSON.stringify(words)})`, ok.out);
    const hang = await audit("/gemini?hang=1", 4000);
    say(hang.code !== 0 && /Timed out after 4000 ms: "\.chat-area" never changed after sending\. Requests since the send: POST http:\/\/127\.0\.0\.1:\d+\/gemini\/hang → still open, no response \(waiting \d+ ms\)\. If that's your AI request, it never answered: check its server's log\./.test(hang.out),
      "gemini page, reply never comes: the timeout names the request still open", hang.out);
  } finally {
    await srv.close();
  }
  if (failed.length) process.exitCode = 1;
}
