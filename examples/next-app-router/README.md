# next-app-router example

A Next.js App Router app wired to [`caliper-timings`](../../packages/timings/): a page with a **Generate** button and an `#output` textarea, and a route that streams a fixed reply from a stand-in model (no model calls, no keys).

| Route | |
|---|---|
| `GET /` | the page |
| `POST /api/generate` | waits 120 ms (the stand-in database), then streams 10 words, one every 60 ms. A marked request records `dbStart` / `dbEnd`, the prompt sizes with one named part (`question`), `modelCallSent`, and `firstChunk` |
| `GET /__caliper/timings/:id` | the `caliper-timings` endpoint, from the folder `app/%5F_caliper/timings/[id]` |

**The endpoint's folder is `%5F_caliper`.** In the App Router a folder starting with `_` is private and never routed. `%5F` is an encoded `_`, so `%5F_caliper` is the URL segment `__caliper`.

**Saving after the response:** `start(request, { …, defer: (p) => after(() => p) })`, with `after` from `next/server` (Next.js 15.1+). On Vercel, `after` keeps the function alive until the save is done.

**Store:** `UpstashStore.fromEnv(process.env) ?? new MemoryStore()` (`lib/caliper.js`): Upstash Redis when `UPSTASH_REDIS_REST_URL`/`_TOKEN` or Vercel's `KV_REST_API_URL`/`_TOKEN` are set, else memory (one local process only).

## Run it

It isn't installed with the repo. With Next.js 16 and React 19 installed here (`npm install`), and `packages/timings` built (`npm run build` there):

```sh
npm run build
CALIPER_TOKEN=local-next-token npm start -- -p 3011 -H 127.0.0.1
```

Then, from `packages/cli`:

```sh
CALIPER_TOKEN=local-next-token node dist/cli.js audit http://127.0.0.1:3011/ \
  --measure "^generate$" --output "#output" --runs 2 \
  --server-timings http://127.0.0.1:3011 --server-runs 1
```

## Checked by hand (not an automated test)

Once, on 2026-11-13, with Next.js 16.2.6 and React 19.1.0, on 127.0.0.1 (`next build`, then `next start`):

- `next build` listed the route `/__caliper/timings/[id]`. The endpoint answered 401 for a missing or wrong bearer, 400 for `caliper.precheck`, 404 for no record (each `application/json`, `cache-control: no-store`), 405 for `POST`, and `/_caliper/…` (one underscore) was 404.
- Caliper's audit above: both runs streamed; the marked visit recorded `db` 122 ms and model call → first bytes sent 61 ms (the code waits 120 ms and 60 ms), and the prompt sizes 34 + 36 bytes with the `question` part found and adding up to the user message.
- The same with `KV_REST_API_URL`/`_TOKEN` pointing at a local stand-in for Upstash's REST API: it received `SET caliper:timings:<run id> … EX 600`, then Caliper's read as `GET caliper:timings:<run id>`, and the block was the same.

Not checked: Vercel itself, real Upstash, the Pages Router.
