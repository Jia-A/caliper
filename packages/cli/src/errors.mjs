// An error meant for the user: cli.mjs prints just the message, no stack trace.
export class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
  }
}
