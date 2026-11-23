import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderId, ReasoningEffort } from "../types/provider.js";
import type {
  AssignmentRecord,
  AssignmentStatus,
  ContributionRecord,
  OrchestrationMode,
  ParticipantAddition,
  RoundtableOpeningPlan,
} from "../types/protocol.js";
import type {
  LeadActionRecord,
  ParticipantConfig,
  ParticipantSummary,
  PriorTurnContext,
  RunDiagnostic,
  RunEvent,
  RunLimits,
  RunStatus,
  WorkspaceSnapshotSummary,
} from "../types/session.js";

export interface ChatRecord {
  id: string;
  title: string;
  workspacePath?: string;
  createdAt: string;
  updatedAt: string;
}

/** A saved folder that chats can be started in; chats belong to it by matching workspace path. */
export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface StoredRunRecord {
  id: string;
  chatId: string;
  turnIndex: number;
  userMessage: string;
  mode: OrchestrationMode;
  independentFirstOpinions: boolean;
  status: RunStatus;
  leadConfig: ParticipantConfig;
  teammatesConfig: ParticipantConfig[];
  limits: RunLimits;
  allowReadOnlyTools: boolean;
  snapshotId?: string;
  roundtablePlan?: RoundtableOpeningPlan;
  finalAnswer?: string;
  usedContributionIds: string[];
  unresolvedIssues: string[];
  participantSummaries: ParticipantAddition[];
  disagreements: string[];
  leadActions: LeadActionRecord[];
  diagnostics: RunDiagnostic[];
  userDecisions: string[];
  errorMessage?: string;
  elapsedMs?: number;
  createdAt: string;
  completedAt?: string;
}

export interface HydratedRun extends StoredRunRecord {
  snapshot?: WorkspaceSnapshotSummary;
  participants: ParticipantSummary[];
  assignments: AssignmentRecord[];
  contributions: ContributionRecord[];
}

export interface ChatWithRuns {
  chat: ChatRecord;
  runs: HydratedRun[];
}

export interface StoredRunEvent {
  seq: number;
  runId: string;
  event: RunEvent;
  createdAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function makeScopedId(runId: string, localId: string): string {
  return `${runId}:${localId}`;
}

export class CouncilDatabase {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    if (dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        source_path TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        digest TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL,
        git_branch TEXT,
        git_commit TEXT,
        git_dirty INTEGER,
        files_preview_json TEXT NOT NULL,
        providers_json TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        turn_index INTEGER NOT NULL,
        user_message TEXT NOT NULL,
        mode TEXT NOT NULL,
        independent_first_opinions INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        lead_config_json TEXT NOT NULL,
        teammates_config_json TEXT NOT NULL,
        limits_json TEXT NOT NULL,
        allow_read_only_tools INTEGER NOT NULL DEFAULT 1,
        snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
        roundtable_plan_json TEXT,
        final_answer TEXT,
        used_contribution_ids_json TEXT NOT NULL DEFAULT '[]',
        unresolved_issues_json TEXT NOT NULL DEFAULT '[]',
        participant_summaries_json TEXT NOT NULL DEFAULT '[]',
        disagreements_json TEXT NOT NULL DEFAULT '[]',
        lead_actions_json TEXT NOT NULL DEFAULT '[]',
        diagnostics_json TEXT NOT NULL DEFAULT '[]',
        user_decisions_json TEXT NOT NULL DEFAULT '[]',
        error_message TEXT,
        elapsed_ms INTEGER,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS participants (
        pk TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        local_id TEXT NOT NULL,
        label TEXT NOT NULL,
        provider TEXT NOT NULL,
        role TEXT NOT NULL,
        executable_path TEXT NOT NULL DEFAULT '',
        model TEXT,
        effort TEXT,
        provider_session_id TEXT,
        continuation_mode TEXT NOT NULL DEFAULT 'native',
        fallback_reason TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assignments (
        pk TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        local_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        participant_label TEXT NOT NULL,
        provider TEXT NOT NULL,
        title TEXT NOT NULL,
        task TEXT NOT NULL,
        context_notes TEXT,
        status TEXT NOT NULL,
        accepted_contribution_id TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS contributions (
        pk TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        local_id TEXT NOT NULL,
        assignment_pk TEXT NOT NULL REFERENCES assignments(pk) ON DELETE CASCADE,
        assignment_local_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        participant_label TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        continuation_mode TEXT NOT NULL,
        fallback_reason TEXT,
        kind TEXT NOT NULL,
        prompt_sent TEXT NOT NULL,
        outcome TEXT NOT NULL,
        content TEXT NOT NULL,
        error_message TEXT,
        usage_json TEXT,
        elapsed_ms INTEGER NOT NULL,
        superseded_by TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runs_chat_turn ON runs(chat_id, turn_index);
      CREATE INDEX IF NOT EXISTS idx_assignments_run ON assignments(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_contributions_run ON contributions(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);
    `);
  }

  createChat(params: {
    id: string;
    title: string;
    workspacePath?: string;
  }): ChatRecord {
    const now = nowIso();
    this.db
      .prepare(
        "INSERT INTO chats (id, title, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        params.id,
        params.title,
        params.workspacePath ?? null,
        now,
        now,
      );
    return {
      id: params.id,
      title: params.title,
      workspacePath: params.workspacePath,
      createdAt: now,
      updatedAt: now,
    };
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE")
      .all() as Array<Record<string, unknown>>;
    return rows.map(toProject);
  }

  getProjectByPath(projectPath: string): ProjectRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE path = ?")
      .get(projectPath) as Record<string, unknown> | undefined;
    return row ? toProject(row) : undefined;
  }

  /** Saves a project, or returns the existing one for the same path. */
  createProject(params: { id: string; name: string; path: string }): ProjectRecord {
    const existing = this.getProjectByPath(params.path);
    if (existing) return existing;
    const now = nowIso();
    this.db
      .prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)")
      .run(params.id, params.name, params.path, now);
    return { ...params, createdAt: now };
  }

  /** Forgets the saved folder only; its chats are kept. */
  deleteProject(projectId: string): boolean {
    const res = this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    return Number(res.changes) > 0;
  }

  listChats(): ChatRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM chats ORDER BY updated_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      workspacePath:
        typeof r.workspace_path === "string" ? r.workspace_path : undefined,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  getChat(chatId: string): ChatRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM chats WHERE id = ?")
      .get(chatId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      title: String(row.title),
      workspacePath:
        typeof row.workspace_path === "string" ? row.workspace_path : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  updateChat(
    chatId: string,
    patch: { title?: string; workspacePath?: string | null },
  ): void {
    const current = this.getChat(chatId);
    if (!current) return;
    const nextTitle = patch.title ?? current.title;
    const nextWorkspace =
      patch.workspacePath === null
        ? null
        : patch.workspacePath !== undefined
          ? patch.workspacePath
          : current.workspacePath ?? null;
    this.db
      .prepare(
        "UPDATE chats SET title = ?, workspace_path = ?, updated_at = ? WHERE id = ?",
      )
      .run(nextTitle, nextWorkspace, nowIso(), chatId);
  }

  deleteChat(chatId: string): boolean {
    const res = this.db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
    return Number(res.changes) > 0;
  }

  insertSnapshot(
    chatId: string,
    snapshot: WorkspaceSnapshotSummary,
  ): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (
          id, chat_id, source_path, snapshot_path, digest, file_count, total_bytes,
          git_branch, git_commit, git_dirty, files_preview_json, providers_json,
          permissions_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        chatId,
        snapshot.sourcePath,
        snapshot.snapshotPath,
        snapshot.digest,
        snapshot.fileCount,
        snapshot.totalBytes,
        snapshot.gitBranch ?? null,
        snapshot.gitCommit ?? null,
        snapshot.gitDirty === undefined ? null : snapshot.gitDirty ? 1 : 0,
        JSON.stringify(snapshot.filesPreview),
        JSON.stringify(snapshot.providersReceivingMaterial),
        JSON.stringify(snapshot.effectivePermissions),
        snapshot.createdAt,
      );
  }

  getSnapshot(snapshotId: string): WorkspaceSnapshotSummary | undefined {
    const row = this.db
      .prepare("SELECT * FROM snapshots WHERE id = ?")
      .get(snapshotId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      sourcePath: String(row.source_path),
      snapshotPath: String(row.snapshot_path),
      digest: String(row.digest),
      fileCount: Number(row.file_count),
      totalBytes: Number(row.total_bytes),
      gitBranch: typeof row.git_branch === "string" ? row.git_branch : undefined,
      gitCommit: typeof row.git_commit === "string" ? row.git_commit : undefined,
      gitDirty:
        row.git_dirty === null || row.git_dirty === undefined
          ? undefined
          : Number(row.git_dirty) === 1,
      filesPreview: parseJson(row.files_preview_json, []),
      providersReceivingMaterial: parseJson(row.providers_json, []),
      effectivePermissions: parseJson(row.permissions_json, []),
      createdAt: String(row.created_at),
    };
  }

  listSnapshotsForChat(chatId: string): WorkspaceSnapshotSummary[] {
    const rows = this.db
      .prepare("SELECT id FROM snapshots WHERE chat_id = ? ORDER BY created_at DESC")
      .all(chatId) as Array<{ id: string }>;
    return rows
      .map((r) => this.getSnapshot(r.id))
      .filter((s): s is WorkspaceSnapshotSummary => Boolean(s));
  }

  nextTurnIndex(chatId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(turn_index), 0) AS max_turn FROM runs WHERE chat_id = ?",
      )
      .get(chatId) as { max_turn: number };
    return Number(row.max_turn) + 1;
  }

  createRun(params: {
    id: string;
    chatId: string;
    turnIndex: number;
    userMessage: string;
    mode: OrchestrationMode;
    independentFirstOpinions: boolean;
    leadConfig: ParticipantConfig;
    teammatesConfig: ParticipantConfig[];
    limits: RunLimits;
    allowReadOnlyTools: boolean;
    snapshotId?: string;
    userDecisions?: string[];
  }): StoredRunRecord {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO runs (
          id, chat_id, turn_index, user_message, mode, independent_first_opinions,
          status, lead_config_json, teammates_config_json, limits_json,
          allow_read_only_tools, snapshot_id, user_decisions_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.chatId,
        params.turnIndex,
        params.userMessage,
        params.mode,
        params.independentFirstOpinions ? 1 : 0,
        JSON.stringify(params.leadConfig),
        JSON.stringify(params.teammatesConfig),
        JSON.stringify(params.limits),
        params.allowReadOnlyTools ? 1 : 0,
        params.snapshotId ?? null,
        JSON.stringify(params.userDecisions ?? []),
        now,
      );
    this.db
      .prepare("UPDATE chats SET updated_at = ? WHERE id = ?")
      .run(now, params.chatId);

    return this.getRun(params.id)!;
  }

  updateRun(
    runId: string,
    patch: {
      status?: RunStatus;
      roundtablePlan?: RoundtableOpeningPlan;
      finalAnswer?: string;
      usedContributionIds?: string[];
      unresolvedIssues?: string[];
      participantSummaries?: ParticipantAddition[];
      disagreements?: string[];
      leadActions?: LeadActionRecord[];
      diagnostics?: RunDiagnostic[];
      userDecisions?: string[];
      /** Passing the key (even as undefined/null) sets it; a run that recovers clears its error. */
      errorMessage?: string | null;
      elapsedMs?: number;
      completedAt?: string;
    },
  ): void {
    const current = this.getRun(runId);
    if (!current) return;

    this.db
      .prepare(
        `UPDATE runs SET
          status = ?,
          roundtable_plan_json = ?,
          final_answer = ?,
          used_contribution_ids_json = ?,
          unresolved_issues_json = ?,
          participant_summaries_json = ?,
          disagreements_json = ?,
          lead_actions_json = ?,
          diagnostics_json = ?,
          user_decisions_json = ?,
          error_message = ?,
          elapsed_ms = ?,
          completed_at = ?
        WHERE id = ?`,
      )
      .run(
        patch.status ?? current.status,
        patch.roundtablePlan !== undefined
          ? JSON.stringify(patch.roundtablePlan)
          : current.roundtablePlan
            ? JSON.stringify(current.roundtablePlan)
            : null,
        patch.finalAnswer !== undefined
          ? patch.finalAnswer
          : current.finalAnswer ?? null,
        JSON.stringify(
          patch.usedContributionIds ?? current.usedContributionIds,
        ),
        JSON.stringify(patch.unresolvedIssues ?? current.unresolvedIssues),
        JSON.stringify(
          patch.participantSummaries ?? current.participantSummaries,
        ),
        JSON.stringify(patch.disagreements ?? current.disagreements),
        JSON.stringify(patch.leadActions ?? current.leadActions),
        JSON.stringify(patch.diagnostics ?? current.diagnostics),
        JSON.stringify(patch.userDecisions ?? current.userDecisions),
        "errorMessage" in patch
          ? (patch.errorMessage ?? null)
          : current.errorMessage ?? null,
        patch.elapsedMs !== undefined
          ? patch.elapsedMs
          : current.elapsedMs ?? null,
        patch.completedAt !== undefined
          ? patch.completedAt
          : current.completedAt ?? null,
        runId,
      );

    this.db
      .prepare("UPDATE chats SET updated_at = ? WHERE id = ?")
      .run(nowIso(), current.chatId);
  }

  getRun(runId: string): StoredRunRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapRunRow(row);
  }

  private mapRunRow(row: Record<string, unknown>): StoredRunRecord {
    return {
      id: String(row.id),
      chatId: String(row.chat_id),
      turnIndex: Number(row.turn_index),
      userMessage: String(row.user_message),
      mode: row.mode as OrchestrationMode,
      independentFirstOpinions: Number(row.independent_first_opinions) === 1,
      status: row.status as RunStatus,
      leadConfig: parseJson(row.lead_config_json, {
        id: "lead",
        label: "lead",
        provider: "claude",
        role: "lead",
      }),
      teammatesConfig: parseJson(row.teammates_config_json, []),
      limits: parseJson(row.limits_json, {
        maxLeadCalls: 6,
        maxTotalCalls: 14,
        perCallTimeoutMs: 90_000,
        hardDeadlineMs: 240_000,
        reserveSynthesisCall: true,
      }),
      allowReadOnlyTools: Number(row.allow_read_only_tools) === 1,
      snapshotId:
        typeof row.snapshot_id === "string" ? row.snapshot_id : undefined,
      roundtablePlan: parseJson<RoundtableOpeningPlan | undefined>(
        row.roundtable_plan_json,
        undefined,
      ),
      finalAnswer:
        typeof row.final_answer === "string" ? row.final_answer : undefined,
      usedContributionIds: parseJson(row.used_contribution_ids_json, []),
      unresolvedIssues: parseJson(row.unresolved_issues_json, []),
      participantSummaries: parseJson(row.participant_summaries_json, []),
      disagreements: parseJson(row.disagreements_json, []),
      leadActions: parseJson(row.lead_actions_json, []),
      diagnostics: parseJson(row.diagnostics_json, []),
      userDecisions: parseJson(row.user_decisions_json, []),
      errorMessage:
        typeof row.error_message === "string" ? row.error_message : undefined,
      elapsedMs:
        row.elapsed_ms === null || row.elapsed_ms === undefined
          ? undefined
          : Number(row.elapsed_ms),
      createdAt: String(row.created_at),
      completedAt:
        typeof row.completed_at === "string" ? row.completed_at : undefined,
    };
  }

  upsertParticipant(
    chatId: string,
    runId: string,
    summary: ParticipantSummary,
  ): void {
    const pk = makeScopedId(runId, summary.participantId);
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO participants (
          pk, chat_id, run_id, local_id, label, provider, role, executable_path,
          model, effort, provider_session_id, continuation_mode, fallback_reason,
          turn_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pk) DO UPDATE SET
          executable_path = excluded.executable_path,
          model = excluded.model,
          effort = excluded.effort,
          provider_session_id = COALESCE(excluded.provider_session_id, participants.provider_session_id),
          continuation_mode = excluded.continuation_mode,
          fallback_reason = excluded.fallback_reason,
          turn_count = excluded.turn_count,
          updated_at = excluded.updated_at`,
      )
      .run(
        pk,
        chatId,
        runId,
        summary.participantId,
        summary.label,
        summary.provider,
        summary.role,
        summary.executablePath,
        summary.model ?? null,
        summary.effort ?? null,
        summary.providerSessionId ?? null,
        summary.continuationMode,
        summary.fallbackReason ?? null,
        summary.turnCount,
        now,
        now,
      );
  }

  listParticipantsForRun(runId: string): ParticipantSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM participants WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      participantId: String(r.local_id),
      label: String(r.label),
      provider: r.provider as ProviderId,
      role: r.role as ParticipantSummary["role"],
      executablePath: String(r.executable_path),
      providerSessionId:
        typeof r.provider_session_id === "string"
          ? r.provider_session_id
          : undefined,
      continuationMode: r.continuation_mode as ParticipantSummary["continuationMode"],
      fallbackReason:
        typeof r.fallback_reason === "string" ? r.fallback_reason : undefined,
      model: typeof r.model === "string" ? r.model : undefined,
      effort: typeof r.effort === "string" ? (r.effort as ReasoningEffort) : undefined,
      turnCount: Number(r.turn_count),
    }));
  }

  insertAssignment(runId: string, assignment: AssignmentRecord): void {
    const pk = makeScopedId(runId, assignment.id);
    this.db
      .prepare(
        `INSERT INTO assignments (
          pk, run_id, local_id, participant_id, participant_label, provider,
          title, task, context_notes, status, accepted_contribution_id,
          created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pk,
        runId,
        assignment.id,
        assignment.participantId,
        assignment.participantLabel,
        assignment.provider,
        assignment.title,
        assignment.task,
        assignment.contextNotes ?? null,
        assignment.status,
        assignment.acceptedContributionId ?? null,
        assignment.createdAt,
        assignment.completedAt ?? null,
      );
  }

  updateAssignment(
    runId: string,
    assignment: AssignmentRecord,
  ): void {
    const pk = makeScopedId(runId, assignment.id);
    this.db
      .prepare(
        `UPDATE assignments SET
          status = ?,
          accepted_contribution_id = ?,
          completed_at = ?
        WHERE pk = ?`,
      )
      .run(
        assignment.status,
        assignment.acceptedContributionId ?? null,
        assignment.completedAt ?? null,
        pk,
      );
  }

  getAssignment(
    runId: string,
    assignmentLocalId: string,
  ): AssignmentRecord | undefined {
    const pk = makeScopedId(runId, assignmentLocalId);
    const row = this.db
      .prepare("SELECT * FROM assignments WHERE pk = ?")
      .get(pk) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapAssignmentRow(row);
  }

  listAssignmentsForRun(runId: string): AssignmentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM assignments WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapAssignmentRow(r));
  }

  private mapAssignmentRow(row: Record<string, unknown>): AssignmentRecord {
    return {
      id: String(row.local_id),
      participantId: String(row.participant_id),
      participantLabel: String(row.participant_label),
      provider: row.provider as ProviderId,
      title: String(row.title),
      task: String(row.task),
      contextNotes:
        typeof row.context_notes === "string" ? row.context_notes : undefined,
      status: row.status as AssignmentStatus,
      acceptedContributionId:
        typeof row.accepted_contribution_id === "string"
          ? row.accepted_contribution_id
          : undefined,
      createdAt: String(row.created_at),
      completedAt:
        typeof row.completed_at === "string" ? row.completed_at : undefined,
    };
  }

  insertContribution(
    runId: string,
    contribution: ContributionRecord,
  ): void {
    const pk = makeScopedId(runId, contribution.id);
    const assignmentPk = makeScopedId(runId, contribution.assignmentId);
    this.db
      .prepare(
        `INSERT INTO contributions (
          pk, run_id, local_id, assignment_pk, assignment_local_id,
          participant_id, participant_label, provider, provider_session_id,
          continuation_mode, fallback_reason, kind, prompt_sent, outcome,
          content, error_message, usage_json, elapsed_ms, superseded_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pk,
        runId,
        contribution.id,
        assignmentPk,
        contribution.assignmentId,
        contribution.participantId,
        contribution.participantLabel,
        contribution.provider,
        contribution.providerSessionId ?? null,
        contribution.continuationMode,
        contribution.fallbackReason ?? null,
        contribution.kind,
        contribution.promptSent,
        contribution.outcome,
        contribution.content,
        contribution.errorMessage ?? null,
        contribution.usage ? JSON.stringify(contribution.usage) : null,
        contribution.elapsedMs,
        contribution.supersededBy ?? null,
        contribution.createdAt,
      );
  }

  supersedeContributionsForAssignment(
    runId: string,
    assignmentLocalId: string,
    replacementContributionLocalId: string,
  ): void {
    const assignmentPk = makeScopedId(runId, assignmentLocalId);
    const replacementPk = makeScopedId(runId, replacementContributionLocalId);
    this.db
      .prepare(
        `UPDATE contributions
         SET superseded_by = ?
         WHERE assignment_pk = ? AND pk != ? AND superseded_by IS NULL`,
      )
      .run(replacementPk, assignmentPk, replacementPk);
  }

  listContributionsForRun(runId: string): ContributionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM contributions WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapContributionRow(r));
  }

  private mapContributionRow(
    row: Record<string, unknown>,
  ): ContributionRecord {
    const rawSuperseded =
      typeof row.superseded_by === "string" ? row.superseded_by : undefined;
    const supersededLocal =
      rawSuperseded && rawSuperseded.includes(":")
        ? rawSuperseded.split(":").slice(1).join(":")
        : rawSuperseded;

    return {
      id: String(row.local_id),
      assignmentId: String(row.assignment_local_id),
      participantId: String(row.participant_id),
      participantLabel: String(row.participant_label),
      provider: row.provider as ProviderId,
      providerSessionId:
        typeof row.provider_session_id === "string"
          ? row.provider_session_id
          : undefined,
      continuationMode:
        row.continuation_mode as ContributionRecord["continuationMode"],
      fallbackReason:
        typeof row.fallback_reason === "string" ? row.fallback_reason : undefined,
      kind: row.kind as ContributionRecord["kind"],
      promptSent: String(row.prompt_sent),
      outcome: row.outcome as ContributionRecord["outcome"],
      content: String(row.content),
      errorMessage:
        typeof row.error_message === "string" ? row.error_message : undefined,
      usage: parseJson(row.usage_json, undefined),
      elapsedMs: Number(row.elapsed_ms),
      supersededBy: supersededLocal,
      createdAt: String(row.created_at),
    };
  }

  getContributionByLocalId(
    chatId: string,
    localId: string,
  ):
    | {
        id: string;
        content: string;
        participantLabel: string;
        provider: string;
        kind: string;
      }
    | undefined {
    const turnScoped = /^t(\d+)_(.+)$/.exec(localId);
    const row = turnScoped
      ? (this.db
          .prepare(
            `SELECT c.local_id, c.content, c.participant_label, c.provider, c.kind, r.turn_index
             FROM contributions c
             JOIN runs r ON r.id = c.run_id
             WHERE r.chat_id = ? AND r.turn_index = ? AND c.local_id = ?
             LIMIT 1`,
          )
          .get(
            chatId,
            Number(turnScoped[1]),
            turnScoped[2]!,
          ) as Record<string, unknown> | undefined)
      : (this.db
          .prepare(
            `SELECT c.local_id, c.content, c.participant_label, c.provider, c.kind, r.turn_index
             FROM contributions c
             JOIN runs r ON r.id = c.run_id
             WHERE r.chat_id = ? AND c.local_id = ?
             ORDER BY r.turn_index DESC, c.created_at DESC
             LIMIT 1`,
          )
          .get(chatId, localId) as Record<string, unknown> | undefined);
    if (!row) return undefined;
    return {
      id: turnScoped ? localId : String(row.local_id),
      content: String(row.content),
      participantLabel: String(row.participant_label),
      provider: String(row.provider),
      kind: String(row.kind),
    };
  }

  appendRunEvent(runId: string, event: RunEvent): StoredRunEvent {
    const createdAt = nowIso();
    const res = this.db
      .prepare(
        "INSERT INTO run_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(runId, event.type, JSON.stringify(event), createdAt);
    return {
      seq: Number(res.lastInsertRowid),
      runId,
      event,
      createdAt,
    };
  }

  listRunEvents(runId: string, afterSeq = 0): StoredRunEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, run_id, payload_json, created_at FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC",
      )
      .all(runId, afterSeq) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: Number(r.seq),
      runId: String(r.run_id),
      event: JSON.parse(String(r.payload_json)) as RunEvent,
      createdAt: String(r.created_at),
    }));
  }

  /** Seq just before the latest run_resumed event (0 if the run was never resumed). */
  getResumeStartSeq(runId: string): number {
    const rows = this.db
      .prepare("SELECT seq, payload_json FROM run_events WHERE run_id = ? ORDER BY seq DESC")
      .all(runId) as Array<Record<string, unknown>>;
    for (const r of rows) {
      if (String(r.payload_json).includes('"type":"run_resumed"')) return Number(r.seq) - 1;
    }
    return 0;
  }

  getHydratedRun(runId: string): HydratedRun | undefined {
    const run = this.getRun(runId);
    if (!run) return undefined;
    return {
      ...run,
      snapshot: run.snapshotId ? this.getSnapshot(run.snapshotId) : undefined,
      participants: this.listParticipantsForRun(runId),
      assignments: this.listAssignmentsForRun(runId),
      contributions: this.listContributionsForRun(runId),
    };
  }

  getChatWithRuns(chatId: string): ChatWithRuns | undefined {
    const chat = this.getChat(chatId);
    if (!chat) return undefined;
    const runRows = this.db
      .prepare("SELECT id FROM runs WHERE chat_id = ? ORDER BY turn_index ASC")
      .all(chatId) as Array<{ id: string }>;
    const runs = runRows
      .map((r) => this.getHydratedRun(r.id))
      .filter((r): r is HydratedRun => Boolean(r));
    return { chat, runs };
  }

  getPriorTurnsForChat(chatId: string): PriorTurnContext[] {
    const chatWithRuns = this.getChatWithRuns(chatId);
    if (!chatWithRuns) return [];
    return chatWithRuns.runs
      .filter((r) => r.status !== "running")
      .map((r) => ({
        turnIndex: r.turnIndex,
        userMessage: r.userMessage,
        mode: r.mode,
        leadParticipantId: r.leadConfig.id,
        leadProvider: r.leadConfig.provider,
        leadLabel: r.leadConfig.label,
        finalAnswer: r.finalAnswer ?? "(No final answer produced)",
        userDecisions: r.userDecisions,
        unresolvedIssues: r.unresolvedIssues,
        disagreements: r.disagreements,
        usedContributionIds: r.usedContributionIds,
        contributions: r.contributions
          .filter((c) => !c.supersededBy)
          .map((c) => ({
            id: `t${r.turnIndex}_${c.id}`,
            assignmentId: c.assignmentId,
            participantId: c.participantId,
            participantLabel: c.participantLabel,
            provider: c.provider,
            kind: c.kind,
            outcome: c.outcome,
            content: c.content || c.errorMessage || "",
          })),
      }));
  }

  recoverInterruptedRuns(): {
    recoveredRuns: number;
    recoveredAssignments: number;
  } {
    const now = nowIso();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const runRes = this.db
        .prepare(
          `UPDATE runs
           SET status = 'interrupted',
               completed_at = COALESCE(completed_at, ?),
               error_message = COALESCE(error_message, 'Service restarted while run was in progress')
           WHERE status = 'running'`,
        )
        .run(now);
      const asgnRes = this.db
        .prepare(
          `UPDATE assignments
           SET status = 'interrupted',
               completed_at = COALESCE(completed_at, ?)
           WHERE status IN ('pending', 'running')`,
        )
        .run(now);
      this.db.exec("COMMIT;");
      return {
        recoveredRuns: Number(runRes.changes),
        recoveredAssignments: Number(asgnRes.changes),
      };
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }
}

function toProject(r: Record<string, unknown>): ProjectRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    path: String(r.path),
    createdAt: String(r.created_at),
  };
}
