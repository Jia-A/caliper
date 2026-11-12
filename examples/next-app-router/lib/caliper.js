// caliper-timings for this app: Upstash Redis when its env vars are set (Vercel), else memory
// (one local process). The token comes from CALIPER_TOKEN; without it, timings are off.
import { MemoryStore, UpstashStore } from "caliper-timings/upstash";

const store = UpstashStore.fromEnv(process.env) ?? new MemoryStore();

export const caliper = () => ({ token: process.env.CALIPER_TOKEN, store });
