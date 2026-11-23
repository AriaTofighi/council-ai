import assert from "node:assert/strict";
import test from "node:test";
import { runOrchestratedTurn } from "../src/orchestration/index.js";
import type { AdapterRegistry } from "../src/providers/registry.js";
import type {
  ProviderAdapter,
  ProviderCheckResult,
  ProviderId,
  ProviderSessionHandle,
  StartSessionOptions,
  TurnInput,
  TurnResult,
} from "../src/types/provider.js";

class ScriptedAdapter implements ProviderAdapter {
  constructor(
    readonly id: ProviderId,
    private readonly handler: (
      handle: ProviderSessionHandle,
      input: TurnInput,
      turn: number,
    ) => Promise<TurnResult> | TurnResult,
  ) {}

  async checkAvailability(): Promise<ProviderCheckResult> {
    throw new Error("not used");
  }

  async startSession(options: StartSessionOptions): Promise<ProviderSessionHandle> {
    return {
      participantId: options.participantId,
      provider: this.id,
      executablePath: `/mock/${this.id}`,
      continuationMode: "native",
      systemPrompt: options.systemPrompt,
      cwd: options.cwd,
      readOnly: true,
      allowReadOnlyTools: options.allowReadOnlyTools ?? true,
      model: options.model,
      effort: options.effort,
      turnCount: 0,
      history: [],
    };
  }

  async sendTurn(handle: ProviderSessionHandle, input: TurnInput): Promise<TurnResult> {
    handle.turnCount += 1;
    const res = await this.handler(handle, input, handle.turnCount);
    if (res.providerSessionId) {
      handle.providerSessionId = res.providerSessionId;
    }
    return res;
  }

  cancel(): boolean {
    return false;
  }
}

function makeRegistry(partial: Partial<Record<ProviderId, ProviderAdapter>>): AdapterRegistry {
  const fallback = new ScriptedAdapter("agy", async () => ({
    outcome: "ok",
    text: "ok",
    continuationMode: "native",
    elapsedMs: 1,
  }));
  return {
    codex: partial.codex ?? fallback,
    claude: partial.claude ?? fallback,
    agy: partial.agy ?? fallback,
  };
}

test("sequential roundtable selects opener, shares attributed order, supports targeted author reply, and synthesizes", async () => {
  const codexPrompts: string[] = [];
  const agyPrompts: string[] = [];

  const claudeLead = new ScriptedAdapter("claude", async (_h, input, turn) => {
    if (turn === 1) {
      return {
        outcome: "ok",
        text: "plan",
        structured: {
          opening_participant_id: "mate_codex_1",
          discussion_order: ["mate_codex_1", "mate_agy_1"],
          framing_note: "Focus on rollback risk",
        },
        providerSessionId: "claude-lead-1",
        continuationMode: "native",
        elapsedMs: 2,
      };
    }
    if (turn === 2) {
      assert.match(input.prompt, /mate_codex_1/);
      assert.match(input.prompt, /mate_agy_1/);
      return {
        outcome: "ok",
        text: "follow_up",
        structured: {
          action: "follow_up",
          assignments: null,
          follow_up: {
            participant_id: "mate_codex_1",
            assignment_id: "asgn_1",
            question: "Does agy's rollback failure apply to deployed mobile clients?",
          },
          retrieve_contribution_id: null,
          final_answer: null,
          used_contribution_ids: null,
          unresolved_issues: null,
          participant_summaries: null,
          disagreements: null,
        },
        providerSessionId: "claude-lead-1",
        continuationMode: "native",
        elapsedMs: 2,
      };
    }
    return {
      outcome: "ok",
      text: "finish",
      structured: {
        action: "finish",
        assignments: null,
        follow_up: null,
        retrieve_contribution_id: null,
        final_answer: "Migrate with dual-write shim after fixing rollback trigger.",
        used_contribution_ids: ["c_1", "c_2", "c_3"],
        unresolved_issues: [],
        participant_summaries: [
          { participant_id: "mate_codex_1", added: "Proposed migration & clarified rollback scope" },
          { participant_id: "mate_agy_1", added: "Identified mobile rollback failure risk" },
        ],
        disagreements: ["Rollout timing before vs after Q3"],
      },
      providerSessionId: "claude-lead-1",
      continuationMode: "native",
      elapsedMs: 2,
    };
  });

  const codexMate = new ScriptedAdapter("codex", async (_h, input, turn) => {
    codexPrompts.push(input.prompt);
    if (turn === 1) {
      return {
        outcome: "ok",
        text: "Codex opening: migrate in two phases.",
        providerSessionId: "codex-rt-1",
        continuationMode: "native",
        elapsedMs: 2,
      };
    }
    assert.match(input.prompt, /Rollback fails for old client/i);
    return {
      outcome: "ok",
      text: "Clarification: yes, keep dual-read during rollback.",
      providerSessionId: "codex-rt-1",
      continuationMode: "native",
      elapsedMs: 2,
    };
  });

  const agyMate = new ScriptedAdapter("agy", async (_h, input) => {
    agyPrompts.push(input.prompt);
    assert.match(input.prompt, /Codex opening: migrate in two phases/);
    return {
      outcome: "ok",
      text: "Objection to c_1: Rollback fails for old client without dual-read.",
      providerSessionId: "agy-rt-1",
      continuationMode: "native",
      elapsedMs: 2,
    };
  });

  const result = await runOrchestratedTurn({
    prompt: "Should we migrate this service?",
    mode: "roundtable",
    independentFirstOpinions: false,
    lead: { id: "lead_claude_1", label: "claude lead", provider: "claude", role: "lead", model: "sonnet", effort: "low" },
    teammates: [
      { id: "mate_codex_1", label: "codex mate", provider: "codex", role: "teammate", model: "gpt-6-luna", effort: "low" },
      { id: "mate_agy_1", label: "agy mate", provider: "agy", role: "teammate", model: "gemini-3.8-flash-low" },
    ],
    adapters: makeRegistry({ claude: claudeLead, codex: codexMate, agy: agyMate }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.leadParticipant.model, "sonnet");
  assert.equal(result.leadParticipant.effort, "low");
  assert.equal(result.teammates[0]?.model, "gpt-6-luna");
  assert.equal(result.teammates[0]?.effort, "low");
  assert.equal(result.mode, "roundtable");
  assert.equal(result.roundtablePlan?.opening_participant_id, "mate_codex_1");
  assert.equal(result.contributions[0]?.kind, "opening_position");
  assert.equal(result.contributions[1]?.kind, "roundtable_turn");
  assert.equal(result.contributions[2]?.kind, "follow_up_reply");
  assert.equal(result.participantSummaries.length, 2);
  assert.deepEqual(result.disagreements, ["Rollout timing before vs after Q3"]);
});

test("roundtable with independentFirstOpinions collects blind openings in parallel", async () => {
  const seenInOpening: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });

  const claudeLead = new ScriptedAdapter("claude", async (_h, input) => {
    assert.match(input.prompt, /Codex blind position/);
    assert.match(input.prompt, /Agy blind position/);
    return {
      outcome: "ok",
      text: "finish",
      structured: {
        action: "finish",
        assignments: null,
        follow_up: null,
        retrieve_contribution_id: null,
        final_answer: "Synthesized independent openings.",
        used_contribution_ids: ["c_1", "c_2"],
        unresolved_issues: [],
        participant_summaries: [],
        disagreements: ["Codex prefers phase 1; Agy prefers canary"],
      },
      providerSessionId: "claude-ind-lead",
      continuationMode: "native",
      elapsedMs: 1,
    };
  });

  const codexMate = new ScriptedAdapter("codex", async (_h, input) => {
    seenInOpening.push("codex");
    if (seenInOpening.length === 2) release();
    await gate;
    assert.equal(input.prompt.includes("Agy blind position"), false);
    return {
      outcome: "ok",
      text: "Codex blind position",
      providerSessionId: "codex-blind-1",
      continuationMode: "native",
      elapsedMs: 1,
    };
  });

  const agyMate = new ScriptedAdapter("agy", async (_h, input) => {
    seenInOpening.push("agy");
    if (seenInOpening.length === 2) release();
    await gate;
    assert.equal(input.prompt.includes("Codex blind position"), false);
    return {
      outcome: "ok",
      text: "Agy blind position",
      providerSessionId: "agy-blind-1",
      continuationMode: "native",
      elapsedMs: 1,
    };
  });

  const result = await runOrchestratedTurn({
    prompt: "Evaluate architecture options",
    mode: "roundtable",
    independentFirstOpinions: true,
    lead: { id: "lead_claude_1", label: "claude lead", provider: "claude", role: "lead" },
    teammates: [
      { id: "mate_codex_1", label: "codex mate", provider: "codex", role: "teammate" },
      { id: "mate_agy_1", label: "agy mate", provider: "agy", role: "teammate" },
    ],
    adapters: makeRegistry({ claude: claudeLead, codex: codexMate, agy: agyMate }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.independentFirstOpinions, true);
  assert.equal(result.contributions[0]?.kind, "independent_opening");
  assert.equal(result.contributions[1]?.kind, "independent_opening");
});

test("multi-turn switch (roundtable -> divide_conquer + lead switch) preserves user decisions and supports retrieve_contribution", async () => {
  const codexLead = new ScriptedAdapter("codex", async (_h, input, turn) => {
    if (turn === 1) {
      assert.match(input.prompt, /LEAD SWITCH NOTICE/);
      assert.match(input.prompt, /USER MESSAGE \/ DECISION/);
      return {
        outcome: "ok",
        text: "retrieve",
        structured: {
          action: "retrieve_contribution",
          assignments: null,
          follow_up: null,
          retrieve_contribution_id: "t1_c_1",
          final_answer: null,
          used_contribution_ids: null,
          unresolved_issues: null,
          participant_summaries: null,
          disagreements: null,
        },
        providerSessionId: "codex-t2-lead",
        continuationMode: "native",
        elapsedMs: 1,
      };
    }
    assert.match(input.prompt, /VERBATIM_ORIGINAL_REPORT_FROM_TURN_1/);
    return {
      outcome: "ok",
      text: "finish",
      structured: {
        action: "finish",
        assignments: null,
        follow_up: null,
        retrieve_contribution_id: null,
        final_answer: "Rollout plan preserves Turn 1 decision and verbatim detail.",
        used_contribution_ids: ["t1_c_1"],
        unresolved_issues: [],
        participant_summaries: [],
        disagreements: [],
      },
      providerSessionId: "codex-t2-lead",
      continuationMode: "native",
      elapsedMs: 1,
    };
  });

  const result = await runOrchestratedTurn({
    prompt: "Turn that decision into a rollout plan.",
    mode: "divide_conquer",
    lead: { id: "lead_codex_1", label: "codex lead", provider: "codex", role: "lead" },
    teammates: [
      { id: "mate_claude_1", label: "claude mate", provider: "claude", role: "teammate" },
    ],
    priorTurns: [
      {
        turnIndex: 1,
        userMessage: "Should we keep the v1 shim until Q3?",
        mode: "roundtable",
        leadParticipantId: "lead_claude_1",
        leadProvider: "claude",
        leadLabel: "claude lead",
        finalAnswer: "Yes, keep the v1 shim until Q3.",
        userDecisions: ["Keep v1 shim until Q3"],
        unresolvedIssues: [],
        disagreements: [],
        usedContributionIds: ["c_1"],
        contributions: [
          {
            id: "t1_c_1",
            assignmentId: "asgn_1",
            participantId: "mate_agy_1",
            participantLabel: "agy mate",
            provider: "agy",
            kind: "opening_position",
            outcome: "ok",
            content: "VERBATIM_ORIGINAL_REPORT_FROM_TURN_1",
          },
        ],
      },
    ],
    adapters: makeRegistry({ codex: codexLead }),
  });

  assert.equal(result.status, "completed");
  assert.match(result.finalAnswer, /Rollout plan/);
  assert.deepEqual(result.usedContributionIds, ["t1_c_1"]);
});
