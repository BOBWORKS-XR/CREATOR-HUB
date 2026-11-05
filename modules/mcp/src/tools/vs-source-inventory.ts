import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { parseDocument } from "yaml";

export interface VSGraphSourceInventory {
  contentHash: string;
  elementIdentities: string[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Read-only inventory; never serialize YAML or rewrite a Unity asset. */
export function inspectVSGraphSource(content: string): VSGraphSourceInventory {
  if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error("Graph source exceeds the 8 MiB inspection limit.");
  const doc = parseDocument(content, { prettyErrors: false, uniqueKeys: true, stringKeys: true });
  if (doc.errors.length) throw new Error("Graph asset is not a supported single YAML document.");
  if (doc.warnings.some(w => w.code !== "TAG_RESOLVE_FAILED")) throw new Error("Graph asset contains unsupported YAML metadata.");
  const asset: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!record(asset) || !record(asset.MonoBehaviour) || !record(asset.MonoBehaviour._data) || typeof asset.MonoBehaviour._data._json !== "string") {
    throw new Error("Graph asset has no supported Visual Scripting _data._json source.");
  }
  let root: unknown;
  try { root = JSON.parse(asset.MonoBehaviour._data._json); }
  catch { throw new Error("Graph asset contains malformed Visual Scripting JSON."); }
  if (!record(root) || !record(root.graph)) throw new Error("Graph source has no graph object.");
  const graph = root.graph;
  let elements: unknown[];
  if (Array.isArray(graph.elements) && !Object.hasOwn(graph, "units")) elements = graph.elements;
  else if (!Object.hasOwn(graph, "elements") && record(graph.units) && Array.isArray(graph.units.$content)) {
    elements = [...graph.units.$content];
    for (const key of ["controlConnections", "valueConnections"]) {
      if (graph[key] !== undefined) {
        if (!record(graph[key]) || !Array.isArray(graph[key].$content)) throw new Error("Malformed legacy graph connections.");
        elements.push(...graph[key].$content);
      }
    }
  } else throw new Error("Graph source has malformed or mixed element containers.");
  if (elements.length > 20000) throw new Error("Graph source exceeds the 20000 element inspection limit.");
  const guids = new Set<string>();
  const elementIdentities = elements.map(element => {
    if (!record(element) || typeof element.guid !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(element.guid) || typeof element.$type !== "string") {
      throw new Error("Graph source contains an element without a stable GUID/type.");
    }
    const guid = element.guid.toLowerCase();
    if (guids.has(guid)) throw new Error("Graph source contains duplicate element GUIDs.");
    guids.add(guid);
    const type = element.$type.split(",", 1)[0].trim();
    if (!type || /[\r\n\t]/.test(type)) throw new Error("Graph source contains an invalid element type.");
    return `${guid}\t${type}`;
  }).sort();
  return { contentHash: createHash("sha256").update(content, "utf8").digest("hex"), elementIdentities };
}

export function readVSGraphSource(assetsPath: string, assetPath: string): VSGraphSourceInventory {
  const root = fs.realpathSync(assetsPath);
  const file = fs.realpathSync(path.join(root, assetPath.slice("Assets/".length)));
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Graph source must resolve within this project's Assets folder.");
  }
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 8 * 1024 * 1024) throw new Error("Graph source is not a bounded regular file.");
  return inspectVSGraphSource(fs.readFileSync(file, "utf8"));
}
