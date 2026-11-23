import crypto from "node:crypto";
import type {
  ExecutableDiscovery,
  OutcomeKind,
  ProviderAdapter,
  ProviderCheckOptions,
  ProviderCheckResult,
  ProviderId,
  ProviderSessionHandle,
  TurnInput,
  TurnResult,
  UsageInfo,
} from "../types/provider.js";
import { extractJsonObject } from "./classify.js";

export function composeInitialPrompt(
  systemPrompt: string,
  userPrompt: string,
): string {
  const sys = systemPrompt.trim();
  if (!sys) return userPrompt;
  return `<system_instructions>\n${sys}\n</system_instructions>\n\n${userPrompt}`;
}

export function formatTranscriptFallbackPrompt(
  handle: ProviderSessionHandle,
  nextPrompt: string,
): string {
  const parts: string[] = [];
  if (handle.systemPrompt.trim()) {
    parts.push(
      `<system_instructions>\n${handle.systemPrompt.trim()}\n</system_instructions>`,
    );
  }
  if (handle.history.length > 0) {
    parts.push("<prior_conversation_transcript>");
    for (const msg of handle.history) {
      const label = msg.role === "user" ? "USER" : "ASSISTANT";
      parts.push(`[${label} @ ${msg.timestamp}]\n${msg.content}`);
    }
    parts.push("</prior_conversation_transcript>");
  }
  parts.push(`<current_turn>\n${nextPrompt}\n</current_turn>`);
  return parts.join("\n\n");
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function normalizeUsage(
  raw: Record<string, unknown> | undefined,
  costUsd?: number,
): UsageInfo | undefined {
  if (!raw && costUsd === undefined) return undefined;
  const r = raw ?? {};
  const inputTokens = asNumber(r.input_tokens);
  const outputTokens = asNumber(r.output_tokens);
  const cachedInputTokens =
    asNumber(r.cached_input_tokens) ??
    asNumber(r.cache_read_tokens) ??
    asNumber(r.cache_read_input_tokens);
  const thinkingTokens = asNumber(r.thinking_tokens);
  const totalTokens =
    asNumber(r.total_tokens) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);

  const resolvedCost = costUsd ?? asNumber(r.total_cost_usd);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    thinkingTokens === undefined &&
    totalTokens === undefined &&
    resolvedCost === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    thinkingTokens,
    totalTokens,
    costUsd: resolvedCost,
    raw: raw ? { ...raw } : undefined,
  };
}

export function resolveStructuredOutput(
  text: string,
  preParsed: unknown,
  responseSchema?: Record<string, unknown>,
): { ok: true; structured: unknown } | { ok: false; error: string } {
  if (!responseSchema) {
    return { ok: true, structured: preParsed };
  }
  if (
    preParsed !== undefined &&
    preParsed !== null &&
    typeof preParsed === "object"
  ) {
    return { ok: true, structured: preParsed };
  }
  const extracted = extractJsonObject(text);
  if (!extracted.ok) {
    return extracted;
  }
  return { ok: true, structured: extracted.value };
}

export function shouldAttemptTranscriptFallback(
  handle: ProviderSessionHandle,
  result: TurnResult,
): boolean {
  if (handle.turnCount === 0 || !handle.providerSessionId) {
    return false;
  }
  if (handle.continuationMode === "transcript_fallback") {
    return false;
  }
  return (
    result.outcome === "execution_error" ||
    result.outcome === "malformed_output"
  );
}

export function recordTurnHistory(
  handle: ProviderSessionHandle,
  prompt: string,
  result: TurnResult,
): void {
  if (result.outcome !== "ok") return;
  const now = new Date().toISOString();
  handle.history.push(
    { role: "user", content: prompt, timestamp: now },
    { role: "assistant", content: result.text, timestamp: now },
  );
  handle.turnCount += 1;
  if (result.providerSessionId) {
    handle.providerSessionId = result.providerSessionId;
  }
}

export function isTerminalUserOrInfraFailure(outcome: OutcomeKind): boolean {
  return (
    outcome === "missing_executable" ||
    outcome === "login_required" ||
    outcome === "timeout" ||
    outcome === "cancelled"
  );
}

export async function runProviderAvailabilityCheck(
  adapter: ProviderAdapter,
  discover: (
    provider: ProviderId,
    overridePath?: string,
  ) => Promise<ExecutableDiscovery>,
  options: ProviderCheckOptions = {},
): Promise<ProviderCheckResult> {
  const startTime = Date.now();
  const discovery = await discover(adapter.id, options.executablePath);

  if (!discovery.executablePath) {
    return {
      provider: adapter.id,
      discovery,
      outcome: "missing_executable",
      elapsedMs: Date.now() - startTime,
      errorMessage: `${adapter.id} executable not found (checked: ${discovery.candidatesChecked.join(", ")})`,
    };
  }

  if (options.skipLive) {
    return {
      provider: adapter.id,
      discovery,
      outcome: "ok",
      elapsedMs: Date.now() - startTime,
      details: "Executable discovered (live check skipped)",
    };
  }

  const handle = await adapter.startSession({
    participantId: `check-${adapter.id}-${crypto.randomUUID().slice(0, 8)}`,
    executablePath: discovery.executablePath,
    systemPrompt:
      "You are verifying CLI connectivity. Reply concisely as instructed.",
    cwd: options.cwd ?? process.cwd(),
    readOnly: true,
    allowReadOnlyTools: false,
    model: options.model,
    effort: options.effort,
  });

  const prompt =
    options.prompt ??
    "Connectivity test: reply with exactly 'COUNCIL_OK' and one short sentence confirming you are ready.";

  const turn = await adapter.sendTurn(handle, {
    prompt,
    timeoutMs: options.timeoutMs ?? 45_000,
  });

  return {
    provider: adapter.id,
    discovery,
    outcome: turn.outcome,
    responseText: turn.text || undefined,
    providerSessionId: turn.providerSessionId,
    continuationMode: turn.continuationMode,
    usage: turn.usage,
    elapsedMs: Date.now() - startTime,
    errorMessage: turn.errorMessage,
  };
}

export async function sendTurnWithFallback(
  handle: ProviderSessionHandle,
  input: TurnInput,
  options: {
    composeTurn1WithSystem: boolean;
    executeOnce: (
      promptPayload: string,
      resumeSessionId: string | undefined,
    ) => Promise<TurnResult>;
  },
): Promise<TurnResult> {
  const isNativeResume =
    handle.turnCount > 0 &&
    Boolean(handle.providerSessionId) &&
    handle.continuationMode === "native";

  let promptPayload: string;
  if (isNativeResume) {
    promptPayload = input.prompt;
  } else if (handle.turnCount === 0) {
    promptPayload = options.composeTurn1WithSystem
      ? composeInitialPrompt(handle.systemPrompt, input.prompt)
      : input.prompt;
  } else {
    promptPayload = formatTranscriptFallbackPrompt(handle, input.prompt);
  }

  const firstAttempt = await options.executeOnce(
    promptPayload,
    isNativeResume ? handle.providerSessionId : undefined,
  );

  if (firstAttempt.outcome === "ok") {
    recordTurnHistory(handle, input.prompt, firstAttempt);
    return firstAttempt;
  }

  if (shouldAttemptTranscriptFallback(handle, firstAttempt)) {
    const reason =
      firstAttempt.errorMessage ??
      `Native ${handle.provider} session resume failed (${firstAttempt.outcome})`;
    handle.continuationMode = "transcript_fallback";
    handle.fallbackReason = reason;
    input.onEvent?.({
      type: "fallback_triggered",
      provider: handle.provider,
      participantId: handle.participantId,
      reason,
    });

    const fallbackPrompt = formatTranscriptFallbackPrompt(handle, input.prompt);
    const retry = await options.executeOnce(fallbackPrompt, undefined);
    retry.continuationMode = "transcript_fallback";
    retry.fallbackReason = reason;
    if (retry.outcome === "ok") {
      recordTurnHistory(handle, input.prompt, retry);
    }
    return retry;
  }

  return firstAttempt;
}
