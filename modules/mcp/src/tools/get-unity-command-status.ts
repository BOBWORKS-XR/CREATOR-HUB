import * as fs from "fs";
import * as path from "path";

import type { BanterMCPConfig } from "../lib/config.js";
import { projectIdForPath } from "../lib/project-router.js";
import {
  readBridgeInstanceDescriptor,
  validateBridgeCommandResult,
  type BridgeCommandResult,
} from "../lib/unity-bridge-transport.js";

export interface UnityCommandStatusResult extends Record<string, unknown> {
  success: boolean;
  accepted?: boolean;
  pending?: boolean;
  status: "completed" | "pending" | "dispatched" | "unknown";
  commandId: string;
  projectId?: string;
  projectPath: string;
  editorInstanceId?: string;
  message?: string;
  error?: string;
}

export function pendingCommandTimeout(commandId: string, config: BanterMCPConfig, error: string) {
  const projectId = config.projectId || projectIdForPath(config.unityProjectPath);
  return {
    success: false,
    pending: true,
    status: "result_timeout",
    commandId,
    projectId,
    projectPath: config.unityProjectPath,
    error,
    message: "Completion is unknown; this command may still execute. Do not resubmit it. Check Unity for a dialog, open menu, reload, or long-running work, then poll the original command.",
    nextAction: { tool: "get_unity_command_status", arguments: { commandId, projectId } },
  };
}

export function getUnityCommandStatus(
  commandId: string,
  projectId: string,
  config: BanterMCPConfig
): UnityCommandStatusResult {
  if (!isSafeCommandId(commandId)) {
    return failure(commandId, config, "commandId must be a UUID returned by a Unity command.");
  }
  if (!projectId || projectId !== config.projectId) {
    return failure(
      commandId,
      config,
      `Project mismatch: status was requested for '${projectId || "(missing)"}', but the selected project is '${config.projectId || "(unrouted)"}'. Reselect the intended project first.`
    );
  }

  const descriptor = readBridgeInstanceDescriptor(config);
  const completionPath = path.join(config.mcpStatePath, "command-results", `${commandId}.json`);
  const retainedPath = path.join(config.mcpStatePath, "command-status", `${commandId}.json`);
  const resultPath = fs.existsSync(completionPath) ? completionPath : retainedPath;
  if (fs.existsSync(resultPath)) {
    try {
      const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as BridgeCommandResult;
      validateBridgeCommandResult(result, commandId, config, descriptor?.editorInstanceId, "Unity command result");
      if (result.status === "dispatched") {
        return {
          success: false, accepted: true, pending: true, status: "dispatched", commandId,
          projectId: config.projectId, projectPath: result.projectPath || config.unityProjectPath,
          editorInstanceId: result.editorInstanceId, lastObservedAt: result.timestamp,
          message: "Unity dispatched this command. Completion is unknown; this is not proof it is still running. Do not resubmit. Menu return does not prove an asynchronous build completed.",
        };
      }
      const sceneResult = result.success === true ? readUnitySceneResult(commandId, config) : undefined;
      const menuResult = result.success === true ? readUnityEditorMenuResult(commandId, config) : undefined;
      // Older bridges have no commandType; their exact completion message identifies menu dispatch.
      const expectsMenuResult = result.commandType === "execute_editor_menu_item" ||
        result.message?.startsWith("Executed Unity Editor menu item:");
      if (result.success === true && expectsMenuResult && !menuResult) {
        return {
          ...failure(commandId, config, "The correlated Unity Editor menu result is missing. The command receipt was kept for inspection."),
          accepted: true,
          completion: "unknown",
          message: "Menu completion is unknown. Do not resubmit; poll the original command. A menu return does not prove an asynchronous build completed.",
          nextAction: { tool: "get_unity_command_status", arguments: { commandId, projectId } },
        };
      }
      if (resultPath === completionPath) {
        try { fs.unlinkSync(resultPath); } catch { /* Cleanup failure must not erase a validated completion. */ }
      }
      return {
        success: result.success === true && sceneResult?.success !== false && menuResult?.success !== false,
        accepted: true,
        pending: false,
        status: "completed",
        commandId,
        projectId: config.projectId,
        projectPath: result.projectPath || config.unityProjectPath,
        editorInstanceId: result.editorInstanceId,
        message: result.message,
        error: sceneResult?.success === false ? String(sceneResult.error || "Unity scene command failed.") :
          menuResult?.success === false ? String(menuResult.error || "Unity Editor menu command failed.") : result.error,
        observed: result.observed ?? undefined,
        sceneResult,
        menuResult,
        ...(menuResult ? {
          executionSucceeded: menuResult.success === true,
          settleVerified: false,
          message: menuResult.success === true
            ? "The menu callback succeeded. Post-command settling and any asynchronous build completion are not verified by status polling."
            : result.message,
        } : {}),
        lastObservedAt: result.timestamp,
      };
    } catch (error) {
      return failure(
        commandId,
        config,
        `Could not read Unity command result: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }

  const commandPath = path.join(config.mcpCommandsPath, `${commandId}.json`);
  if (fs.existsSync(commandPath)) {
    return {
      success: false,
      accepted: true,
      pending: true,
      status: "pending",
      commandId,
      projectId: config.projectId,
      projectPath: config.unityProjectPath,
      editorInstanceId: descriptor?.editorInstanceId,
      message: "Unity has not completed this command yet.",
    };
  }

  return {
    success: false,
    accepted: false,
    pending: false,
    status: "unknown",
    commandId,
    projectId: config.projectId,
    projectPath: config.unityProjectPath,
    editorInstanceId: descriptor?.editorInstanceId,
    error: "No pending command or correlated result exists in the selected project's state directory.",
  };
}

export function readUnitySceneResult(commandId: string, config: BanterMCPConfig): Record<string, unknown> | undefined {
  if (!isSafeCommandId(commandId)) throw new Error("Invalid scene result command ID.");
  const file = path.join(config.mcpStatePath, "scene-results", `${commandId}.json`);
  if (!fs.existsSync(file)) return undefined;
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    throw new Error("Could not read the correlated Unity scene result.");
  }
  if (!result || typeof result !== "object" || Array.isArray(result) || result.commandId !== commandId ||
      typeof result.success !== "boolean" ||
      (result.success && (!Array.isArray(result.openScenes) || !Array.isArray(result.buildScenes)))) {
    throw new Error("Unity scene result has an invalid shape or correlation ID. It was kept for inspection.");
  }
  return result;
}

export function readUnityEditorMenuResult(commandId: string, config: BanterMCPConfig): Record<string, unknown> | undefined {
  if (!isSafeCommandId(commandId)) throw new Error("Invalid menu result command ID.");
  const file = path.join(config.mcpStatePath, "editor-menu-results", `${commandId}.json`);
  if (!fs.existsSync(file)) return undefined;
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    throw new Error("Could not read the correlated Unity Editor menu result. It was kept for inspection.");
  }
  if (!result || typeof result !== "object" || Array.isArray(result) || result.commandId !== commandId ||
      typeof result.success !== "boolean" ||
      ["executionSucceeded", "executionReturnedTrue"].some(key =>
        result[key] !== undefined && (typeof result[key] !== "boolean" || (result.success && result[key] !== true))) ||
      (result.diagnostics !== undefined && !Array.isArray(result.diagnostics)) ||
      (result.success && (typeof result.menuPath !== "string" || !result.menuPath.trim() ||
        result.executionSucceeded !== true || result.executionReturnedTrue !== true))) {
    throw new Error("Unity Editor menu result has an invalid shape or correlation ID. It was kept for inspection.");
  }
  return result;
}

function failure(commandId: string, config: BanterMCPConfig, error: string): UnityCommandStatusResult {
  return {
    success: false,
    accepted: false,
    pending: false,
    status: "unknown",
    commandId,
    projectId: config.projectId,
    projectPath: config.unityProjectPath,
    error,
  };
}

function isSafeCommandId(value: string): boolean {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
