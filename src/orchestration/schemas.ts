import type {
  DelegateAssignmentSpec,
  FollowUpSpec,
  LeadAction,
  ParticipantAddition,
  RoundtableOpeningPlan,
} from "../types/protocol.js";

export const LEAD_ACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "assignments",
    "follow_up",
    "retrieve_contribution_id",
    "final_answer",
    "used_contribution_ids",
    "unresolved_issues",
    "participant_summaries",
    "disagreements",
  ],
  properties: {
    action: {
      type: "string",
      enum: ["delegate", "follow_up", "retrieve_contribution", "finish"],
    },
    assignments: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["participant_id", "title", "task", "context_notes"],
        properties: {
          participant_id: { type: "string" },
          title: { type: "string" },
          task: { type: "string" },
          context_notes: { type: ["string", "null"] },
        },
      },
    },
    follow_up: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["participant_id", "assignment_id", "question"],
      properties: {
        participant_id: { type: "string" },
        assignment_id: { type: "string" },
        question: { type: "string" },
      },
    },
    retrieve_contribution_id: {
      type: ["string", "null"],
    },
    final_answer: {
      type: ["string", "null"],
    },
    used_contribution_ids: {
      type: ["array", "null"],
      items: { type: "string" },
    },
    unresolved_issues: {
      type: ["array", "null"],
      items: { type: "string" },
    },
    participant_summaries: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["participant_id", "added"],
        properties: {
          participant_id: { type: "string" },
          added: { type: "string" },
        },
      },
    },
    disagreements: {
      type: ["array", "null"],
      items: { type: "string" },
    },
  },
};

export const ROUNDTABLE_OPENING_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["opening_participant_id", "discussion_order", "framing_note"],
  properties: {
    opening_participant_id: { type: "string" },
    discussion_order: {
      type: "array",
      items: { type: "string" },
    },
    framing_note: { type: ["string", "null"] },
  },
};

export interface LeadActionValidationContext {
  allowedTeammateIds: Set<string>;
  validAssignments: Map<string, string>;
  validContributionIds: Set<string>;
  retrievableContributionIds?: Set<string>;
  mustFinish?: boolean;
}

export type LeadActionValidationResult =
  | { ok: true; value: LeadAction }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateStringArray(
  value: unknown,
  fieldName: string,
): { ok: true; items: string[] } | { ok: false; error: string } {
  if (value === null || value === undefined) {
    return { ok: true, items: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: `${fieldName} must be an array or null` };
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return { ok: false, error: `${fieldName} items must be strings` };
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      items.push(trimmed);
    }
  }
  return { ok: true, items };
}

function validateParticipantSummaries(
  value: unknown,
): { ok: true; items: ParticipantAddition[] } | { ok: false; error: string } {
  if (value === null || value === undefined) {
    return { ok: true, items: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: "participant_summaries must be an array or null" };
  }
  const items: ParticipantAddition[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (!isPlainObject(entry)) {
      return {
        ok: false,
        error: `participant_summaries[${i}] must be an object`,
      };
    }
    if (!isNonEmptyString(entry.participant_id) || !isNonEmptyString(entry.added)) {
      return {
        ok: false,
        error: `participant_summaries[${i}] requires non-empty participant_id and added`,
      };
    }
    items.push({
      participant_id: entry.participant_id.trim(),
      added: entry.added.trim(),
    });
  }
  return { ok: true, items };
}

export function validateLeadAction(
  raw: unknown,
  context: LeadActionValidationContext,
): LeadActionValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "Lead action must be a JSON object" };
  }

  const action = raw.action;
  if (
    action !== "delegate" &&
    action !== "follow_up" &&
    action !== "retrieve_contribution" &&
    action !== "finish"
  ) {
    return {
      ok: false,
      error: `Invalid action "${String(action)}"; expected "delegate", "follow_up", "retrieve_contribution", or "finish"`,
    };
  }

  if (context.mustFinish && action !== "finish") {
    return {
      ok: false,
      error:
        'Final reserved lead call reached: you must return action="finish" with final_answer now.',
    };
  }

  const allowedList = Array.from(context.allowedTeammateIds).join(", ");

  if (action === "delegate") {
    if (!Array.isArray(raw.assignments) || raw.assignments.length === 0) {
      return {
        ok: false,
        error:
          'action="delegate" requires a non-empty "assignments" array.',
      };
    }

    const validatedAssignments: DelegateAssignmentSpec[] = [];
    for (let i = 0; i < raw.assignments.length; i += 1) {
      const item = raw.assignments[i];
      if (!isPlainObject(item)) {
        return {
          ok: false,
          error: `assignments[${i}] must be an object`,
        };
      }
      if (!isNonEmptyString(item.participant_id)) {
        return {
          ok: false,
          error: `assignments[${i}].participant_id must be a non-empty string`,
        };
      }
      const pid = item.participant_id.trim();
      if (!context.allowedTeammateIds.has(pid)) {
        return {
          ok: false,
          error: `assignments[${i}].participant_id "${pid}" is not in allowed teammate roster [${allowedList}]`,
        };
      }
      if (!isNonEmptyString(item.title)) {
        return {
          ok: false,
          error: `assignments[${i}].title must be a non-empty string`,
        };
      }
      if (!isNonEmptyString(item.task)) {
        return {
          ok: false,
          error: `assignments[${i}].task must be a non-empty string`,
        };
      }
      if (
        item.context_notes !== undefined &&
        item.context_notes !== null &&
        typeof item.context_notes !== "string"
      ) {
        return {
          ok: false,
          error: `assignments[${i}].context_notes must be a string or null`,
        };
      }
      validatedAssignments.push({
        participant_id: pid,
        title: item.title.trim(),
        task: item.task.trim(),
        context_notes:
          typeof item.context_notes === "string" &&
          item.context_notes.trim().length > 0
            ? item.context_notes.trim()
            : null,
      });
    }

    return {
      ok: true,
      value: {
        action: "delegate",
        assignments: validatedAssignments,
        follow_up: null,
        retrieve_contribution_id: null,
        final_answer: null,
        used_contribution_ids: null,
        unresolved_issues: null,
        participant_summaries: null,
        disagreements: null,
      },
    };
  }

  if (action === "follow_up") {
    if (!isPlainObject(raw.follow_up)) {
      return {
        ok: false,
        error: 'action="follow_up" requires a "follow_up" object.',
      };
    }
    const fu = raw.follow_up;
    if (!isNonEmptyString(fu.participant_id)) {
      return {
        ok: false,
        error: "follow_up.participant_id must be a non-empty string",
      };
    }
    if (!isNonEmptyString(fu.assignment_id)) {
      return {
        ok: false,
        error: "follow_up.assignment_id must be a non-empty string",
      };
    }
    if (!isNonEmptyString(fu.question)) {
      return {
        ok: false,
        error: "follow_up.question must be a non-empty string",
      };
    }
    const pid = fu.participant_id.trim();
    const aid = fu.assignment_id.trim();

    if (!context.allowedTeammateIds.has(pid)) {
      return {
        ok: false,
        error: `follow_up.participant_id "${pid}" is not in allowed teammate roster [${allowedList}]`,
      };
    }
    const owner = context.validAssignments.get(aid);
    if (!owner) {
      const validIds = Array.from(context.validAssignments.keys()).join(", ");
      return {
        ok: false,
        error: `follow_up.assignment_id "${aid}" does not exist. Valid assignments: [${validIds}]`,
      };
    }
    if (owner !== pid) {
      return {
        ok: false,
        error: `follow_up.assignment_id "${aid}" belongs to "${owner}", not "${pid}"`,
      };
    }

    const validatedFollowUp: FollowUpSpec = {
      participant_id: pid,
      assignment_id: aid,
      question: fu.question.trim(),
    };

    return {
      ok: true,
      value: {
        action: "follow_up",
        assignments: null,
        follow_up: validatedFollowUp,
        retrieve_contribution_id: null,
        final_answer: null,
        used_contribution_ids: null,
        unresolved_issues: null,
        participant_summaries: null,
        disagreements: null,
      },
    };
  }

  if (action === "retrieve_contribution") {
    if (!isNonEmptyString(raw.retrieve_contribution_id)) {
      return {
        ok: false,
        error:
          'action="retrieve_contribution" requires a non-empty "retrieve_contribution_id".',
      };
    }
    const cid = raw.retrieve_contribution_id.trim();
    const pool = context.retrievableContributionIds ?? context.validContributionIds;
    if (!pool.has(cid)) {
      return {
        ok: false,
        error: `retrieve_contribution_id "${cid}" was not found in available contributions [${Array.from(pool).join(", ")}]`,
      };
    }
    return {
      ok: true,
      value: {
        action: "retrieve_contribution",
        assignments: null,
        follow_up: null,
        retrieve_contribution_id: cid,
        final_answer: null,
        used_contribution_ids: null,
        unresolved_issues: null,
        participant_summaries: null,
        disagreements: null,
      },
    };
  }

  if (!isNonEmptyString(raw.final_answer)) {
    return {
      ok: false,
      error: 'action="finish" requires a non-empty "final_answer" string.',
    };
  }

  const usedCheck = validateStringArray(
    raw.used_contribution_ids,
    "used_contribution_ids",
  );
  if (!usedCheck.ok) {
    return usedCheck;
  }

  const allowedCitations = new Set([
    ...context.validContributionIds,
    ...(context.retrievableContributionIds ?? []),
  ]);
  for (const cid of usedCheck.items) {
    if (!allowedCitations.has(cid)) {
      const validList = Array.from(allowedCitations).join(", ");
      return {
        ok: false,
        error: `used_contribution_ids contains unknown ID "${cid}". Valid contribution IDs: [${validList}]`,
      };
    }
  }

  const unresolvedCheck = validateStringArray(
    raw.unresolved_issues,
    "unresolved_issues",
  );
  if (!unresolvedCheck.ok) {
    return unresolvedCheck;
  }

  const summariesCheck = validateParticipantSummaries(
    raw.participant_summaries,
  );
  if (!summariesCheck.ok) {
    return summariesCheck;
  }

  const disagreementsCheck = validateStringArray(
    raw.disagreements,
    "disagreements",
  );
  if (!disagreementsCheck.ok) {
    return disagreementsCheck;
  }

  return {
    ok: true,
    value: {
      action: "finish",
      assignments: null,
      follow_up: null,
      retrieve_contribution_id: null,
      final_answer: raw.final_answer.trim(),
      used_contribution_ids: usedCheck.items,
      unresolved_issues: unresolvedCheck.items,
      participant_summaries: summariesCheck.items,
      disagreements: disagreementsCheck.items,
    },
  };
}

export function validateRoundtableOpeningPlan(
  raw: unknown,
  allowedTeammateIds: string[],
): { ok: true; value: RoundtableOpeningPlan } | { ok: false; error: string } {
  if (allowedTeammateIds.length === 0) {
    return {
      ok: false,
      error: "Cannot plan roundtable opening with zero teammates",
    };
  }
  const allowedSet = new Set(allowedTeammateIds);
  if (!isPlainObject(raw)) {
    return { ok: false, error: "Opening plan must be a JSON object" };
  }
  const openerRaw = isNonEmptyString(raw.opening_participant_id)
    ? raw.opening_participant_id.trim()
    : allowedTeammateIds[0]!;
  if (!allowedSet.has(openerRaw)) {
    return {
      ok: false,
      error: `opening_participant_id "${openerRaw}" is not in allowed teammate roster [${allowedTeammateIds.join(", ")}]`,
    };
  }

  const ordered: string[] = [openerRaw];
  const seen = new Set<string>([openerRaw]);
  if (Array.isArray(raw.discussion_order)) {
    for (const id of raw.discussion_order) {
      if (typeof id !== "string") continue;
      const trimmed = id.trim();
      if (allowedSet.has(trimmed) && !seen.has(trimmed)) {
        seen.add(trimmed);
        ordered.push(trimmed);
      }
    }
  }
  for (const fallbackId of allowedTeammateIds) {
    if (!seen.has(fallbackId)) {
      seen.add(fallbackId);
      ordered.push(fallbackId);
    }
  }

  const framingNote =
    typeof raw.framing_note === "string" && raw.framing_note.trim().length > 0
      ? raw.framing_note.trim()
      : null;

  return {
    ok: true,
    value: {
      opening_participant_id: openerRaw,
      discussion_order: ordered,
      framing_note: framingNote,
    },
  };
}
