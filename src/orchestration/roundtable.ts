import { extractJsonObject } from "../providers/classify.js";
import type { TurnResult } from "../types/provider.js";
import type {
  AssignmentRecord,
  ContributionRecord,
  RoundtableOpeningPlan,
} from "../types/protocol.js";
import type {
  DelegationRunResult,
  ParticipantConfig,
} from "../types/session.js";
import {
  createOrchestrationRuntime,
  executeLeadActionLoop,
  type OrchestrationRuntime,
  type RunOrchestratedTurnOptions,
} from "./loop.js";
import {
  buildLeadFeedbackPrompt,
  buildLeadInitialPrompt,
  buildRoundtableOpeningPrompt,
  buildRoundtablePlanPrompt,
  buildRoundtableSequentialPrompt,
} from "./prompts.js";
import {
  ROUNDTABLE_OPENING_SCHEMA,
  validateRoundtableOpeningPlan,
} from "./schemas.js";

function nowIso(): string {
  return new Date().toISOString();
}

async function planRoundtableOpening(
  rt: OrchestrationRuntime,
): Promise<RoundtableOpeningPlan> {
  const teammateIds = rt.options.teammates.map((t) => t.id);
  const fallbackPlan: RoundtableOpeningPlan = {
    opening_participant_id: teammateIds[0]!,
    discussion_order: [...teammateIds],
    framing_note: null,
  };

  if (teammateIds.length <= 1) {
    return fallbackPlan;
  }

  const reservedForTeammates = teammateIds.length + (rt.limits.reserveSynthesisCall ? 1 : 0);
  if (
    rt.limits.maxLeadCalls - rt.leadCallsUsed < 2 ||
    rt.limits.maxTotalCalls - rt.totalCallsUsed <= reservedForTeammates
  ) {
    return fallbackPlan;
  }

  const timeoutMs = rt.remainingDeadlineMs();
  if (timeoutMs <= 0) {
    return fallbackPlan;
  }

  rt.leadCallsUsed += 1;
  rt.totalCallsUsed += 1;

  const planPrompt = buildRoundtablePlanPrompt(
    rt.options.prompt,
    rt.options.teammates,
    rt.priorContextText,
  );

  const turn = await rt.manager.sendTurn(rt.options.lead.id, {
    prompt: planPrompt,
    responseSchema: ROUNDTABLE_OPENING_SCHEMA,
    timeoutMs,
    signal: rt.abortSignal,
    onEvent: rt.buildProviderEventHandler(rt.options.lead.id),
  });
  rt.recordFallbackIfNeeded(rt.options.lead.id);
  rt.options.hooks?.onParticipantUpdated?.(
    rt.manager.getSummary(rt.options.lead.id),
  );

  if (turn.outcome !== "ok") {
    rt.addDiagnostic(
      "warn",
      "roundtable_plan_fallback",
      `Roundtable opening selection failed (${turn.errorMessage ?? turn.outcome}); defaulting to ${fallbackPlan.opening_participant_id}.`,
      rt.options.lead.id,
      rt.options.lead.provider,
    );
    return fallbackPlan;
  }

  let candidate: unknown = turn.structured;
  if (!candidate || typeof candidate !== "object") {
    const extracted = extractJsonObject(turn.text);
    if (!extracted.ok) {
      return fallbackPlan;
    }
    candidate = extracted.value;
  }

  const validated = validateRoundtableOpeningPlan(candidate, teammateIds);
  if (!validated.ok) {
    rt.addDiagnostic(
      "warn",
      "roundtable_plan_fallback",
      `Roundtable opening plan invalid (${validated.error}); defaulting to ${fallbackPlan.opening_participant_id}.`,
      rt.options.lead.id,
      rt.options.lead.provider,
    );
    return fallbackPlan;
  }

  return validated.value;
}

async function runTeammateRoundtableTurn(
  rt: OrchestrationRuntime,
  mate: ParticipantConfig,
  roundNumber: number,
  promptSent: string,
  kindWhenOk: "opening_position" | "independent_opening" | "roundtable_turn",
  isBlind: boolean,
): Promise<{ assignment: AssignmentRecord; contribution: ContributionRecord }> {
  const assignmentId = rt.nextAssignmentId();
  const assignment: AssignmentRecord = {
    id: assignmentId,
    participantId: mate.id,
    participantLabel: mate.label,
    provider: mate.provider,
    title: isBlind
      ? `Independent opening (${mate.label})`
      : roundNumber === 1
        ? `Roundtable opening (${mate.label})`
        : `Roundtable turn #${roundNumber} (${mate.label})`,
    task: isBlind
      ? "Provide independent opening position on the user question"
      : roundNumber === 1
        ? "Open the roundtable on the user question"
        : "Respond to the user question and prior attributed roundtable turns",
    status: "running",
    createdAt: nowIso(),
  };

  rt.registerAssignment(assignment);
  rt.emit({
    type: "roundtable_turn_started",
    runId: rt.runId,
    round: roundNumber,
    participantId: mate.id,
    participantLabel: mate.label,
    provider: mate.provider,
    assignmentId,
    isBlind,
  });

  const reservedForSynthesis = rt.limits.reserveSynthesisCall ? 1 : 0;
  let turn: TurnResult;

  if (
    rt.limits.maxTotalCalls - rt.totalCallsUsed - reservedForSynthesis <=
    0
  ) {
    turn = {
      outcome: "execution_error",
      text: "",
      continuationMode: rt.manager.getHandle(mate.id).continuationMode,
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
        continuationMode: rt.manager.getHandle(mate.id).continuationMode,
        elapsedMs: 0,
        errorMessage: "Hard deadline expired before roundtable turn",
      };
    } else {
      turn = await rt.manager.sendTurn(mate.id, {
        prompt: promptSent,
        timeoutMs,
        signal: rt.abortSignal,
        onEvent: rt.buildProviderEventHandler(mate.id),
      });
      rt.recordFallbackIfNeeded(mate.id);
    }
  }

  const handle = rt.manager.getHandle(mate.id);
  const cid = rt.nextContributionId();
  const isOk = turn.outcome === "ok";
  assignment.status = isOk ? "completed" : "failed";
  assignment.completedAt = nowIso();

  const contribution: ContributionRecord = {
    id: cid,
    assignmentId,
    participantId: mate.id,
    participantLabel: mate.label,
    provider: mate.provider,
    providerSessionId: turn.providerSessionId ?? handle.providerSessionId,
    continuationMode: turn.continuationMode,
    fallbackReason: turn.fallbackReason,
    kind: isOk ? kindWhenOk : "failure",
    promptSent,
    outcome: turn.outcome,
    content: turn.text,
    errorMessage: turn.errorMessage,
    usage: turn.usage,
    elapsedMs: turn.elapsedMs,
    createdAt: nowIso(),
  };

  rt.completeAssignment(assignment, contribution, isOk);
  rt.emit({
    type: "roundtable_turn_completed",
    runId: rt.runId,
    round: roundNumber,
    assignment,
    contribution,
  });

  return { assignment, contribution };
}

export async function runRoundtableTurn(
  options: RunOrchestratedTurnOptions,
): Promise<DelegationRunResult> {
  const rt = await createOrchestrationRuntime({
    ...options,
    mode: "roundtable",
  });

  try {
    if (options.teammates.length === 0) {
      const soloPrompt = buildLeadInitialPrompt(
        options.prompt,
        [],
        rt.priorContextText,
      );
      return await executeLeadActionLoop(rt, soloPrompt);
    }

    const mateById = new Map(options.teammates.map((m) => [m.id, m]));
    const openingContributions: ContributionRecord[] = [];

    if (rt.independentFirstOpinions) {
      const openingPrompt = buildRoundtableOpeningPrompt({
        originalRequest: options.prompt,
        priorContextText: rt.priorContextText,
        isBlindIndependent: true,
      });

      const results = await Promise.all(
        options.teammates.map((mate) =>
          runTeammateRoundtableTurn(
            rt,
            mate,
            1,
            openingPrompt,
            "independent_opening",
            true,
          ),
        ),
      );
      for (const r of results) {
        openingContributions.push(r.contribution);
      }
    } else {
      const plan = await planRoundtableOpening(rt);
      rt.roundtablePlan = plan;
      rt.emit({
        type: "roundtable_opening_planned",
        runId: rt.runId,
        plan,
      });

      const discussionSoFar: ContributionRecord[] = [];
      for (let i = 0; i < plan.discussion_order.length; i += 1) {
        if (rt.externallyCancelled() || rt.deadlineExpired()) {
          break;
        }
        const pid = plan.discussion_order[i]!;
        const mate = mateById.get(pid);
        if (!mate) continue;

        const isOpener = i === 0;
        const promptSent = isOpener
          ? buildRoundtableOpeningPrompt({
              originalRequest: options.prompt,
              priorContextText: rt.priorContextText,
              framingNote: plan.framing_note,
              isBlindIndependent: false,
            })
          : buildRoundtableSequentialPrompt({
              originalRequest: options.prompt,
              priorContextText: rt.priorContextText,
              discussionSoFar,
              framingNote: plan.framing_note,
            });

        const { contribution } = await runTeammateRoundtableTurn(
          rt,
          mate,
          i + 1,
          promptSent,
          isOpener ? "opening_position" : "roundtable_turn",
          false,
        );
        discussionSoFar.push(contribution);
        openingContributions.push(contribution);
      }
    }

    const remainingLead = rt.limits.maxLeadCalls - rt.leadCallsUsed;
    const remainingTotal = rt.limits.maxTotalCalls - rt.totalCallsUsed;
    const mustFinish =
      rt.limits.reserveSynthesisCall &&
      (remainingLead <= 1 || remainingTotal <= 2);

    const extraNotice = [
      `<original_user_request>\n${options.prompt.trim()}\n</original_user_request>`,
      rt.independentFirstOpinions
        ? "All independent opening positions above are now revealed together. You may use follow_up to address differences between participants, retrieve_contribution to inspect any prior turn, delegate an extra check, or finish with your synthesis, participant_summaries, and disagreements."
        : "All roundtable participants have contributed in order above. You may send a targeted follow_up (e.g., letting an author respond to a reviewer's objection so their reply re-enters the shared discussion), retrieve_contribution, or finish with your synthesis, participant_summaries, and disagreements.",
    ].join("\n\n");

    const synthesisPrompt = buildLeadFeedbackPrompt(
      openingContributions,
      {
        remainingLeadCalls: remainingLead,
        remainingTotalCalls: remainingTotal,
        mustFinish,
      },
      extraNotice,
    );

    return await executeLeadActionLoop(rt, synthesisPrompt);
  } finally {
    rt.cleanup();
  }
}
