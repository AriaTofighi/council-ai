import assert from "node:assert/strict";
import test from "node:test";
import { CouncilRunManager } from "../src/server/run-manager.js";
import { CouncilDatabase } from "../src/storage/db.js";
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

class MockAdapter implements ProviderAdapter {
  calls = 0;

  constructor(
    readonly id: ProviderId,
    private readonly fn: (
      handle: ProviderSessionHandle,
      input: TurnInput,
      callIndex: number,
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
      allowReadOnlyTools: true,
      turnCount: 0,
      history: [],
    };
  }

  async sendTurn(handle: ProviderSessionHandle, input: TurnInput): Promise<TurnResult> {
    this.calls += 1;
    handle.turnCount += 1;
    return this.fn(handle, input, this.calls);
  }

  cancel(): boolean {
    return false;
  }
}

test("SQLite crash recovery marks interrupted runs/assignments while preserving completed work", () => {
  const db = new CouncilDatabase(":memory:");
  const chat = db.createChat({ id: "chat_1", title: "Recovery Test" });
  db.createRun({
    id: "run_1",
    chatId: chat.id,
    turnIndex: 1,
    userMessage: "Analyze repo",
    mode: "divide_conquer",
    independentFirstOpinions: false,
    leadConfig: { id: "lead_claude_1", label: "claude lead", provider: "claude", role: "lead" },
    teammatesConfig: [
      { id: "mate_codex_1", label: "codex", provider: "codex", role: "teammate" },
      { id: "mate_agy_1", label: "agy", provider: "agy", role: "teammate" },
    ],
    limits: {
      maxLeadCalls: 4,
      maxTotalCalls: 8,
      perCallTimeoutMs: 5000,
      hardDeadlineMs: 10000,
      reserveSynthesisCall: true,
    },
    allowReadOnlyTools: true,
  });

  db.insertAssignment("run_1", {
    id: "asgn_1",
    participantId: "mate_codex_1",
    participantLabel: "codex",
    provider: "codex",
    title: "Completed task",
    task: "Done before crash",
    status: "completed",
    acceptedContributionId: "c_1",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });
  db.insertContribution("run_1", {
    id: "c_1",
    assignmentId: "asgn_1",
    participantId: "mate_codex_1",
    participantLabel: "codex",
    provider: "codex",
    continuationMode: "native",
    kind: "initial_report",
    promptSent: "prompt",
    outcome: "ok",
    content: "Preserved codex report",
    elapsedMs: 10,
    createdAt: new Date().toISOString(),
  });
  db.insertAssignment("run_1", {
    id: "asgn_2",
    participantId: "mate_agy_1",
    participantLabel: "agy",
    provider: "agy",
    title: "Interrupted task",
    task: "Running during crash",
    status: "running",
    createdAt: new Date().toISOString(),
  });

  const recovered = db.recoverInterruptedRuns();
  assert.equal(recovered.recoveredRuns, 1);
  assert.equal(recovered.recoveredAssignments, 1);

  const hydrated = db.getHydratedRun("run_1")!;
  assert.equal(hydrated.status, "interrupted");
  assert.equal(hydrated.assignments.find((a) => a.id === "asgn_1")?.status, "completed");
  assert.equal(hydrated.assignments.find((a) => a.id === "asgn_2")?.status, "interrupted");
  assert.equal(hydrated.contributions[0]?.content, "Preserved codex report");
  db.close();
});

test("CouncilRunManager retryAssignment reuses completed siblings and produces one accepted reply", async () => {
  let agyAttempt = 0;

  const claudeLead = new MockAdapter("claude", async (_h, input, call) => {
    if (call === 1) {
      return {
        outcome: "ok",
        text: "delegate",
        structured: {
          action: "delegate",
          assignments: [
            { participant_id: "mate_codex_1", title: "Part A", task: "Check A", context_notes: null },
            { participant_id: "mate_agy_1", title: "Part B", task: "Check B", context_notes: null },
          ],
          follow_up: null,
          retrieve_contribution_id: null,
          final_answer: null,
          used_contribution_ids: null,
          unresolved_issues: null,
          participant_summaries: null,
          disagreements: null,
        },
        providerSessionId: "claude-1",
        continuationMode: "native",
        elapsedMs: 1,
      };
    }
    const hasRetryReply = input.prompt.includes("Agy recovered finding");
    return {
      outcome: "ok",
      text: "finish",
      structured: {
        action: "finish",
        assignments: null,
        follow_up: null,
        retrieve_contribution_id: null,
        final_answer: hasRetryReply
          ? "Synthesized both Codex and recovered Agy findings."
          : "Partial synthesis without Agy.",
        used_contribution_ids: hasRetryReply ? ["c_1", "c_3"] : ["c_1"],
        unresolved_issues: hasRetryReply ? [] : ["agy timed out"],
        participant_summaries: [],
        disagreements: [],
      },
      providerSessionId: "claude-1",
      continuationMode: "native",
      elapsedMs: 1,
    };
  });

  const codexMate = new MockAdapter("codex", async () => ({
    outcome: "ok",
    text: "Codex finding",
    providerSessionId: "codex-1",
    continuationMode: "native",
    elapsedMs: 1,
  }));

  const agyMate = new MockAdapter("agy", async () => {
    agyAttempt += 1;
    if (agyAttempt === 1) {
      return {
        outcome: "timeout",
        text: "",
        continuationMode: "native",
        elapsedMs: 5,
        errorMessage: "Timed out",
      };
    }
    return {
      outcome: "ok",
      text: "Agy recovered finding",
      providerSessionId: "agy-2",
      continuationMode: "native",
      elapsedMs: 2,
    };
  });

  const adapters: AdapterRegistry = {
    codex: codexMate,
    claude: claudeLead,
    agy: agyMate,
  };
  const db = new CouncilDatabase(":memory:");
  const manager = new CouncilRunManager(db, { adapters });
  const chat = db.createChat({ id: "chat_retry", title: "Retry Chat" });

  const initialRun = await manager.startTurn(chat.id, {
    prompt: "Check A and B",
    mode: "divide_conquer",
    lead: { provider: "claude", label: "claude lead" },
    teammates: [
      { provider: "codex", label: "codex mate" },
      { provider: "agy", label: "agy mate" },
    ],
  });
  await manager.waitForRun(initialRun.id);

  assert.equal(codexMate.calls, 1);
  assert.equal(agyMate.calls, 1);

  const started = await manager.retryAssignment(initialRun.id, "asgn_2", {
    synthesize: true,
  });
  // Retries run in the background like a turn: the run is "running" until it settles.
  assert.equal(started.status, "running");
  await manager.waitForRun(initialRun.id);
  const retried = db.getHydratedRun(initialRun.id)!;
  assert.equal(retried.errorMessage, undefined, "a recovered run drops its old error");
  const types = db.listRunEvents(initialRun.id).map((e) => e.event.type);
  const resumedAt = types.lastIndexOf("run_resumed");
  assert.ok(resumedAt > 0, "retry announces itself with run_resumed");
  assert.deepEqual(
    types.slice(resumedAt).filter((t) => t !== "agent_activity"),
    ["run_resumed", "assignment_started", "assignment_completed", "lead_thinking", "run_finished"],
  );

  // Codex must NOT be re-run when retrying Agy's assignment
  assert.equal(codexMate.calls, 1);
  assert.equal(agyMate.calls, 2);

  assert.equal(retried.status, "completed");
  assert.match(retried.finalAnswer ?? "", /recovered Agy findings/);

  const asgn2 = retried.assignments.find((a) => a.id === "asgn_2")!;
  assert.equal(asgn2.status, "completed");
  assert.equal(asgn2.acceptedContributionId, "c_3");

  const oldC2 = retried.contributions.find((c) => c.id === "c_2")!;
  assert.equal(oldC2.supersededBy, "c_3");
  const activeForAsgn2 = retried.contributions.filter(
    (c) => c.assignmentId === "asgn_2" && !c.supersededBy,
  );
  assert.equal(activeForAsgn2.length, 1);
  assert.equal(activeForAsgn2[0]?.id, "c_3");

  db.close();
});
