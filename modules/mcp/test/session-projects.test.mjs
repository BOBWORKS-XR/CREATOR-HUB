import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfigForProject } from "../dist/lib/config.js";
import { projectIdForPath, UnityProjectRouter } from "../dist/lib/project-router.js";
import { handleToolCall, registerTools } from "../dist/tools/index.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "creator-session-project-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = async name => {
    const dir = path.join(root, name);
    await mkdir(path.join(dir, "Assets"), { recursive: true });
    await mkdir(path.join(dir, "ProjectSettings"));
    await writeFile(path.join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.27f1\n");
    return dir;
  };
  const initial = await project("Initial"), isolated = await project("Isolated");
  const launcher = path.join(root, "launcher.json");
  const saved = JSON.stringify({ channels: [{ id: "original", unity_project_path: initial, enabled: true }], untouched: "keep" });
  await writeFile(launcher, saved);
  return { root, initial, isolated, launcher, saved, project, router: new UnityProjectRouter(createConfigForProject(initial), launcher) };
}
test("registration is explicit, deduplicated, unselected and session-only", async t => {
  const f = await fixture(t), before = f.router.getActiveConfig();
  const first = f.router.registerProject(f.isolated);
  assert.equal(first.success, true); assert.equal(first.selected, false); assert.equal(first.settingsChanged, false);
  assert.equal(f.router.getActiveConfig().unityProjectPath, before.unityProjectPath);
  assert.equal(f.router.registerProject(path.join(f.isolated, ".")).alreadyRegistered, true);
  const rows = f.router.listProjects().projects;
  assert.equal(rows.length, 2); assert.equal(rows.find(r => r.projectId === first.projectId).sessionRegistered, true);
  assert.equal(await readFile(f.launcher, "utf8"), f.saved);
  assert.equal(new UnityProjectRouter(before, f.launcher).listProjects().projects.length, 1);
});
test("selecting a registration preserves an in-flight configuration snapshot", async t => {
  const f = await fixture(t), before = f.router.getActiveConfig();
  const registered = f.router.registerProject(f.isolated);
  assert.equal(f.router.selectProject(registered.projectId).success, true);
  assert.equal(f.router.getActiveConfig().unityProjectPath, f.isolated);
  assert.equal(before.unityProjectPath, f.initial);
  assert.equal(f.router.unregisterProject(registered.projectId).success, false);
  assert.equal(f.router.selectProject(projectIdForPath(f.initial)).success, true);
  assert.equal(f.router.unregisterProject(registered.projectId).success, true);
  assert.equal(f.router.listProjects().projects.length, 1);
  assert.equal(await readFile(f.launcher, "utf8"), f.saved);
});
test("saved routes survive unregistering their session registration", async t => {
  const f = await fixture(t);
  const a = f.router.registerProject(f.initial);
  f.router.registerProject(f.isolated); f.router.selectProject(projectIdForPath(f.isolated));
  assert.equal(f.router.unregisterProject(a.projectId).stillConfigured, true);
  assert.equal(f.router.listProjects().projects.find(p => p.projectId === a.projectId).sessionRegistered, false);
});
test("disabled launcher routes cannot be enabled through registration", async t => {
  const f = await fixture(t);
  await writeFile(f.launcher, JSON.stringify({ channels: [{ unity_project_path: f.isolated, enabled: false }] }));
  assert.equal(f.router.registerProject(f.isolated).success, false);
  assert.equal(f.router.selectProject(projectIdForPath(f.isolated)).success, false);
});

async function shortPath(root, value) {
  const sdk = execFileSync("dotnet", ["--list-sdks"], { encoding: "utf8", windowsHide: true, timeout: 10000 })
    .trim().split(/\r?\n/).map(line => /^(\S+) \[(.+)\]$/.exec(line)).filter(Boolean).at(-1);
  assert.ok(sdk, "Windows alias regression requires the installed .NET SDK");
  const packs = path.join(path.dirname(sdk[2]), "packs/Microsoft.NETCore.App.Ref");
  const version = (await readdir(packs)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  const frameworkRoot = path.join(packs, version, "ref");
  const framework = (await readdir(frameworkRoot)).at(-1);
  const refs = path.join(frameworkRoot, framework);
  const source = path.join(root, "AliasProbe.cs"), output = path.join(root, "AliasProbe.dll"), response = path.join(root, "alias.rsp");
  await writeFile(source, `using System; using System.Text; using System.Runtime.InteropServices;
class AliasProbe {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetShortPathName(string path, StringBuilder output, uint size);
 static int Main(string[] args) { var text=new StringBuilder(32768); var count=GetShortPathName(args[0],text,(uint)text.Capacity); if(count==0||count>=text.Capacity)return 1; Console.Write(text.ToString()); return 0; }
}`);
  await writeFile(response, ["-nologo", "-nostdlib+", "-target:exe", `-out:\"${output}\"`,
    ...(await readdir(refs)).filter(f => f.endsWith(".dll")).map(f => `-r:\"${path.join(refs, f)}\"`), `\"${source}\"`].join("\n"));
  execFileSync("dotnet", [path.join(sdk[2], sdk[1], "Roslyn/bincore/csc.dll"), "@" + response], { windowsHide: true, timeout: 30000 });
  await writeFile(path.join(root, "AliasProbe.runtimeconfig.json"), JSON.stringify({ runtimeOptions: { tfm: framework, framework: { name: "Microsoft.NETCore.App", version } } }));
  return execFileSync("dotnet", [output, value], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
}

test("Windows short-path aliases preserve configured IDs and cannot enable disabled routes", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const alias = await shortPath(f.root, f.isolated);
  if (alias.toLowerCase() === f.isolated.toLowerCase()) { t.skip("This volume does not provide a short-path alias"); return; }
  const stored = JSON.stringify({ channels: [{ id: "alias", unity_project_path: alias, enabled: false }], untouched: "keep" });
  await writeFile(f.launcher, stored);
  assert.equal(f.router.registerProject(f.isolated).success, false, "Long spelling cannot bypass a disabled short spelling");
  assert.equal(f.router.registerProject(alias).success, false);
  assert.equal(await readFile(f.launcher, "utf8"), stored);
  const enabled = JSON.stringify({ channels: [{ id: "alias", unity_project_path: alias, enabled: true }], untouched: "keep" });
  await writeFile(f.launcher, enabled);
  const registered = f.router.registerProject(f.isolated);
  assert.equal(registered.success, true);
  assert.equal(registered.projectId, projectIdForPath(alias), "Existing IDs remain unchanged");
  assert.equal(registered.projectPath, path.resolve(alias));
  assert.equal(f.router.registerProject(alias).alreadyRegistered, true);
  assert.equal(f.router.listProjects().projects.filter(p => p.channelIds.includes("alias")).length, 1);
  assert.equal(f.router.selectProject(registered.projectId).success, true);
  assert.equal(f.router.getActiveConfig().unityProjectPath, path.resolve(alias));
  f.router.selectProject(projectIdForPath(f.initial));
  assert.equal(f.router.unregisterProject(registered.projectId).stillConfigured, true);
  assert.equal(await readFile(f.launcher, "utf8"), enabled);
});

test("Windows alias disabled after registration cannot reuse session authority", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const alias = await shortPath(f.root, f.isolated);
  if (alias.toLowerCase() === f.isolated.toLowerCase()) { t.skip("This volume does not provide a short-path alias"); return; }
  const before = f.router.getActiveConfig();
  const registered = f.router.registerProject(f.isolated);
  assert.equal(registered.success, true);
  const settings = JSON.stringify({ channels: [{ id: "later", unity_project_path: alias, enabled: false }], untouched: "keep" });
  await writeFile(f.launcher, settings);
  assert.equal(f.router.selectProject(registered.projectId).success, false);
  assert.equal(f.router.registerProject(f.isolated).success, false);
  assert.equal(f.router.registerProject(alias).success, false);
  assert.equal(f.router.getActiveConfig().unityProjectPath, before.unityProjectPath);
  assert.equal(f.router.getActiveConfig().projectId, before.projectId);
  assert.equal(await readFile(f.launcher, "utf8"), settings);
  assert.equal(f.router.unregisterProject(registered.projectId).stillConfigured, true);
});
test("registration refuses invalid paths and malformed Unity roots", async t => {
  const f = await fixture(t);
  for (const value of [undefined, null, 2, [], {}, "", "relative", "a\u0000b", f.root, path.join(f.root, "missing")]) {
    assert.equal(f.router.registerProject(value).success, false, String(value));
  }
  const version = path.join(f.isolated, "ProjectSettings", "ProjectVersion.txt");
  for (const text of ["", "arbitrary data", "m_EditorVersion: invalid", "x".repeat(9000)]) {
    await writeFile(version, text); assert.equal(f.router.registerProject(f.isolated).success, false);
  }
  assert.equal(await readFile(f.launcher, "utf8"), f.saved);
});
test("registration refuses directory links and linked MCP state", async t => {
  const f = await fixture(t), link = path.join(f.root, "Linked");
  await symlink(f.isolated, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(f.router.registerProject(link).success, false);
  await symlink(f.initial, path.join(f.isolated, ".bantworks-mcp"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(f.router.registerProject(f.isolated).success, false);
});

test("registration rejects dangling state links and metadata excludes arbitrary JSON", async t => {
  const f = await fixture(t);
  const stateRoot = path.join(f.isolated, ".bantworks-mcp");
  await symlink(path.join(f.root, "absent"), stateRoot, process.platform === "win32" ? "junction" : "dir");
  assert.equal(f.router.registerProject(f.isolated).success, false);
  await rm(stateRoot);
  await mkdir(path.join(stateRoot, "state"), { recursive: true });
  await writeFile(path.join(stateRoot, "state", "project-instance.json"), JSON.stringify({
    editorInstanceId: "editor-test", processId: 42, updatedAt: Date.now() + 60000,
    secret: "must-not-leak", nested: { arbitrary: true }, capabilities: ["query_state"],
  }));
  const id = f.router.registerProject(f.isolated).projectId;
  const row = f.router.listProjects().projects.find(p => p.projectId === id);
  assert.equal(row.editorInstance.secret, undefined);
  assert.deepEqual(row.editorInstance.capabilities, ["query_state"]);
  assert.equal(row.editorState, "stale");
  await writeFile(path.join(stateRoot, "state", "project-instance.json"), JSON.stringify({ huge: "x".repeat(65536) }));
  assert.equal(f.router.listProjects().projects.find(p => p.projectId === id).editorInstance, undefined);
  assert.equal(await readFile(f.launcher, "utf8"), f.saved);
});
test("replaced registered roots refuse selection and existing active use", async t => {
  const f = await fixture(t), r = f.router.registerProject(f.isolated);
  f.router.selectProject(r.projectId);
  await rename(f.isolated, f.isolated + "-old"); await f.project("Isolated");
  assert.throws(() => f.router.getActiveConfig(), /changed/);
  assert.equal(f.router.selectProject(r.projectId).success, false);
  assert.equal(f.router.registerProject(f.isolated).success, true);
  assert.equal(f.router.getActiveConfig().unityProjectPath, f.isolated);
});
test("session registration has a finite capacity without evicting existing projects", async t => {
  const f = await fixture(t);
  for (let n = 0; n < 32; n++) assert.equal(f.router.registerProject(await f.project(`P${n}`)).success, true);
  assert.equal(f.router.registerProject(f.isolated).success, false);
  assert.equal(f.router.registerProject(path.join(f.root, "P0")).success, true);
  assert.equal(f.router.listProjects().total, 33);
});
test("project pages filter and project fields without dropping stable IDs", async t => {
  const f = await fixture(t), registered = f.router.registerProject(f.isolated);
  const result = f.router.listProjects({ projectIds: [registered.projectId], fields: ["projectName"], limit: 1 });
  assert.equal(result.total, 1); assert.equal(result.returned, 1); assert.equal(result.truncated, false);
  assert.deepEqual(Object.keys(result.projects[0]).sort(), ["projectId", "projectName"]);
  assert.deepEqual(f.router.listProjects({ projectIds: [] }).projects, []);
});
test("project cursors cover all rows, reject changed lists and remain bounded", async t => {
  const f = await fixture(t);
  for (let n = 0; n < 5; n++) f.router.registerProject(await f.project(`P${n}`));
  const options = { fields: ["projectName"], limit: 2, maxResponseBytes: 4096 };
  let page = f.router.listProjects(options), ids = [];
  const oldCursor = page.nextCursor;
  do {
    assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2)) <= 4096);
    ids.push(...page.projects.map(p => p.projectId));
    page = page.nextCursor ? f.router.listProjects({ ...options, cursor: page.nextCursor }) : null;
  } while (page);
  assert.equal(new Set(ids).size, 6);
  f.router.registerProject(f.isolated);
  assert.throws(() => f.router.listProjects({ ...options, cursor: oldCursor }), /changed/);
});
test("project query rejects unknown, oversized and invalid options", async t => {
  const { router } = await fixture(t);
  for (const options of [{ limit: 0 }, { limit: 101 }, { maxResponseBytes: 4000 }, { maxResponseBytes: 65537 },
    { fields: [] }, { fields: ["password"] }, { projectIds: ["wrong"] }, { cursor: "bad" }, { extra: true }]) {
    assert.throws(() => router.listProjects(options));
  }
});
test("MCP route tools are advertised and reject unsupported arguments before registration", async t => {
  const f = await fixture(t), config = f.router.getActiveConfig();
  for (const name of ["register_unity_project", "unregister_unity_project"]) {
    assert.equal(registerTools().find(t => t.name === name).inputSchema.additionalProperties, false);
  }
  const call = (name, args) => handleToolCall(name, args, config, f.router);
  assert.equal((await call("register_unity_project", { projectPath: f.isolated, select: true })).isError, true);
  assert.equal(f.router.listProjects().total, 1);
  const result = JSON.parse((await call("register_unity_project", { projectPath: f.isolated })).content[0].text);
  assert.equal(result.success, true); assert.equal(result.selected, false);
  const bad = JSON.parse((await call("list_unity_projects", { limit: 0 })).content[0].text);
  assert.equal(bad.success, false);
  assert.equal(await readFile(f.launcher, "utf8"), f.saved);
});
