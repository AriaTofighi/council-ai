import assert from "node:assert/strict";
import test from "node:test";
import { validateLeadAction } from "../src/orchestration/schemas.js";

const baseContext = {
  allowedTeammateIds: new Set(["mate_codex_1", "mate_claude_2"]),
  validAssignments: new Map([["asgn_1", "mate_codex_1"]]),
  validContributionIds: new Set(["c_1"]),
};

test("validateLeadAction accepts valid delegate, follow_up, and finish", () => {
  const del = validateLeadAction(
    {
      action: "delegate",
      assignments: [
        {
          participant_id: "mate_codex_1",
          title: "Audit API",
          task: "Find client constraints",
          context_notes: null,
        },
      ],
      follow_up: null,
      final_answer: null,
      used_contribution_ids: null,
      unresolved_issues: null,
    },
    baseContext,
  );
  assert.equal(del.ok, true);

  const fu = validateLeadAction(
    {
      action: "follow_up",
      assignments: null,
      follow_up: {
        participant_id: "mate_codex_1",
        assignment_id: "asgn_1",
        question: "Confirm Q3 timeline",
      },
      final_answer: null,
      used_contribution_ids: null,
      unresolved_issues: null,
    },
    baseContext,
  );
  assert.equal(fu.ok, true);

  const fin = validateLeadAction(
    {
      action: "finish",
      assignments: null,
      follow_up: null,
      final_answer: "Keep /v1 shim until Q3.",
      used_contribution_ids: ["c_1"],
      unresolved_issues: [],
    },
    baseContext,
  );
  assert.equal(fin.ok, true);
});

test("validateLeadAction rejects out-of-roster delegation and mismatched follow_up", () => {
  const badRoster = validateLeadAction(
    {
      action: "delegate",
      assignments: [
        {
          participant_id: "lead_claude_1",
          title: "Self",
          task: "Self delegate",
          context_notes: null,
        },
      ],
    },
    baseContext,
  );
  assert.equal(badRoster.ok, false);

  const badOwner = validateLeadAction(
    {
      action: "follow_up",
      follow_up: {
        participant_id: "mate_claude_2",
        assignment_id: "asgn_1",
        question: "Wrong owner",
      },
    },
    baseContext,
  );
  assert.equal(badOwner.ok, false);
});

test("validateLeadAction enforces mustFinish and valid used_contribution_ids", () => {
  const mustFin = validateLeadAction(
    {
      action: "delegate",
      assignments: [
        {
          participant_id: "mate_codex_1",
          title: "Extra",
          task: "Work",
          context_notes: null,
        },
      ],
    },
    { ...baseContext, mustFinish: true },
  );
  assert.equal(mustFin.ok, false);

  const badCitation = validateLeadAction(
    {
      action: "finish",
      final_answer: "Done",
      used_contribution_ids: ["c_999"],
      unresolved_issues: [],
    },
    baseContext,
  );
  assert.equal(badCitation.ok, false);
});
