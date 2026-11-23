import type { OutcomeKind } from "../types/provider.js";

const LOGIN_PATTERNS: RegExp[] = [
  /\bnot logged in\b/i,
  /\blogin required\b/i,
  /\bplease log in\b/i,
  /\bauthentication required\b/i,
  /\bauthentication failed\b/i,
  /\bunauthenticated\b/i,
  /\bunauthorized\b/i,
  /\binvalid api key\b/i,
  /\bmissing api key\b/i,
  /\bapi key\b.*\b(not set|missing|invalid|required)\b/i,
  /\bHTTP\s*401\b|\bstatus(?:\s+code)?\s*401\b|\b401 Unauthorized\b/i,
  /\boauth\b.*\b(expired|invalid|failed|required|token|login)\b/i,
  /\bcredentials?\b.*\b(missing|expired|invalid|not found|required)\b/i,
  /\brun\b.*\b(login|auth)\b/i,
  /\bsign in\b.*\b(browser|account|cli|required|again)\b/i,
  /\bauth(?:entication)?\s+token\b.*\b(expired|invalid|missing|required)\b/i,
];

export interface FailureClassificationInput {
  spawnError?: NodeJS.ErrnoException;
  timedOut?: boolean;
  cancelled?: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
}

export interface FailureClassification {
  outcome: Exclude<OutcomeKind, "ok" | "malformed_output">;
  message: string;
}

export function isLoginErrorText(text: string): boolean {
  return LOGIN_PATTERNS.some((pattern) => pattern.test(text));
}

function summarizeErrorText(
  errorMessage?: string,
  stderr?: string,
  stdout?: string,
  exitCode?: number | null,
): string {
  const candidates = [errorMessage, stderr, stdout]
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .map((value) => value.trim());

  if (candidates.length > 0) {
    const first = candidates[0]!;
    return first.length > 600 ? `${first.slice(0, 600)}...` : first;
  }

  return exitCode !== null && exitCode !== undefined
    ? `Process exited with code ${exitCode}`
    : "Process failed without diagnostic output";
}

export function classifyProcessFailure(
  input: FailureClassificationInput,
): FailureClassification {
  if (input.spawnError) {
    const code = input.spawnError.code;
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") {
      return {
        outcome: "missing_executable",
        message: input.spawnError.message,
      };
    }
    return {
      outcome: "execution_error",
      message: input.spawnError.message,
    };
  }

  if (input.cancelled) {
    return {
      outcome: "cancelled",
      message: "Invocation cancelled",
    };
  }

  if (input.timedOut) {
    return {
      outcome: "timeout",
      message: "Invocation timed out",
    };
  }

  const combined = [input.errorMessage, input.stderr, input.stdout]
    .filter(Boolean)
    .join("\n");

  if (isLoginErrorText(combined)) {
    return {
      outcome: "login_required",
      message: summarizeErrorText(
        input.errorMessage,
        input.stderr,
        input.stdout,
        input.exitCode,
      ),
    };
  }

  return {
    outcome: "execution_error",
    message: summarizeErrorText(
      input.errorMessage,
      input.stderr,
      input.stdout,
      input.exitCode,
    ),
  };
}

export type JsonExtractResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function extractJsonObject(raw: string): JsonExtractResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "Empty output where JSON was expected" };
  }

  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // Try fenced code block extraction next
  }

  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return { ok: true, value: JSON.parse(fenceMatch[1].trim()) };
    } catch {
      // Continue to brace scan
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return { ok: true, value: JSON.parse(slice) };
    } catch (err) {
      return {
        ok: false,
        error: `Malformed JSON output: ${(err as Error).message}`,
      };
    }
  }

  return { ok: false, error: "Output did not contain valid JSON" };
}
