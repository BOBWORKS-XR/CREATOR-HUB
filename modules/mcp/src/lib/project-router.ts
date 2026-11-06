import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { BanterMCPConfig, createConfigForProject } from "./config.js";
import { projectListPage } from "./project-list.js";
import { assertOrdinaryPath, readBoundedJson } from "./bounded-json.js";

interface LauncherProjectChannel {
  id?: string;
  name?: string;
  unity_project_path?: string;
  scene_path?: string | null;
  enabled?: boolean;
}

interface LauncherConfigFile {
  channels?: LauncherProjectChannel[];
  active_channel_id?: string | null;
}

interface ProjectInstanceState {
  editorInstanceId?: string;
  bridgeVersion?: string;
  protocolVersion?: number;
  minimumProtocolVersion?: number;
  capabilities?: string[];
  preferredTransport?: string;
  pipeName?: string;
  projectPath?: string;
  projectName?: string;
  unityVersion?: string;
  processId?: number;
  processStartedAt?: number;
  updatedAt?: number;
}

export interface UnityProjectRoute {
  projectId: string;
  projectPath: string;
  projectName: string;
  enabled: boolean;
  selected: boolean;
  source: "environment" | "launcher" | "environment+launcher" | "session";
  channelIds: string[];
  channelNames: string[];
  scenePaths: string[];
  validProject: boolean;
  bridgeInstalled: boolean;
  editorState: "live" | "stale" | "not_seen";
  editorInstance?: ProjectInstanceState;
  sessionRegistered: boolean;
}

export interface UnityProjectListResult {
  success: true;
  activeProjectId: string;
  activeProjectPath: string;
  launcherConfigPath: string;
  projects: UnityProjectRoute[];
  warnings: string[];
}

interface RouteCandidate {
  projectPath: string;
  fromEnvironment: boolean;
  fromSession: boolean;
  channels: LauncherProjectChannel[];
}

export class UnityProjectRouter {
  private activeProjectPath: string;
  private activeProjectId: string;
  private readonly environmentProjectPath: string;
  private readonly launcherConfigPath: string;
  private readonly sessionProjects = new Map<string, { projectPath: string; identity: string }>();

  constructor(initialConfig: BanterMCPConfig, launcherConfigPath = getLauncherConfigPath()) {
    this.launcherConfigPath = launcherConfigPath;
    this.environmentProjectPath = canonicalProjectPath(initialConfig.unityProjectPath);
    this.activeProjectPath = this.environmentProjectPath || launcherDefaultProjectPath(launcherConfigPath);
    this.activeProjectId = this.activeProjectPath ? projectIdForPath(this.activeProjectPath) : "";
  }

  getActiveConfig(): BanterMCPConfig {
    const registered = this.sessionProjects.get(this.activeProjectId);
    if (registered) {
      try {
        if (!sameProjectPath(validateSessionProject(registered.projectPath), registered.projectPath) ||
          projectDirectoryIdentity(registered.projectPath) !== registered.identity) throw new Error("Changed identity");
      } catch {
        throw new Error("Registered project directory is missing or changed. Register it again or select another project.");
      }
    }
    return createConfigForProject(this.activeProjectPath, this.activeProjectId);
  }

  listProjects(options: Record<string, unknown> = {}): Record<string, unknown> & { projects: Partial<UnityProjectRoute>[] } {
    return projectListPage(this.allProjects(), options) as Record<string, unknown> & { projects: Partial<UnityProjectRoute>[] };
  }

  private allProjects(): UnityProjectListResult {
    const warnings: string[] = [];
    const launcher = readLauncherConfig(this.launcherConfigPath, warnings);
    const candidates = new Map<string, RouteCandidate>();

    const addCandidate = (projectPath: string, fromEnvironment: boolean, fromSession: boolean, channel?: LauncherProjectChannel) => {
      const canonical = canonicalProjectPath(projectPath);
      if (!canonical) return;
      const key = canonicalPathKey(canonical);
      const existing = candidates.get(key) ?? {
        projectPath: canonical,
        fromEnvironment: false,
        fromSession: false,
        channels: [],
      };
      existing.fromEnvironment ||= fromEnvironment;
      existing.fromSession ||= fromSession;
      if (channel) existing.channels.push(channel);
      candidates.set(key, existing);
    };

    addCandidate(this.environmentProjectPath, true, false);
    addCandidate(this.activeProjectPath, false, true);
    for (const channel of launcher.channels ?? []) {
      if (typeof channel.unity_project_path === "string") {
        addCandidate(channel.unity_project_path, false, false, channel);
      }
    }
    for (const entry of this.sessionProjects.values()) addCandidate(entry.projectPath, false, true);

    const projects = [...candidates.values()]
      .map((candidate) => ({ ...buildProjectRoute(candidate, this.activeProjectId, this.environmentProjectPath),
        sessionRegistered: this.sessionProjects.has(projectIdForPath(candidate.projectPath)) }))
      .sort((left, right) => {
        if (left.selected !== right.selected) return left.selected ? -1 : 1;
        const stateRank = { live: 0, stale: 1, not_seen: 2 } as const;
        if (left.editorState !== right.editorState) return stateRank[left.editorState] - stateRank[right.editorState];
        return left.projectName.localeCompare(right.projectName);
      });

    if (this.sessionProjects.size) {
      const authority = new Map<string, boolean>();
      const keys = new Map(projects.map(project => [project, resolvedPathKey(project.projectPath)]));
      for (const project of projects) {
        if (project.source !== "session") {
          const key = keys.get(project)!;
          authority.set(key, (authority.get(key) ?? false) || project.enabled);
        }
      }
      for (const project of projects) {
        const key = keys.get(project)!;
        if (project.source === "session" && authority.has(key)) project.enabled &&= authority.get(key)!;
      }
    }

    return {
      success: true,
      activeProjectId: this.activeProjectId,
      activeProjectPath: this.activeProjectPath,
      launcherConfigPath: this.launcherConfigPath,
      projects,
      warnings,
    };
  }

  selectProject(projectId: string): Record<string, unknown> {
    if (!isValidProjectId(projectId)) {
      return { success: false, error: "projectId has an invalid format." };
    }

    const listing = this.allProjects();
    const selected = listing.projects.find((project) => project.projectId === projectId);
    if (!selected) {
      return { success: false, error: `Unknown projectId: ${projectId}`, availableProjectIds: listing.projects.map((project) => project.projectId) };
    }
    if (!selected.enabled) {
      return { success: false, error: `Project route is disabled in the launcher: ${selected.projectName}` };
    }
    if (!selected.validProject) {
      return { success: false, error: `Unity project is missing or invalid: ${selected.projectPath}` };
    }
    if (this.sessionProjects.has(projectId)) {
      try {
        const entry = this.sessionProjects.get(projectId)!;
        if (!sameProjectPath(validateSessionProject(entry.projectPath), entry.projectPath) ||
          projectDirectoryIdentity(entry.projectPath) !== entry.identity) {
          throw new Error("Registered project identity changed. Register the project again.");
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Registered project is no longer valid." };
      }
    }

    this.activeProjectPath = selected.projectPath;
    this.activeProjectId = selected.projectId;
    return {
      success: true,
      activeProjectId: selected.projectId,
      activeProjectPath: selected.projectPath,
      projectName: selected.projectName,
      bridgeInstalled: selected.bridgeInstalled,
      editorState: selected.editorState,
      editorInstance: selected.editorInstance,
      message: "Selected this Unity project for subsequent calls in the current MCP session.",
    };
  }

  registerProject(projectPath: unknown): Record<string, unknown> {
    try {
      const canonical = validateSessionProject(projectPath);
      const existingRoutes = this.allProjects().projects.filter(project => sameProjectPath(project.projectPath, canonical));
      const existing = existingRoutes.find(project => project.enabled);
      if (!existing && existingRoutes.length) throw new Error("This project is disabled in the launcher. Review it in Creator Hub; registration will not bypass that setting.");
      // Keep the existing route's ID and spelling; expanding a Windows 8.3 alias must not create a new route.
      const registeredPath = existing?.projectPath ?? canonical;
      const projectId = existing?.projectId ?? projectIdForPath(canonical);
      const alreadyRegistered = this.sessionProjects.has(projectId);
      if (!alreadyRegistered && this.sessionProjects.size >= 32) throw new Error("This session already has 32 registered projects. Unregister an unused project first.");
      this.sessionProjects.set(projectId, { projectPath: registeredPath, identity: projectDirectoryIdentity(registeredPath) });
      return { success: true, projectId, projectPath: registeredPath, alreadyRegistered,
        selected: projectId === this.activeProjectId, scope: "session", settingsChanged: false,
        message: "Registered for this MCP session only. Use select_unity_project to select it." };
    } catch (error) {
      return { success: false, settingsChanged: false, error: error instanceof Error ? error.message : "Project registration failed." };
    }
  }

  unregisterProject(projectId: unknown): Record<string, unknown> {
    if (typeof projectId !== "string" || !isValidProjectId(projectId)) return { success: false, error: "Invalid projectId.", settingsChanged: false };
    if (!this.sessionProjects.has(projectId)) return { success: false, error: "Project is not registered in this session.", settingsChanged: false };
    if (projectId === this.activeProjectId) return { success: false, error: "Select another project before unregistering the active project.", settingsChanged: false };
    const registered = this.sessionProjects.get(projectId)!;
    this.sessionProjects.delete(projectId);
    return { success: true, projectId, scope: "session", settingsChanged: false,
      stillConfigured: this.allProjects().projects.some(project => sameProjectPath(project.projectPath, registered.projectPath)) };
  }
}

function projectDirectoryIdentity(projectPath: string): string {
  const stat = fs.statSync(projectPath);
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function sameProjectPath(left: string, right: string): boolean {
  if (canonicalPathKey(canonicalProjectPath(left)) === canonicalPathKey(canonicalProjectPath(right))) return true;
  try {
    return canonicalPathKey(fs.realpathSync.native(left)) === canonicalPathKey(fs.realpathSync.native(right));
  } catch {
    return false;
  }
}

function resolvedPathKey(projectPath: string): string {
  try { return canonicalPathKey(fs.realpathSync.native(projectPath)); }
  catch { return canonicalPathKey(canonicalProjectPath(projectPath)); }
}

function validateSessionProject(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || !value.trim() || /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value.trim())) {
    throw new Error("Supply an absolute Unity project directory path.");
  }
  const absolute = path.resolve(value.trim());
  const root = fs.lstatSync(absolute);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Use the actual project directory, not a linked directory.");
  const canonical = fs.realpathSync.native(absolute);
  for (const name of ["Assets", "ProjectSettings"]) {
    const directory = path.join(canonical, name);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${name} must be an ordinary project directory.`);
  }
  const versionPath = path.join(canonical, "ProjectSettings", "ProjectVersion.txt");
  const stat = fs.lstatSync(versionPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error("Missing or invalid Unity ProjectVersion.txt.");
  const descriptor = fs.readFileSync(versionPath, "utf8");
  if (!/^m_EditorVersion: [0-9]+\.[0-9]+\.[0-9]+[abfp][0-9]+\s*$/m.test(descriptor)) throw new Error("ProjectVersion.txt does not identify a Unity Editor version.");
  for (const relative of [".bantworks-mcp", path.join(".bantworks-mcp", "state")]) {
    const candidate = path.join(canonical, relative);
    try {
      const state = fs.lstatSync(candidate);
      if (!state.isDirectory() || state.isSymbolicLink()) {
        throw new Error("Registered project MCP state must not use linked or non-directory paths.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return canonical;
}

export function getLauncherConfigPath(platform = process.platform, env = process.env, home = os.homedir()): string {
  const configuredPath = env.CREATOR_WORKS_LAUNCHER_CONFIG ?? env.BANTWORKS_LAUNCHER_CONFIG;
  if (configuredPath) {
    return path.resolve(configuredPath);
  }
  if (platform === "win32" && env.APPDATA) {
    const current = path.join(env.APPDATA, "creator-works-mcp", "launcher-config.json");
    const legacy = path.join(env.APPDATA, "banter-mcp", "launcher-config.json");
    return fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy;
  }
  const configRoot = platform === "darwin"
    ? path.join(home, "Library", "Application Support")
    : env.XDG_CONFIG_HOME || path.join(home, ".config");
  const current = path.join(configRoot, "creator-works-mcp", "launcher-config.json");
  const legacy = path.join(configRoot, "banter-mcp", "launcher-config.json");
  return fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy;
}

export function projectIdForPath(projectPath: string): string {
  const key = canonicalPathKey(canonicalProjectPath(projectPath));
  if (!key) return "";
  return `unity-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}

export function isValidProjectId(projectId: string): boolean {
  return typeof projectId === "string" && /^unity-[a-f0-9]{20}$/.test(projectId);
}

function canonicalProjectPath(projectPath: string): string {
  if (typeof projectPath !== "string" || !projectPath.trim()) return "";
  return path.resolve(projectPath.trim());
}

function canonicalPathKey(projectPath: string): string {
  if (!projectPath) return "";
  return process.platform === "win32" ? projectPath.toLowerCase() : projectPath;
}

function readLauncherConfig(configPath: string, warnings: string[]): LauncherConfigFile {
  if (!fs.existsSync(configPath)) return { channels: [] };
  try {
    const parsed = readBoundedJson(configPath, 2 * 1024 * 1024);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a launcher configuration object.");
    }
    const saved = parsed as Record<string, unknown>;
    if (saved.channels !== undefined && !Array.isArray(saved.channels)) {
      throw new Error("Expected a project channels array.");
    }
    const raw = (saved.channels ?? []) as unknown[];
    if (raw.length > 4096) throw new Error("Launcher configuration exceeds 4096 project channels.");
    const channels = raw.filter(isLauncherProjectChannel);
    if (channels.length !== raw.length) {
      warnings.push(`Ignored ${raw.length - channels.length} invalid saved project channel(s). Review them in Creator Hub; the settings file was not changed.`);
    }
    const active = saved.active_channel_id;
    if (active !== undefined && active !== null && typeof active !== "string") {
      warnings.push("Ignored an invalid active project selection. The settings file was not changed.");
    }
    return { channels, active_channel_id: typeof active === "string" ? active : null };
  } catch (error) {
    warnings.push(`Could not parse launcher configuration: ${error instanceof Error ? error.message : "unknown error"}`);
    return { channels: [] };
  }
}

function isLauncherProjectChannel(value: unknown): value is LauncherProjectChannel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const channel = value as Record<string, unknown>;
  return typeof channel.unity_project_path === "string" &&
    (channel.id === undefined || typeof channel.id === "string") &&
    (channel.name === undefined || typeof channel.name === "string") &&
    (channel.scene_path === undefined || channel.scene_path === null || typeof channel.scene_path === "string") &&
    (channel.enabled === undefined || typeof channel.enabled === "boolean");
}

function launcherDefaultProjectPath(configPath: string): string {
  const launcher = readLauncherConfig(configPath, []);
  const channels = launcher.channels ?? [];
  const active = channels.find((channel) => channel.id === launcher.active_channel_id && channel.enabled !== false);
  const fallback = channels.find((channel) => channel.enabled !== false);
  return canonicalProjectPath(active?.unity_project_path || fallback?.unity_project_path || "");
}

function buildProjectRoute(
  candidate: RouteCandidate,
  activeProjectId: string,
  environmentProjectPath: string
): UnityProjectRoute {
  const projectId = projectIdForPath(candidate.projectPath);
  const assetsPath = path.join(candidate.projectPath, "Assets");
  const projectSettingsPath = path.join(candidate.projectPath, "ProjectSettings");
  const statePath = path.join(candidate.projectPath, ".bantworks-mcp", "state");
  const bridgePath = path.join(assetsPath, "Editor", "BanterMCPBridge.cs");
  const instance = readProjectInstance(path.join(statePath, "project-instance.json"), candidate.projectPath);
  const updatedAt = instance?.updatedAt ?? readTimestamp(path.join(statePath, "editor-state.json"), candidate.projectPath);
  const age = updatedAt ? Date.now() - updatedAt : Number.POSITIVE_INFINITY;
  const channelEnabled = candidate.channels.length === 0 || candidate.channels.some((channel) => channel.enabled !== false);
  const projectName = candidate.channels.find((channel) => channel.name)?.name || path.basename(candidate.projectPath);
  const fromEnvironment = candidate.fromEnvironment || canonicalPathKey(candidate.projectPath) === canonicalPathKey(environmentProjectPath);

  return {
    projectId,
    projectPath: candidate.projectPath,
    projectName,
    enabled: fromEnvironment || channelEnabled,
    selected: projectId === activeProjectId,
    source: fromEnvironment && candidate.channels.length > 0
      ? "environment+launcher"
      : fromEnvironment ? "environment" : candidate.channels.length > 0 ? "launcher" : "session",
    channelIds: candidate.channels.flatMap((channel) => typeof channel.id === "string" ? [channel.id] : []),
    channelNames: candidate.channels.flatMap((channel) => typeof channel.name === "string" ? [channel.name] : []),
    scenePaths: candidate.channels.flatMap((channel) => typeof channel.scene_path === "string" ? [channel.scene_path] : []),
    validProject: fs.existsSync(assetsPath) && fs.existsSync(projectSettingsPath),
    bridgeInstalled: fs.existsSync(bridgePath),
    editorState: age >= 0 && age <= 10_000 ? "live" : updatedAt ? "stale" : "not_seen",
    editorInstance: instance,
    sessionRegistered: false,
  };
}

function readProjectInstance(instancePath: string, root: string): ProjectInstanceState | undefined {
  try {
    assertOrdinaryPath(instancePath, root);
    const value = readBoundedJson(instancePath, 65536);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of ["editorInstanceId", "bridgeVersion", "preferredTransport", "pipeName", "projectPath", "projectName", "unityVersion"]) {
      if (typeof raw[key] === "string" && raw[key].length <= 4096) result[key] = raw[key];
    }
    for (const key of ["protocolVersion", "minimumProtocolVersion", "processId", "processStartedAt", "updatedAt"]) {
      if (typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0) result[key] = raw[key];
    }
    if (Array.isArray(raw.capabilities) && raw.capabilities.length <= 128 &&
      raw.capabilities.every(item => typeof item === "string" && item.length <= 128)) result.capabilities = raw.capabilities;
    return result as ProjectInstanceState;
  } catch {
    return undefined;
  }
}

function readTimestamp(statePath: string, root: string): number | undefined {
  try {
    assertOrdinaryPath(statePath, root);
    const state = readBoundedJson(statePath, 65536) as { timestamp?: number } | null;
    return state && typeof state.timestamp === "number" && Number.isFinite(state.timestamp) && state.timestamp >= 0 ? state.timestamp : undefined;
  } catch {
    return undefined;
  }
}
