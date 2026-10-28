#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from "node:util";
import { CliError, messageOf } from "./errors.js";

const DEFAULT_REPORT = "caliper-report.html";

const USAGE = `Usage:
  caliper login <url> [--auth auth.json]
      Open a browser, log in by hand, save the session.

  caliper audit <url> (--measure <text> | --measure-selector <css>) --output <selector>
  caliper audit <url> --input <selector> --prompt <text> --output <selector>
      [--measure <text> | --measure-selector <css>]
      [--step <text>]... [--runs 3] [--headed] [--auth auth.json] [--timeout 60000]
      [--request <regex>] [--report [path]] [--settle-ms 2000] [--stop <text>] [--double]
      [--canary] [--canary-input <selector>] [--csp] [--server-timings <origin>]
      Measure time from clicking the --measure button to first painted output,
      and break it down using the AI request (auto-detected, or the first whose
      URL matches --request). --report writes an HTML timeline
      (default: ${DEFAULT_REPORT}). The answer counts as done at its last change
      once the output has been unchanged for --settle-ms.
      --stop adds one extra run that clicks the Stop button mid-stream and checks
      that the output stops and the browser aborts the AI request.
      --double adds one extra run that clicks the --measure button again mid-stream
      and checks whether the first request is cancelled and the output replaced.
      --canary adds one extra run that checks whether a markdown image the model
      was told to write becomes an image request. --canary-input types that
      instruction into the matching input first (and implies --canary); without
      it, paste the printed line into content the AI reads.
      --csp reads the page's Content-Security-Policy and reports where images may
      load from (on by default with --canary).
      --input and --prompt time a chat-style page instead: Caliper types --prompt
      into --input and sends it with the --measure button, or Enter without one.
      --output may then be the message list; the first word is its first change
      after the AI request's first byte, so your own message and placeholders like
      "Thinking…" don't count. Not yet combinable with --stop, --double or --canary.
      --server-timings <origin> (with CALIPER_TOKEN set) adds one marked visit after
      the runs: the first request after the click that matches the AI request the
      runs picked (method, origin, path; changing path parts as wildcards) gets
      x-caliper-run and x-caliper-token headers. Only if that request goes to
      exactly this origin, and only after a token pre-check against its
      /__caliper/timings endpoint; otherwise nothing is sent. Then the server's
      record for that run is fetched and printed (terminal only), apart from the
      user timings. The token is never printed.
      --measure-selector clicks the one element a CSS selector matches instead of a
      button by name, for icon-only buttons with no text or aria-label. It must match
      exactly one element; Caliper prints it before each run. Tested in click runs and
      chat-style runs (--input/--prompt) only. It isn't tested with --stop, --double or
      --canary yet. Not together with --measure.

  --step, --measure and --stop are button names, matched as case-insensitive regexes.`;

type OptionsConfig = NonNullable<ParseArgsConfig["options"]>;

// What parseArgs returns for these options, typed per option (string, boolean, string[]…).
type Values<O extends OptionsConfig> = ReturnType<
  typeof parseArgs<{ args: string[]; options: O; allowPositionals: true; strict: true }>
>["values"];

interface Command<O extends OptionsConfig> {
  options: O;
  optionalValues?: Record<string, string>;
  run(args: { url: string; values: Values<O> }): Promise<void>;
}

// Keeps each command's option types precise instead of widening them to one shared shape.
function command<const O extends OptionsConfig>(c: Command<O>): Command<O> {
  return c;
}

const COMMANDS = {
  login: command({
    options: {
      auth: { type: "string", default: "auth.json" },
    },
    async run({ url, values }) {
      const { login } = await import("./login.js");
      await login({ url, auth: values.auth });
    },
  }),

  audit: command({
    options: {
      measure: { type: "string" },
      "measure-selector": { type: "string" },
      output: { type: "string" },
      step: { type: "string", multiple: true, default: [] },
      runs: { type: "string", default: "3" },
      headed: { type: "boolean", default: false },
      auth: { type: "string", default: "auth.json" },
      timeout: { type: "string", default: "60000" },
      "settle-ms": { type: "string", default: "2000" },
      request: { type: "string" },
      report: { type: "string" },
      stop: { type: "string" },
      double: { type: "boolean", default: false },
      canary: { type: "boolean", default: false },
      "canary-input": { type: "string" },
      csp: { type: "boolean", default: false },
      input: { type: "string" },
      prompt: { type: "string" },
      "server-timings": { type: "string" },
    },
    optionalValues: { report: DEFAULT_REPORT },
    async run({ url, values }) {
      if (values.measure !== undefined && values["measure-selector"] !== undefined) {
        throw new CliError("audit: pass --measure <text> or --measure-selector <css>, not both.");
      }
      if (!values.measure && !values["measure-selector"] && !values.input) {
        throw new CliError("audit: --measure <text> or --measure-selector <css> (or --input <selector>) is required.");
      }
      if (!values.output) throw new CliError("audit: --output <selector> is required.");
      if (values.input && values.prompt === undefined) throw new CliError("audit: --input needs --prompt <text>.");
      if (values.prompt !== undefined && !values.input) throw new CliError("audit: --prompt needs --input <selector>.");
      if (values.input) {
        const clash = (["stop", "double", "canary", "canary-input"] as const).find((f) => values[f]);
        if (clash) throw new CliError(`audit: --${clash} can't be combined with --input yet.`);
      }

      let serverTimings: { origin: string; token: string } | undefined;
      if (values["server-timings"] !== undefined) {
        const token = process.env.CALIPER_TOKEN;
        if (!token) throw new CliError("audit: --server-timings needs CALIPER_TOKEN set in the environment.");
        serverTimings = { origin: parseOrigin(values["server-timings"]), token };
      }

      const { audit } = await import("./audit.js");
      await audit({
        url,
        measure: values.measure ? { name: values.measure } : values["measure-selector"] ? { selector: values["measure-selector"] } : undefined,
        output: values.output,
        steps: values.step,
        runs: positiveInt(values.runs, "--runs"),
        headed: values.headed,
        auth: values.auth,
        timeout: positiveInt(values.timeout, "--timeout"),
        settleMs: positiveInt(values["settle-ms"], "--settle-ms"),
        request: values.request,
        report: values.report,
        stop: values.stop,
        double: values.double,
        canary: values.canary,
        canaryInput: values["canary-input"],
        csp: values.csp,
        chat: values.input ? { input: values.input, prompt: values.prompt! } : undefined,
        serverTimings,
      });
    },
  }),
};

// parseArgs has no optional-value options, so a bare `--flag` (followed by nothing, another
// flag, or the <url>) becomes `--flag=<default>`.
function withOptionalValues(args: string[], defaults: Record<string, string>): string[] {
  return args.map((arg, i) => {
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    if (name === null || !(name in defaults)) return arg;
    const next = args[i + 1];
    const takesNext = next !== undefined && !next.startsWith("-") && !/^[a-z][a-z\d+.-]*:\/\//i.test(next);
    return takesNext ? arg : `${arg}=${defaults[name]}`;
  });
}

// An http(s) origin and nothing else (a trailing "/" is fine), normalized the way the browser
// writes it: lowercase host, no default port.
function parseOrigin(value: string): string {
  const fail = () => new CliError(`audit: --server-timings must be an origin like https://api.example.com (scheme, host and optional port), got "${value}".`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail();
  }
  const extra = url.pathname !== "/" || url.search || url.hash || url.username || url.password || value.includes("?") || value.includes("#");
  if (!/^https?:$/.test(url.protocol) || extra) throw fail();
  return url.origin;
}

function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError(`${flag} must be a positive integer, got "${value}".`);
  }
  return n;
}

async function runCommand<O extends OptionsConfig>(name: string, command: Command<O>, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: withOptionalValues(rest, command.optionalValues ?? {}),
      options: { ...command.options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new CliError(`${name}: ${messageOf(err)}\n\n${USAGE}`);
  }

  // TypeScript can't evaluate parseArgs' result type for a generic O, so name the two views
  // we need: the extra --help flag, and the command's own options.
  const { positionals } = parsed;
  if ((parsed.values as { help?: boolean }).help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 1) {
    throw new CliError(`${name}: expected exactly one <url>, got ${positionals.length}.\n\n${USAGE}`);
  }

  await command.run({ url: positionals[0]!, values: parsed.values as Values<O> });
}

async function main(argv: string[]): Promise<void> {
  const [name, ...rest] = argv;

  if (!name || name === "--help" || name === "-h" || name === "help") {
    console.log(USAGE);
    return;
  }

  if (!Object.hasOwn(COMMANDS, name)) throw new CliError(`Unknown command "${name}".\n\n${USAGE}`);
  const key = name as keyof typeof COMMANDS;
  // Each branch keeps its command's own option types.
  if (key === "login") await runCommand(name, COMMANDS.login, rest);
  else await runCommand(name, COMMANDS.audit, rest);
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof CliError) {
    console.error(`error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}
