export type ProviderId = "codex" | "claude" | "agy";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderModelOption {
  id: string;
  label: string;
  provider: ProviderId;
  /** Thinking levels the CLI accepts for this model, lowest first. Empty = no --effort allowed. */
  efforts: ReasoningEffort[];
  /** Level the CLI uses when none is passed, if it reports one. */
  defaultEffort?: ReasoningEffort;
  supportsEffort: boolean;
  isFast?: boolean;
}

export interface EffectiveReadOnlyPolicy {
  provider: ProviderId;
  sandboxSummary: string;
  allowedOperations: string[];
  blockedOperations: string[];
  flags: string[];
}

export type OutcomeKind =
  | "ok"
  | "missing_executable"
  | "login_required"
  | "timeout"
  | "cancelled"
  | "malformed_output"
  | "execution_error";

export type ExecutableSource =
  | "override"
  | "env"
  | "path"
  | "macos-app-bundle"
  | "not-found";

export interface ExecutableDiscovery {
  provider: ProviderId;
  executablePath: string | null;
  source: ExecutableSource;
  version?: string;
  candidatesChecked: string[];
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  thinkingTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  raw?: Record<string, unknown>;
}

export type ProviderEvent =
  | {
      type: "session_started";
      provider: ProviderId;
      participantId: string;
      providerSessionId: string;
    }
  | {
      type: "status";
      provider: ProviderId;
      participantId: string;
      message: string;
    }
  | {
      type: "text_delta";
      provider: ProviderId;
      participantId: string;
      text: string;
    }
  | {
      type: "tool_use";
      provider: ProviderId;
      participantId: string;
      toolName: string;
      detail?: string;
    }
  | {
      type: "completed";
      provider: ProviderId;
      participantId: string;
      outcome: OutcomeKind;
      usage?: UsageInfo;
    }
  | {
      type: "error";
      provider: ProviderId;
      participantId: string;
      outcome: OutcomeKind;
      message: string;
    }
  | {
      type: "fallback_triggered";
      provider: ProviderId;
      participantId: string;
      reason: string;
    };

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface ProviderSessionHandle {
  participantId: string;
  provider: ProviderId;
  executablePath: string;
  providerSessionId?: string;
  continuationMode: "native" | "transcript_fallback";
  fallbackReason?: string;
  systemPrompt: string;
  cwd: string;
  readOnly: boolean;
  allowReadOnlyTools: boolean;
  model?: string;
  effort?: ReasoningEffort;
  turnCount: number;
  history: HistoryMessage[];
}

export interface TurnInput {
  prompt: string;
  responseSchema?: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: ProviderEvent) => void;
}

export interface TurnResult {
  outcome: OutcomeKind;
  text: string;
  structured?: unknown;
  providerSessionId?: string;
  continuationMode: "native" | "transcript_fallback";
  fallbackReason?: string;
  usage?: UsageInfo;
  elapsedMs: number;
  exitCode?: number | null;
  stderr?: string;
  rawOutput?: string;
  errorMessage?: string;
}

export interface ProviderCheckOptions {
  executablePath?: string;
  cwd?: string;
  prompt?: string;
  timeoutMs?: number;
  skipLive?: boolean;
  model?: string;
  effort?: ReasoningEffort;
}

export interface ProviderCheckResult {
  provider: ProviderId;
  discovery: ExecutableDiscovery;
  outcome: OutcomeKind;
  responseText?: string;
  providerSessionId?: string;
  continuationMode?: "native" | "transcript_fallback";
  usage?: UsageInfo;
  elapsedMs: number;
  errorMessage?: string;
  details?: string;
}

export interface StartSessionOptions {
  participantId: string;
  executablePath?: string;
  systemPrompt: string;
  cwd: string;
  readOnly?: boolean;
  allowReadOnlyTools?: boolean;
  model?: string;
  effort?: ReasoningEffort;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  checkAvailability(options?: ProviderCheckOptions): Promise<ProviderCheckResult>;
  startSession(options: StartSessionOptions): Promise<ProviderSessionHandle>;
  sendTurn(handle: ProviderSessionHandle, input: TurnInput): Promise<TurnResult>;
  cancel(participantId: string): boolean;
}
