// An error meant for the user: cli.ts prints just the message, no stack trace.
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

// The message of anything thrown; catch clauses see `unknown`.
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
