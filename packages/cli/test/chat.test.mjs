// Proves chat-style triggers end to end: runs the built CLI with --input/--prompt against the
// local chat fixture, whose page shows your message and a "Thinking…" placeholder before the
// streamed reply, and fails unless every run's first word comes after the AI request's first
// byte and both the terminal and the HTML report list the pre-reply changes.
// Run with `npm run test:chat` (builds first).

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFixtureServer } from "./fixtures/server.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));
const PROMPT = "hello";
const PLACEHOLDER = "Thinking…";
const FETCH_DELAY_MS = 800; // chat-page.html fetches the reply this long after Enter

// Each run's block: from its "run N" line to the next one (or the summary).
function runBlocks(stdout) {
  return stdout.split(/^(?=run \d)/m).filter((b) => /^run \d/.test(b)).map((b) => b.split(/^cold /m)[0]);
}

const msOf = (block, label) => {
  const m = block.match(new RegExp(`^\\s+${label}\\s+(-?\\d+) ms`, "m"));
  return m ? Number(m[1]) : null;
};

// The pre-reply lines under "pre-reply changes (not timed):", as { at, text }.
function preReply(block) {
  return [...block.matchAll(/^\s+\+(\d+) ms {2}(".*")$/gm)].map((m) => ({ at: Number(m[1]), text: JSON.parse(m[2]) }));
}

const server = await startFixtureServer();
const dir = mkdtempSync(join(tmpdir(), "caliper-chat-"));
const report = join(dir, "report.html");
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

let stdout = "";
try {
  const args = [cli, "audit", `${server.url}/chat`, "--input", "#msg", "--prompt", PROMPT, "--output", "#messages",
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
    const changes = preReply(block);
    check(firstWord !== null && firstByte !== null && firstWord >= firstByte,
      `${name}: first word (${firstWord} ms) is at or after the first body byte (${firstByte} ms)`);
    // Independent of Caliper's own first byte: nothing before the fetch can be the reply.
    check(firstWord !== null && firstWord >= FETCH_DELAY_MS,
      `${name}: first word (${firstWord} ms) is after the page's ${FETCH_DELAY_MS} ms fetch delay`);
    const placeholder = changes.find((c) => c.text === PLACEHOLDER);
    check(!!placeholder && placeholder.at < firstByte, `${name}: "${PLACEHOLDER}" listed as a pre-reply change, before the first byte`);
    check(!changes.some((c) => c.text === PROMPT), `${name}: your own message isn't counted`);
  }

  let html = "";
  try {
    html = readFileSync(report, "utf8");
  } catch {}
  check(html.includes("Before the reply") && html.includes(`&quot;${PLACEHOLDER}&quot;`), "HTML report lists the pre-reply changes");
} finally {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) console.log(stdout.replace(/^/gm, "     | "));
process.exitCode = failures.length ? 1 : 0;
