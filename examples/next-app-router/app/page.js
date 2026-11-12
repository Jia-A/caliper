"use client";
// A Generate button and an #output textarea that fills as the reply streams in.
import { useState } from "react";

export default function Page() {
  const [output, setOutput] = useState("");
  async function generate() {
    setOutput("");
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What does Caliper measure?" }),
    });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      setOutput((o) => o + value);
    }
  }
  return (
    <main>
      <button onClick={generate}>Generate</button>
      <textarea id="output" value={output} readOnly rows={6} cols={60} />
    </main>
  );
}
