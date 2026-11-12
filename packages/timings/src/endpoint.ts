// The timings endpoint (GET /__caliper/timings/:id), shared by the adapters: what to answer, in
// SPEC.md's check order, or null when the request isn't the endpoint's (the app answers it).
import { isValidRunId, TIMINGS_PATH, type TimingRecord, type TimingStore } from "./protocol.ts";
import { tokenMatches } from "./token.ts";

export type EndpointAnswer = { status: number; body: unknown };

export async function answerTimings(
  method: string,
  url: string,
  authorization: string | null | undefined,
  secret: string | undefined,
  store: TimingStore,
): Promise<EndpointAnswer | null> {
  if (!secret || method !== "GET") return null;
  let path: string;
  try {
    path = new URL(url, "http://localhost").pathname;
  } catch {
    return null; // a URL that doesn't parse is the app's to answer
  }
  if (!path.startsWith(TIMINGS_PATH)) return null;

  // Checked before anything else, so an unauthenticated call never reads the store.
  const bearer = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
  if (bearer === undefined || !(await tokenMatches(bearer, secret))) {
    return { status: 401, body: { error: { code: "UNAUTHORIZED", message: "Missing or invalid Caliper token" } } };
  }

  let id = "";
  try {
    id = decodeURIComponent(path.slice(TIMINGS_PATH.length));
  } catch {
    // Not valid percent-encoding: rejected as malformed below.
  }
  if (!isValidRunId(id)) {
    return { status: 400, body: { error: { code: "INVALID_RUN_ID", message: "Run id must be 1-64 characters of A-Z, a-z, 0-9, _ or -" } } };
  }

  let record: TimingRecord | null;
  try {
    record = await store.get(id);
  } catch (err) {
    logFailure("Caliper timing record not read", err);
    return { status: 500, body: { error: { code: "STORE_ERROR", message: "The timing store failed; see the server log" } } };
  }
  if (!record) return { status: 404, body: { error: { code: "NOT_FOUND", message: "No timing record for this run id" } } };
  return { status: 200, body: record };
}

export function logFailure(what: string, err: unknown) {
  try {
    console.error(what, err);
  } catch {
    // Not even the log: drop it.
  }
}
