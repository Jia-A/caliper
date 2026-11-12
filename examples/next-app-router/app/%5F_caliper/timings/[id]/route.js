// GET /__caliper/timings/:id. The folder is "%5F_caliper": a folder starting with "_" is private in
// the App Router, and %5F (an encoded "_") makes the URL segment "__caliper".
import { handle } from "caliper-timings/upstash";
import { caliper } from "../../../../lib/caliper.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  return (await handle(request, caliper())) ?? new Response("Not found", { status: 404 });
}
