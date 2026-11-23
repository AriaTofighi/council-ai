import crypto from "node:crypto";
import path from "node:path";
import {
  resolveRunLimits,
  runOrchestratedTurn,
  synthesizeFromContributions,
} from "../orchestration/index.js";
import { buildTeammateSystemPrompt, buildTeammateTaskPrompt } from "../orchestration/prompts.js";
import {
  createDefaultAdapters,
  type AdapterRegistry,
} from "../providers/registry.js";
import type { CouncilDatabase, HydratedRun, StoredRunEvent } from "../storage/db.js";
import type { ProviderId, ReasoningEffort } from "../types/provider.js";
import type {
  ContributionRecord,
  OrchestrationMode,
} from "../types/protocol.js";
import type {
  ParticipantConfig,
  RunEvent,
  RunLimits,
  WorkspaceSnapshotSummary,
} from "../types/session.js";
import { createReadOnlySnapshot } from "../workspace/snapshot.js";

export interface ParticipantInputSpec {
  provider: ProviderId;
  label?: string;
  model?: string;
  effort?: ReasoningEffort;
  extraInstructions?: string;
  privateContext?: string;
}

export interface StartTurnRequest {
  prompt: string;
  mode: OrchestrationMode;
  independentFirstOpinions?: boolean;
  lead: ParticipantInputSpec;
  teammates: ParticipantInputSpec[];
  workspacePath?: string;
  selectedPaths?: string[];
  allowReadOnlyTools?: boolean;
  userDecisions?: string[];
  limits?: Partial<RunLimits>;
}

type RunEventListener = (stored: StoredRunEvent) => void;

function nowIso(): string {
  return new Date().toISOString();
}

export class CouncilRunManager {
  readonly adapters: AdapterRegistry;
  private readonly snapshotRootDir: string;
  private readonly executableOverrides: Partial<Record<ProviderId, string>>;
  private readonly activeAborts = new Map<string, AbortController>();
  private readonly activeTasks = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, Set<RunEventListener>>();

  constructor(
    readonly db: CouncilDatabase,
    options: {
      adapters?: AdapterRegistry;
      snapshotRootDir?: string;
      executableOverrides?: Partial<Record<ProviderId, string>>;
    } = {},
  ) {
    this.adapters = options.adapters ?? createDefaultAdapters();
    this.snapshotRootDir =
      options.snapshotRootDir ?? path.resolve(".council", "snapshots");
    this.executableOverrides = options.executableOverrides ?? {};
    this.db.recoverInterruptedRuns();
  }

  private emitAndPersistEvent(runId: string, event: RunEvent): void {
    const stored = this.db.appendRunEvent(runId, event);
    const set = this.listeners.get(runId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(stored);
      } catch {
        // Ignore subscriber errors
      }
    }
  }

  subscribeToRun(
    runId: string,
    afterSeq: number,
    listener: RunEventListener,
  ): () => void {
    const backlog = this.db.listRunEvents(runId, afterSeq);
    let lastSeq = afterSeq;
    for (const item of backlog) {
      listener(item);
      lastSeq = Math.max(lastSeq, item.seq);
    }

    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }

    const wrapped: RunEventListener = (stored) => {
      if (stored.seq <= lastSeq) return;
      lastSeq = stored.seq;
      listener(stored);
    };
    set.add(wrapped);

    return () => {
      const current = this.listeners.get(runId);
      if (!current) return;
      current.delete(wrapped);
      if (current.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }

  isRunActive(runId: string): boolean {
    return this.activeAborts.has(runId);
  }

  async waitForRun(runId: string): Promise<void> {
    const task = this.activeTasks.get(runId);
    if (task) {
      await task;
    }
  }

  async waitForAllRuns(): Promise<void> {
    await Promise.all(Array.from(this.activeTasks.values()));
  }

  private buildParticipants(
    leadSpec: ParticipantInputSpec,
    teamSpecs: ParticipantInputSpec[],
  ): { lead: ParticipantConfig; teammates: ParticipantConfig[] } {
    const counts = new Map<ProviderId, number>();
    const nextIdx = (provider: ProviderId): number => {
      const val = (counts.get(provider) ?? 0) + 1;
      counts.set(provider, val);
      return val;
    };

    const leadIdx = nextIdx(leadSpec.provider);
    const lead: ParticipantConfig = {
      id: `lead_${leadSpec.provider}_${leadIdx}`,
      label: leadSpec.label?.trim() || `${leadSpec.provider} lead`,
      provider: leadSpec.provider,
      role: "lead",
      executablePath: this.executableOverrides[leadSpec.provider],
      model: leadSpec.model?.trim() || undefined,
      effort: leadSpec.effort,
      extraInstructions: leadSpec.extraInstructions,
    };

    const teammates: ParticipantConfig[] = teamSpecs.map((spec) => {
      const idx = nextIdx(spec.provider);
      const defaultLabel =
        spec.provider === leadSpec.provider
          ? `${spec.provider} specialist #${idx}`
          : `${spec.provider} teammate #${idx}`;
      return {
        id: `mate_${spec.provider}_${idx}`,
        label: spec.label?.trim() || defaultLabel,
        provider: spec.provider,
        role: "teammate",
        executablePath: this.executableOverrides[spec.provider],
        model: spec.model?.trim() || undefined,
        effort: spec.effort,
        extraInstructions: spec.extraInstructions,
        privateContext: spec.privateContext,
      };
    });

    return { lead, teammates };
  }

  async startTurn(
    chatId: string,
    request: StartTurnRequest,
  ): Promise<HydratedRun> {
    const chat = this.db.getChat(chatId);
    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }
    const prompt = request.prompt?.trim();
    if (!prompt) {
      throw new Error("Prompt is required");
    }

    const existingRuns = this.db.getChatWithRuns(chatId)?.runs ?? [];
    if (existingRuns.some((r) => r.status === "running" && this.activeAborts.has(r.id))) {
      throw new Error("A turn is already running in this chat");
    }

    const { lead, teammates } = this.buildParticipants(
      request.lead,
      request.teammates,
    );
    const limits = resolveRunLimits(request.limits);
    const allowReadOnlyTools = request.allowReadOnlyTools ?? true;
    const workspacePath =
      request.workspacePath?.trim() || chat.workspacePath || undefined;

    let snapshot: WorkspaceSnapshotSummary | undefined;
    if (workspacePath) {
      snapshot = await createReadOnlySnapshot({
        sourcePath: workspacePath,
        selectedPaths: request.selectedPaths,
        snapshotRootDir: this.snapshotRootDir,
        providers: [lead.provider, ...teammates.map((t) => t.provider)],
        allowReadOnlyTools,
      });
      this.db.insertSnapshot(chatId, snapshot);
      this.db.updateChat(chatId, { workspacePath: snapshot.sourcePath });
    }

    const turnIndex = this.db.nextTurnIndex(chatId);
    const priorTurns = this.db.getPriorTurnsForChat(chatId);

    if (turnIndex === 1 && (chat.title === "New Chat" || !chat.title.trim())) {
      const compact = prompt.replace(/\s+/g, " ").trim();
      const autoTitle =
        compact.length > 52 ? `${compact.slice(0, 52)}...` : compact;
      this.db.updateChat(chatId, { title: autoTitle });
    }

    const runId = `run_${crypto.randomUUID().slice(0, 8)}`;
    this.db.createRun({
      id: runId,
      chatId,
      turnIndex,
      userMessage: prompt,
      mode: request.mode,
      independentFirstOpinions: Boolean(request.independentFirstOpinions),
      leadConfig: lead,
      teammatesConfig: teammates,
      limits,
      allowReadOnlyTools,
      snapshotId: snapshot?.id,
      userDecisions: request.userDecisions ?? [],
    });

    const controller = new AbortController();
    this.activeAborts.set(runId, controller);

    const task = (async () => {
      try {
        const result = await runOrchestratedTurn({
          runId,
          prompt,
          mode: request.mode,
          independentFirstOpinions: request.independentFirstOpinions,
          lead,
          teammates,
          priorTurns,
          snapshot,
          cwd: snapshot?.snapshotPath ?? process.cwd(),
          limits,
          allowReadOnlyTools,
          adapters: this.adapters,
          signal: controller.signal,
          hooks: {
            onAssignmentCreated: (assignment) => {
              this.db.insertAssignment(runId, assignment);
            },
            onAssignmentUpdated: (assignment) => {
              this.db.updateAssignment(runId, assignment);
            },
            onContributionRecorded: (contribution) => {
              this.db.insertContribution(runId, contribution);
            },
            onParticipantUpdated: (summary) => {
              this.db.upsertParticipant(chatId, runId, summary);
            },
            resolveHistoricalContribution: (cid) =>
              this.db.getContributionByLocalId(chatId, cid),
          },
          onEvent: (event) => {
            if (event.type === "roundtable_opening_planned") {
              this.db.updateRun(runId, { roundtablePlan: event.plan });
            }
            this.emitAndPersistEvent(runId, event);
          },
        });

        this.db.updateRun(runId, {
          status: result.status,
          roundtablePlan: result.roundtablePlan,
          finalAnswer: result.finalAnswer,
          usedContributionIds: result.usedContributionIds,
          unresolvedIssues: result.unresolvedIssues,
          participantSummaries: result.participantSummaries,
          disagreements: result.disagreements,
          leadActions: result.leadActions,
          diagnostics: result.diagnostics,
          errorMessage: result.errorMessage,
          elapsedMs: result.elapsedMs,
          completedAt: nowIso(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.db.updateRun(runId, {
          status: "failed",
          errorMessage: message,
          completedAt: nowIso(),
        });
        this.emitAndPersistEvent(runId, {
          type: "diagnostic",
          runId,
          diagnostic: {
            level: "error",
            code: "run_exception",
            message,
            timestamp: nowIso(),
          },
        });
        this.emitAndPersistEvent(runId, {
          type: "run_finished",
          runId,
          status: "failed",
          elapsedMs: 0,
        });
      } finally {
        this.activeAborts.delete(runId);
        this.activeTasks.delete(runId);
      }
    })();

    this.activeTasks.set(runId, task);
    return this.db.getHydratedRun(runId)!;
  }

  stopRun(runId: string): boolean {
    const controller = this.activeAborts.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async retryAssignment(
    runId: string,
    assignmentLocalId: string,
    options: { synthesize?: boolean } = {},
  ): Promise<HydratedRun> {
    if (this.activeAborts.has(runId)) {
      throw new Error("Cannot retry an assignment while the run is active");
    }

    const run = this.db.getHydratedRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const assignment = run.assignments.find((a) => a.id === assignmentLocalId);
    if (!assignment) {
      throw new Error(
        `Assignment "${assignmentLocalId}" not found in run ${runId}`,
      );
    }
    if (assignment.status !== "failed" && assignment.status !== "interrupted") {
      throw new Error(
        `Assignment "${assignmentLocalId}" has status "${assignment.status}" and does not need retry`,
      );
    }

    const mateConfig = run.teammatesConfig.find(
      (t) => t.id === assignment.participantId,
    );
    if (!mateConfig) {
      throw new Error(
        `Participant configuration for "${assignment.participantId}" not found`,
      );
    }

    assignment.status = "running";
    assignment.completedAt = undefined;
    this.db.updateAssignment(runId, assignment);
    this.emitAndPersistEvent(runId, {
      type: "assignment_started",
      runId,
      assignment,
    });

    const adapter = this.adapters[mateConfig.provider];
    const cwd = run.snapshot?.snapshotPath ?? process.cwd();
    const handle = await adapter.startSession({
      participantId: `${mateConfig.id}_retry_${crypto.randomUUID().slice(0, 6)}`,
      executablePath:
        this.executableOverrides[mateConfig.provider] ?? mateConfig.executablePath,
      systemPrompt: buildTeammateSystemPrompt(mateConfig, {
        allowReadOnlyTools: run.allowReadOnlyTools,
        mode: run.mode,
        snapshot: run.snapshot,
      }),
      cwd,
      readOnly: true,
      allowReadOnlyTools: run.allowReadOnlyTools,
      model: mateConfig.model,
      effort: mateConfig.effort,
    });

    const priorTurns = this.db
      .getPriorTurnsForChat(run.chatId)
      .filter((t) => t.turnIndex < run.turnIndex);

    const promptSent = buildTeammateTaskPrompt(run.userMessage, assignment);
    const turn = await adapter.sendTurn(handle, {
      prompt: promptSent,
      timeoutMs: run.limits.perCallTimeoutMs,
    });

    const nextContributionId = `c_${run.contributions.length + 1}`;
    const isOk = turn.outcome === "ok";
    const contribution: ContributionRecord = {
      id: nextContributionId,
      assignmentId: assignment.id,
      participantId: mateConfig.id,
      participantLabel: mateConfig.label,
      provider: mateConfig.provider,
      providerSessionId: turn.providerSessionId ?? handle.providerSessionId,
      continuationMode: turn.continuationMode,
      fallbackReason: turn.fallbackReason,
      kind: isOk
        ? run.mode === "roundtable"
          ? "roundtable_turn"
          : "initial_report"
        : "failure",
      promptSent,
      outcome: turn.outcome,
      content: turn.text,
      errorMessage: turn.errorMessage,
      usage: turn.usage,
      elapsedMs: turn.elapsedMs,
      createdAt: nowIso(),
    };

    assignment.status = isOk ? "completed" : "failed";
    assignment.completedAt = nowIso();
    if (isOk) {
      assignment.acceptedContributionId = contribution.id;
    }

    this.db.insertContribution(runId, contribution);
    if (isOk) {
      this.db.supersedeContributionsForAssignment(
        runId,
        assignment.id,
        contribution.id,
      );
    }
    this.db.updateAssignment(runId, assignment);
    this.db.upsertParticipant(run.chatId, runId, {
      participantId: mateConfig.id,
      label: mateConfig.label,
      provider: mateConfig.provider,
      role: "teammate",
      executablePath: handle.executablePath,
      providerSessionId: handle.providerSessionId,
      continuationMode: handle.continuationMode,
      fallbackReason: handle.fallbackReason,
      model: mateConfig.model,
      effort: mateConfig.effort,
      turnCount: handle.turnCount,
    });

    this.emitAndPersistEvent(runId, {
      type: "assignment_completed",
      runId,
      assignment,
      contribution,
    });

    if (isOk && options.synthesize !== false) {
      return this.synthesizeRun(runId, priorTurns);
    }

    return this.db.getHydratedRun(runId)!;
  }

  async synthesizeRun(
    runId: string,
    preloadedPriorTurns?: ReturnType<CouncilDatabase["getPriorTurnsForChat"]>,
  ): Promise<HydratedRun> {
    if (this.activeAborts.has(runId)) {
      throw new Error("Cannot synthesize while run is actively executing");
    }
    const run = this.db.getHydratedRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    const priorTurns =
      preloadedPriorTurns ??
      this.db
        .getPriorTurnsForChat(run.chatId)
        .filter((t) => t.turnIndex < run.turnIndex);

    const leadWithOverride: ParticipantConfig = {
      ...run.leadConfig,
      executablePath:
        this.executableOverrides[run.leadConfig.provider] ??
        run.leadConfig.executablePath,
    };

    const synthesis = await synthesizeFromContributions({
      prompt: run.userMessage,
      mode: run.mode,
      lead: leadWithOverride,
      teammates: run.teammatesConfig,
      priorTurns,
      snapshot: run.snapshot,
      contributions: run.contributions,
      cwd: run.snapshot?.snapshotPath ?? process.cwd(),
      timeoutMs: run.limits.perCallTimeoutMs,
      allowReadOnlyTools: run.allowReadOnlyTools,
      adapters: this.adapters,
    });

    this.db.upsertParticipant(run.chatId, runId, synthesis.leadParticipant);

    if (!synthesis.ok) {
      this.db.updateRun(runId, {
        status: "partial",
        errorMessage: synthesis.errorMessage,
      });
      return this.db.getHydratedRun(runId)!;
    }

    const hasRemainingFailure = run.assignments.some(
      (a) => a.status !== "completed",
    );

    this.db.updateRun(runId, {
      status: hasRemainingFailure ? "partial" : "completed",
      finalAnswer: synthesis.finalAnswer,
      usedContributionIds: synthesis.usedContributionIds,
      unresolvedIssues: synthesis.unresolvedIssues,
      participantSummaries: synthesis.participantSummaries,
      disagreements: synthesis.disagreements,
      errorMessage: undefined,
      completedAt: nowIso(),
    });

    this.emitAndPersistEvent(runId, {
      type: "run_finished",
      runId,
      status: hasRemainingFailure ? "partial" : "completed",
      elapsedMs: synthesis.elapsedMs,
    });

    return this.db.getHydratedRun(runId)!;
  }
}
