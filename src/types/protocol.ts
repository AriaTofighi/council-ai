import type { OutcomeKind, ProviderId, UsageInfo } from "./provider.js";

export type OrchestrationMode = "divide_conquer" | "roundtable";

export interface DelegateAssignmentSpec {
  participant_id: string;
  title: string;
  task: string;
  context_notes: string | null;
}

export interface FollowUpSpec {
  participant_id: string;
  assignment_id: string;
  question: string;
}

export interface ParticipantAddition {
  participant_id: string;
  added: string;
}

export interface RoundtableOpeningPlan {
  opening_participant_id: string;
  discussion_order: string[];
  framing_note: string | null;
}

export type LeadAction =
  | {
      action: "delegate";
      assignments: DelegateAssignmentSpec[];
      follow_up: null;
      retrieve_contribution_id: null;
      final_answer: null;
      used_contribution_ids: null;
      unresolved_issues: null;
      participant_summaries: null;
      disagreements: null;
    }
  | {
      action: "follow_up";
      assignments: null;
      follow_up: FollowUpSpec;
      retrieve_contribution_id: null;
      final_answer: null;
      used_contribution_ids: null;
      unresolved_issues: null;
      participant_summaries: null;
      disagreements: null;
    }
  | {
      action: "retrieve_contribution";
      assignments: null;
      follow_up: null;
      retrieve_contribution_id: string;
      final_answer: null;
      used_contribution_ids: null;
      unresolved_issues: null;
      participant_summaries: null;
      disagreements: null;
    }
  | {
      action: "finish";
      assignments: null;
      follow_up: null;
      retrieve_contribution_id: null;
      final_answer: string;
      used_contribution_ids: string[];
      unresolved_issues: string[];
      participant_summaries: ParticipantAddition[];
      disagreements: string[];
    };

export type AssignmentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface AssignmentRecord {
  id: string;
  participantId: string;
  participantLabel: string;
  provider: ProviderId;
  title: string;
  task: string;
  contextNotes?: string;
  status: AssignmentStatus;
  acceptedContributionId?: string;
  createdAt: string;
  completedAt?: string;
}

export type ContributionKind =
  | "initial_report"
  | "follow_up_reply"
  | "opening_position"
  | "independent_opening"
  | "roundtable_turn"
  | "failure";

export interface ContributionRecord {
  id: string;
  assignmentId: string;
  participantId: string;
  participantLabel: string;
  provider: ProviderId;
  providerSessionId?: string;
  continuationMode: "native" | "transcript_fallback";
  fallbackReason?: string;
  kind: ContributionKind;
  promptSent: string;
  outcome: OutcomeKind;
  content: string;
  errorMessage?: string;
  usage?: UsageInfo;
  elapsedMs: number;
  supersededBy?: string;
  createdAt: string;
}
