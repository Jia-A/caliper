// An error meant for the user: cli.ts prints just the message, no stack trace.
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

// The audited page didn't load (e.g. net::ERR_TIMED_OUT). A timed run reports it and moves on.
export class PageLoadError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "PageLoadError";
  }
}

// A --step or --measure button that never appeared, with the named buttons that were on the
// page (null when they couldn't be read). audit() adds things to check before it's printed.
export class ButtonNotFoundError extends CliError {
  constructor(
    message: string,
    readonly pattern: RegExp,
    readonly seen: string[] | null,
    readonly unnamed: { tag: string; selector: string }[] = [], // visible buttons with no name, each with a selector that matches only it
    readonly selectorFlag = "--measure-selector" // the flag that clicks one of those
  ) {
    super(message);
    this.name = "ButtonNotFoundError";
  }
}

// A timed run whose AI request couldn't be identified: no request's body bytes explain the
// output changes, or two explain them equally. The run reports it and isn't timed.
// details: more lines to print under the message (the requests the run saw, any that failed).
export class UnidentifiedRequestError extends Error {
  details: string[] = [];
  constructor(message: string) {
    super(message);
    this.name = "UnidentifiedRequestError";
  }
}

// A timed run whose AI request was identified (by timing or --request) but failed: a network
// error before any body bytes, or an HTTP status of 400 or more. What the page showed is an
// error, not a reply, so the run isn't timed. The message names the request and how it failed.
export class FailedRequestError extends UnidentifiedRequestError {
  constructor(message: string) {
    super(message);
    this.name = "FailedRequestError";
  }
}

// The message of anything thrown; catch clauses see `unknown`.
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
