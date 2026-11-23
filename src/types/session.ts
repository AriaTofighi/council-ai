import type {
  EffectiveReadOnlyPolicy,
  ProviderId,
  ReasoningEffort,
  UsageInfo,
} from "./provider.js";
import type {
  AssignmentRecord,
  ContributionRecord,
  LeadAction,
  OrchestrationMode,
  ParticipantAddition,
  RoundtableOpeningPlan,
} from "./protocol.js";

export type ParticipantRole = "lead" | "teammate";

export interface ParticipantConfig {
  id: string;
  label: string;
  provider: ProviderId;
  role: ParticipantRole;
  executablePath?: string;
  model?: string;
  effort?: ReasoningEffort;
  extraInstructions?: string;
  privateContext?: string;
}

export interface ParticipantSummary {
  participantId: string;
  label: string;
  provider: ProviderId;
  role: ParticipantRole;
  executablePath: string;
  providerSessionId?: string;
  continuationMode: "native" | "transcript_fallback";
  fallbackReason?: string;
  model?: string;
  effort?: ReasoningEffort;
  turnCount: number;
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

export interface PriorTurnContribution {
  id: string;
  assignmentId: string;
  participantId: string;
  participantLabel: string;
  provider: ProviderId;
  kind: string;
  outcome: string;
  content: string;
}

export interface PriorTurnContext {
  turnIndex: number;
  userMessage: string;
  mode: OrchestrationMode;
  leadParticipantId: string;
  leadProvider: ProviderId;
  leadLabel: string;
  finalAnswer: string;
  userDecisions: string[];
  unresolvedIssues: string[];
  disagreements: string[];
  usedContributionIds: string[];
  contributions: PriorTurnContribution[];
}

/** Run budget. `null` on any numeric field means "no limit". */
export interface RunLimits {
  maxLeadCalls: number | null;
  maxTotalCalls: number | null;
  perCallTimeoutMs: number | null;
  hardDeadlineMs: number | null;
  reserveSynthesisCall: boolean;
}

/** RunLimits as the orchestrator uses them: "no limit" becomes Infinity. */
export interface EffectiveRunLimits {
  maxLeadCalls: number;
  maxTotalCalls: number;
  perCallTimeoutMs: number;
  hardDeadlineMs: number;
  reserveSynthesisCall: boolean;
}

export interface RunDiagnostic {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  participantId?: string;
  provider?: ProviderId;
  timestamp: string;
}

export type RunStatus =
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";

export type RunEvent =
  | {
      type: "run_started";
      runId: string;
      mode: OrchestrationMode;
      independentFirstOpinions?: boolean;
      lead: ParticipantConfig;
      teammates: ParticipantConfig[];
      prompt: string;
      snapshot?: WorkspaceSnapshotSummary;
    }
  | {
      type: "roundtable_opening_planned";
      runId: string;
      plan: RoundtableOpeningPlan;
    }
  | {
      type: "roundtable_turn_started";
      runId: string;
      round: number;
      participantId: string;
      participantLabel: string;
      provider: ProviderId;
      assignmentId: string;
      isBlind: boolean;
    }
  | {
      type: "roundtable_turn_completed";
      runId: string;
      round: number;
      assignment: AssignmentRecord;
      contribution: ContributionRecord;
    }
  | {
      type: "lead_thinking";
      runId: string;
      turn: number;
      participantId: string;
      provider: ProviderId;
      mustFinish: boolean;
    }
  | {
      type: "lead_action";
      runId: string;
      turn: number;
      action: LeadAction;
      elapsedMs: number;
      usage?: UsageInfo;
    }
  | {
      type: "assignment_started";
      runId: string;
      assignment: AssignmentRecord;
    }
  | {
      type: "assignment_completed";
      runId: string;
      assignment: AssignmentRecord;
      contribution: ContributionRecord;
    }
  | {
      type: "followup_started";
      runId: string;
      assignmentId: string;
      participantId: string;
      provider: ProviderId;
      question: string;
    }
  | {
      type: "followup_completed";
      runId: string;
      contribution: ContributionRecord;
    }
  | {
      type: "contribution_retrieved";
      runId: string;
      contributionId: string;
      found: boolean;
    }
  | {
      type: "session_fallback";
      runId: string;
      participantId: string;
      provider: ProviderId;
      reason: string;
    }
  | {
      type: "diagnostic";
      runId: string;
      diagnostic: RunDiagnostic;
    }
  | {
      /** What an agent is doing right now (tool calls, status, writing). Throttled. */
      type: "agent_activity";
      runId: string;
      participantId: string;
      provider: ProviderId;
      kind: "tool" | "status" | "writing" | "error";
      detail?: string;
    }
  | {
      /** A finished run is working again (retrying an assignment or re-synthesizing). */
      type: "run_resumed";
      runId: string;
      reason: "retry" | "synthesize";
      participantId?: string;
      assignmentId?: string;
    }
  | {
      type: "run_finished";
      runId: string;
      status: Exclude<RunStatus, "running">;
      elapsedMs: number;
    };

export interface LeadActionRecord {
  turn: number;
  action: LeadAction;
  elapsedMs: number;
  usage?: UsageInfo;
}

export interface DelegationRunResult {
  runId: string;
  mode: OrchestrationMode;
  independentFirstOpinions?: boolean;
  status: Exclude<RunStatus, "running">;
  finalAnswer: string;
  usedContributionIds: string[];
  unresolvedIssues: string[];
  participantSummaries: ParticipantAddition[];
  disagreements: string[];
  leadParticipant: ParticipantSummary;
  teammates: ParticipantSummary[];
  assignments: AssignmentRecord[];
  contributions: ContributionRecord[];
  leadActions: LeadActionRecord[];
  diagnostics: RunDiagnostic[];
  snapshot?: WorkspaceSnapshotSummary;
  roundtablePlan?: RoundtableOpeningPlan;
  elapsedMs: number;
  errorMessage?: string;
}
