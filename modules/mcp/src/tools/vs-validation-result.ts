import * as fs from "fs";
import * as path from "path";
import type { VSGraphSourceInventory } from "./vs-source-inventory.js";

const COUNTS = ["elementCount", "nodeCount", "controlConnectionCount", "valueConnectionCount",
  "groupCount", "missingElementCount", "invalidConnectionCount", "failedUnitDefinitionCount",
  "valueInputCount", "unboundValueInputCount", "valuePortInspectionErrorCount"] as const;

function invalid(reason: string): never {
  throw new Error(`Invalid Visual Scripting validation receipt: ${reason}. The receipt was kept; do not resubmit the command automatically.`);
}

export function validateVSGraphReceipt(
  value: unknown, commandId: string, assetPath: string, allowUnboundValueInputs = false,
  source?: VSGraphSourceInventory
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("expected an object");
  const receipt = value as Record<string, unknown>;
  if (receipt.commandId !== commandId) invalid("command ID mismatch");
  if (typeof receipt.success !== "boolean") invalid("success must be boolean");
  if (typeof receipt.assetPath !== "string" ||
      receipt.assetPath.replace(/\\/g, "/") !== assetPath) invalid("asset path mismatch");
  if (!Number.isSafeInteger(receipt.timestamp) || (receipt.timestamp as number) <= 0) invalid("missing timestamp");
  if (!Array.isArray(receipt.warnings) || receipt.warnings.some((v) => typeof v !== "string")) invalid("invalid warnings");
  if (receipt.success === false) {
    if (typeof receipt.error !== "string" || !receipt.error.trim()) invalid("failed result requires an error");
    return receipt;
  }
  if (typeof receipt.assetGuid !== "string" || !/^[a-f0-9]{32}$/i.test(receipt.assetGuid)) invalid("invalid asset GUID");
  if (receipt.assetType !== "Unity.VisualScripting.ScriptGraphAsset" || receipt.graphType !== "Unity.VisualScripting.FlowGraph") invalid("unexpected graph type");
  if (typeof receipt.dependencyHash !== "string" || !/^[a-f0-9]{32}$/i.test(receipt.dependencyHash)) invalid("invalid dependency hash");
  for (const name of COUNTS) {
    if (!Number.isSafeInteger(receipt[name]) || (receipt[name] as number) < 0) invalid(`invalid ${name}`);
  }
  const number = (key: typeof COUNTS[number]) => receipt[key] as number;
  if (number("elementCount") !== number("nodeCount") + number("controlConnectionCount") + number("valueConnectionCount") + number("groupCount")) invalid("inconsistent element counts");
  if (number("missingElementCount") || number("invalidConnectionCount") || number("failedUnitDefinitionCount") || number("valuePortInspectionErrorCount")) invalid("successful result contains validation failures");
  if (receipt.allowUnboundValueInputs !== allowUnboundValueInputs ||
      (!allowUnboundValueInputs && number("unboundValueInputCount") > 0)) invalid("unbound-input policy mismatch");
  if (typeof receipt.valuePortInspectionAvailable !== "boolean" || typeof receipt.unboundValueInputsTruncated !== "boolean") invalid("missing inspection status");
  if (!Array.isArray(receipt.elementTypes) || receipt.elementTypes.some((v) => typeof v !== "string")) invalid("invalid element types");
  if (!Array.isArray(receipt.unboundValueInputs)) invalid("missing input diagnostics");
  if (source) {
    if (receipt.sourceContentHash !== source.contentHash) invalid("source hash mismatch or missing; update the project's MCP bridge and inspect again");
    if (!Array.isArray(receipt.elementIdentities) || receipt.elementIdentities.length !== source.elementIdentities.length ||
        receipt.elementIdentities.some((id: unknown) => typeof id !== "string")) invalid("imported element inventory is incomplete");
    const identities = [...receipt.elementIdentities as string[]].sort();
    if (identities.some((id, i) => id !== source.elementIdentities[i])) invalid("import changed element identities or types");
  }
  return receipt;
}

export function readVSGraphValidationResult(
  statePath: string, commandId: string, assetPath: string, allowUnboundValueInputs = false,
  source?: VSGraphSourceInventory
): Record<string, unknown> | undefined {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(commandId)) invalid("invalid command ID");
  const file = path.join(statePath, "vs-validation-results", `${commandId}.json`);
  if (!fs.existsSync(file)) return undefined;
  if (fs.statSync(file).size > 4 * 1024 * 1024) invalid("receipt exceeds 4 MiB");
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { invalid("malformed JSON"); }
  const receipt = validateVSGraphReceipt(parsed, commandId, assetPath, allowUnboundValueInputs, source);
  fs.unlinkSync(file);
  if (source && receipt.success === true) {
    const { elementIdentities: _verifiedInventory, ...summary } = receipt;
    return { ...summary, sourceIntegrityVerified: true, sourceElementCount: source.elementIdentities.length };
  }
  return receipt;
}
