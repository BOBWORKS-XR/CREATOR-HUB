import { randomUUID } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";

import type { BanterMCPConfig } from "./config.js";
import { assertOrdinaryPath, readBoundedJson } from "./bounded-json.js";
import { atomicWriteFileSync } from "./files.js";

export const BRIDGE_PROTOCOL_VERSION = 1;
const BRIDGE_HEARTBEAT_MAX_AGE_MS = 10_000;
const PIPE_RESPONSE_LIMIT_BYTES = 64 * 1024;

export interface BridgeCommandResult {
  commandType?: string;
  status?: "dispatched" | "completed";
  observed?: Record<string, unknown>;
  commandId?: string;
  success?: boolean;
  message?: string;
  error?: string;
  timestamp?: number;
  projectId?: string;
  projectPath?: string;
  editorInstanceId?: string;
}

export interface BridgeTransportDispatch {
  commandId: string;
  acknowledgement?: BridgeCommandResult;
  transport: "named_pipe" | "file";
  queued: boolean;
  fallbackReason?: string;
}

export interface BridgeTransportErrorContext {
  commandId: string;
  projectId?: string;
  projectPath: string;
  editorInstanceId?: string;
  transport?: "named_pipe" | "file";
  deliveryPhase: "not_sent" | "possibly_sent" | "sent";
  receiptPath?: string;
}

/** A transport failure is not proof that Unity did not execute the command. */
export class BridgeTransportError extends Error implements BridgeTransportErrorContext {
  readonly commandId: string;
  readonly projectId?: string;
  readonly projectPath: string;
  readonly editorInstanceId?: string;
  readonly transport?: "named_pipe" | "file";
  readonly deliveryPhase: BridgeTransportErrorContext["deliveryPhase"];
  readonly receiptPath?: string;
  readonly completion: "not_started" | "unknown";

  constructor(cause: unknown, context: BridgeTransportErrorContext) {
    super(cause instanceof Error ? cause.message : "Unknown Unity transport error", { cause });
    this.name = "BridgeTransportError";
    this.commandId = context.commandId;
    this.projectId = context.projectId;
    this.projectPath = context.projectPath;
    this.editorInstanceId = context.editorInstanceId;
    this.transport = context.transport;
    this.deliveryPhase = context.deliveryPhase;
    this.receiptPath = context.receiptPath;
    this.completion = context.deliveryPhase === "not_sent" ? "not_started" : "unknown";
  }
}

export interface BridgeInstanceDescriptor {
  editorInstanceId?: string;
  projectPath?: string;
  projectName?: string;
  bridgeVersion?: string;
  protocolVersion?: number;
  minimumProtocolVersion?: number;
  capabilities?: string[];
  preferredTransport?: string;
  pipeName?: string;
  unityVersion?: string;
  processId?: number;
  processStartedAt?: number;
  updatedAt?: number;
}

export type BridgeInstanceEvidence =
  | { descriptor?: BridgeInstanceDescriptor; error?: never }
  | { descriptor?: never; error: string };

interface PipeAttempt {
  status: "acknowledged" | "sent_without_acknowledgement" | "unavailable";
  acknowledgement?: BridgeCommandResult;
  reason?: string;
}

export async function dispatchUnityBridgeCommand(
  command: Record<string, unknown>,
  config: BanterMCPConfig,
  timeoutMs = 3000
): Promise<BridgeTransportDispatch> {
  const commandId = randomUUID();
  // Freeze the recovery target even if the caller changes selection during an await.
  config = { ...config };
  const context: BridgeTransportErrorContext = {
    commandId, projectId: config.projectId, projectPath: config.unityProjectPath,
    deliveryPhase: "not_sent",
  };
  try {
    const evidence = inspectBridgeInstance(config.mcpStatePath, config.unityProjectPath);
    if (evidence.error) throw new Error(evidence.error);
    const descriptor = evidence.descriptor;
    context.editorInstanceId = descriptor?.editorInstanceId;
    const payload = {
      ...command,
      id: commandId,
      timestamp: Date.now(),
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      expectedProjectId: config.projectId,
      expectedProjectPath: config.unityProjectPath,
      expectedEditorInstanceId: descriptor?.editorInstanceId,
    };

    const pipeEligibility = namedPipeEligibility(descriptor);
    if (pipeEligibility.eligible && descriptor?.pipeName) {
      context.transport = "named_pipe";
      const pipeAttempt = await sendOverNamedPipe(payload, descriptor.pipeName, timeoutMs);
      if (pipeAttempt.status === "acknowledged") {
        context.deliveryPhase = "sent";
        validateBridgeCommandResult(pipeAttempt.acknowledgement, commandId, config, descriptor.editorInstanceId);
        return {
          commandId,
          acknowledgement: pipeAttempt.acknowledgement,
          transport: "named_pipe",
          queued: false,
        };
      }

      if (pipeAttempt.status === "sent_without_acknowledgement") {
        context.deliveryPhase = "possibly_sent";
        return {
          commandId,
          transport: "named_pipe",
          queued: true,
          fallbackReason: pipeAttempt.reason,
        };
      }

      return await dispatchOverFiles(
        payload,
        commandId,
        config,
        timeoutMs,
        descriptor?.editorInstanceId,
        pipeAttempt.reason,
        context
      );
    }

    return await dispatchOverFiles(
      payload,
      commandId,
      config,
      timeoutMs,
      descriptor?.editorInstanceId,
      pipeEligibility.reason,
      context
    );
  } catch (error) {
    throw new BridgeTransportError(error, context);
  }
}

export function readBridgeInstanceDescriptor(
  config: BanterMCPConfig
): BridgeInstanceDescriptor | undefined {
  // Metadata consumers (including receipt correlation) do not require a valid heartbeat.
  try { return readInstanceObject(config.mcpStatePath, config.unityProjectPath); }
  catch { return undefined; }
}

function readInstanceObject(statePath: string, projectPath: string): Record<string, unknown> | undefined {
  const file = path.join(statePath, "project-instance.json");
  assertOrdinaryPath(file, projectPath);
  const value = readBoundedJson(file, 65536);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function inspectBridgeInstance(statePath: string, projectPath: string): BridgeInstanceEvidence {
  const invalid = { error: "The Unity bridge instance descriptor is invalid or unreadable." };
  try {
    const raw = readInstanceObject(statePath, projectPath);
    if (!raw) return invalid;
    if (raw.projectPath !== undefined) {
      const reported = raw.projectPath;
      if (typeof reported !== "string" || reported.length > 4096 || /[\x00-\x1f\x7f]/.test(reported) ||
        !path.isAbsolute(reported.trim())) return invalid;
      // Compare the reported spelling only. Never resolve a descriptor-supplied path on disk.
      if (!pathsReferToSameProject(reported, projectPath)) {
        return { error: `Unity bridge project mismatch: selected '${projectPath}', descriptor reports '${reported}'.` };
      }
    }
    const descriptor: BridgeInstanceDescriptor = {};
    for (const key of ["editorInstanceId", "bridgeVersion", "preferredTransport", "pipeName", "projectPath", "projectName", "unityVersion"] as const) {
      if (typeof raw[key] === "string" && raw[key].length <= 4096) descriptor[key] = raw[key];
    }
    for (const key of ["protocolVersion", "minimumProtocolVersion", "updatedAt"] as const) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] !== "number" || !Number.isSafeInteger(raw[key]) || raw[key] < 0) return invalid;
      descriptor[key] = raw[key];
    }
    for (const key of ["processId", "processStartedAt"] as const) {
      if (typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0) descriptor[key] = raw[key];
    }
    if (Array.isArray(raw.capabilities) && raw.capabilities.length <= 128 &&
      raw.capabilities.every(item => typeof item === "string" && item.length <= 128)) descriptor.capabilities = raw.capabilities;
    return { descriptor };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : invalid;
  }
}

export function namedPipeEligibility(
  descriptor: BridgeInstanceDescriptor | undefined
): { eligible: boolean; reason?: string } {
  if (process.platform !== "win32") {
    return { eligible: false, reason: "Named-pipe transport is currently available on Windows only." };
  }
  if (!descriptor) {
    return { eligible: false, reason: "The bridge instance descriptor is unavailable." };
  }
  if (!isLiveHeartbeat(descriptor.updatedAt)) {
    return { eligible: false, reason: "The bridge instance descriptor is stale." };
  }
  if (
    descriptor.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    (descriptor.minimumProtocolVersion ?? BRIDGE_PROTOCOL_VERSION) > BRIDGE_PROTOCOL_VERSION
  ) {
    return {
      eligible: false,
      reason: `Bridge protocol ${String(descriptor.protocolVersion)} is not compatible with server protocol ${BRIDGE_PROTOCOL_VERSION}.`,
    };
  }
  if (!Array.isArray(descriptor.capabilities) || !descriptor.capabilities.includes("named_pipe_commands")) {
    return { eligible: false, reason: "The bridge does not advertise named-pipe commands." };
  }
  if (
    typeof descriptor.pipeName !== "string" ||
    !/^bantworks-unity-[A-Za-z0-9._-]{1,100}$/.test(descriptor.pipeName)
  ) {
    return { eligible: false, reason: "The bridge pipe name is missing or invalid." };
  }
  return { eligible: true };
}

export function isLiveHeartbeat(stamp: number | undefined): boolean {
  if (stamp === undefined || !Number.isSafeInteger(stamp) || stamp <= 0) return false;
  const age = Date.now() - stamp;
  return age >= 0 && age <= BRIDGE_HEARTBEAT_MAX_AGE_MS;
}

async function dispatchOverFiles(
  payload: Record<string, unknown>,
  commandId: string,
  config: BanterMCPConfig,
  timeoutMs: number,
  expectedEditorInstanceId: string | undefined,
  fallbackReason: string | undefined,
  context: BridgeTransportErrorContext
): Promise<BridgeTransportDispatch> {
  const commandFile = path.join(config.mcpCommandsPath, `${commandId}.json`);
  const serialized = JSON.stringify(payload, null, 2);
  context.transport = "file";
  // A write can fail after publishing the file; never infer non-delivery from IO failure.
  context.deliveryPhase = "possibly_sent";
  atomicWriteFileSync(commandFile, serialized);
  context.deliveryPhase = "sent";
  const acknowledgement = await waitForFileAcknowledgement(commandId, config, timeoutMs, expectedEditorInstanceId, context);

  return {
    commandId,
    acknowledgement,
    transport: "file",
    queued: !acknowledgement,
    fallbackReason,
  };
}

async function waitForFileAcknowledgement(
  commandId: string,
  config: BanterMCPConfig,
  timeoutMs: number,
  expectedEditorInstanceId?: string,
  context?: BridgeTransportErrorContext
): Promise<BridgeCommandResult | undefined> {
  const resultPath = path.join(config.mcpStatePath, "command-results", `${commandId}.json`);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(resultPath)) {
      if (context) context.receiptPath = resultPath;
      let result: unknown;
      try {
        result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
      } catch {
        throw new Error("Could not read the Unity acknowledgement. It was kept for inspection.");
      }
      validateBridgeCommandResult(result, commandId, config, expectedEditorInstanceId);
      // Validate before consuming evidence, including its project and Editor identity.
      try { fs.unlinkSync(resultPath); } catch { /* A valid receipt still proves completion if cleanup fails. */ }
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return undefined;
}

export function validateBridgeCommandResult(
  value: unknown,
  commandId: string,
  config: BanterMCPConfig,
  expectedEditorInstanceId?: string,
  label = "Unity acknowledgement"
): asserts value is BridgeCommandResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} has an invalid shape. It was not accepted.`);
  }
  const acknowledgement = value as BridgeCommandResult;
  if (acknowledgement.commandId !== commandId) {
    throw new Error(`${label} correlation ID did not match the request. It was not accepted.`);
  }
  if (typeof acknowledgement.success !== "boolean" ||
      (acknowledgement.status != null && acknowledgement.status !== "dispatched" && acknowledgement.status !== "completed") ||
      ["projectId", "projectPath", "editorInstanceId", "message", "error", "commandType"].some(
        (key) => (value as Record<string, unknown>)[key] != null && typeof (value as Record<string, unknown>)[key] !== "string")) {
    throw new Error(`${label} has an invalid shape. It was not accepted.`);
  }
  if (acknowledgement.projectId && acknowledgement.projectId !== config.projectId) {
    throw new Error(`${label} project ID mismatch. It was not accepted.`);
  }
  if (acknowledgement.projectPath &&
      !pathsReferToSameProject(acknowledgement.projectPath, config.unityProjectPath)) {
    throw new Error(
      `${label} project mismatch: selected '${config.unityProjectPath}', result reports '${acknowledgement.projectPath}'. It was not accepted.`
    );
  }
  if (expectedEditorInstanceId && acknowledgement.editorInstanceId &&
      acknowledgement.editorInstanceId !== expectedEditorInstanceId) {
    throw new Error(
      `${label} Editor mismatch: expected '${expectedEditorInstanceId}', result reports '${acknowledgement.editorInstanceId}'. It was not accepted.`
    );
  }
}

function sendOverNamedPipe(
  payload: Record<string, unknown>,
  pipeName: string,
  timeoutMs: number
): Promise<PipeAttempt> {
  const serialized = `${JSON.stringify(payload)}\n`;
  return new Promise((resolve) => {
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    const socket = net.createConnection(pipePath);
    let commandMayHaveBeenDelivered = false;
    let responseBytes = 0;
    let response = "";
    let settled = false;

    const finish = (result: PipeAttempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(commandMayHaveBeenDelivered
        ? {
            status: "sent_without_acknowledgement",
            reason: "The named-pipe command was sent but Unity did not acknowledge it before the timeout.",
          }
        : {
            status: "unavailable",
            reason: "The named-pipe endpoint did not accept the command before the timeout.",
          });
    }, Math.max(250, timeoutMs));

    socket.once("connect", () => {
      commandMayHaveBeenDelivered = true;
      try {
        socket.write(serialized);
      } catch {
        finish({ status: "sent_without_acknowledgement", reason: "The named-pipe write failed; delivery and completion are unknown." });
      }
    });

    socket.on("data", (chunk: Buffer) => {
      responseBytes += chunk.length;
      if (responseBytes > PIPE_RESPONSE_LIMIT_BYTES) {
        finish({
          status: "sent_without_acknowledgement",
          reason: "The named-pipe acknowledgement exceeded the response size limit.",
        });
        return;
      }

      response += chunk.toString("utf-8");
      const newline = response.indexOf("\n");
      if (newline < 0) return;

      try {
        const acknowledgement = JSON.parse(response.slice(0, newline)) as BridgeCommandResult;
        if (acknowledgement.commandId !== payload.id) {
          finish({
            status: "sent_without_acknowledgement",
            reason: "Unity returned an acknowledgement for a different command.",
          });
          return;
        }
        finish({ status: "acknowledged", acknowledgement });
      } catch {
        finish({
          status: "sent_without_acknowledgement",
          reason: "Unity returned an invalid named-pipe acknowledgement.",
        });
      }
    });

    socket.once("error", (error) => {
      finish(commandMayHaveBeenDelivered
        ? {
            status: "sent_without_acknowledgement",
            reason: `The named-pipe connection failed after sending the command: ${error.message}`,
          }
        : {
            status: "unavailable",
            reason: `The named-pipe endpoint is unavailable: ${error.message}`,
          });
    });

    socket.once("end", () => {
      if (!settled) {
        finish(commandMayHaveBeenDelivered
          ? {
              status: "sent_without_acknowledgement",
              reason: "The named-pipe connection closed before Unity acknowledged the command.",
            }
          : {
              status: "unavailable",
              reason: "The named-pipe connection closed before the command was sent.",
            });
      }
    });
  });
}

function pathsReferToSameProject(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value.trim()).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };

  return Boolean(left?.trim() && right?.trim()) && normalize(left) === normalize(right);
}
