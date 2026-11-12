// Fetch adapter (Web Request/Response), for runtimes and frameworks that speak fetch: Hono on
// Cloudflare Workers, and others. The token is passed on every call, because on Workers the
// secret is only available inside a request (env). handle() answers only the timings endpoint;
// start() is called first thing in the route to be timed; finish() goes on its response.
import { answerTimings, logFailure } from "./endpoint.ts";
import { isValidRunId, RUN_HEADER, TOKEN_HEADER, type TimingStore } from "./protocol.ts";
import { CaliperRun } from "./run.ts";
import { tokenMatches } from "./token.ts";

export * from "./index.ts";

export type FetchTimingsOptions = {
  // The CALIPER_TOKEN secret. Unset or empty: nothing is recorded and handle() answers nothing.
  token: string | undefined;
  store: TimingStore;
};

export type StartOptions = FetchTimingsOptions & {
  // Keeps a save alive after the response is returned (Workers: ctx.waitUntil). The save runs either way.
  defer?: (p: Promise<void>) => void;
};

// GET /__caliper/timings/:id, checked in SPEC.md's order: the answer, or null for any other
// request and for every request when no secret is set, so the app answers it like any unknown route.
export async function handle(request: Request, { token, store }: FetchTimingsOptions): Promise<Response | null> {
  const answer = await answerTimings(request.method, request.url, request.headers.get("authorization"), token || undefined, store);
  if (!answer) return null;
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// A CaliperRun when the request carries a valid x-caliper-run and the right x-caliper-token,
// otherwise null, and the request runs unmarked. A malformed id is ignored here; the endpoint
// rejects it with 400 when Caliper asks for it. Marks are measured from this call. Never throws.
export async function start(request: Request, { token, store, defer }: StartOptions): Promise<CaliperRun | null> {
  try {
    const arrived = Date.now();
    const secret = token || undefined;
    const id = request.headers.get(RUN_HEADER);
    if (id === null || !secret) return null;
    const given = request.headers.get(TOKEN_HEADER);
    if (given === null || !isValidRunId(id)) return null;
    if (!(await tokenMatches(given, secret))) return null;
    return new CaliperRun(id, store, { start: arrived, ...(defer && { defer }) });
  } catch (err) {
    logFailure("Caliper timings off for this request", err);
    return null;
  }
}

// Notes the response's status and returns the response as it was. A streamed reply passed
// through run.watchFirstChunk is saved at its first chunk with bytes; any other reply is saved
// here. Never throws.
export function finish(run: CaliperRun, response: Response): Response {
  try {
    run.status = response.status;
    if (!run.savesOnStream) void run.save();
  } catch (err) {
    logFailure("Caliper timing record not saved", err);
  }
  return response;
}
