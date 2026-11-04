# node-memory example

A fake AI app on plain `node:http` with delays we control, wired to [`caliper-timings`](../../packages/timings/) with `MemoryStore`. It's for checking Caliper's server timings against known true values. No dependencies. Needs Node 22.18+ (it imports the timings package's TypeScript source directly).

| Route | |
|---|---|
| `GET /` | a page with a **Generate** button and an `#output` textarea |
| `POST /api/generate` | waits 300 ms (the stand-in database), sends its headers, then streams 5 SSE events: the first 100 ms after the headers, the rest 100 ms apart |
| `GET /__example/stamps` | the server's own count of `/api/generate` requests, and how many carried each `x-caliper-run` id (the token is never kept or shown) |
| `GET /__caliper/timings/:id` | the `caliper-timings` endpoint; 404 like any unknown route when `CALIPER_TOKEN` is unset |

A marked `/api/generate` request records `dbStart` / `dbEnd` around the 300 ms wait, `modelCallSent` just before the headers, and `firstChunk` at the first write.

## Run the server

From the repo root:

```sh
CALIPER_TOKEN=local-test-token node examples/node-memory/server.mjs
```

It listens on `127.0.0.1:8790` only (`PORT` to change it) and prints one line per `/api/generate` request. Ctrl-C prints the final stamp count. Without `CALIPER_TOKEN` the app runs the same, with server timings off.

## measure.mjs: client-side timings

curl can't show where chunks start and end. `measure.mjs` records when the headers and each body chunk reach the client, in ms from when the request was sent (client clock). Each request goes on a new connection, one at a time. It prints min / median / max and writes the raw data as JSON (default `measure-results.json` in the current directory). `BASE` (default `http://127.0.0.1:8790`) and `RUNS` (default 20) come from the environment.

**Marked vs unmarked, one server.** With the server above running:

```sh
CALIPER_TOKEN=local-test-token node examples/node-memory/measure.mjs results.json
```

This sends `RUNS` marked requests (a unique `x-caliper-run` each) and `RUNS` unmarked, alternating. For each marked one it reads the stored record. It prints the db span (`dbEnd − dbStart`), the model span (`firstChunk − modelCallSent`), client first-chunk times and gaps between chunks for both groups, and the server's stamp count.

**Unmarked only, two servers.** To compare against another server (for example the app before it was wired, `git show ac68fe9:examples/node-memory/server.mjs` saved outside the repo and run with `PORT=8791`):

```sh
COMPARE=http://127.0.0.1:8791 node examples/node-memory/measure.mjs results.json
```

This sends `RUNS` unmarked requests to each of `BASE` and `COMPARE`, alternating, and prints first-chunk times for each and the paired difference (`BASE − COMPARE`). No token needed.

## Caliper against it

Build the CLI once (`npm run build` in `packages/cli`), start the server as above, then from the repo root:

```sh
CALIPER_TOKEN=local-test-token node packages/cli/dist/cli.js audit http://127.0.0.1:8790/ \
  --measure "Generate" --output "#output" --runs 3 \
  --server-timings http://127.0.0.1:8790 --server-runs 3
```

No `--auth`: the app has no login. Caliper writes no report file unless you pass `--report`. Expect a `pre-check: feature on, token accepted` line, three marked visits, and an "Inside the server" block with a `db` span near 300 ms and `model call → first bytes sent` near 100 ms. `/__example/stamps` should then show 3 unmarked requests (the timed runs) and exactly 1 for each marked run id.
