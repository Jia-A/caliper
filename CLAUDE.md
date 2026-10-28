# Caliper — working rules

Caliper (npm `caliper-ai`) measures AI features in real browsers. CLI lives in `packages/cli`.

## The report never claims more than it measured
- Every number comes from a real measurement. No estimates, no approximations shown as results.
- If Caliper can't tell, it says so ("Inconclusive" / "?" + the reason) — never a guessed number.
- Write down what actually happened, not what should have happened. Don't assume — check the network data, the DOM, the logs.
- Never guess what the user meant. Ambiguous input = clear error (e.g. --measure vs --measure-selector; a selector matching 0 or 2+ elements).

## Evidence before rules
- Before writing any detection or scoring rule, measure on real data first, show the numbers, then propose the rule.
- Ask before choosing between design options. Explain in plain language first, details after.

## Tests
- New behaviour starts with a fixture + a test that FAILS on the current code. Show it failing.
- A test must be able to fail for the right reason — assert the specific message, not just "it errored".
- Before any commit: typecheck + test:csp, test:sidecall, test:chat, test:nostore, test:canary, test:selector, test:marked.

## Docs say only what's tested
- README, --help and CHANGELOG claim only tested behaviour, and list known limits.

## Never without an explicit OK in the prompt
- Never push, tag or publish.
- Never run against an external site. On external apps: timing checks only, max 3 runs, no canary/injection tests.
- Never commit or publish auth.json or caliper-report.html.
