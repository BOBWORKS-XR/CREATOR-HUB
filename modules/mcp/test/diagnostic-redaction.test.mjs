import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactDiagnosticText, redactToolDiagnostics } from "../dist/lib/diagnostic-redaction.js";
import { createConfigForProject } from "../dist/lib/config.js";
import { handleResourceRead } from "../dist/resources/index.js";

test("diagnostics redact signed URLs, encoded keys, fragments and basic userinfo", () => {
  for (const query of ["X-Amz-Signature=PRIVATE", "sig=PRIVATE", "token=PRIVATE", "X-Amz%2DSignature=PRIVATE", "X-Amz%252DSignature=PRIVATE", "x-goog-credential=PRIVATE"]) {
    const text = `failed https://example.invalid/file?${query}&part=1#PRIVATE`;
    const redacted = redactDiagnosticText(text);
    assert.ok(!redacted.includes("PRIVATE"), redacted);
    assert.match(redacted, /file\?\[REDACTED\]/);
  }
  assert.equal(redactDiagnosticText("https://user:PRIVATE@example.invalid/file"), "https://example.invalid/file");
  assert.equal(redactDiagnosticText("Authorization: Bearer PRIVATE"), "Authorization: [REDACTED]");
  assert.equal(redactDiagnosticText("Proxy-Authorization=Basic PRIVATE"), "Proxy-Authorization=[REDACTED]");
  assert.equal(redactDiagnosticText("See https://example.invalid/docs?q=ports"), "See https://example.invalid/docs?q=ports");
});

test("redaction preserves structured diagnostics and never changes graph/project content", () => {
  const secret = "https://example.invalid/file?X-Amz-Signature=PRIVATE";
  const original = { success: false, count: 3, errors: [secret], nested: { stackTrace: secret }, graphJson: secret };
  const redacted = redactToolDiagnostics("generate_vs_graph", original);
  assert.equal(original.errors[0], secret);
  assert.equal(redacted.graphJson, secret);
  assert.equal(redacted.count, 3);
  assert.equal(redacted.success, false);
  assert.ok(!redacted.errors[0].includes("PRIVATE"));
  assert.ok(!redacted.nested.stackTrace.includes("PRIVATE"));
  const logs = redactToolDiagnostics("get_console_logs", { logs: [{ message: secret, stackTrace: secret }] });
  assert.ok(!JSON.stringify(logs).includes("PRIVATE"));
  const timestamp = new Date("2026-11-05T00:00:00Z");
  assert.equal(redactToolDiagnostics("query_project_state", { timestamp }).timestamp, timestamp);
});

test("diagnostic resources also redact old snapshots without rewriting them", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "creator-redaction-resource-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "Assets"));
  const config = createConfigForProject(root);
  fs.mkdirSync(config.mcpStatePath, { recursive: true });
  const raw = JSON.stringify({ errors: [{ message: "https://example.invalid/upload?sig=PRIVATE" }] });
  for (const [uri, name] of [["project://console", "console-log.json"], ["project://compilation-status", "compilation-status.json"], ["project://import-status", "import-status.json"]]) {
    const file = path.join(config.mcpStatePath, name);
    fs.writeFileSync(file, raw);
    const result = await handleResourceRead(uri, config);
    assert.ok(!result.contents[0].text.includes("PRIVATE"));
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }
});
