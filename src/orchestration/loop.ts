import crypto from "node:crypto";
import { extractJsonObject } from "../providers/classify.js";
import {
  createDefaultAdapters,
  type AdapterRegistry,
} from "../providers/registry.js";
import type { ProviderEvent, TurnResult, UsageInfo } from "../types/provider.js";
import type {
  AssignmentRecord,
  ContributionRecord,
  DelegateAssignmentSpec,
  LeadAction,
  OrchestrationMode,
  ParticipantAddition,
  RoundtableOpeningPlan,
} from "../types/protocol.js";
import type {
  DelegationRunResult,
  LeadActionRecord,
  ParticipantConfig,
  ParticipantSummary,
  PriorTurnContext,
  RunDiagnostic,
  RunEvent,
  RunLimits,
  WorkspaceSnapshotSummary,
} from "../types/session.js";
import { formatPriorConversationContext } from "./context.js";
import { ParticipantManager } from "./participant-manager.js";
import {
  buildLeadFeedbackPrompt,
  buildLeadInitialPrompt,
  buildLeadRepairPrompt,
  buildLeadSystemPrompt,
  buildRoundtableFollowUpPrompt,
  buildTeammateSystemPrompt,
  buildTeammateTaskPrompt,
} from "./prompts.js";
import { LEAD_ACTION_JSON_SCHEMA, validateLeadAction } from "./schemas.js";

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxLeadCalls: 6,
  maxTotalCalls: 14,
  perCallTimeoutMs: 90_000,
  hardDeadlineMs: 240_000,
  reserveSynthesisCall: true,
};

export interface PersistenceHooks {
  onRunStarted?: (runId: string) => void;
  onAssignmentCreated?: (assignment: AssignmentRecord) => void;
  onAssignmentUpdated?: (assignment: AssignmentRecord) => void;
  onContributionRecorded?: (contribution: ContributionRecord) => void;
  onParticipantUpdated?: (summary: ParticipantSummary) => void;
  resolveHistoricalContribution?: (
    contributionId: string,
  ) =>
    | {
        id: string;
        content: string;
        participantLabel: string;
        provider: string;
        kind: string;
      }
    | undefined;
}

export interface RunOrchestratedTurnOptions {
  runId?: string;
  prompt: string;
  mode?: OrchestrationMode;
  independentFirstOpinions?: boolean;
  lead: ParticipantConfig;
  teammates: ParticipantConfig[];
  priorTurns?: PriorTurnContext[];
  snapshot?: WorkspaceSnapshotSummary;
  cwd?: string;
  limits?: Partial<RunLimits>;
  allowReadOnlyTools?: boolean;
  adapters?: AdapterRegistry;
  signal?: AbortSignal;
  hooks?: PersistenceHooks;
  onEvent?: (event: RunEvent) => void;
}

export type RunLeadDelegationOptions = RunOrchestratedTurnOptions;

export function resolveRunLimits(overrides?: Partial<RunLimits>): RunLimits {
  if (!overrides) return { ...DEFAULT_RUN_LIMITS };
  return {
    maxLeadCalls: overrides.maxLeadCalls ?? DEFAULT_RUN_LIMITS.maxLeadCalls,
    maxTotalCalls: overrides.maxTotalCalls ?? DEFAULT_RUN_LIMITS.maxTotalCalls,
    perCallTimeoutMs:
      overrides.perCallTimeoutMs ?? DEFAULT_RUN_LIMITS.perCallTimeoutMs,
    hardDeadlineMs:
      overrides.hardDeadlineMs ?? DEFAULT_RUN_LIMITS.hardDeadlineMs,
    reserveSynthesisCall:
      overrides.reserveSynthesisCall ?? DEFAULT_RUN_LIMITS.reserveSynthesisCall,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface OrchestrationRuntime {
  runId: string;
  mode: OrchestrationMode;
  independentFirstOpinions: boolean;
  startTime: number;
  cwd: string;
  limits: RunLimits;
  allowTools: boolean;
  priorContextText: string;
  manager: ParticipantManager;
  options: RunOrchestratedTurnOptions;
  assignments: AssignmentRecord[];
  assignmentMap: Map<string, AssignmentRecord>;
  assignmentOwners: Map<string, string>;
  contributions: ContributionRecord[];
  validContributionIds: Set<string>;
  retrievableContributionIds: Set<string>;
  priorContributionIndex: Map<
    string,
    {
      id: string;
      content: string;
      participantLabel: string;
      provider: string;
      kind: string;
    }
  >;
  leadActions: LeadActionRecord[];
  diagnostics: RunDiagnostic[];
  roundtablePlan?: RoundtableOpeningPlan;
  leadCallsUsed: number;
  totalCallsUsed: number;
  externallyCancelled: () => boolean;
  deadlineExpired: () => boolean;
  remainingDeadlineMs: () => number;
  abortSignal: AbortSignal;
  emit: (event: RunEvent) => void;
  addDiagnostic: (
    level: RunDiagnostic["level"],
    code: string,
    message: string,
    participantId?: string,
    provider?: ParticipantConfig["provider"],
  ) => void;
  recordFallbackIfNeeded: (participantId: string) => void;
  buildProviderEventHandler: (
    participantId: string,
  ) => (evt: ProviderEvent) => void;
  nextAssignmentId: () => string;
  nextContributionId: () => string;
  registerAssignment: (record: AssignmentRecord) => void;
  completeAssignment: (
    record: AssignmentRecord,
    contribution: ContributionRecord,
    accepted?: boolean,
  ) => void;
  makeResult: (
    status: DelegationRunResult["status"],
    finalAnswer: string,
    usedContributionIds: string[],
    unresolvedIssues: string[],
    errorMessage?: string,
    participantSummaries?: ParticipantAddition[],
    disagreements?: string[],
  ) => DelegationRunResult;
  cleanup: () => void;
}

export async function createOrchestrationRuntime(
  options: RunOrchestratedTurnOptions,
): Promise<OrchestrationRuntime> {
  const startTime = Date.now();
  const mode: OrchestrationMode = options.mode ?? "divide_conquer";
  const independentFirstOpinions = Boolean(options.independentFirstOpinions);
  const runId = options.runId ?? `run_${crypto.randomUUID().slice(0, 8)}`;
  const cwd = options.snapshot?.snapshotPath ?? options.cwd ?? process.cwd();
  const limits = resolveRunLimits(options.limits);
  const adapters = options.adapters ?? createDefaultAdapters();
  const manager = new ParticipantManager(adapters);

  const diagnostics: RunDiagnostic[] = [];
  const assignments: AssignmentRecord[] = [];
  const assignmentMap = new Map<string, AssignmentRecord>();
  const assignmentOwners = new Map<string, string>();
  const contributions: ContributionRecord[] = [];
  const validContributionIds = new Set<string>();
  const priorContributionIndex = new Map<
    string,
    {
      id: string;
      content: string;
      participantLabel: string;
      provider: string;
      kind: string;
    }
  >();
  const retrievableContributionIds = new Set<string>();
  const leadActions: LeadActionRecord[] = [];
  const seenFallbacks = new Set<string>();

  for (const pt of options.priorTurns ?? []) {
    for (const c of pt.contributions) {
      retrievableContributionIds.add(c.id);
      priorContributionIndex.set(c.id, {
        id: c.id,
        content: c.content,
        participantLabel: c.participantLabel,
        provider: c.provider,
        kind: c.kind,
      });
    }
  }

  const emit = (event: RunEvent) => {
    options.onEvent?.(event);
  };

  const addDiagnostic = (
    level: RunDiagnostic["level"],
    code: string,
    message: string,
    participantId?: string,
    provider?: ParticipantConfig["provider"],
  ) => {
    const diagnostic: RunDiagnostic = {
      level,
      code,
      message,
      participantId,
      provider,
      timestamp: nowIso(),
    };
    diagnostics.push(diagnostic);
    emit({ type: "diagnostic", runId, diagnostic });
  };

  const runAbort = new AbortController();
  let isDeadlineExpired = false;
  let isExternallyCancelled = Boolean(options.signal?.aborted);

  const onExternalAbort = () => {
    isExternallyCancelled = true;
    manager.cancelAll();
    runAbort.abort();
  };

  if (options.signal) {
    if (options.signal.aborted) {
      onExternalAbort();
    } else {
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  let deadlineTimer: NodeJS.Timeout | undefined;
  if (limits.hardDeadlineMs > 0) {
    deadlineTimer = setTimeout(() => {
      isDeadlineExpired = true;
      manager.cancelAll();
      runAbort.abort();
    }, limits.hardDeadlineMs);
    deadlineTimer.unref();
  }

  const remainingDeadlineMs = (): number => {
    if (limits.hardDeadlineMs <= 0) return limits.perCallTimeoutMs;
    const elapsed = Date.now() - startTime;
    const rem = limits.hardDeadlineMs - elapsed;
    return Math.max(0, Math.min(limits.perCallTimeoutMs, rem));
  };

  const recordFallbackIfNeeded = (participantId: string) => {
    const handle = manager.getHandle(participantId);
    if (
      handle.continuationMode === "transcript_fallback" &&
      !seenFallbacks.has(participantId)
    ) {
      seenFallbacks.add(participantId);
      const reason =
        handle.fallbackReason ?? "Native session continuation failed";
      emit({
        type: "session_fallback",
        runId,
        participantId,
        provider: handle.provider,
        reason,
      });
      addDiagnostic(
        "warn",
        "session_fallback",
        `Participant "${participantId}" (${handle.provider}) switched to transcript_fallback: ${reason}`,
        participantId,
        handle.provider,
      );
    }
  };

  const buildProviderEventHandler = (
    participantId: string,
  ): ((evt: ProviderEvent) => void) => {
    return (evt) => {
      if (evt.type === "fallback_triggered") {
        recordFallbackIfNeeded(participantId);
      }
    };
  };

  let assignmentSeq = 0;
  let contributionSeq = 0;

  const allowTools = options.allowReadOnlyTools ?? true;
  const priorContextText = formatPriorConversationContext(
    options.priorTurns ?? [],
    { currentLead: options.lead },
  );

  options.hooks?.onRunStarted?.(runId);

  emit({
    type: "run_started",
    runId,
    mode,
    independentFirstOpinions:
      mode === "roundtable" ? independentFirstOpinions : undefined,
    lead: options.lead,
    teammates: options.teammates,
    prompt: options.prompt,
    snapshot: options.snapshot,
  });

  await manager.startParticipant(options.lead, {
    systemPrompt: buildLeadSystemPrompt(options.lead, options.teammates, {
      allowReadOnlyTools: allowTools,
      mode,
      independentFirstOpinions,
      snapshot: options.snapshot,
    }),
    cwd,
    readOnly: true,
    allowReadOnlyTools: allowTools,
  });
  options.hooks?.onParticipantUpdated?.(manager.getSummary(options.lead.id));

  for (const mate of options.teammates) {
    await manager.startParticipant(mate, {
      systemPrompt: buildTeammateSystemPrompt(mate, {
        allowReadOnlyTools: allowTools,
        mode,
        independentFirstOpinions,
        snapshot: options.snapshot,
      }),
      cwd,
      readOnly: true,
      allowReadOnlyTools: allowTools,
    });
    options.hooks?.onParticipantUpdated?.(manager.getSummary(mate.id));
  }

  const runtime: OrchestrationRuntime = {
    runId,
    mode,
    independentFirstOpinions,
    startTime,
    cwd,
    limits,
    allowTools,
    priorContextText,
    manager,
    options,
    assignments,
    assignmentMap,
    assignmentOwners,
    contributions,
    validContributionIds,
    retrievableContributionIds,
    priorContributionIndex,
    leadActions,
    diagnostics,
    leadCallsUsed: 0,
    totalCallsUsed: 0,
    externallyCancelled: () => isExternallyCancelled,
    deadlineExpired: () => isDeadlineExpired,
    remainingDeadlineMs,
    abortSignal: runAbort.signal,
    emit,
    addDiagnostic,
    recordFallbackIfNeeded,
    buildProviderEventHandler,
    nextAssignmentId: () => {
      assignmentSeq += 1;
      return `asgn_${assignmentSeq}`;
    },
    nextContributionId: () => {
      contributionSeq += 1;
      return `c_${contributionSeq}`;
    },
    registerAssignment: (record) => {
      assignments.push(record);
      assignmentMap.set(record.id, record);
      assignmentOwners.set(record.id, record.participantId);
      options.hooks?.onAssignmentCreated?.(record);
    },
    completeAssignment: (record, contribution, accepted = true) => {
      contributions.push(contribution);
      validContributionIds.add(contribution.id);
      retrievableContributionIds.add(contribution.id);
      if (accepted && contribution.outcome === "ok") {
        record.acceptedContributionId = contribution.id;
      }
      options.hooks?.onAssignmentUpdated?.(record);
      options.hooks?.onContributionRecorded?.(contribution);
      options.hooks?.onParticipantUpdated?.(
        manager.getSummary(record.participantId),
      );
    },
    makeResult: (
      status,
      finalAnswer,
      usedContributionIds,
      unresolvedIssues,
      errorMessage,
      participantSummaries = [],
      disagreements = [],
    ) => {
      const elapsedMs = Date.now() - startTime;
      emit({
        type: "run_finished",
        runId,
        status,
        elapsedMs,
      });
      return {
        runId,
        mode,
        independentFirstOpinions:
          mode === "roundtable" ? independentFirstOpinions : undefined,
        status,
        finalAnswer,
        usedContributionIds,
        unresolvedIssues,
        participantSummaries,
        disagreements,
        leadParticipant: manager.getSummary(options.lead.id),
        teammates: options.teammates.map((t) => manager.getSummary(t.id)),
        assignments,
        contributions,
        leadActions,
        diagnostics,
        snapshot: options.snapshot,
        roundtablePlan: runtime.roundtablePlan,
        elapsedMs,
        errorMessage,
      };
    },
    cleanup: () => {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
      }
      if (options.signal) {
        options.signal.removeEventListener("abort", onExternalAbort);
      }
    },
  };

  return runtime;
}

export async function executeLeadActionLoop(
  rt: OrchestrationRuntime,
  initialLeadPrompt: string,
): Promise<DelegationRunResult> {
  const {
    runId,
    limits,
    manager,
    options,
    assignments,
    assignmentMap,
    assignmentOwners,
    contributions,
    validContributionIds,
    retrievableContributionIds,
    leadActions,
    emit,
    addDiagnostic,
  } = rt;

  const allowedTeammateIds = new Set(options.teammates.map((t) => t.id));
  let nextLeadPrompt = initialLeadPrompt;

  while (true) {
    if (rt.externallyCancelled()) {
      return rt.makeResult(
        "cancelled",
        "Run cancelled before completion.",
        Array.from(validContributionIds),
        ["Run was cancelled."],
        "Cancelled",
      );
    }

    if (rt.deadlineExpired() || rt.remainingDeadlineMs() <= 0) {
      addDiagnostic(
        "warn",
        "hard_deadline_expired",
        `Hard deadline (${limits.hardDeadlineMs}ms) reached before lead finished.`,
      );
      return rt.makeResult(
        contributions.length > 0 ? "partial" : "failed",
        contributions.length > 0
          ? "Partial run: hard deadline expired before the lead synthesized a final answer. Completed teammate contributions remain available."
          : "Hard deadline expired before any contributions were completed.",
        Array.from(validContributionIds),
        ["Hard deadline expired before final lead synthesis."],
        "Hard deadline expired",
      );
    }

    if (
      rt.leadCallsUsed >= limits.maxLeadCalls ||
      rt.totalCallsUsed >= limits.maxTotalCalls
    ) {
      addDiagnostic(
        "warn",
        "budget_exhausted",
        "Call budget exhausted before lead emitted finish.",
      );
      return rt.makeResult(
        contributions.length > 0 ? "partial" : "failed",
        contributions.length > 0
          ? "Partial run: call budget exhausted before the lead emitted a final answer."
          : "Call budget exhausted.",
        Array.from(validContributionIds),
        ["Call budget exhausted before final synthesis."],
        "Call budget exhausted",
      );
    }

    const remainingLeadAfterThis = limits.maxLeadCalls - (rt.leadCallsUsed + 1);
    const remainingTotalAfterThis =
      limits.maxTotalCalls - (rt.totalCallsUsed + 1);
    const mustFinish =
      limits.reserveSynthesisCall &&
      (remainingLeadAfterThis <= 0 || remainingTotalAfterThis < 2);

    const turnNumber = rt.leadCallsUsed + 1;
    emit({
      type: "lead_thinking",
      runId,
      turn: turnNumber,
      participantId: options.lead.id,
      provider: options.lead.provider,
      mustFinish,
    });

    const invokeLeadWithValidation = async (
      promptText: string,
      allowRepair: boolean,
    ): Promise<
      | { ok: true; action: LeadAction; turnResult: TurnResult }
      | { ok: false; error: string; turnResult?: TurnResult }
    > => {
      const timeoutMs = rt.remainingDeadlineMs();
      if (timeoutMs <= 0) {
        return { ok: false, error: "Hard deadline expired" };
      }
      const effectiveMustFinish =
        mustFinish ||
        (limits.reserveSynthesisCall &&
          (limits.maxLeadCalls - (rt.leadCallsUsed + 1) <= 0 ||
            limits.maxTotalCalls - (rt.totalCallsUsed + 1) < 2));

      rt.leadCallsUsed += 1;
      rt.totalCallsUsed += 1;

      const turnResult = await manager.sendTurn(options.lead.id, {
        prompt: promptText,
        responseSchema: LEAD_ACTION_JSON_SCHEMA,
        timeoutMs,
        signal: rt.abortSignal,
        onEvent: rt.buildProviderEventHandler(options.lead.id),
      });
      rt.recordFallbackIfNeeded(options.lead.id);
      options.hooks?.onParticipantUpdated?.(manager.getSummary(options.lead.id));

      if (turnResult.outcome !== "ok") {
        return {
          ok: false,
          error:
            turnResult.errorMessage ??
            `Lead call failed (${turnResult.outcome})`,
          turnResult,
        };
      }

      let candidate: unknown = turnResult.structured;
      if (!candidate || typeof candidate !== "object") {
        const parsed = extractJsonObject(turnResult.text);
        if (!parsed.ok) {
          if (
            allowRepair &&
            rt.leadCallsUsed < limits.maxLeadCalls &&
            rt.totalCallsUsed < limits.maxTotalCalls
          ) {
            addDiagnostic(
              "warn",
              "lead_repair_attempt",
              `Lead output was not valid JSON (${parsed.error}); requesting repair turn.`,
              options.lead.id,
              options.lead.provider,
            );
            return invokeLeadWithValidation(
              buildLeadRepairPrompt(parsed.error),
              false,
            );
          }
          return { ok: false, error: parsed.error, turnResult };
        }
        candidate = parsed.value;
      }

      const validation = validateLeadAction(candidate, {
        allowedTeammateIds,
        validAssignments: assignmentOwners,
        validContributionIds,
        retrievableContributionIds,
        mustFinish: effectiveMustFinish,
      });

      if (!validation.ok) {
        if (
          allowRepair &&
          rt.leadCallsUsed < limits.maxLeadCalls &&
          rt.totalCallsUsed < limits.maxTotalCalls
        ) {
          addDiagnostic(
            "warn",
            "lead_repair_attempt",
            `Lead action failed validation (${validation.error}); requesting repair turn.`,
            options.lead.id,
            options.lead.provider,
          );
          return invokeLeadWithValidation(
            buildLeadRepairPrompt(validation.error),
            false,
          );
        }
        return { ok: false, error: validation.error, turnResult };
      }

      return { ok: true, action: validation.value, turnResult };
    };

    const leadStep = await invokeLeadWithValidation(nextLeadPrompt, true);
    if (!leadStep.ok) {
      const finalStatus = rt.externallyCancelled()
        ? "cancelled"
        : contributions.length > 0
          ? "partial"
          : "failed";
      addDiagnostic(
        "error",
        "lead_turn_failed",
        leadStep.error,
        options.lead.id,
        options.lead.provider,
      );
      return rt.makeResult(
        finalStatus,
        contributions.length > 0
          ? `Partial run: lead failed (${leadStep.error}). Completed teammate contributions are preserved.`
          : `Run failed: ${leadStep.error}`,
        Array.from(validContributionIds),
        [leadStep.error],
        leadStep.error,
      );
    }

    const { action, turnResult } = leadStep;
    leadActions.push({
      turn: turnNumber,
      action,
      elapsedMs: turnResult.elapsedMs,
      usage: turnResult.usage,
    });
    emit({
      type: "lead_action",
      runId,
      turn: turnNumber,
      action,
      elapsedMs: turnResult.elapsedMs,
      usage: turnResult.usage,
    });

    if (action.action === "finish") {
      return rt.makeResult(
        "completed",
        action.final_answer,
        action.used_contribution_ids,
        action.unresolved_issues,
        undefined,
        action.participant_summaries,
        action.disagreements,
      );
    }

    if (action.action === "retrieve_contribution") {
      const targetId = action.retrieve_contribution_id;
      const inCurrent = contributions.find((c) => c.id === targetId);
      const inPrior = rt.priorContributionIndex.get(targetId);
      const inHook = options.hooks?.resolveHistoricalContribution?.(targetId);
      const found = inCurrent ?? inPrior ?? inHook;
      emit({
        type: "contribution_retrieved",
        runId,
        contributionId: targetId,
        found: Boolean(found),
      });

      const nextRemainingLead = limits.maxLeadCalls - rt.leadCallsUsed;
      const nextRemainingTotal = limits.maxTotalCalls - rt.totalCallsUsed;
      const nextMustFinish =
        limits.reserveSynthesisCall &&
        (nextRemainingLead <= 1 || nextRemainingTotal <= 2);

      nextLeadPrompt = [
        found
          ? `<retrieved_original_contribution id="${found.id}" participant="${found.participantLabel}" provider="${found.provider}" kind="${found.kind}">\n${found.content}\n</retrieved_original_contribution>`
          : `Contribution "${targetId}" could not be found.`,
        `Budget status: remainingLeadCalls=${nextRemainingLead}, remainingTotalCalls=${nextRemainingTotal}.`,
        nextMustFinish
          ? 'FINAL CALL NOTICE: You MUST return action="finish" now.'
          : "Return your next LeadAction JSON.",
      ].join("\n\n");
      continue;
    }

    const batchContributions: ContributionRecord[] = [];

    if (action.action === "delegate") {
      const reservedForSynthesis = limits.reserveSynthesisCall ? 1 : 0;
      const availableForTeammates = Math.max(
        0,
        limits.maxTotalCalls - rt.totalCallsUsed - reservedForSynthesis,
      );

      const toDispatch: Array<{
        spec: DelegateAssignmentSpec;
        record: AssignmentRecord;
      }> = [];
      const skippedSpecs: Array<{
        spec: DelegateAssignmentSpec;
        record: AssignmentRecord;
      }> = [];

      for (let i = 0; i < action.assignments.length; i += 1) {
        const spec = action.assignments[i]!;
        const mateConfig = manager.getConfig(spec.participant_id);
        const id = rt.nextAssignmentId();
        const willDispatch = i < availableForTeammates;
        const record: AssignmentRecord = {
          id,
          participantId: spec.participant_id,
          participantLabel: mateConfig.label,
          provider: mateConfig.provider,
          title: spec.title,
          task: spec.task,
          contextNotes: spec.context_notes ?? undefined,
          status: willDispatch ? "running" : "failed",
          createdAt: nowIso(),
          completedAt: willDispatch ? undefined : nowIso(),
        };
        rt.registerAssignment(record);

        if (willDispatch) {
          toDispatch.push({ spec, record });
        } else {
          skippedSpecs.push({ spec, record });
        }
      }

      for (const { record } of toDispatch) {
        emit({ type: "assignment_started", runId, assignment: record });
      }

      rt.totalCallsUsed += toDispatch.length;

      const dispatchResults = await Promise.all(
        toDispatch.map(async ({ record }) => {
          const promptSent = buildTeammateTaskPrompt(
            options.prompt,
            record,
            rt.priorContextText,
          );
          const timeoutMs = rt.remainingDeadlineMs();
          let turn: TurnResult;

          if (timeoutMs <= 0) {
            turn = {
              outcome: "timeout",
              text: "",
              continuationMode: manager.getHandle(record.participantId)
                .continuationMode,
              elapsedMs: 0,
              errorMessage: "Hard deadline expired before teammate dispatch",
            };
          } else {
            turn = await manager.sendTurn(record.participantId, {
              prompt: promptSent,
              timeoutMs,
              signal: rt.abortSignal,
              onEvent: rt.buildProviderEventHandler(record.participantId),
            });
            rt.recordFallbackIfNeeded(record.participantId);
          }

          const handle = manager.getHandle(record.participantId);
          const cid = rt.nextContributionId();
          const isOk = turn.outcome === "ok";
          record.status = isOk ? "completed" : "failed";
          record.completedAt = nowIso();

          const contribution: ContributionRecord = {
            id: cid,
            assignmentId: record.id,
            participantId: record.participantId,
            participantLabel: record.participantLabel,
            provider: record.provider,
            providerSessionId:
              turn.providerSessionId ?? handle.providerSessionId,
            continuationMode: turn.continuationMode,
            fallbackReason: turn.fallbackReason,
            kind: isOk ? "initial_report" : "failure",
            promptSent,
            outcome: turn.outcome,
            content: turn.text,
            errorMessage: turn.errorMessage,
            usage: turn.usage,
            elapsedMs: turn.elapsedMs,
            createdAt: nowIso(),
          };

          rt.completeAssignment(record, contribution, isOk);
          emit({
            type: "assignment_completed",
            runId,
            assignment: record,
            contribution,
          });
          return contribution;
        }),
      );

      batchContributions.push(...dispatchResults);

      for (const { record } of skippedSpecs) {
        const cid = rt.nextContributionId();
        const handle = manager.getHandle(record.participantId);
        const contribution: ContributionRecord = {
          id: cid,
          assignmentId: record.id,
          participantId: record.participantId,
          participantLabel: record.participantLabel,
          provider: record.provider,
          providerSessionId: handle.providerSessionId,
          continuationMode: handle.continuationMode,
          fallbackReason: handle.fallbackReason,
          kind: "failure",
          promptSent: "",
          outcome: "execution_error",
          content: "",
          errorMessage:
            "Call budget exhausted (remaining call reserved for lead synthesis).",
          elapsedMs: 0,
          createdAt: nowIso(),
        };
        rt.completeAssignment(record, contribution, false);
        emit({
          type: "assignment_completed",
          runId,
          assignment: record,
          contribution,
        });
        batchContributions.push(contribution);
      }
    } else if (action.action === "follow_up") {
      const fu = action.follow_up;
      const assignment = assignmentMap.get(fu.assignment_id)!;
      const mateConfig = manager.getConfig(fu.participant_id);
      const reservedForSynthesis = limits.reserveSynthesisCall ? 1 : 0;

      emit({
        type: "followup_started",
        runId,
        assignmentId: fu.assignment_id,
        participantId: fu.participant_id,
        provider: mateConfig.provider,
        question: fu.question,
      });

      const promptSent =
        rt.mode === "roundtable"
          ? buildRoundtableFollowUpPrompt({
              originalRequest: options.prompt,
              discussionSoFar: contributions,
              assignment,
              question: fu.question,
            })
          : `Follow-up question from lead regarding assignment "${assignment.title}" (${assignment.id}):\n\n${fu.question}`;

      let turn: TurnResult;
      if (limits.maxTotalCalls - rt.totalCallsUsed - reservedForSynthesis <= 0) {
        turn = {
          outcome: "execution_error",
          text: "",
          continuationMode: manager.getHandle(fu.participant_id)
            .continuationMode,
          elapsedMs: 0,
          errorMessage:
            "Call budget exhausted (remaining call reserved for lead synthesis).",
        };
      } else {
        rt.totalCallsUsed += 1;
        const timeoutMs = rt.remainingDeadlineMs();
        if (timeoutMs <= 0) {
          turn = {
            outcome: "timeout",
            text: "",
            continuationMode: manager.getHandle(fu.participant_id)
              .continuationMode,
            elapsedMs: 0,
            errorMessage: "Hard deadline expired before follow-up dispatch",
          };
        } else {
          turn = await manager.sendTurn(fu.participant_id, {
            prompt: promptSent,
            timeoutMs,
            signal: rt.abortSignal,
            onEvent: rt.buildProviderEventHandler(fu.participant_id),
          });
          rt.recordFallbackIfNeeded(fu.participant_id);
        }
      }

      const handle = manager.getHandle(fu.participant_id);
      const cid = rt.nextContributionId();
      const isOk = turn.outcome === "ok";
      if (isOk) {
        assignment.status = "completed";
        assignment.completedAt = nowIso();
      }
      const contribution: ContributionRecord = {
        id: cid,
        assignmentId: fu.assignment_id,
        participantId: fu.participant_id,
        participantLabel: mateConfig.label,
        provider: mateConfig.provider,
        providerSessionId: turn.providerSessionId ?? handle.providerSessionId,
        continuationMode: turn.continuationMode,
        fallbackReason: turn.fallbackReason,
        kind: isOk ? "follow_up_reply" : "failure",
        promptSent,
        outcome: turn.outcome,
        content: turn.text,
        errorMessage: turn.errorMessage,
        usage: turn.usage,
        elapsedMs: turn.elapsedMs,
        createdAt: nowIso(),
      };
      rt.completeAssignment(assignment, contribution, isOk);
      emit({ type: "followup_completed", runId, contribution });
      batchContributions.push(contribution);
    }

    const nextRemainingLead = limits.maxLeadCalls - rt.leadCallsUsed;
    const nextRemainingTotal = limits.maxTotalCalls - rt.totalCallsUsed;
    const nextMustFinish =
      limits.reserveSynthesisCall &&
      (nextRemainingLead <= 1 || nextRemainingTotal <= 2);

    const anyFailedInRun = assignments.some((a) => a.status === "failed");
    const extraNotice = anyFailedInRun
      ? "Note: one or more assignments failed; keep any impact visible in unresolved_issues and final_answer."
      : undefined;

    nextLeadPrompt = buildLeadFeedbackPrompt(
      batchContributions,
      {
        remainingLeadCalls: nextRemainingLead,
        remainingTotalCalls: nextRemainingTotal,
        mustFinish: nextMustFinish,
      },
      extraNotice,
    );
  }
}

export async function runLeadDelegation(
  options: RunLeadDelegationOptions,
): Promise<DelegationRunResult> {
  const rt = await createOrchestrationRuntime({
    ...options,
    mode: "divide_conquer",
  });
  try {
    const initialPrompt = buildLeadInitialPrompt(
      options.prompt,
      options.teammates,
      rt.priorContextText,
    );
    return await executeLeadActionLoop(rt, initialPrompt);
  } finally {
    rt.cleanup();
  }
}

export interface SynthesizeFromContributionsOptions {
  prompt: string;
  mode: OrchestrationMode;
  lead: ParticipantConfig;
  teammates: ParticipantConfig[];
  priorTurns?: PriorTurnContext[];
  snapshot?: WorkspaceSnapshotSummary;
  contributions: ContributionRecord[];
  cwd?: string;
  timeoutMs?: number;
  allowReadOnlyTools?: boolean;
  adapters?: AdapterRegistry;
  signal?: AbortSignal;
}

export interface SynthesisResult {
  ok: boolean;
  finalAnswer: string;
  usedContributionIds: string[];
  unresolvedIssues: string[];
  participantSummaries: ParticipantAddition[];
  disagreements: string[];
  leadParticipant: ParticipantSummary;
  elapsedMs: number;
  usage?: UsageInfo;
  errorMessage?: string;
}

export async function synthesizeFromContributions(
  options: SynthesizeFromContributionsOptions,
): Promise<SynthesisResult> {
  const startTime = Date.now();
  const adapters = options.adapters ?? createDefaultAdapters();
  const manager = new ParticipantManager(adapters);
  const cwd = options.snapshot?.snapshotPath ?? options.cwd ?? process.cwd();
  const allowTools = options.allowReadOnlyTools ?? true;
  const priorContextText = formatPriorConversationContext(
    options.priorTurns ?? [],
    { currentLead: options.lead },
  );

  await manager.startParticipant(options.lead, {
    systemPrompt: buildLeadSystemPrompt(options.lead, options.teammates, {
      allowReadOnlyTools: allowTools,
      mode: options.mode,
      snapshot: options.snapshot,
    }),
    cwd,
    readOnly: true,
    allowReadOnlyTools: allowTools,
  });

  const activeContributions = options.contributions.filter(
    (c) => !c.supersededBy,
  );
  const validIds = new Set(activeContributions.map((c) => c.id));
  const retrievableIds = new Set(validIds);
  for (const pt of options.priorTurns ?? []) {
    for (const c of pt.contributions) {
      retrievableIds.add(c.id);
    }
  }

  const promptParts: string[] = [];
  if (priorContextText.trim()) {
    promptParts.push(priorContextText.trim());
  }
  promptParts.push(`<original_user_request>\n${options.prompt.trim()}\n</original_user_request>`);
  promptParts.push(
    buildLeadFeedbackPrompt(activeContributions, {
      remainingLeadCalls: 1,
      remainingTotalCalls: 1,
      mustFinish: true,
    }),
  );

  const turn = await manager.sendTurn(options.lead.id, {
    prompt: promptParts.join("\n\n"),
    responseSchema: LEAD_ACTION_JSON_SCHEMA,
    timeoutMs: options.timeoutMs ?? 90_000,
    signal: options.signal,
  });

  const summary = manager.getSummary(options.lead.id);
  if (turn.outcome !== "ok") {
    return {
      ok: false,
      finalAnswer: "",
      usedContributionIds: [],
      unresolvedIssues: [turn.errorMessage ?? `Synthesis failed (${turn.outcome})`],
      participantSummaries: [],
      disagreements: [],
      leadParticipant: summary,
      elapsedMs: Date.now() - startTime,
      usage: turn.usage,
      errorMessage: turn.errorMessage ?? `Synthesis failed (${turn.outcome})`,
    };
  }

  let candidate: unknown = turn.structured;
  if (!candidate || typeof candidate !== "object") {
    const parsed = extractJsonObject(turn.text);
    if (!parsed.ok) {
      return {
        ok: false,
        finalAnswer: "",
        usedContributionIds: [],
        unresolvedIssues: [parsed.error],
        participantSummaries: [],
        disagreements: [],
        leadParticipant: summary,
        elapsedMs: Date.now() - startTime,
        usage: turn.usage,
        errorMessage: parsed.error,
      };
    }
    candidate = parsed.value;
  }

  const validated = validateLeadAction(candidate, {
    allowedTeammateIds: new Set(options.teammates.map((t) => t.id)),
    validAssignments: new Map(),
    validContributionIds: validIds,
    retrievableContributionIds: retrievableIds,
    mustFinish: true,
  });

  if (!validated.ok || validated.value.action !== "finish") {
    const err = validated.ok
      ? "Lead did not return finish during synthesis"
      : validated.error;
    return {
      ok: false,
      finalAnswer: "",
      usedContributionIds: [],
      unresolvedIssues: [err],
      participantSummaries: [],
      disagreements: [],
      leadParticipant: summary,
      elapsedMs: Date.now() - startTime,
      usage: turn.usage,
      errorMessage: err,
    };
  }

  return {
    ok: true,
    finalAnswer: validated.value.final_answer,
    usedContributionIds: validated.value.used_contribution_ids,
    unresolvedIssues: validated.value.unresolved_issues,
    participantSummaries: validated.value.participant_summaries,
    disagreements: validated.value.disagreements,
    leadParticipant: summary,
    elapsedMs: Date.now() - startTime,
    usage: turn.usage,
  };
}
