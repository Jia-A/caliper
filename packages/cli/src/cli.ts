#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from "node:util";
import { CliError, messageOf } from "./errors.js";

const DEFAULT_REPORT = "caliper-report.html";

const USAGE = `Usage:
  caliper login <url> [--auth auth.json]
      Open a browser, log in by hand, save the session.

  caliper audit <url> --measure <text> --output <selector>
      [--step <text>]... [--runs 3] [--headed] [--auth auth.json] [--timeout 60000]
      [--request <regex>] [--report [path]]
      Measure time from clicking the --measure button to first painted output,
      and break it down using the AI request (auto-detected, or the first whose
      URL matches --request). --report writes an HTML timeline
      (default: ${DEFAULT_REPORT}).

  --step and --measure are button names, matched as case-insensitive regexes.`;

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
      output: { type: "string" },
      step: { type: "string", multiple: true, default: [] },
      runs: { type: "string", default: "3" },
      headed: { type: "boolean", default: false },
      auth: { type: "string", default: "auth.json" },
      timeout: { type: "string", default: "60000" },
      request: { type: "string" },
      report: { type: "string" },
    },
    optionalValues: { report: DEFAULT_REPORT },
    async run({ url, values }) {
      if (!values.measure) throw new CliError("audit: --measure <text> is required.");
      if (!values.output) throw new CliError("audit: --output <selector> is required.");

      const { audit } = await import("./audit.js");
      await audit({
        url,
        measure: values.measure,
        output: values.output,
        steps: values.step,
        runs: positiveInt(values.runs, "--runs"),
        headed: values.headed,
        auth: values.auth,
        timeout: positiveInt(values.timeout, "--timeout"),
        request: values.request,
        report: values.report,
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
