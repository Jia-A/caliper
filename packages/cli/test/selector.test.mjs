// Proves --measure-selector against a local fixture whose send button is icon-only (an <svg>, no
// text, no aria-label) and where Enter doesn't send. First checks the fixture really is out of
// reach without it: --measure finds no button and Enter sends nothing. Then fails unless
// --measure-selector times the reply in click mode and in --input/--prompt chat mode, prints
// the clicked element before each run, and stops (never picks) when the selector matches 0 or
// 2 elements or is passed together with --measure.
// Run with `npm run test:selector` (builds first).

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFixtureServer } from "./fixtures/server.mjs";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));
const FETCH_DELAY_MS = 800; // icon-page.html fetches the reply this long after the click
const CLICKED = /^clicking <button id="UploadAndSendButton"> \(no text or aria-label\)$/gm;

const runBlocks = (stdout) => stdout.split(/^(?=run \d)/m).filter((b) => /^run \d/.test(b)).map((b) => b.split(/^cold /m)[0]);
const msOf = (block, label) => {
  const m = block.match(new RegExp(`^\\s+${label}\\s+(-?\\d+) ms`, "m"));
  return m ? Number(m[1]) : null;
};

// Runs the CLI; never throws. Returns { code, stdout, stderr }.
async function caliper(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "audit", ...args, "--auth", auth], { timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}

const server = await startFixtureServer();
const page = `${server.url}/icon`;
const timed = ["--output", "#messages", "--runs", "2", "--settle-ms", "500", "--timeout", "15000"];
const quick = ["--output", "#messages", "--runs", "1", "--settle-ms", "500", "--timeout", "3000"];
const failures = [];
const logs = [];
const check = (ok, what, out) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) {
    failures.push(what);
    if (out) logs.push(`--- ${what} ---\n${out.stdout}${out.stderr}`);
  }
};

try {
  // The fixture: no name to match, and Enter doesn't send.
  const byName = await caliper([page, "--measure", "send", ...quick]);
  check(byName.code !== 0 && /No button matching \/send\/i/.test(byName.stderr), "fixture: --measure finds no button by name", byName);
  const byEnter = await caliper([page, "--input", "#msg", "--prompt", "hello", ...quick]);
  check(byEnter.code !== 0 || !/^run \d.*\s\d+ ms$/m.test(byEnter.stdout), "fixture: Enter sends nothing, so no timing", byEnter);

  // Click mode.
  const click = await caliper([page, "--measure-selector", "#UploadAndSendButton", ...timed]);
  const clickBlocks = runBlocks(click.stdout);
  check(click.code === 0 && clickBlocks.length === 2, `click mode: 2 runs reported (got ${clickBlocks.length})`, click);
  for (const block of clickBlocks) {
    const name = block.split("\n")[0].replace(/\s+\d+ ms$/, "").trim();
    const firstWord = msOf(block, "click → first word");
    check(firstWord !== null && firstWord >= FETCH_DELAY_MS, `click mode, ${name}: first word (${firstWord} ms) is after the ${FETCH_DELAY_MS} ms fetch delay`, click);
  }
  const clickPrinted = click.stdout.match(CLICKED) ?? [];
  check(clickPrinted.length === 2, `click mode: clicked element printed for each run (got ${clickPrinted.length})`, click);

  // Chat mode.
  const chat = await caliper([page, "--input", "#msg", "--prompt", "hello", "--measure-selector", "#UploadAndSendButton", ...timed]);
  const chatBlocks = runBlocks(chat.stdout);
  check(chat.code === 0 && chatBlocks.length === 2, `chat mode: 2 runs reported (got ${chatBlocks.length})`, chat);
  for (const block of chatBlocks) {
    const name = block.split("\n")[0].replace(/\s+\d+ ms$/, "").trim();
    const firstWord = msOf(block, "send → first word");
    check(firstWord !== null && firstWord >= FETCH_DELAY_MS, `chat mode, ${name}: first word (${firstWord} ms) is after the ${FETCH_DELAY_MS} ms fetch delay`, chat);
  }
  const chatPrinted = chat.stdout.match(CLICKED) ?? [];
  check(chatPrinted.length === 2, `chat mode: clicked element printed for each run (got ${chatPrinted.length})`, chat);

  // Never guess.
  const both = await caliper([page, "--measure", "send", "--measure-selector", "#UploadAndSendButton", ...quick]);
  check(both.code !== 0 && /--measure <text> or --measure-selector <css>, not both/.test(both.stderr) && !/^run \d/m.test(both.stdout),
    "--measure with --measure-selector is an error", both);
  for (const mode of [[], ["--input", "#msg", "--prompt", "hello"]]) {
    const label = mode.length ? "chat mode" : "click mode";
    const two = await caliper([page, ...mode, "--measure-selector", "button.icon", ...quick]);
    check(two.code !== 0 && /--measure-selector "button\.icon" matches 2 elements/.test(two.stderr) && !/^run \d.*\s\d+ ms$/m.test(two.stdout),
      `${label}: a selector matching 2 elements stops, naming the count`, two);
    const none = await caliper([page, ...mode, "--measure-selector", "#NoSuchButton", ...quick]);
    check(none.code !== 0 && /--measure-selector "#NoSuchButton" matches 0 elements/.test(none.stderr) && !/^run \d.*\s\d+ ms$/m.test(none.stdout),
      `${label}: a selector matching 0 elements stops, naming the count`, none);
  }
} finally {
  await server.close();
}

if (logs.length) console.log(logs.join("\n").replace(/^/gm, "     | "));
process.exitCode = failures.length ? 1 : 0;
