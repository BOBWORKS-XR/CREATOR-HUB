/**
 * Read-only diagnostics for the project-local Unity bridge.
 */

import * as fs from "fs";
import * as path from "path";
import type { BanterMCPConfig } from "../lib/config.js";
import { MCP_VERSION } from "../lib/version.js";
import { editorHeartbeatState } from "../lib/project-router.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  namedPipeEligibility,
  readBridgeInstanceDescriptor,
} from "../lib/unity-bridge-transport.js";

const STATE_FILES = [
  "scene-hierarchy.json",
  "editor-state.json",
  "project-instance.json",
  "console-log.json",
  "import-status.json",
  "compilation-status.json",
  "prefab-catalog.json",
];

interface StateFileStatus {
  name: string;
  exists: boolean;
  updatedAt?: string;
  ageMs?: number;
}

export interface BridgeStatusResult {
  success: boolean;
  mcpServerVersion: string;
  ready?: boolean;
  error?: string;
  project?: {
    id?: string;
    path: string;
    exists: boolean;
    assetsPath: string;
    assetsExists: boolean;
  };
  bridge?: {
    path: string;
    installed: boolean;
    stateDirectory: string;
    stateDirectoryExists: boolean;
    commandsDirectory: string;
    commandsDirectoryExists: boolean;
    stateStatus: "fresh" | "stale" | "missing";
    stateFiles: StateFileStatus[];
    protocol: {
      serverVersion: number;
      bridgeVersion?: number;
      minimumBridgeVersion?: number;
      compatible: boolean;
      bridgeRelease?: string;
      capabilities: string[];
    };
    transport: {
      preferred: "named_pipe" | "file";
      namedPipeAdvertised: boolean;
      pipeName?: string;
    };
  };
  nextSteps?: string[];
}

/**
 * Inspect the local bridge state without creating commands or modifying Unity.
 */
export function getBridgeStatus(config: BanterMCPConfig): BridgeStatusResult {
  if (!config.unityProjectPath) {
    return {
      success: false,
      mcpServerVersion: MCP_VERSION,
      error: "UNITY_PROJECT_PATH is not set.",
      nextSteps: [
        "Set UNITY_PROJECT_PATH to the Unity project root, then restart the MCP client.",
      ],
    };
  }

  const projectExists = fs.existsSync(config.unityProjectPath);
  const assetsExists = fs.existsSync(config.assetsPath);
  const bridgePath = path.join(config.assetsPath, "Editor", "BanterMCPBridge.cs");
  const bridgeInstalled = fs.existsSync(bridgePath);
  const stateDirectoryExists = fs.existsSync(config.mcpStatePath);
  const commandsDirectoryExists = fs.statSync(config.mcpCommandsPath, { throwIfNoEntry: false })?.isDirectory() === true;
  const descriptor = readBridgeInstanceDescriptor(config);
  const now = Date.now();

  const stateFiles = STATE_FILES.map((name): StateFileStatus => {
    const filePath = path.join(config.mcpStatePath, name);
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      return { name, exists: false };
    }

    const modifiedAt = stat.mtime;
    return {
      name,
      exists: true,
      updatedAt: modifiedAt.toISOString(),
      ageMs: Math.max(0, now - modifiedAt.getTime()),
    };
  });

  const heartbeat = editorHeartbeatState(config.mcpStatePath, config.unityProjectPath, descriptor?.updatedAt);
  const stateStatus = heartbeat === "live" ? "fresh" : heartbeat === "not_seen" ? "missing" : "stale";
  const bridgeProtocol = descriptor?.protocolVersion;
  const minimumBridgeProtocol = descriptor?.minimumProtocolVersion ?? bridgeProtocol;
  const protocolCompatible = bridgeProtocol === undefined ||
    (bridgeProtocol === BRIDGE_PROTOCOL_VERSION &&
      (minimumBridgeProtocol ?? BRIDGE_PROTOCOL_VERSION) <= BRIDGE_PROTOCOL_VERSION);
  const capabilities = Array.isArray(descriptor?.capabilities)
    ? descriptor.capabilities.filter((item): item is string => typeof item === "string")
    : [];
  const namedPipeAdvertised = capabilities.includes("named_pipe_commands") &&
    typeof descriptor?.pipeName === "string";
  const commandChannelAvailable = commandsDirectoryExists || namedPipeEligibility(descriptor).eligible;
  const ready = assetsExists && bridgeInstalled && stateDirectoryExists &&
    stateStatus === "fresh" && protocolCompatible && commandChannelAvailable;

  const nextSteps: string[] = [];
  if (!projectExists || !assetsExists) {
    nextSteps.push("Point UNITY_PROJECT_PATH at a Unity project root containing an Assets folder.");
  } else if (!bridgeInstalled) {
    nextSteps.push("Install unity-extension/Editor/BanterMCPBridge.cs into Assets/Editor, then let Unity compile it.");
  } else if (!stateDirectoryExists || stateStatus === "missing") {
    nextSteps.push("Open the project in Unity and wait for Creator Works MCP to export state.");
  } else if (stateStatus === "stale") {
    nextSteps.push("Open this project in Unity and wait for a fresh Editor heartbeat, then check again.");
  } else if (!protocolCompatible) {
    nextSteps.push("Update the Unity bridge; its command protocol does not match this MCP server.");
  } else if (!commandChannelAvailable) {
    nextSteps.push("Let Unity finish compiling the bridge, then check again. The Editor has not provided a usable command channel.");
  }

  return {
    success: true,
    mcpServerVersion: MCP_VERSION,
    ready,
    project: {
      id: config.projectId,
      path: config.unityProjectPath,
      exists: projectExists,
      assetsPath: config.assetsPath,
      assetsExists,
    },
    bridge: {
      path: bridgePath,
      installed: bridgeInstalled,
      stateDirectory: config.mcpStatePath,
      stateDirectoryExists,
      commandsDirectory: config.mcpCommandsPath,
      commandsDirectoryExists,
      stateStatus,
      stateFiles,
      protocol: {
        serverVersion: BRIDGE_PROTOCOL_VERSION,
        bridgeVersion: bridgeProtocol,
        minimumBridgeVersion: minimumBridgeProtocol,
        compatible: protocolCompatible,
        bridgeRelease: descriptor?.bridgeVersion,
        capabilities,
      },
      transport: {
        preferred: namedPipeAdvertised ? "named_pipe" : "file",
        namedPipeAdvertised,
        pipeName: namedPipeAdvertised ? descriptor?.pipeName : undefined,
      },
    },
    nextSteps,
  };
}
