import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Overlay only the owned sources for inherited tests; never write dist or the release bundle.
const files = new Map([
  [new URL("../../dist/lib/unity-bridge-transport.js", import.meta.url).href,
    new URL("../../src/lib/unity-bridge-transport.ts", import.meta.url)],
  [new URL("../../dist/tools/get-unity-command-status.js", import.meta.url).href,
    new URL("../../src/tools/get-unity-command-status.ts", import.meta.url)],
]);

export async function load(url, context, nextLoad) {
  const source = files.get(url);
  if (!source) return nextLoad(url, context);
  return {
    format: "module", shortCircuit: true,
    source: ts.transpileModule(await fs.readFile(source, "utf8"), {
      fileName: fileURLToPath(source),
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  };
}
