// A marker that must never leave the app (not in the record, its problems, the error log, the
// endpoint, or anything Caliper prints), and messages that carry it every way a prompt could.

export const SECRET = "CALIPER-LEAK-CANARY-7f3a";

export const LEAKY_MESSAGES = () => [
  { role: "system", content: `You are a writer. ${SECRET}` },
  { role: `user ${SECRET}`, content: "a role that's really text" },
  { role: "user", content: [{ type: "text", text: SECRET }] },
  { role: "assistant", content: "earlier reply", [SECRET]: SECRET },
  { role: "user", content: `${SECRET}`.repeat(3) },
];
