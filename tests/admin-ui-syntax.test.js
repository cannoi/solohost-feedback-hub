import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("admin page embedded JavaScript parses", () => {
  const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0, "admin page should contain its application script");
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
});
