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

export interface ParsedAgyOutput {
  conversationId?: string;
  status?: string;
  text: string;
  structuredOutput?: unknown;
  error?: string;
  usage?: UsageInfo;
  validObjects: number;
  malformed: boolean;
}

export function parseAgyOutput(stdout: string): ParsedAgyOutput {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let conversationId: string | undefined;
  let status: string | undefined;
  let responseText = "";
  let streamedDeltas = "";
  let structuredOutput: unknown;
  let error: string | undefined;
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

    if (obj.event === "init") {
      if (typeof obj.conversation_id === "string") {
        conversationId = obj.conversation_id;
      }
      continue;
    }

    if (
      obj.event === "step_update" &&
      obj.step_update &&
      typeof obj.step_update === "object"
    ) {
      const step = obj.step_update as Record<string, unknown>;
      if (typeof step.conversation_id === "string") {
        conversationId = step.conversation_id;
      }
      if (
        step.step_type === "agent_response" &&
        typeof step.text_delta === "string"
      ) {
        streamedDeltas += step.text_delta;
      }
      continue;
    }

    const resultObj =
      obj.event === "result" && obj.result && typeof obj.result === "object"
        ? (obj.result as Record<string, unknown>)
        : "status" in obj || "response" in obj || "conversation_id" in obj
          ? obj
          : undefined;

    if (resultObj) {
      if (
        typeof resultObj.conversation_id === "string" &&
        resultObj.conversation_id
      ) {
        conversationId = resultObj.conversation_id;
      }
      if (typeof resultObj.status === "string") {
        status = resultObj.status;
      }
      if (typeof resultObj.response === "string") {
        responseText = resultObj.response;
      }
      if (
        "structured_output" in resultObj &&
        resultObj.structured_output !== undefined
      ) {
        structuredOutput = resultObj.structured_output;
      }
      if (typeof resultObj.error === "string" && resultObj.error) {
        error = resultObj.error;
      }
      if (resultObj.usage && typeof resultObj.usage === "object") {
        usage = normalizeUsage(resultObj.usage as Record<string, unknown>);
      }
    }
  }

  const finalText =
    responseText ||
    streamedDeltas ||
    (structuredOutput !== undefined ? JSON.stringify(structuredOutput) : "");

  return {
    conversationId,
    status,
    text: finalText,
    structuredOutput,
    error,
    usage,
    validObjects,
    malformed: lines.length > 0 && validObjects === 0,
  };
}

const TIERED_AGY_SLUG_RE = /-(low|medium|high|xhigh|max)$/i;

export function buildAgyArgs(
  handle: Pick<
    ProviderSessionHandle,
    "readOnly" | "allowReadOnlyTools" | "model" | "effort"
  >,
  promptText: string,
  resumeConversationId: string | undefined,
  input: Pick<TurnInput, "timeoutMs" | "responseSchema">,
): string[] {
  const args = [
    `--print=${promptText}`,
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
  ];

  if (handle.readOnly) {
    const denyRules = handle.allowReadOnlyTools
      ? ["write_file(*)", "command(*)", "execute_url(*)", "mcp(*)"]
      : [
          "write_file(*)",
          "read_file(*)",
          "command(*)",
          "read_url(*)",
          "execute_url(*)",
          "mcp(*)",
        ];
    args.push(
      "--sandbox",
      "--settings",
      JSON.stringify({ permissions: { deny: denyRules } }),
    );
  }

  if (input.timeoutMs > 0) {
    const seconds = Math.max(1, Math.ceil(input.timeoutMs / 1000));
    args.push("--print-timeout", `${seconds}s`);
  }

  if (handle.model) {
    args.push("--model", handle.model);
  }

  if (
    handle.effort &&
    !(handle.model && TIERED_AGY_SLUG_RE.test(handle.model))
  ) {
    args.push("--effort", handle.effort);
  }

  if (resumeConversationId) {
    args.push("--conversation", resumeConversationId);
  }

  if (input.responseSchema) {
    args.push("--json-schema", JSON.stringify(input.responseSchema));
  }

  return args;
}

export class AgyAdapter implements ProviderAdapter {
  readonly id = "agy" as const;
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
      "agy",
      options.executablePath,
    );
    if (!discovery.executablePath) {
      throw new Error(
        `Antigravity CLI (agy) executable not found (checked: ${discovery.candidatesChecked.join(", ")})`,
      );
    }

    return {
      participantId: options.participantId,
      provider: "agy",
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
      executeOnce: (promptPayload, resumeConversationId) =>
        this.executeOnce(handle, promptPayload, resumeConversationId, input),
    });
  }

  cancel(participantId: string): boolean {
    return this.tracker.cancel(participantId);
  }

  private async executeOnce(
    handle: ProviderSessionHandle,
    promptText: string,
    resumeConversationId: string | undefined,
    input: TurnInput,
  ): Promise<TurnResult> {
    const args = this.buildArgs(
      handle,
      promptText,
      resumeConversationId,
      input,
    );

    let seenSessionStart = false;
    const proc = await runCliProcess(
      {
        command: handle.executablePath,
        args,
        cwd: handle.cwd,
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
        provider: "agy",
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

    const parsed = parseAgyOutput(proc.stdout);

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
        : "Antigravity CLI returned non-JSON output";
      input.onEvent?.({
        type: "error",
        provider: "agy",
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

    if (parsed.status === "CANCELED" || parsed.status === "INTERRUPTED") {
      return {
        outcome: "cancelled",
        text: parsed.text,
        providerSessionId: parsed.conversationId ?? resumeConversationId,
        continuationMode: handle.continuationMode,
        fallbackReason: handle.fallbackReason,
        usage: parsed.usage,
        elapsedMs: proc.elapsedMs,
        exitCode: proc.exitCode,
        stderr: proc.stderr,
        rawOutput: proc.stdout,
        errorMessage: parsed.error ?? `Antigravity run ${parsed.status}`,
      };
    }

    const failedStatus =
      parsed.status !== undefined && parsed.status !== "SUCCESS";

    if (proc.exitCode !== 0 || failedStatus) {
      const failure = classifyProcessFailure({
        exitCode: proc.exitCode,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage: parsed.error,
      });
      input.onEvent?.({
        type: "error",
        provider: "agy",
        participantId: handle.participantId,
        outcome: failure.outcome,
        message: failure.message,
      });
      return {
        outcome: failure.outcome,
        text: parsed.text,
        providerSessionId: parsed.conversationId ?? resumeConversationId,
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
        providerSessionId: parsed.conversationId ?? resumeConversationId,
        continuationMode: handle.continuationMode,
        fallbackReason: handle.fallbackReason,
        usage: parsed.usage,
        elapsedMs: proc.elapsedMs,
        exitCode: proc.exitCode,
        stderr: proc.stderr,
        rawOutput: proc.stdout,
        errorMessage: "Antigravity CLI completed without a response",
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
        providerSessionId: parsed.conversationId ?? resumeConversationId,
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
      provider: "agy",
      participantId: handle.participantId,
      outcome: "ok",
      usage: parsed.usage,
    });

    return {
      outcome: "ok",
      text: parsed.text,
      structured: structuredCheck.structured,
      providerSessionId: parsed.conversationId ?? resumeConversationId,
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
    promptText: string,
    resumeConversationId: string | undefined,
    input: TurnInput,
  ): string[] {
    return buildAgyArgs(handle, promptText, resumeConversationId, input);
  }

  private parseLineForEvent(
    line: string,
    participantId: string,
  ): ProviderEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.event === "init" && typeof obj.conversation_id === "string") {
        return {
          type: "session_started",
          provider: "agy",
          participantId,
          providerSessionId: obj.conversation_id,
        };
      }
      if (
        obj.event === "step_update" &&
        obj.step_update &&
        typeof obj.step_update === "object"
      ) {
        const step = obj.step_update as Record<string, unknown>;
        if (step.step_type === "tool" && typeof step.tool_name === "string") {
          return {
            type: "tool_use",
            provider: "agy",
            participantId,
            toolName: step.tool_name,
          };
        }
        if (
          step.step_type === "agent_response" &&
          typeof step.text_delta === "string" &&
          step.text_delta.length > 0
        ) {
          return {
            type: "text_delta",
            provider: "agy",
            participantId,
            text: step.text_delta,
          };
        }
      }
    } catch {
      return null;
    }
    return null;
  }
}
