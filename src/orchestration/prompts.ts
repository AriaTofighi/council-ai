import type {
  AssignmentRecord,
  ContributionRecord,
  OrchestrationMode,
} from "../types/protocol.js";
import type {
  ParticipantConfig,
  WorkspaceSnapshotSummary,
} from "../types/session.js";
import { formatWorkspaceSnapshotContext } from "./context.js";

const NO_TOOLS_NOTICE =
  "Workspace and shell tools are disabled for this run. Do not attempt to run commands or read/search local files; answer directly from the prompt and any provided reference material.";

export interface PromptBuildOptions {
  allowReadOnlyTools?: boolean;
  mode?: OrchestrationMode;
  independentFirstOpinions?: boolean;
  snapshot?: WorkspaceSnapshotSummary;
}

export function buildLeadSystemPrompt(
  lead: ParticipantConfig,
  teammates: ParticipantConfig[],
  options: PromptBuildOptions = {},
): string {
  const mode = options.mode ?? "divide_conquer";
  const rosterLines =
    teammates.length > 0
      ? teammates
          .map(
            (t) =>
              `- participant_id: "${t.id}" | label: "${t.label}" | provider: "${t.provider}"`,
          )
          .join("\n")
      : "- (none)";

  const modeRules =
    mode === "roundtable"
      ? [
          "Mode: ROUNDTABLE.",
          options.independentFirstOpinions
            ? "- Independent first opinions are enabled: teammates first submit blind opening positions, which are then revealed together for your review."
            : "- Sequential roundtable: you select who opens, then each selected participant responds to the question and prior attributed turns in order.",
          "- After the opening pass, use follow_up to let an earlier author answer a reviewer's objection or clarify a disputed claim (their reply re-enters the shared discussion), retrieve_contribution if you need an un-truncated earlier turn, or finish once ready.",
          "- On finish, provide final_answer (synthesized recommendation), participant_summaries (what each participant added), disagreements (any unresolved disagreements), used_contribution_ids, and unresolved_issues.",
        ]
      : [
          "Mode: DIVIDE & CONQUER.",
          "- Break the problem into focused deliverables and delegate independent pieces in parallel in one delegate action; start dependent tasks once prerequisites return.",
          "- Account for every assignment you dispatched. If findings conflict across teammates, send a follow_up for revision before calling finish.",
          "- On finish, provide final_answer, participant_summaries (what each participant added), disagreements (open conflicts if any), used_contribution_ids, and unresolved_issues.",
        ];

  const snapshotBlock = options.snapshot
    ? `\n${formatWorkspaceSnapshotContext(options.snapshot)}\n`
    : "";

  const extra = lead.extraInstructions?.trim()
    ? `\nAdditional lead instructions:\n${lead.extraInstructions.trim()}\n`
    : "";

  const toolPolicy =
    options.allowReadOnlyTools === false ? `\n${NO_TOOLS_NOTICE}` : "";

  return [
    `You are the TEAM LEAD ("${lead.label}", participant_id: "${lead.id}", provider: "${lead.provider}") in a local read-only coding agent team.`,
    "",
    "Available teammates you may direct (strictly limited to this roster):",
    rosterLines,
    "",
    ...modeRules,
    "",
    "LeadAction JSON contract:",
    "Respond ONLY with a JSON object matching the LeadAction schema with one action:",
    '1. "delegate": assign deliverables in "assignments" (non-empty array). Never delegate to yourself. Set unused fields to null.',
    '2. "follow_up": send a targeted follow-up to a specific teammate regarding an existing assignment_id ("follow_up": { participant_id, assignment_id, question }). Set unused fields to null.',
    '3. "retrieve_contribution": fetch full verbatim text of a prior/summarized contribution by ID ("retrieve_contribution_id": "c_1" or prior ID). Set unused fields to null.',
    '4. "finish": return "final_answer", "used_contribution_ids", "unresolved_issues", "participant_summaries" ([{ participant_id, added }]), and "disagreements" ([...]). Set assignments, follow_up, and retrieve_contribution_id to null.',
    "",
    "Core accountability rules:",
    "- Keep failed or timed-out assignments visible in unresolved_issues and explain their impact in final_answer.",
    "- Distinguish explicit USER decisions from prior AGENT recommendations when continuing across turns or after a lead switch.",
    toolPolicy,
    snapshotBlock,
    extra,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
    .trim();
}

export function buildTeammateSystemPrompt(
  teammate: ParticipantConfig,
  options: PromptBuildOptions = {},
): string {
  const mode = options.mode ?? "divide_conquer";
  const parts = [
    `You are TEAMMATE "${teammate.label}" (participant_id: "${teammate.id}", provider: "${teammate.provider}") on a read-only planning and analysis team.`,
    mode === "roundtable"
      ? "You are participating in a structured technical roundtable. Give concise, evidence-backed positions, quote specific prior contributions when objecting or refining, and cite concrete files/lines or assumptions."
      : "Provide accurate, concise, evidence-backed findings for the assignment you receive from the team lead. Explicitly state constraints, files/lines, assumptions, and open questions.",
  ];

  if (options.allowReadOnlyTools === false) {
    parts.push("", NO_TOOLS_NOTICE);
  }

  if (options.snapshot) {
    parts.push("", formatWorkspaceSnapshotContext(options.snapshot));
  }

  if (teammate.extraInstructions?.trim()) {
    parts.push("", teammate.extraInstructions.trim());
  }

  if (teammate.privateContext?.trim()) {
    parts.push(
      "",
      "<teammate_reference_material>",
      teammate.privateContext.trim(),
      "</teammate_reference_material>",
    );
  }

  return parts.join("\n");
}

export function buildLeadInitialPrompt(
  userMessage: string,
  teammates: ParticipantConfig[],
  priorContextText?: string,
): string {
  const rosterIds = teammates.map((t) => `"${t.id}"`).join(", ");
  const parts: string[] = [];
  if (priorContextText?.trim()) {
    parts.push(priorContextText.trim(), "");
  }
  parts.push("<user_request>", userMessage.trim(), "</user_request>", "");
  parts.push(
    teammates.length > 0
      ? `Decide your next LeadAction JSON. Available teammate participant_id values: [${rosterIds}]. Delegate relevant discovery/analysis before calling finish.`
      : 'No teammates are assigned; decide your next LeadAction JSON (return action="finish").',
  );
  return parts.join("\n");
}

export function buildTeammateTaskPrompt(
  originalRequest: string,
  assignment: Pick<AssignmentRecord, "id" | "title" | "task" | "contextNotes">,
  priorContextText?: string,
): string {
  const lines: string[] = [];
  if (priorContextText?.trim()) {
    lines.push(priorContextText.trim(), "");
  }
  lines.push(
    "<original_user_request>",
    originalRequest.trim(),
    "</original_user_request>",
    "",
    `<assignment id="${assignment.id}" title="${assignment.title}">`,
    assignment.task.trim(),
    "</assignment>",
  );

  if (assignment.contextNotes?.trim()) {
    lines.push(
      "",
      "<context_notes>",
      assignment.contextNotes.trim(),
      "</context_notes>",
    );
  }

  lines.push(
    "",
    "Respond directly with your findings, constraints, and cited evidence/assumptions.",
  );

  return lines.join("\n");
}

export function formatAttributedContributions(
  contributions: ContributionRecord[],
): string {
  return contributions
    .map((c) => {
      const header = `<contribution id="${c.id}" assignment_id="${c.assignmentId}" participant_id="${c.participantId}" label="${c.participantLabel}" provider="${c.provider}" kind="${c.kind}" outcome="${c.outcome}" continuation_mode="${c.continuationMode}">`;
      const body =
        c.outcome === "ok"
          ? c.content.trim()
          : [
              `FAILED (${c.outcome}): ${c.errorMessage ?? "No error details"}`,
              c.content.trim()
                ? `Partial output:\n${c.content.trim()}`
                : undefined,
            ]
              .filter(Boolean)
              .join("\n");
      return `${header}\n${body}\n</contribution>`;
    })
    .join("\n\n");
}

export function buildLeadFeedbackPrompt(
  contributions: ContributionRecord[],
  budget: {
    remainingLeadCalls: number;
    remainingTotalCalls: number;
    mustFinish: boolean;
  },
  extraNotice?: string,
): string {
  const blocks = formatAttributedContributions(contributions);
  const footer = [
    extraNotice?.trim() ? extraNotice.trim() : undefined,
    `Budget status: remainingLeadCalls=${budget.remainingLeadCalls}, remainingTotalCalls=${budget.remainingTotalCalls}.`,
    budget.mustFinish
      ? 'FINAL CALL NOTICE: You MUST return action="finish" now, synthesizing all attributed contributions and noting unresolved issues or disagreements.'
      : 'Return your next LeadAction JSON ("delegate", "follow_up", "retrieve_contribution", or "finish"). Cite exact contribution IDs in used_contribution_ids when finishing.',
  ].filter(Boolean);

  return `${blocks}\n\n${footer.join("\n\n")}`;
}

export function buildLeadRepairPrompt(validationError: string): string {
  return [
    "Your previous response did not satisfy the LeadAction JSON contract.",
    `Validation error: ${validationError}`,
    "Respond ONLY with a corrected JSON object matching the LeadAction schema.",
  ].join("\n");
}

export function buildRoundtablePlanPrompt(
  userMessage: string,
  teammates: ParticipantConfig[],
  priorContextText?: string,
): string {
  const roster = teammates
    .map((t) => `- "${t.id}" (${t.label}, provider=${t.provider})`)
    .join("\n");
  const parts: string[] = [];
  if (priorContextText?.trim()) {
    parts.push(priorContextText.trim(), "");
  }
  parts.push(
    "<user_request>",
    userMessage.trim(),
    "</user_request>",
    "",
    "Roundtable Participants:",
    roster,
    "",
    "Choose which participant should open the roundtable, the exact discussion_order (include all teammate participant_id values), and an optional short framing_note for the panel.",
    "Respond ONLY with JSON matching the RoundtableOpeningPlan schema.",
  );
  return parts.join("\n");
}

export function buildRoundtableOpeningPrompt(params: {
  originalRequest: string;
  priorContextText?: string;
  framingNote?: string | null;
  isBlindIndependent: boolean;
}): string {
  const parts: string[] = [];
  if (params.priorContextText?.trim()) {
    parts.push(params.priorContextText.trim(), "");
  }
  parts.push(
    "<original_user_request>",
    params.originalRequest.trim(),
    "</original_user_request>",
  );
  if (params.framingNote) {
    parts.push("", `<lead_framing_note>\n${params.framingNote}\n</lead_framing_note>`);
  }
  parts.push(
    "",
    params.isBlindIndependent
      ? "Provide your independent opening position now (other participants' positions are hidden until everyone responds). State your recommendation, key reasoning, risks, and cited files/assumptions."
      : "You are opening the roundtable discussion. State your clear initial recommendation, key reasoning, assumptions, and concrete evidence.",
  );
  return parts.join("\n");
}

export function buildRoundtableSequentialPrompt(params: {
  originalRequest: string;
  priorContextText?: string;
  discussionSoFar: ContributionRecord[];
  framingNote?: string | null;
}): string {
  const parts: string[] = [];
  if (params.priorContextText?.trim()) {
    parts.push(params.priorContextText.trim(), "");
  }
  parts.push(
    "<original_user_request>",
    params.originalRequest.trim(),
    "</original_user_request>",
  );
  if (params.framingNote) {
    parts.push("", `<lead_framing_note>\n${params.framingNote}\n</lead_framing_note>`);
  }
  if (params.discussionSoFar.length > 0) {
    parts.push(
      "",
      "<roundtable_discussion_so_far>",
      formatAttributedContributions(params.discussionSoFar),
      "</roundtable_discussion_so_far>",
    );
  }
  parts.push(
    "",
    "Respond to the original question and the attributed discussion above. Add a concrete correction, objection, alternative, or endorsement with reasons and cited evidence/assumptions (reference prior contribution IDs or authors where relevant).",
  );
  return parts.join("\n");
}

export function buildRoundtableFollowUpPrompt(params: {
  originalRequest: string;
  discussionSoFar: ContributionRecord[];
  assignment: Pick<AssignmentRecord, "id" | "title">;
  question: string;
}): string {
  return [
    "<original_user_request>",
    params.originalRequest.trim(),
    "</original_user_request>",
    "",
    "<shared_roundtable_discussion>",
    formatAttributedContributions(params.discussionSoFar),
    "</shared_roundtable_discussion>",
    "",
    `<targeted_follow_up assignment_id="${params.assignment.id}" title="${params.assignment.title}">`,
    params.question.trim(),
    "</targeted_follow_up>",
    "",
    "Respond directly to the lead's question and any critiques/points raised in the shared discussion.",
  ].join("\n");
}
