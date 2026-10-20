import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfigForProject } from "../dist/lib/config.js";
import { getLauncherConfigPath, projectIdForPath, UnityProjectRouter } from "../dist/lib/project-router.js";

test("launcher settings lookup matches native platform directories and preserves explicit overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "creator-settings-roots-"));
  try {
    const native = path.join(root, "Library", "Application Support");
    const env = { XDG_CONFIG_HOME: path.join(root, "xdg"), APPDATA: path.join(root, "roaming") };
    const current = path.join(native, "creator-works-mcp", "launcher-config.json");
    const legacy = path.join(native, "banter-mcp", "launcher-config.json");
    assert.equal(getLauncherConfigPath("darwin", env, root), current);
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, "{}");
    assert.equal(getLauncherConfigPath("darwin", env, root), legacy);
    await mkdir(path.dirname(current), { recursive: true });
    await writeFile(current, "{}");
    assert.equal(getLauncherConfigPath("darwin", env, root), current);
    assert.equal(getLauncherConfigPath("linux", env, root), path.join(env.XDG_CONFIG_HOME, "creator-works-mcp", "launcher-config.json"));
    assert.equal(getLauncherConfigPath("linux", {}, root), path.join(root, ".config", "creator-works-mcp", "launcher-config.json"));
    assert.equal(getLauncherConfigPath("win32", env, root), path.join(env.APPDATA, "creator-works-mcp", "launcher-config.json"));
    for (const platform of ["darwin", "win32", "linux"]) {
      assert.equal(getLauncherConfigPath(platform, { ...env, CREATOR_WORKS_LAUNCHER_CONFIG: current, BANTWORKS_LAUNCHER_CONFIG: legacy }, root), current);
      assert.equal(getLauncherConfigPath(platform, { ...env, BANTWORKS_LAUNCHER_CONFIG: legacy }, root), legacy);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function createUnityProject(root, name, updatedAt) {
  const projectPath = path.join(root, name);
  await mkdir(path.join(projectPath, "Assets", "Editor"), { recursive: true });
  await mkdir(path.join(projectPath, "ProjectSettings"), { recursive: true });
  await mkdir(path.join(projectPath, ".bantworks-mcp", "state"), { recursive: true });
  await writeFile(path.join(projectPath, "Assets", "Editor", "BanterMCPBridge.cs"), "// bridge");
  await writeFile(path.join(projectPath, ".bantworks-mcp", "state", "project-instance.json"), JSON.stringify({
    editorInstanceId: `${name}-instance`,
    projectPath,
    projectName: name,
    unityVersion: "2022.3.39f1",
    processId: 123,
    processStartedAt: updatedAt - 1000,
    updatedAt,
  }));
  return projectPath;
}

test("project router deduplicates launcher channels and snapshots selection per call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bantworks-router-"));
  try {
    const now = Date.now();
    const projectA = await createUnityProject(root, "ProjectA", now);
    const projectB = await createUnityProject(root, "ProjectB", now - 20_000);
    const launcherPath = path.join(root, "launcher-config.json");
    await writeFile(launcherPath, JSON.stringify({
      active_channel_id: "channel-b",
      channels: [
        { id: "channel-a1", name: "Alpha", unity_project_path: projectA, scene_path: "A.unity", enabled: true },
        { id: "channel-a2", name: "Alpha Alt", unity_project_path: projectA, scene_path: "A2.unity", enabled: true },
        { id: "channel-b", name: "Beta", unity_project_path: projectB, scene_path: "B.unity", enabled: true },
      ],
    }));

    const router = new UnityProjectRouter(createConfigForProject(projectA), launcherPath);
    const listing = router.listProjects();
    assert.equal(listing.projects.length, 2);
    assert.equal(listing.activeProjectId, projectIdForPath(projectA));

    const alpha = listing.projects.find((project) => project.projectPath === projectA);
    const beta = listing.projects.find((project) => project.projectPath === projectB);
    assert.equal(alpha?.source, "environment+launcher");
    assert.equal(alpha?.channelIds.length, 2);
    assert.equal(alpha?.editorState, "live");
    assert.equal(beta?.editorState, "stale");

    const inFlightSnapshot = router.getActiveConfig();
    const selected = router.selectProject(projectIdForPath(projectB));
    assert.equal(selected.success, true);
    assert.equal(router.getActiveConfig().unityProjectPath, projectB);
    assert.equal(inFlightSnapshot.unityProjectPath, projectA);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project router falls back to the launcher's active channel without an environment project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bantworks-router-"));
  try {
    const projectA = await createUnityProject(root, "ProjectA", Date.now());
    const projectB = await createUnityProject(root, "ProjectB", Date.now());
    const launcherPath = path.join(root, "launcher-config.json");
    await writeFile(launcherPath, JSON.stringify({
      active_channel_id: "channel-b",
      channels: [
        { id: "channel-a", unity_project_path: projectA, enabled: true },
        { id: "channel-b", unity_project_path: projectB, enabled: true },
      ],
    }));

    const router = new UnityProjectRouter(createConfigForProject(""), launcherPath);
    assert.equal(router.getActiveConfig().unityProjectPath, projectB);
    assert.equal(router.selectProject("../outside").success, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid saved channel field types are ignored without repairing the user's settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "creator-router-invalid-"));
  try {
    const project = await createUnityProject(root, "Valid", Date.now());
    const launcher = path.join(root, "launcher-config.json");
    const valid = { id: "valid", unity_project_path: project };
    for (const bad of [null, [], 7, "bad", { ...valid, unity_project_path: 7 },
      { ...valid, id: {} }, { ...valid, name: [] }, { ...valid, enabled: "false" },
      { ...valid, scene_path: 42 }]) {
      const text = JSON.stringify({ active_channel_id: {}, channels: [bad, valid] });
      await writeFile(launcher, text);
      const router = new UnityProjectRouter(createConfigForProject(""), launcher);
      const listing = router.listProjects();
      assert.equal(listing.projects.length, 1);
      assert.equal(listing.activeProjectPath, project);
      assert.equal(listing.warnings.length, 2);
      assert.equal(await readFile(launcher, "utf8"), text);
    }
    for (const invalid of [null, [], 27, "bad", { channels: {} }, { channels: null }]) {
      const text = JSON.stringify(invalid);
      await writeFile(launcher, text);
      const router = new UnityProjectRouter(createConfigForProject(""), launcher);
      const listing = router.listProjects();
      assert.deepEqual(listing.projects, []);
      assert.equal(listing.warnings.length, 1);
      assert.equal(await readFile(launcher, "utf8"), text);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
