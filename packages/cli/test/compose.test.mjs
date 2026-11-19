// What to type into and what to click, so a developer never has to guess (caliper-test-3 A1,
// A2, App 1's textarea, and the CLI input tables). Runs the built CLI against /compose:
//   step-name      --step "stream" can't match the toggle (no accessible name): the error lists
//                  the buttons without a name, each with a --step-selector that matches only it,
//                  and never says "Buttons I saw: none"
//   step-selector  --step-selector "button.toggle-btn" clicks it, and the reply is "[stream] …"
//   textarea       --input on a <textarea> and no --measure: the form's only button sends, and
//                  Caliper says so with the flags to change it
//   input pick     --prompt without --input: the only text box is used, and Caliper says so
//   enter          ?form=0: no form, two buttons; Enter only adds a line break, so Caliper stops
//                  right away (not at --timeout) and lists both buttons with ready-to-copy flags
//   two boxes      ?boxes=2 without --input: both text boxes listed with --input flags
// Run with `npm run test:compose` (builds first).

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFixtureServer } from "./fixtures/server.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));
const server = await startFixtureServer();
let failed = 0;
const check = (ok, what, out) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) {
    failed++;
    if (out) console.log(`${out.stdout}\n${out.stderr}`.replace(/^/gm, "     | "));
  }
};
async function caliper(path, args) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, "audit", `${server.url}${path}`, "--output", "#messages", "--runs", "1",
      "--auth", auth, "--settle-ms", "500", "--no-report", ...args], { timeout: 90_000 });
    return { stdout, stderr, code: 0, took: Date.now() - started };
  } catch (err) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1, took: Date.now() - started };
  }
}
const firstWord = (out) => JSON.parse(out.stdout.match(/^\s+first word shows\s+(".*")$/m)?.[1] ?? "null");

try {
  const name = await caliper("/compose", ["--step", "stream", "--input", "textarea", "--prompt", "hi", "--timeout", "3000"]);
  check(name.code !== 0 && name.stderr.includes('Buttons without a name (a name can\'t match them; use a selector): <button> --step-selector "button.toggle-btn"'),
    "step-name: the unnamed toggle is listed with a --step-selector that matches only it", name);
  check(!name.stderr.includes("Buttons I saw: none"), 'step-name: never "Buttons I saw: none"', name);

  const sel = await caliper("/compose", ["--step-selector", "button.toggle-btn", "--input", "textarea", "--prompt", "hi", "--timeout", "15000"]);
  check(sel.code === 0 && String(firstWord(sel)).startsWith("[stream]"), `step-selector: the toggle was clicked, the reply streams (first word: ${JSON.stringify(firstWord(sel))})`, sel);
  check(sel.stdout.includes("clicking <button> \"Streaming response Off\" for --step-selector \"button.toggle-btn\""), "step-selector: says what it clicked, by its text", sel);

  const ta = await caliper("/compose", ["--input", "textarea", "--prompt", "hi", "--timeout", "15000"]);
  check(ta.code === 0 && firstWord(ta) !== null, "textarea: the run is timed", ta);
  check(ta.stdout.includes('sending with <button> "Send", the only button in the <textarea>\'s form (Enter in a <textarea> adds a line break) — to use another: --measure "<name>" or --measure-selector "<css>"'),
    "textarea: says it sends with the form's only button, and how to change it", ta);

  const pick = await caliper("/compose", ["--prompt", "hi", "--timeout", "15000"]);
  check(pick.code === 0 && firstWord(pick) !== null, "input pick: the run is timed", pick);
  check(pick.stdout.includes('typing into <textarea> textarea[name="chat"], the only text box on the page — to use another: --input "<css>"'),
    "input pick: says which text box it typed into, and how to change it", pick);

  const enter = await caliper("/compose?form=0", ["--input", "textarea", "--prompt", "hi", "--timeout", "60000"]);
  check(enter.code !== 0 && enter.took < 20_000, `enter: stops right away, not at --timeout (took ${enter.took} ms)`, enter);
  check(enter.stderr.includes("Enter added a line break to the <textarea> (its text is now your prompt and a new line), so the page didn't take it as a send.")
    && enter.stderr.includes('--measure "^Send$"') && enter.stderr.includes('--measure-selector "button.icon-send"'),
    "enter: says why, and lists both buttons with ready-to-copy flags", enter);

  const boxes = await caliper("/compose?boxes=2", ["--prompt", "hi", "--timeout", "15000"]);
  check(boxes.code !== 0 && boxes.stderr.includes('2 text boxes on the page; pick one: --input "#find" (<input>) · --input "textarea[name=\\"chat\\"]" (<textarea>)'),
    "two boxes: both listed with --input flags", boxes);
} finally {
  await server.close();
}
process.exitCode = failed ? 1 : 0;
