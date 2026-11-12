// POST /api/generate: a stand-in model that streams a fixed reply, timed with caliper-timings.
// The same messages array would go to a real model and to run.prompt(); the save after the
// response is kept alive with after() (Next.js 15.1+; waitUntil on Vercel).
import { after } from "next/server";
import { finish, start } from "caliper-timings/upstash";
import { caliper } from "../../../lib/caliper.js";

export const dynamic = "force-dynamic";

const DB_MS = 120; // the stand-in database
const WORDS = "Here is a short streamed reply from a stand-in model.".split(/(?<= )/);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function POST(request) {
  const run = await start(request, { ...caliper(), defer: (p) => after(() => p) });
  const { question = "" } = await request.json().catch(() => ({}));

  run?.mark("dbStart");
  await sleep(DB_MS);
  run?.mark("dbEnd");

  const questionLine = `Question: ${String(question).slice(0, 200)}`;
  const messages = [
    { role: "system", content: "You answer in one short paragraph." },
    { role: "user", content: questionLine },
  ];
  run?.prompt(messages, { parts: [{ message: 1, name: "question", text: questionLine }] });
  run?.mark("modelCallSent");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const word of WORDS) {
        await sleep(60);
        controller.enqueue(encoder.encode(word));
      }
      controller.close();
    },
  });
  const response = new Response(run ? run.watchFirstChunk(stream) : stream, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
  return run ? finish(run, response) : response;
}
