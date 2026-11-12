// node:http adapter. The app calls handle() first for every request (it answers only the
// timings endpoint), and start() first thing in the route it wants timed.
import type { IncomingMessage, ServerResponse } from "node:http";
import { answerTimings, logFailure } from "./endpoint.ts";
import { isValidRunId, RUN_HEADER, TOKEN_HEADER, type TimingStore } from "./protocol.ts";
import { CaliperRun, hasBytes } from "./run.ts";
import { tokenMatches } from "./token.ts";

export * from "./index.ts";

export type TimingsOptions = {
  // The CALIPER_TOKEN secret. Unset or empty: nothing is recorded and handle() answers nothing.
  token: string | undefined;
  store: TimingStore;
};

export type Timings = {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  start(req: IncomingMessage, res: ServerResponse): Promise<CaliperRun | null>;
};

const header = (req: IncomingMessage, name: string) => {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
  return true;
}

export function createTimings({ token, store }: TimingsOptions): Timings {
  const secret = token || undefined;

  return {
    // GET /__caliper/timings/:id, checked in SPEC.md's order. Returns false (and leaves the
    // response alone) for any other request, and for every request when no secret is set, so
    // the app answers it like any unknown route.
    async handle(req, res) {
      const answer = await answerTimings(req.method ?? "", req.url ?? "/", header(req, "authorization"), secret, store);
      if (!answer) return false;
      return sendJson(res, answer.status, answer.body);
    },

    // A CaliperRun when the request carries a valid x-caliper-run and the right x-caliper-token,
    // otherwise null and the request and response are left exactly as they were. A malformed id
    // is ignored here; the endpoint rejects it with 400 when Caliper asks for it. Never throws:
    // if anything fails, the request runs unmarked.
    async start(req, res) {
      try {
        const arrived = Date.now();
        const id = header(req, RUN_HEADER);
        if (id === undefined || !secret) return null;
        const given = header(req, TOKEN_HEADER);
        if (given === undefined || !isValidRunId(id)) return null;
        if (!(await tokenMatches(given, secret))) return null;

        const run = new CaliperRun(id, store, { start: arrived });
        watchResponse(run, res);
        return run;
      } catch (err) {
        logFailure("Caliper timings off for this request", err);
        return null;
      }
    },
  };
}

// The record is saved once: at the first res.write with bytes (a streamed reply: firstChunk is
// marked then), or else when the response closes (finished, or the client left). Every write
// goes through unchanged, and whatever the original write does (returns, throws) is what the app
// sees; after the first, res.write is the original again. The wrapper's own part can't throw.
function watchResponse(run: CaliperRun, res: ServerResponse) {
  let saved = false;
  const write = res.write as (...args: unknown[]) => boolean;
  res.write = function (this: ServerResponse, ...args: unknown[]) {
    // Backstop for the never-change-the-app rule (SPEC.md). Nothing inside can throw today;
    // this protects future edits. No test can trigger it.
    try {
      if (!saved && hasBytes(args[0])) {
        saved = true;
        res.write = write as ServerResponse["write"];
        run.status = res.statusCode;
        run.mark("firstChunk");
        void run.save();
      }
    } catch (err) {
      logFailure("Caliper timing record not saved", err);
    }
    return write.apply(this, args);
  } as ServerResponse["write"];

  res.once("close", () => {
    try {
      if (saved) return;
      saved = true;
      run.status = res.headersSent ? res.statusCode : null;
      void run.save();
    } catch (err) {
      logFailure("Caliper timing record not saved", err);
    }
  });
}
