#!/usr/bin/env node
import { parseArgs } from "node:util";
import { CliError } from "./errors.mjs";

const USAGE = `Usage:
  context-lens login <url> [--auth auth.json]
      Open a browser, log in by hand, save the session.

  context-lens audit <url> --measure <text> --output <selector>
      [--step <text>]... [--runs 3] [--headed] [--auth auth.json] [--timeout 60000]
      [--request <regex>]
      Measure time from clicking the --measure button to first painted output,
      and break it down using the AI request (auto-detected, or the first whose
      URL matches --request).

  --step and --measure are button names, matched as case-insensitive regexes.`;

const COMMANDS = {
  login: {
    options: {
      auth: { type: "string", default: "auth.json" },
    },
    async run({ url, values }) {
      const { login } = await import("./login.mjs");
      await login({ url, auth: values.auth });
    },
  },

  audit: {
    options: {
      measure: { type: "string" },
      output: { type: "string" },
      step: { type: "string", multiple: true, default: [] },
      runs: { type: "string", default: "3" },
      headed: { type: "boolean", default: false },
      auth: { type: "string", default: "auth.json" },
      timeout: { type: "string", default: "60000" },
      request: { type: "string" },
    },
    async run({ url, values }) {
      if (!values.measure) throw new CliError("audit: --measure <text> is required.");
      if (!values.output) throw new CliError("audit: --output <selector> is required.");

      const { audit } = await import("./audit.mjs");
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
      });
    },
  },
};

function positiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError(`${flag} must be a positive integer, got "${value}".`);
  }
  return n;
}

async function main(argv) {
  const [name, ...rest] = argv;

  if (!name || name === "--help" || name === "-h" || name === "help") {
    console.log(USAGE);
    return;
  }

  const command = COMMANDS[name];
  if (!command) throw new CliError(`Unknown command "${name}".\n\n${USAGE}`);

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...command.options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new CliError(`${name}: ${err.message}\n\n${USAGE}`);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 1) {
    throw new CliError(`${name}: expected exactly one <url>, got ${positionals.length}.\n\n${USAGE}`);
  }

  await command.run({ url: positionals[0], values });
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
