export type ProviderId = "codex" | "claude" | "agy";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type OrchestrationMode = "divide_conquer" | "roundtable";
export type RunStatus =
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface ProviderModelOption {
  id: string;
  label: string;
  provider: ProviderId;
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

export interface ProviderCatalogEntry {
  id: ProviderId;
  discovery: {
    provider: ProviderId;
    executablePath: string | null;
    source: string;
    version?: string;
  };
  models: ProviderModelOption[];
  efforts: ReasoningEffort[];
  readOnlyPolicies: {
    withTools: EffectiveReadOnlyPolicy;
    withoutTools: EffectiveReadOnlyPolicy;
  };
}

export interface ProviderCheckResult {
  provider: ProviderId;
  discovery: {
    executablePath: string | null;
    source: string;
    version?: string;
  };
  outcome: string;
  responseText?: string;
  providerSessionId?: string;
  elapsedMs: number;
  errorMessage?: string;
}

export interface WorkspaceInspection {
  sourcePath: string;
  isGitRepo: boolean;
  gitBranch?: string;
  gitCommit?: string;
  gitDirty?: boolean;
  files: Array<{ path: string; sizeBytes: number }>;
  totalBytes: number;
  truncated: boolean;
}

export interface WorkspaceSnapshotSummary {
  id: string;
  sourcePath: string;
  snapshotPath: string;
  digest: string;
  fileCount: number;
  totalBytes: number;
  gitBranch?: string;
  gitCommit?: string;
  gitDirty?: boolean;
  filesPreview: string[];
  providersReceivingMaterial: ProviderId[];
  effectivePermissions: EffectiveReadOnlyPolicy[];
  createdAt: string;
}

export interface ParticipantSpec {
  id?: string;
  provider: ProviderId;
  label: string;
  model?: string;
  effort?: ReasoningEffort;
}

export interface ParticipantSummary {
  participantId: string;
  label: string;
  provider: ProviderId;
  role: "lead" | "teammate";
  executablePath: string;
  providerSessionId?: string;
  continuationMode: "native" | "transcript_fallback";
  fallbackReason?: string;
  model?: string;
  effort?: ReasoningEffort;
  turnCount: number;
}

export interface AssignmentRecord {
  id: string;
  participantId: string;
  participantLabel: string;
  provider: ProviderId;
  title: string;
  task: string;
  contextNotes?: string;
  status: "pending" | "running" | "completed" | "failed" | "interrupted";
  acceptedContributionId?: string;
  createdAt: string;
  completedAt?: string;
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  thinkingTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface ContributionRecord {
  id: string;
  assignmentId: string;
  participantId: string;
  participantLabel: string;
  provider: ProviderId;
  providerSessionId?: string;
  continuationMode: "native" | "transcript_fallback";
  fallbackReason?: string;
  kind: string;
  promptSent: string;
  outcome: string;
  content: string;
  errorMessage?: string;
  usage?: UsageInfo;
  elapsedMs: number;
  supersededBy?: string;
  createdAt: string;
}

export interface HydratedRun {
  id: string;
  chatId: string;
  turnIndex: number;
  userMessage: string;
  mode: OrchestrationMode;
  independentFirstOpinions: boolean;
  status: RunStatus;
  leadConfig: {
    id: string;
    label: string;
    provider: ProviderId;
    model?: string;
    effort?: ReasoningEffort;
  };
  teammatesConfig: Array<{
    id: string;
    label: string;
    provider: ProviderId;
    model?: string;
    effort?: ReasoningEffort;
  }>;
  allowReadOnlyTools: boolean;
  snapshot?: WorkspaceSnapshotSummary;
  finalAnswer?: string;
  usedContributionIds: string[];
  unresolvedIssues: string[];
  participantSummaries: Array<{ participant_id: string; added: string }>;
  disagreements: string[];
  diagnostics: Array<{
    level: "info" | "warn" | "error";
    code: string;
    message: string;
    participantId?: string;
    provider?: ProviderId;
    timestamp: string;
  }>;
  participants: ParticipantSummary[];
  assignments: AssignmentRecord[];
  contributions: ContributionRecord[];
  errorMessage?: string;
  elapsedMs?: number;
  createdAt: string;
  completedAt?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  workspacePath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredRunEvent {
  seq: number;
  runId: string;
  event: {
    type: string;
    [key: string]: unknown;
  };
  createdAt: string;
}
