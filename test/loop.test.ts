import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RUN_LIMITS, resolveRunLimits, runLeadDelegation } from "../src/orchestration/loop.js";
import type { AdapterRegistry } from "../src/providers/registry.js";
import { sendTurnWithFallback } from "../src/providers/shared.js";
import type {
  ProviderAdapter,
  ProviderCheckResult,
  ProviderEvent,
  ProviderId,
  ProviderSessionHandle,
  StartSessionOptions,
  TurnInput,
  TurnResult,
} from "../src/types/provider.js";

type ScriptedHandler = (
  handle: ProviderSessionHandle,
  input: TurnInput,
  turnIndex: number,
) => Promise<TurnResult> | TurnResult;

class ScriptedMockAdapter implements ProviderAdapter {
  readonly turns = new Map<string, number>();

  constructor(
    readonly id: ProviderId,
    private readonly handler: ScriptedHandler,
  ) {}

  async checkAvailability(): Promise<ProviderCheckResult> {
    return {
      provider: this.id,
      discovery: {
        provider: this.id,
        executablePath: `/mock/${this.id}`,
        source: "override",
        version: "mock-1.0",
        candidatesChecked: [`/mock/${this.id}`],
      },
      outcome: "ok",
      elapsedMs: 1,
    };
  }

  async startSession(
    options: StartSessionOptions,
  ): Promise<ProviderSessionHandle> {
    return {
      participantId: options.participantId,
      provider: this.id,
      executablePath: options.executablePath ?? `/mock/${this.id}`,
      continuationMode: "native",
      systemPrompt: options.systemPrompt,
      cwd: options.cwd,
      readOnly: options.readOnly ?? true,
      allowReadOnlyTools: options.allowReadOnlyTools ?? true,
      model: options.model,
      turnCount: 0,
      history: [],
    };
  }

  async sendTurn(
    handle: ProviderSessionHandle,
    input: TurnInput,
  ): Promise<TurnResult> {
    const idx = (this.turns.get(handle.participantId) ?? 0) + 1;
    this.turns.set(handle.participantId, idx);
    const result = await this.handler(handle, input, idx);
    if (result.outcome === "ok") {
      handle.turnCount += 1;
      handle.providerSessionId = result.providerSessionId ?? handle.providerSessionId;
      handle.history.push(
        { role: "user", content: input.prompt, timestamp: new Date().toISOString() },
        { role: "assistant", content: result.text, timestamp: new Date().toISOString() },
      );
    }
    return result;
  }

  cancel(): boolean {
    return false;
  }
}

function makeRegistry(
  partial: Partial<Record<ProviderId, ProviderAdapter>>,
): AdapterRegistry {
  const fallback = new ScriptedMockAdapter("agy", async () => ({
    outcome: "ok",
    text: "unused",
    continuationMode: "native",
    elapsedMs: 1,
  }));
  return {
    codex: partial.codex ?? fallback,
    claude: partial.claude ?? fallback,
    agy: partial.agy ?? fallback,
  };
}

test("runLeadDelegation dispatches parallel delegate batch, routes follow_up, and finishes", async () => {
  const startedOrder: string[] = [];
  let releaseTeammates!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseTeammates = resolve;
  });

  const claudeLead = new ScriptedMockAdapter("claude", async (_h, _i, turn) => {
    if (turn === 1) {
      return {
        outcome: "ok",
        text: "delegating",
        structured: {
          action: "delegate",
          assignments: [
            {
              participant_id: "mate_codex_1",
              title: "Audit callers",
              task: "Check /v1/invoices clients",
              context_notes: null,
            },
            {
              participant_id: "mate_agy_1",
              title: "Check tests",
              task: "Check test coverage",
              context_notes: null,
            },
          ],
          follow_up: null,
          final_answer: null,
          used_contribution_ids: null,
          unresolved_issues: null,
        },
        providerSessionId: "lead-sess-1",
        continuationMode: "native",
        elapsedMs: 5,
      };
    }
    if (turn === 2) {
      return {
        outcome: "ok",
        text: "follow_up",
        structured: {
          action: "follow_up",
          assignments: null,
          follow_up: {
            participant_id: "mate_codex_1",
            assignment_id: "asgn_1",
            question: "Does iOS-FieldApp need amount_cents?",
          },
          final_answer: null,
          used_contribution_ids: null,
          unresolved_issues: null,
        },
        providerSessionId: "lead-sess-1",
        continuationMode: "native",
        elapsedMs: 5,
      };
    }
    return {
      outcome: "ok",
      text: "finish",
      structured: {
        action: "finish",
        assignments: null,
        follow_up: null,
        final_answer:
          "Keep /v1/invoices shim until Q3 for iOS-FieldApp v3.4 (amount_cents + idempotency_key).",
        used_contribution_ids: ["c_1", "c_2", "c_3"],
        unresolved_issues: [],
      },
      providerSessionId: "lead-sess-1",
      continuationMode: "native",
      elapsedMs: 5,
    };
  });

  const codexMate = new ScriptedMockAdapter("codex", async (_h, _i, turn) => {
    if (turn === 1) {
      startedOrder.push("codex");
      if (startedOrder.length === 2) releaseTeammates();
      await gate;
      return {
        outcome: "ok",
        text: "Found iOS-FieldApp v3.4 locked until Q3.",
        providerSessionId: "codex-sess-1",
        continuationMode: "native",
        elapsedMs: 5,
      };
    }
    return {
      outcome: "ok",
      text: "Confirmed: requires integer amount_cents and body idempotency_key.",
      providerSessionId: "codex-sess-1",
      continuationMode: "native",
      elapsedMs: 5,
    };
  });

  const agyMate = new ScriptedMockAdapter("agy", async () => {
    startedOrder.push("agy");
    if (startedOrder.length === 2) releaseTeammates();
    await gate;
    return {
      outcome: "ok",
      text: "Contract tests exist for /v1 shim.",
      providerSessionId: "agy-sess-1",
      continuationMode: "native",
      elapsedMs: 5,
    };
  });

  const result = await runLeadDelegation({
    prompt: "Can we migrate /v1/invoices this weekend?",
    lead: { id: "lead_claude_1", label: "claude lead", provider: "claude", role: "lead" },
    teammates: [
      { id: "mate_codex_1", label: "codex mate", provider: "codex", role: "teammate" },
      { id: "mate_agy_1", label: "agy mate", provider: "agy", role: "teammate" },
    ],
    limits: {
      maxLeadCalls: undefined,
      maxTotalCalls: undefined,
      perCallTimeoutMs: undefined,
      hardDeadlineMs: undefined,
    } as unknown as Partial<{
      maxLeadCalls: number;
      maxTotalCalls: number;
      perCallTimeoutMs: number;
      hardDeadlineMs: number;
    }>,
    adapters: makeRegistry({ claude: claudeLead, codex: codexMate, agy: agyMate }),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(startedOrder.sort(), ["agy", "codex"]);
  assert.equal(result.assignments.length, 2);
  assert.equal(result.contributions.length, 3);
  assert.deepEqual(result.usedContributionIds, ["c_1", "c_2", "c_3"]);
  assert.match(result.finalAnswer, /Q3/);
});

test("runLeadDelegation isolates two sessions of the same CLI provider", async () => {
  const sharedClaude = new ScriptedMockAdapter("claude", async (handle, input, turn) => {
    if (handle.participantId === "lead_claude_1") {
      if (turn === 1) {
        assert.ok(!handle.systemPrompt.includes("SECRET_Q3_FIXTURE"));
        return {
          outcome: "ok",
          text: "delegate",
          structured: {
            action: "delegate",
            assignments: [
              {
                participant_id: "mate_claude_2",
                title: "Check client constraint",
                task: "Inspect any hidden constraints",
                context_notes: null,
              },
            ],
            follow_up: null,
            final_answer: null,
            used_contribution_ids: null,
            unresolved_issues: null,
          },
          providerSessionId: "claude-session-lead",
          continuationMode: "native",
          elapsedMs: 2,
        };
      }
      assert.match(input.prompt, /SECRET_Q3_FIXTURE/);
      return {
        outcome: "ok",
        text: "finish",
        structured: {
          action: "finish",
          assignments: null,
          follow_up: null,
          final_answer: "Revised plan incorporates SECRET_Q3_FIXTURE.",
          used_contribution_ids: ["c_1"],
          unresolved_issues: [],
        },
        providerSessionId: "claude-session-lead",
        continuationMode: "native",
        elapsedMs: 2,
      };
    }

    assert.equal(handle.participantId, "mate_claude_2");
    assert.match(handle.systemPrompt, /SECRET_Q3_FIXTURE/);
    return {
      outcome: "ok",
      text: "Constraint observed: SECRET_Q3_FIXTURE",
      providerSessionId: "claude-session-mate",
      continuationMode: "native",
      elapsedMs: 2,
    };
  });

  const result = await runLeadDelegation({
    prompt: "Plan migration",
    lead: { id: "lead_claude_1", label: "claude lead", provider: "claude", role: "lead" },
    teammates: [
      {
        id: "mate_claude_2",
        label: "claude specialist",
        provider: "claude",
        role: "teammate",
        privateContext: "SECRET_Q3_FIXTURE",
      },
    ],
    adapters: makeRegistry({ claude: sharedClaude }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.leadParticipant.providerSessionId, "claude-session-lead");
  assert.equal(result.teammates[0]?.providerSessionId, "claude-session-mate");
  assert.notEqual(
    result.leadParticipant.providerSessionId,
    result.teammates[0]?.providerSessionId,
  );
  assert.match(result.finalAnswer, /SECRET_Q3_FIXTURE/);
});

test("runLeadDelegation isolates teammate timeouts locally and reserves lead synthesis call", async () => {
  let leadSawTimeout = false;
  const claudeLead = new ScriptedMockAdapter("claude", async (_h, input, turn) => {
    if (turn === 1) {
      return {
        outcome: "ok",
        text: "delegate",
        structured: {
          action: "delegate",
          assignments: [
            { participant_id: "mate_codex_1", title: "Fast check", task: "Run fast", context_notes: null },
            { participant_id: "mate_agy_1", title: "Slow check", task: "Run slow", context_notes: null },
          ],
          follow_up: null,
          final_answer: null,
          used_contribution_ids: null,
          unresolved_issues: null,
        },
        providerSessionId: "lead-1",
        continuationMode: "native",
        elapsedMs: 1,
      };
    }
    leadSawTimeout = input.prompt.includes("FAILED (timeout)") && input.prompt.includes("FINAL CALL NOTICE");
    return {
      outcome: "ok",
      text: "finish",
      structured: {
        action: "finish",
        assignments: null,
        follow_up: null,
        final_answer: "Used codex finding; agy timed out.",
        used_contribution_ids: ["c_1"],
        unresolved_issues: ["mate_agy_1 timed out"],
      },
      providerSessionId: "lead-1",
      continuationMode: "native",
      elapsedMs: 1,
    };
  });

  const codexMate = new ScriptedMockAdapter("codex", async () => ({
    outcome: "ok",
    text: "Codex succeeded cleanly.",
    providerSessionId: "codex-1",
    continuationMode: "native",
    elapsedMs: 1,
  }));

  const agyTimeout = new ScriptedMockAdapter("agy", async () => ({
    outcome: "timeout",
    text: "",
    continuationMode: "native",
    elapsedMs: 50,
    errorMessage: "Invocation timed out",
  }));

  const result = await runLeadDelegation({
    prompt: "Analyze repo",
    lead: { id: "lead_claude_1", label: "claude lead", provider: "claude", role: "lead" },
    teammates: [
      { id: "mate_codex_1", label: "codex", provider: "codex", role: "teammate" },
      { id: "mate_agy_1", label: "agy", provider: "agy", role: "teammate" },
    ],
    limits: { maxLeadCalls: 2, maxTotalCalls: 5, reserveSynthesisCall: true },
    adapters: makeRegistry({ claude: claudeLead, codex: codexMate, agy: agyTimeout }),
  });

  assert.equal(leadSawTimeout, true);
  assert.equal(result.status, "completed");
  assert.equal(result.assignments.find((a) => a.participantId === "mate_codex_1")?.status, "completed");
  assert.equal(result.assignments.find((a) => a.participantId === "mate_agy_1")?.status, "failed");
  assert.deepEqual(result.unresolvedIssues, ["mate_agy_1 timed out"]);
});

test("runLeadDelegation runs one repair turn for malformed lead action and tracks transcript fallback", async () => {
  const codexLead = new ScriptedMockAdapter("codex", async (handle, input, turn) => {
    if (turn === 1) {
      return {
        outcome: "ok",
        text: "not valid json",
        providerSessionId: "codex-lead-1",
        continuationMode: "native",
        elapsedMs: 1,
      };
    }
    if (turn === 2) {
      assert.match(input.prompt, /Validation error/);
      handle.continuationMode = "transcript_fallback";
      handle.fallbackReason = "Simulated resume failure";
      return {
        outcome: "ok",
        text: "finish",
        structured: {
          action: "finish",
          assignments: null,
          follow_up: null,
          final_answer: "Repaired finish answer.",
          used_contribution_ids: [],
          unresolved_issues: [],
        },
        providerSessionId: "codex-lead-2",
        continuationMode: "transcript_fallback",
        fallbackReason: "Simulated resume failure",
        elapsedMs: 1,
      };
    }
    throw new Error("Unexpected extra turn");
  });

  const result = await runLeadDelegation({
    prompt: "Quick question",
    lead: { id: "lead_codex_1", label: "codex lead", provider: "codex", role: "lead" },
    teammates: [],
    adapters: makeRegistry({ codex: codexLead }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.finalAnswer, "Repaired finish answer.");
  assert.equal(result.leadParticipant.continuationMode, "transcript_fallback");
  assert.ok(result.diagnostics.some((d) => d.code === "lead_repair_attempt"));
  assert.ok(result.diagnostics.some((d) => d.code === "session_fallback"));
});

test("sendTurnWithFallback degrades cleanly from failed native resume to transcript fallback", async () => {
  const handle: ProviderSessionHandle = {
    participantId: "mate_codex_1",
    provider: "codex",
    executablePath: "/mock/codex",
    continuationMode: "native",
    systemPrompt: "Be concise.",
    cwd: "/tmp",
    readOnly: true,
    allowReadOnlyTools: false,
    turnCount: 0,
    history: [],
  };

  const events: ProviderEvent[] = [];
  const calls: Array<{ resumeId?: string; prompt: string }> = [];

  const turn1 = await sendTurnWithFallback(
    handle,
    {
      prompt: "Remember the code 42.",
      timeoutMs: 5000,
      onEvent: (e) => events.push(e),
    },
    {
      composeTurn1WithSystem: true,
      executeOnce: async (promptPayload, resumeId) => {
        calls.push({ resumeId, prompt: promptPayload });
        return {
          outcome: "ok",
          text: "Remembered 42.",
          providerSessionId: "native-thread-1",
          continuationMode: handle.continuationMode,
          elapsedMs: 1,
        };
      },
    },
  );
  assert.equal(turn1.outcome, "ok");
  assert.equal(handle.providerSessionId, "native-thread-1");

  const turn2 = await sendTurnWithFallback(
    handle,
    {
      prompt: "What was the code?",
      timeoutMs: 5000,
      onEvent: (e) => events.push(e),
    },
    {
      composeTurn1WithSystem: true,
      executeOnce: async (promptPayload, resumeId) => {
        calls.push({ resumeId, prompt: promptPayload });
        if (resumeId) {
          return {
            outcome: "execution_error",
            text: "",
            continuationMode: handle.continuationMode,
            elapsedMs: 1,
            errorMessage: "thread not found",
          };
        }
        return {
          outcome: "ok",
          text: "The code is 42.",
          providerSessionId: "native-thread-2",
          continuationMode: handle.continuationMode,
          elapsedMs: 1,
        };
      },
    },
  );

  assert.equal(turn2.outcome, "ok");
  assert.equal(turn2.continuationMode, "transcript_fallback");
  assert.equal(turn2.fallbackReason, "thread not found");
  assert.equal(handle.continuationMode, "transcript_fallback");
  assert.equal(calls.length, 3);
  assert.equal(calls[1]?.resumeId, "native-thread-1");
  assert.equal(calls[2]?.resumeId, undefined);
  assert.match(calls[2]!.prompt, /Remember the code 42/);
  assert.ok(events.some((e) => e.type === "fallback_triggered"));
});

test("resolveRunLimits treats null, 0 and junk as no limit, and missing fields as defaults", () => {
  const limits = resolveRunLimits({
    maxLeadCalls: null,
    maxTotalCalls: 0,
    perCallTimeoutMs: Number.NaN,
    reserveSynthesisCall: false,
  });
  assert.deepEqual(limits, {
    maxLeadCalls: null,
    maxTotalCalls: null,
    perCallTimeoutMs: null,
    hardDeadlineMs: DEFAULT_RUN_LIMITS.hardDeadlineMs,
    reserveSynthesisCall: false,
  });
});

test("runLeadDelegation runs with no limits at all and gives adapters no timeout", async () => {
  const timeouts: number[] = [];
  let budgetLine = "";
  const lead = new ScriptedMockAdapter("claude", async (_h, input, turn) => {
    timeouts.push(input.timeoutMs);
    if (turn === 1) {
      return {
        outcome: "ok",
        text: "delegate",
        structured: {
          action: "delegate",
          assignments: [{ participant_id: "mate_codex_1", title: "Check", task: "Do it", context_notes: null }],
          follow_up: null,
          final_answer: null,
          used_contribution_ids: null,
          unresolved_issues: null,
        },
        continuationMode: "native",
        elapsedMs: 1,
      };
    }
    budgetLine = /Budget status:[^\n]*/.exec(input.prompt)?.[0] ?? "";
    return {
      outcome: "ok",
      text: "finish",
      structured: {
        action: "finish",
        assignments: null,
        follow_up: null,
        final_answer: "Done.",
        used_contribution_ids: ["c_1"],
        unresolved_issues: null,
      },
      continuationMode: "native",
      elapsedMs: 1,
    };
  });
  const mate = new ScriptedMockAdapter("codex", async (_h, input) => {
    timeouts.push(input.timeoutMs);
    return { outcome: "ok", text: "Found it.", continuationMode: "native", elapsedMs: 1 };
  });

  const result = await runLeadDelegation({
    prompt: "Analyze",
    lead: { id: "lead_claude_1", label: "claude lead", provider: "claude", role: "lead" },
    teammates: [{ id: "mate_codex_1", label: "codex", provider: "codex", role: "teammate" }],
    limits: { maxLeadCalls: null, maxTotalCalls: null, perCallTimeoutMs: null, hardDeadlineMs: null },
    adapters: makeRegistry({ claude: lead, codex: mate }),
  });

  assert.equal(result.status, "completed");
  assert.ok(timeouts.length >= 3);
  assert.ok(timeouts.every((t) => t === 0), `expected no timeouts, got ${timeouts.join(",")}`);
  assert.match(budgetLine, /remainingLeadCalls=unlimited, remainingTotalCalls=unlimited/);
});
