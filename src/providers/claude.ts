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

export interface ParsedClaudeOutput {
  sessionId?: string;
  text: string;
  structuredOutput?: unknown;
  isError: boolean;
  errors: string[];
  usage?: UsageInfo;
  validObjects: number;
  malformed: boolean;
}

function extractTextFromAssistantMessage(
  message: Record<string, unknown>,
): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      parts.push((block as Record<string, unknown>).text as string);
    }
  }
  return parts.join("");
}

export function parseClaudeOutput(stdout: string): ParsedClaudeOutput {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let sessionId: string | undefined;
  let resultText = "";
  let assistantText = "";
  let structuredOutput: unknown;
  let isError = false;
  const errors: string[] = [];
  let usage: UsageInfo | undefined;
  let validObjects = 0;

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    validObjects += 1;

    if (typeof obj.session_id === "string" && obj.session_id.length > 0) {
      sessionId = obj.session_id;
    }

    if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
      const msg = obj.message as Record<string, unknown>;
      const extracted = extractTextFromAssistantMessage(msg);
      if (extracted) assistantText = extracted;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block &&
            typeof block === "object" &&
            (block as Record<string, unknown>).type === "tool_use" &&
            (block as Record<string, unknown>).name === "StructuredOutput" &&
            (block as Record<string, unknown>).input &&
            typeof (block as Record<string, unknown>).input === "object"
          ) {
            structuredOutput = (block as Record<string, unknown>).input;
          }
        }
      }
    }

    if (
      obj.type === "result" ||
      "is_error" in obj ||
      "result" in obj ||
      "structured_output" in obj
    ) {
      if (typeof obj.is_error === "boolean") {
        isError = obj.is_error;
      }
      if (typeof obj.result === "string") {
        resultText = obj.result;
      }
      if ("structured_output" in obj && obj.structured_output !== undefined) {
        structuredOutput = obj.structured_output;
      }
      if (Array.isArray(obj.errors)) {
        for (const err of obj.errors) {
          if (typeof err === "string") errors.push(err);
        }
      }
      if (isError && typeof obj.result === "string" && obj.result.trim()) {
        errors.push(obj.result);
      }
      const rawUsage =
        obj.usage && typeof obj.usage === "object"
          ? (obj.usage as Record<string, unknown>)
          : undefined;
      const costUsd =
        typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined;
      usage = normalizeUsage(rawUsage, costUsd) ?? usage;
    }
  }

  const finalText =
    resultText ||
    assistantText ||
    (structuredOutput !== undefined ? JSON.stringify(structuredOutput) : "");

  return {
    sessionId,
    text: finalText,
    structuredOutput,
    isError,
    errors,
    usage,
    validObjects,
    malformed: lines.length > 0 && validObjects === 0,
  };
}

export function buildClaudeArgs(
  handle: Pick<
    ProviderSessionHandle,
    "readOnly" | "allowReadOnlyTools" | "model" | "effort" | "systemPrompt"
  >,
  resumeSessionId: string | undefined,
  generatedSessionId: string | undefined,
  responseSchema: Record<string, unknown> | undefined,
): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
  ];

  if (handle.readOnly) {
    args.push("--restricted", "--strict-mcp-config");
    if (handle.allowReadOnlyTools) {
      args.push(
        "--disallowedTools",
        "Bash,PowerShell,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch",
      );
    } else {
      args.push(
        "--disallowedTools",
        "Bash,PowerShell,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch",
      );
      if (!responseSchema) {
        args.push("--tools", "");
      }
    }
  }

  if (handle.model) {
    args.push("--model", handle.model);
  }

  if (handle.effort) {
    args.push("--effort", handle.effort);
  }

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  } else {
    if (generatedSessionId) {
      args.push("--session-id", generatedSessionId);
    }
    if (handle.systemPrompt.trim()) {
      args.push("--append-system-prompt", handle.systemPrompt);
    }
  }

  if (responseSchema) {
    args.push("--json-schema", JSON.stringify(responseSchema));
  }

  return args;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
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
      "claude",
      options.executablePath,
    );
    if (!discovery.executablePath) {
      throw new Error(
        `Claude executable not found (checked: ${discovery.candidatesChecked.join(", ")})`,
      );
    }

    return {
      participantId: options.participantId,
      provider: "claude",
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
      composeTurn1WithSystem: false,
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
    const generatedSessionId = resumeSessionId ? undefined : crypto.randomUUID();
    const args = this.buildArgs(
      handle,
      resumeSessionId,
      generatedSessionId,
      input.responseSchema,
    );

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    let seenSessionStart = false;
    const proc = await runCliProcess(
      {
        command: handle.executablePath,
        args,
        cwd: handle.cwd,
        env,
        stdin: stdinPrompt,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        processKey: handle.participantId,
        onStdoutLine: (line) => {
          if (!input.onEvent) return;
          const events = this.parseLineForEvents(line, handle.participantId);
          for (const evt of events) {
            if (evt.type === "session_started") {
              if (seenSessionStart) continue;
              seenSessionStart = true;
            }
            input.onEvent(evt);
          }
        },
      },
      this.tracker,
    );

    if (proc.spawnError || proc.timedOut || proc.cancelled) {
      const failure = classifyProcessFailure(proc);
      input.onEvent?.({
        type: "error",
        provider: "claude",
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

    const parsed = parseClaudeOutput(proc.stdout);

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
        : "Claude Code CLI returned non-JSON output";
      input.onEvent?.({
        type: "error",
        provider: "claude",
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

    if (proc.exitCode !== 0 || parsed.isError) {
      const failure = classifyProcessFailure({
        exitCode: proc.exitCode,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage: parsed.errors.join("; ") || undefined,
      });
      input.onEvent?.({
        type: "error",
        provider: "claude",
        participantId: handle.participantId,
        outcome: failure.outcome,
        message: failure.message,
      });
      return {
        outcome: failure.outcome,
        text: parsed.text,
        providerSessionId:
          parsed.sessionId ?? resumeSessionId ?? generatedSessionId,
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

    if (!parsed.text.trim() && parsed.structuredOutput === undefined) {
      return {
        outcome: "malformed_output",
        text: "",
        providerSessionId:
          parsed.sessionId ?? resumeSessionId ?? generatedSessionId,
        continuationMode: handle.continuationMode,
        fallbackReason: handle.fallbackReason,
        usage: parsed.usage,
        elapsedMs: proc.elapsedMs,
        exitCode: proc.exitCode,
        stderr: proc.stderr,
        rawOutput: proc.stdout,
        errorMessage: "Claude Code completed without a result or response text",
      };
    }

    const structuredCheck = resolveStructuredOutput(
      parsed.text,
      parsed.structuredOutput,
      input.responseSchema,
    );
    if (!structuredCheck.ok) {
      return {
        outcome: "malformed_output",
        text: parsed.text,
        providerSessionId:
          parsed.sessionId ?? resumeSessionId ?? generatedSessionId,
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
      provider: "claude",
      participantId: handle.participantId,
      outcome: "ok",
      usage: parsed.usage,
    });

    return {
      outcome: "ok",
      text: parsed.text,
      structured: structuredCheck.structured,
      providerSessionId:
        parsed.sessionId ?? resumeSessionId ?? generatedSessionId,
      continuationMode: handle.continuationMode,
      fallbackReason: handle.fallbackReason,
      usage: parsed.usage,
      elapsedMs: proc.elapsedMs,
      exitCode: proc.exitCode,
      stderr: proc.stderr,
      rawOutput: proc.stdout,
    };
  }

  private buildArgs(
    handle: ProviderSessionHandle,
    resumeSessionId: string | undefined,
    generatedSessionId: string | undefined,
    responseSchema: Record<string, unknown> | undefined,
  ): string[] {
    return buildClaudeArgs(
      handle,
      resumeSessionId,
      generatedSessionId,
      responseSchema,
    );
  }

  private parseLineForEvents(
    line: string,
    participantId: string,
  ): ProviderEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const events: ProviderEvent[] = [];
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.session_id === "string" && obj.session_id.length > 0) {
        events.push({
          type: "session_started",
          provider: "claude",
          participantId,
          providerSessionId: obj.session_id,
        });
      }
      if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
        const msg = obj.message as Record<string, unknown>;
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            if (b.type === "tool_use" && typeof b.name === "string") {
              events.push({
                type: "tool_use",
                provider: "claude",
                participantId,
                toolName: b.name,
              });
            } else if (b.type === "text" && typeof b.text === "string" && b.text) {
              events.push({
                type: "text_delta",
                provider: "claude",
                participantId,
                text: b.text,
              });
            }
          }
        }
      }
    } catch {
      return [];
    }
    return events;
  }
}
