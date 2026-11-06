import { createHash } from "node:crypto";
import type { UnityProjectListResult } from "./project-router.js";

export const PROJECT_LIST_FIELDS = ["projectId", "projectPath", "projectName", "enabled", "selected", "source",
  "sessionRegistered", "channelIds", "channelNames", "scenePaths", "validProject", "bridgeInstalled", "editorState", "editorInstance"] as const;
export type ProjectListField = typeof PROJECT_LIST_FIELDS[number];
export interface ProjectListOptions {
  projectIds?: string[];
  fields?: ProjectListField[];
  limit?: number;
  cursor?: string;
  maxResponseBytes?: number;
}

export function projectListPage(list: UnityProjectListResult, input: Record<string, unknown> = {}): Record<string, unknown> {
  const allowed = ["projectIds", "fields", "limit", "cursor", "maxResponseBytes"];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Unsupported project-list argument.");
  const ids = input.projectIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== "string" || !/^unity-[a-f0-9]{20}$/.test(id)))) {
    throw new Error("projectIds must contain at most 100 stable Unity project IDs.");
  }
  const suppliedFields = input.fields;
  if (suppliedFields !== undefined && (!Array.isArray(suppliedFields) || suppliedFields.length === 0 || suppliedFields.length > PROJECT_LIST_FIELDS.length ||
    suppliedFields.some(field => !PROJECT_LIST_FIELDS.includes(field as ProjectListField)))) throw new Error("Unsupported or empty project field selection.");
  const fields = [...new Set<ProjectListField>(["projectId", ...((suppliedFields ?? PROJECT_LIST_FIELDS) as ProjectListField[])])];
  const limit = input.limit ?? 50;
  const budget = input.maxResponseBytes ?? 32768;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error("limit must be an integer from 1 to 100.");
  if (!Number.isInteger(budget) || (budget as number) < 4096 || (budget as number) > 65536) throw new Error("maxResponseBytes must be an integer from 4096 to 65536.");
  const requested = ids === undefined ? undefined : new Set(ids as string[]);
  const projects = list.projects.filter(project => !requested || requested.has(project.projectId));
  const fingerprint = createHash("sha256").update(JSON.stringify({
    active: list.activeProjectId, ids: ids ?? null, fields,
    rows: projects.map(project => [project.projectId, project.projectName, project.enabled, project.selected, project.source, project.sessionRegistered]),
  })).digest("hex").slice(0, 24);
  let offset = 0;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || !/^v1\.[0-9]{1,8}\.[a-f0-9]{24}$/.test(input.cursor)) throw new Error("Invalid project-list cursor.");
    const [, rawOffset, digest] = input.cursor.split(".");
    offset = Number(rawOffset);
    if (digest !== fingerprint || offset > projects.length) throw new Error("Project list changed. Repeat without a cursor.");
  }
  const page = projects.slice(offset, offset + (limit as number));
  const render = (count: number): Record<string, unknown> => ({
    success: true, activeProjectId: list.activeProjectId, activeProjectPath: list.activeProjectPath,
    launcherConfigPath: list.launcherConfigPath,
    total: projects.length, returned: count, truncated: offset + count < projects.length,
    nextCursor: offset + count < projects.length ? `v1.${offset + count}.${fingerprint}` : null,
    projects: page.slice(0, count).map(project => Object.fromEntries(fields.filter(field => project[field] !== undefined).map(field => [field, project[field]]))),
    warnings: list.warnings.slice(0, 8).map(warning => warning.slice(0, 1024)),
    maxResponseBytes: budget,
  });
  let count = page.length;
  while (count > 0 && Buffer.byteLength(JSON.stringify(render(count), null, 2), "utf8") > (budget as number)) count--;
  const result = render(count);
  if ((page.length > 0 && count === 0) || Buffer.byteLength(JSON.stringify(result, null, 2), "utf8") > (budget as number)) {
    throw new Error("A project row cannot fit the response budget. Select fewer fields or increase maxResponseBytes.");
  }
  return result;
}
