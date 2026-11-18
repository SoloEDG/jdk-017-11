// Node-level checks for the publish helpers that do not require a browser.
import assert from "node:assert/strict";

// The HTML-embedding escaper is the security-critical piece; verify it directly.
const source = await (await import("node:fs/promises")).readFile(
  new URL("../src/features/export/lib/publish.ts", import.meta.url),
  "utf8",
);
const fnMatch = source.match(
  /export function escapeJsonForHtml\(json: string\) \{([\s\S]*?)\n\}/,
);
assert.ok(fnMatch, "escapeJsonForHtml found");
const escapeJsonForHtml = new Function("json", fnMatch[1]);
const payload = { title: "</script><script>alert(1)</script>", note: "a && b" };
const escaped = escapeJsonForHtml(JSON.stringify(payload));
assert.ok(!escaped.includes("<"), "no raw < in embedded JSON");
assert.ok(!escaped.includes(">"), "no raw > in embedded JSON");
const round = JSON.parse(escaped);
assert.equal(round.title, payload.title);
assert.equal(round.note, payload.note);

// The embedded viewer must contain no relative or absolute network references.
const runtime = await (await import("node:fs/promises")).readFile(
  new URL("../src/features/export/lib/viewer/runtime.js", import.meta.url),
  "utf8",
);
assert.ok(!/fetch\s*\(|XMLHttpRequest|importScripts|new WebSocket/.test(runtime), "runtime is network-free");
assert.ok(!/innerHTML/.test(runtime), "runtime never injects HTML strings");
console.log("viewer unit checks passed");
