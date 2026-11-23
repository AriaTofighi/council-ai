import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type {
  ProviderAdapter,
  ProviderCheckOptions,
  ProviderCheckResult,
  ProviderEvent,
  ProviderSessionHandle,
  StartSessionOptions,
  TurnInput,
  TurnResult,
  UsageInfo,
} from "../types/provider.js";
import { classifyProcessFailure } from "./classify.js";
import { discoverProviderExecutable } from "./discovery.js";
import { ActiveProcessTracker, runCliProcess } from "./process.js";
import {
  normalizeUsage,
  resolveStructuredOutput,
  runProviderAvailabilityCheck,
  sendTurnWithFallback,
} from "./shared.js";

export interface ParsedCodexOutput {
  threadId?: string;
  text: string;
  usage?: UsageInfo;
  errors: string[];
  validEvents: number;
  malformed: boolean;
}

export function parseCodexJsonl(stdout: string): ParsedCodexOutput {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let threadId: string | undefined;
  let lastAgentMessage = "";
  let usage: UsageInfo | undefined;
  const errors: string[] = [];
  let validEvents = 0;

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      const obj = JSON.parse(line);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        continue;
      }
      parsed = obj as Record<string, unknown>;
    } catch {
      continue;
    }

    validEvents += 1;
    const type = parsed.type;

    if (type === "thread.started" && typeof parsed.thread_id === "string") {
      threadId = parsed.thread_id;
    } else if (type === "item.completed" && parsed.item && typeof parsed.item === "object") {
      const item = parsed.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") {
        lastAgentMessage = item.text;
      }
    } else if (type === "turn.completed" && parsed.usage && typeof parsed.usage === "object") {
      usage = normalizeUsage(parsed.usage as Record<string, unknown>);
    } else if (type === "error" && typeof parsed.message === "string") {
      errors.push(parsed.message);
    } else if (type === "turn.failed") {
      const errObj = parsed.error as Record<string, unknown> | undefined;
      const msg =
        (errObj && typeof errObj.message === "string" && errObj.message) ||
        (typeof parsed.message === "string" ? parsed.message : "Codex turn failed");
      errors.push(msg);
    }
  }

  return {
    threadId,
    text: lastAgentMessage,
    usage,
    errors,
    validEvents,
    malformed: lines.length > 0 && validEvents === 0,
  };
}

function writeTempSchemaFile(schema: Record<string, unknown>): string {
  const filePath = path.join(
    os.tmpdir(),
    `council-codex-schema-${crypto.randomUUID()}.json`,
  );
  fs.writeFileSync(filePath, JSON.stringify(schema), "utf8");
  return filePath;
}

export function buildCodexArgs(
  handle: Pick<
    ProviderSessionHandle,
    "cwd" | "readOnly" | "model" | "effort"
  >,
  resumeSessionId: string | undefined,
  schemaFile: string | undefined,
): string[] {
  if (resumeSessionId) {
    const args = ["exec", "resume", "--json", "--skip-git-repo-check"];
    if (handle.readOnly) {
      args.push("-c", 'sandbox_mode="read-only"');
    }
    if (handle.model) {
      args.push("-m", handle.model);
    }
    if (handle.effort) {
      args.push("-c", `model_reasoning_effort="${handle.effort}"`);
    }
    if (schemaFile) {
      args.push("--output-schema", schemaFile);
    }
    args.push(resumeSessionId, "-");
    return args;
  }

  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    handle.cwd,
  ];
  if (handle.readOnly) {
    args.push("-s", "read-only");
  }
  if (handle.model) {
    args.push("-m", handle.model);
  }
  if (handle.effort) {
    args.push("-c", `model_reasoning_effort="${handle.effort}"`);
  }
  if (schemaFile) {
    args.push("--output-schema", schemaFile);
  }
  args.push("-");
  return args;
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex" as const;
  private readonly tracker = new ActiveProcessTracker();

  checkAvailability(
    options: ProviderCheckOptions = {},
  ): Promise<ProviderCheckResult> {
    return runProviderAvailabilityCheck(this, discoverProviderExecutable, options);
  }

  async startSession(
    options: StartSessionOptions,
  ): Promise<ProviderSessionHandle> {
    const discovery = await discoverProviderExecutable(
      "codex",
      options.executablePath,
    );
    if (!discovery.executablePath) {
      throw new Error(
        `Codex executable not found (checked: ${discovery.candidatesChecked.join(", ")})`,
      );
    }

    return {
      participantId: options.participantId,
      provider: "codex",
      executablePath: discovery.executablePath,
      continuationMode: "native",
      systemPrompt: options.systemPrompt,
      cwd: options.cwd,
      readOnly: options.readOnly ?? true,
      allowReadOnlyTools: options.allowReadOnlyTools ?? true,
      model: options.model,
      effort: options.effort,
      turnCount: 0,
      history: [],
    };
  }

  sendTurn(
    handle: ProviderSessionHandle,
    input: TurnInput,
  ): Promise<TurnResult> {
    return sendTurnWithFallback(handle, input, {
      composeTurn1WithSystem: true,
      executeOnce: (promptPayload, resumeSessionId) =>
        this.executeOnce(handle, promptPayload, resumeSessionId, input),
    });
  }

  cancel(participantId: string): boolean {
    return this.tracker.cancel(participantId);
  }

  private async executeOnce(
    handle: ProviderSessionHandle,
    stdinPrompt: string,
    resumeSessionId: string | undefined,
    input: TurnInput,
  ): Promise<TurnResult> {
    let schemaFile: string | undefined;
    try {
      if (input.responseSchema) {
        schemaFile = writeTempSchemaFile(input.responseSchema);
      }

      const args = this.buildArgs(handle, resumeSessionId, schemaFile);
      let seenSessionStart = false;

      const proc = await runCliProcess(
        {
          command: handle.executablePath,
          args,
          cwd: handle.cwd,
          stdin: stdinPrompt,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          processKey: handle.participantId,
          onStdoutLine: (line) => {
            if (!input.onEvent) return;
            const evt = this.parseLineForEvent(line, handle.participantId);
            if (!evt) return;
            if (evt.type === "session_started") {
              if (seenSessionStart) return;
              seenSessionStart = true;
            }
            input.onEvent(evt);
          },
        },
        this.tracker,
      );

      if (proc.spawnError || proc.timedOut || proc.cancelled) {
        const failure = classifyProcessFailure(proc);
        input.onEvent?.({
          type: "error",
          provider: "codex",
          participantId: handle.participantId,
          outcome: failure.outcome,
          message: failure.message,
        });
        return {
          outcome: failure.outcome,
          text: "",
          continuationMode: handle.continuationMode,
          fallbackReason: handle.fallbackReason,
          elapsedMs: proc.elapsedMs,
          exitCode: proc.exitCode,
          stderr: proc.stderr,
          rawOutput: proc.stdout,
          errorMessage: failure.message,
        };
      }

      const parsed = parseCodexJsonl(proc.stdout);

      if (parsed.malformed) {
        const failure = classifyProcessFailure({
          exitCode: proc.exitCode,
          stdout: proc.stdout,
          stderr: proc.stderr,
        });
        const isLogin = failure.outcome === "login_required";
        const outcome = isLogin ? "login_required" : "malformed_output";
        const message = isLogin
          ? failure.message
          : "Codex CLI returned non-JSONL output";
        input.onEvent?.({
          type: "error",
          provider: "codex",
          participantId: handle.participantId,
          outcome,
          message,
        });
        return {
          outcome,
          text: "",
          continuationMode: handle.continuationMode,
          fallbackReason: handle.fallbackReason,
          elapsedMs: proc.elapsedMs,
          exitCode: proc.exitCode,
          stderr: proc.stderr,
          rawOutput: proc.stdout,
          errorMessage: message,
        };
      }

      if (proc.exitCode !== 0 || (parsed.errors.length > 0 && !parsed.text)) {
        const failure = classifyProcessFailure({
          exitCode: proc.exitCode,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage: parsed.errors.join("; ") || undefined,
        });
        input.onEvent?.({
          type: "error",
          provider: "codex",
          participantId: handle.participantId,
          outcome: failure.outcome,
          message: failure.message,
        });
        return {
          outcome: failure.outcome,
          text: parsed.text,
          providerSessionId: parsed.threadId ?? resumeSessionId,
          continuationMode: handle.continuationMode,
          fallbackReason: handle.fallbackReason,
          usage: parsed.usage,
          elapsedMs: proc.elapsedMs,
          exitCode: proc.exitCode,
          stderr: proc.stderr,
          rawOutput: proc.stdout,
          errorMessage: failure.message,
        };
      }

      if (!parsed.text.trim()) {
        return {
          outcome: "malformed_output",
          text: "",
          providerSessionId: parsed.threadId ?? resumeSessionId,
          continuationMode: handle.continuationMode,
          fallbackReason: handle.fallbackReason,
          usage: parsed.usage,
          elapsedMs: proc.elapsedMs,
          exitCode: proc.exitCode,
          stderr: proc.stderr,
          rawOutput: proc.stdout,
          errorMessage: "Codex completed without an agent_message response",
        };
      }

      const structuredCheck = resolveStructuredOutput(
        parsed.text,
        undefined,
        input.responseSchema,
      );
      if (!structuredCheck.ok) {
        return {
          outcome: "malformed_output",
          text: parsed.text,
          providerSessionId: parsed.threadId ?? resumeSessionId,
          continuationMode: handle.continuationMode,
          fallbackReason: handle.fallbackReason,
          usage: parsed.usage,
          elapsedMs: proc.elapsedMs,
          exitCode: proc.exitCode,
          stderr: proc.stderr,
          rawOutput: proc.stdout,
          errorMessage: structuredCheck.error,
        };
      }

      input.onEvent?.({
        type: "completed",
        provider: "codex",
        participantId: handle.participantId,
        outcome: "ok",
        usage: parsed.usage,
      });

      return {
        outcome: "ok",
        text: parsed.text,
        structured: structuredCheck.structured,
        providerSessionId: parsed.threadId ?? resumeSessionId,
        continuationMode: handle.continuationMode,
        fallbackReason: handle.fallbackReason,
        usage: parsed.usage,
        elapsedMs: proc.elapsedMs,
        exitCode: proc.exitCode,
        stderr: proc.stderr,
        rawOutput: proc.stdout,
      };
    } finally {
      if (schemaFile) {
        try {
          fs.unlinkSync(schemaFile);
        } catch {
          // Ignore temp cleanup failure
        }
      }
    }
  }

  private buildArgs(
    handle: ProviderSessionHandle,
    resumeSessionId: string | undefined,
    schemaFile: string | undefined,
  ): string[] {
    return buildCodexArgs(handle, resumeSessionId, schemaFile);
  }

  private parseLineForEvent(
    line: string,
    participantId: string,
  ): ProviderEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
        return {
          type: "session_started",
          provider: "codex",
          participantId,
          providerSessionId: obj.thread_id,
        };
      }
      if (
        (obj.type === "item.started" || obj.type === "item.completed") &&
        obj.item &&
        typeof obj.item === "object"
      ) {
        const item = obj.item as Record<string, unknown>;
        if (
          obj.type === "item.completed" &&
          item.type === "agent_message" &&
          typeof item.text === "string"
        ) {
          return {
            type: "text_delta",
            provider: "codex",
            participantId,
            text: item.text,
          };
        }
        if (item.type === "command_execution" && obj.type === "item.started") {
          return {
            type: "tool_use",
            provider: "codex",
            participantId,
            toolName: "command_execution",
            detail:
              typeof item.command === "string" ? item.command : undefined,
          };
        }
      }
    } catch {
      return null;
    }
    return null;
  }
}
