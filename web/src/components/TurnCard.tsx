import React, { useState } from "react";
import type { HydratedRun, StoredRunEvent } from "../types";
import { MarkdownView } from "./MarkdownView";

interface TurnCardProps {
  run: HydratedRun;
  liveEvents: StoredRunEvent[];
  busyAction: string | null;
  onStopRun: (runId: string) => void;
  onRetryAssignment: (runId: string, assignmentId: string) => void;
  onSynthesizeRun: (runId: string) => void;
}

function summarizeLiveEvent(evt: StoredRunEvent): string {
  const e = evt.event;
  switch (e.type) {
    case "run_started":
      return `Started ${String(e.mode)} run with ${Array.isArray(e.teammates) ? e.teammates.length : 0} teammate(s).`;
    case "roundtable_opening_planned":
      return `Roundtable opener selected.`;
    case "roundtable_turn_started":
      return `Round ${String(e.round)}: ${String(e.participantLabel)} (${String(e.provider)}) ${e.isBlind ? "writing blind opening" : "responding"}...`;
    case "roundtable_turn_completed":
      return `Round ${String(e.round)} completed.`;
    case "lead_thinking":
      return `Lead (${String(e.provider)}) turn #${String(e.turn)}${e.mustFinish ? " — final synthesis" : ""}...`;
    case "lead_action": {
      const action = e.action as { action?: string };
      return `Lead action: ${action?.action ?? "unknown"} (${String(e.elapsedMs)}ms)`;
    }
    case "assignment_started": {
      const a = e.assignment as { participantLabel?: string; title?: string };
      return `Assigned to ${a?.participantLabel}: "${a?.title}"`;
    }
    case "assignment_completed": {
      const c = e.contribution as { id?: string; participantLabel?: string; outcome?: string };
      return `Received [${c?.id}] from ${c?.participantLabel} (${c?.outcome})`;
    }
    case "followup_started":
      return `Follow-up sent to ${String(e.participantId)} (${String(e.provider)})`;
    case "followup_completed": {
      const c = e.contribution as { id?: string; outcome?: string };
      return `Follow-up reply [${c?.id}] (${c?.outcome})`;
    }
    case "contribution_retrieved":
      return `Lead retrieved original contribution ${String(e.contributionId)}.`;
    case "session_fallback":
      return `Fallback triggered for ${String(e.participantId)}: ${String(e.reason)}`;
    case "run_finished":
      return `Run finished (${String(e.status)}, ${String(e.elapsedMs)}ms).`;
    default:
      return e.type;
  }
}

export const TurnCard: React.FC<TurnCardProps> = ({
  run,
  liveEvents,
  busyAction,
  onStopRun,
  onRetryAssignment,
  onSynthesizeRun,
}) => {
  const [expandedDiscussion, setExpandedDiscussion] = useState(
    run.status !== "completed",
  );
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const validContributionIds = new Set(run.contributions.map((c) => c.id));
  const retryableAssignments = run.assignments.filter(
    (a) => a.status === "failed" || a.status === "interrupted",
  );

  const handleCitationClick = (cid: string) => {
    setExpandedDiscussion(true);
    setHighlightedId(cid);
    window.setTimeout(() => {
      document
        .getElementById(`contrib-${run.id}-${cid}`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
  };

  const statusBadgeClass =
    run.status === "completed"
      ? "badge-ok"
      : run.status === "running"
        ? "badge-running"
        : run.status === "partial" || run.status === "interrupted"
          ? "badge-warn"
          : "badge-err";

  return (
    <article className="turn-card">
      <div className="turn-header">
        <div className="turn-meta-left">
          <span className="turn-index">Turn {run.turnIndex}</span>
          <span className={`badge ${statusBadgeClass}`}>{run.status}</span>
          <span className="pill">
            Lead: {run.leadConfig.provider}
            {run.leadConfig.model ? ` (${run.leadConfig.model})` : ""}
            {run.leadConfig.effort ? ` [${run.leadConfig.effort}]` : ""}
          </span>
          <span className="pill">
            Mode:{" "}
            {run.mode === "roundtable"
              ? run.independentFirstOpinions
                ? "Roundtable (Independent openings)"
                : "Roundtable"
              : "Divide & conquer"}
          </span>
          {run.teammatesConfig.length > 0 && (
            <span className="pill">
              Team:{" "}
              {run.teammatesConfig
                .map(
                  (t) =>
                    `${t.provider}${t.model ? `:${t.model}` : ""}${t.effort ? `@${t.effort}` : ""}`,
                )
                .join(", ")}
            </span>
          )}
          {run.snapshot && (
            <span
              className="pill pill-accent"
              title={`Snapshot ${run.snapshot.id} (${run.snapshot.digest})`}
            >
              Snapshot: {run.snapshot.fileCount} files (
              {run.snapshot.gitCommit
                ? run.snapshot.gitCommit.slice(0, 7)
                : run.snapshot.digest.slice(0, 7)}
              )
            </span>
          )}
        </div>
        <div className="turn-meta-right">
          {run.elapsedMs !== undefined && (
            <span className="muted-time">
              {(run.elapsedMs / 1000).toFixed(1)}s
            </span>
          )}
          {run.status === "running" && (
            <button
              type="button"
              className="btn btn-xs btn-danger"
              disabled={busyAction === `stop:${run.id}`}
              onClick={() => onStopRun(run.id)}
            >
              Stop Run
            </button>
          )}
        </div>
      </div>

      <div className="user-prompt-box">{run.userMessage}</div>

      {run.status === "running" && (
        <div className="live-feed">
          <div className="live-feed-title">
            <span className="spinner" /> Live progress
          </div>
          {run.assignments.length > 0 && (
            <div className="active-assignments">
              {run.assignments.map((a) => (
                <div key={a.id} className="active-asgn-row">
                  <span className={`badge badge-sm badge-${a.status === "completed" ? "ok" : a.status === "running" ? "running" : "warn"}`}>
                    {a.status}
                  </span>
                  <strong>{a.participantLabel}</strong>
                  <span>— {a.title}</span>
                </div>
              ))}
            </div>
          )}
          <ul className="live-log">
            {liveEvents.slice(-8).map((evt) => (
              <li key={evt.seq}>{summarizeLiveEvent(evt)}</li>
            ))}
          </ul>
        </div>
      )}

      {run.finalAnswer && (
        <div className="answer-box">
          <div className="answer-label">Lead Recommendation</div>
          <MarkdownView
            text={run.finalAnswer}
            validCitationIds={validContributionIds}
            onCiteClick={handleCitationClick}
          />
          {run.usedContributionIds.length > 0 && (
            <div className="cited-row">
              <span>Cited evidence:</span>
              {run.usedContributionIds.map((cid) => (
                <button
                  key={cid}
                  type="button"
                  className="cite-pill"
                  onClick={() => handleCitationClick(cid)}
                >
                  {cid}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {run.participantSummaries.length > 0 && (
        <div className="summaries-grid">
          {run.participantSummaries.map((s) => (
            <div key={s.participant_id} className="summary-chip">
              <div className="summary-who">{s.participant_id}</div>
              <div className="summary-text">{s.added}</div>
            </div>
          ))}
        </div>
      )}

      {(run.disagreements.length > 0 ||
        run.unresolvedIssues.length > 0 ||
        retryableAssignments.length > 0 ||
        run.errorMessage) && (
        <div className="issues-panel">
          {run.disagreements.length > 0 && (
            <div className="issue-block">
              <strong>Open disagreements:</strong>
              <ul>
                {run.disagreements.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {run.unresolvedIssues.length > 0 && (
            <div className="issue-block">
              <strong>Unresolved issues:</strong>
              <ul>
                {run.unresolvedIssues.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          )}
          {run.errorMessage && (
            <div className="issue-block">
              <strong>Run status note:</strong> {run.errorMessage}
            </div>
          )}
          {run.status !== "running" && retryableAssignments.length > 0 && (
            <div className="recovery-actions">
              {retryableAssignments.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="btn btn-xs btn-secondary"
                  disabled={busyAction !== null}
                  onClick={() => onRetryAssignment(run.id, a.id)}
                >
                  {busyAction === `retry:${run.id}:${a.id}`
                    ? `Retrying ${a.participantLabel}...`
                    : `Retry ${a.participantLabel} (${a.id})`}
                </button>
              ))}
              {run.contributions.some((c) => c.outcome === "ok") && (
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  disabled={busyAction !== null}
                  onClick={() => onSynthesizeRun(run.id)}
                >
                  {busyAction === `synth:${run.id}`
                    ? "Synthesizing..."
                    : "Synthesize available replies"}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="discussion-toggle-row">
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          onClick={() => setExpandedDiscussion((v) => !v)}
        >
          {expandedDiscussion ? "▾ Hide" : "▸ Inspect"} assignments, replies &amp;
          diagnostics ({run.contributions.length} contribution
          {run.contributions.length === 1 ? "" : "s"})
        </button>
      </div>

      {expandedDiscussion && (
        <div className="discussion-drawer">
          {run.snapshot && (
            <div className="drawer-sub">
              <div className="drawer-sub-title">
                Read-only Snapshot ({run.snapshot.id})
              </div>
              <div className="muted-hint">
                Source: <code>{run.snapshot.sourcePath}</code> · Digest:{" "}
                <code>{run.snapshot.digest.slice(0, 16)}</code> · Providers
                receiving material:{" "}
                <strong>
                  {run.snapshot.providersReceivingMaterial.join(", ")}
                </strong>
              </div>
            </div>
          )}

          {run.assignments.length > 0 && (
            <div className="drawer-sub">
              <div className="drawer-sub-title">Assignments</div>
              {run.assignments.map((a) => (
                <div key={a.id} className="assignment-row">
                  <div className="asgn-head">
                    <code>{a.id}</code>
                    <strong>{a.participantLabel}</strong>
                    <span className="pill">{a.provider}</span>
                    <span className="pill">{a.status}</span>
                    {a.acceptedContributionId && (
                      <span className="pill pill-accent">
                        accepted: {a.acceptedContributionId}
                      </span>
                    )}
                  </div>
                  <div className="asgn-title">{a.title}</div>
                  <div className="asgn-task">{a.task}</div>
                </div>
              ))}
            </div>
          )}

          {run.contributions.length > 0 && (
            <div className="drawer-sub">
              <div className="drawer-sub-title">Contributions &amp; Replies</div>
              {run.contributions.map((c) => (
                <div
                  key={c.id}
                  id={`contrib-${run.id}-${c.id}`}
                  className={`contrib-card ${highlightedId === c.id ? "highlighted" : ""} ${c.supersededBy ? "superseded" : ""}`}
                >
                  <div className="contrib-head">
                    <code>{c.id}</code>
                    <strong>{c.participantLabel}</strong>
                    <span className="pill">{c.provider}</span>
                    <span className="pill">{c.kind}</span>
                    <span
                      className={`badge ${c.outcome === "ok" ? "badge-ok" : "badge-err"}`}
                    >
                      {c.outcome}
                    </span>
                    <span className="pill">{c.continuationMode}</span>
                    {c.supersededBy && (
                      <span className="pill">
                        superseded by {c.supersededBy}
                      </span>
                    )}
                    <span className="muted-time">
                      {(c.elapsedMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                  {c.fallbackReason && (
                    <div className="fallback-note">
                      Fallback reason: {c.fallbackReason}
                    </div>
                  )}
                  {c.outcome === "ok" ? (
                    <MarkdownView text={c.content} />
                  ) : (
                    <div className="error-inline">
                      {c.errorMessage ?? "Execution failed"}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {run.participants.length > 0 && (
            <div className="drawer-sub">
              <div className="drawer-sub-title">
                Session Isolation &amp; Diagnostics
              </div>
              <div className="session-list">
                {run.participants.map((p) => (
                  <div key={p.participantId} className="session-row">
                    <code>{p.participantId}</code>
                    <span>
                      {p.provider} ({p.role})
                    </span>
                    <span>turns={p.turnCount}</span>
                    <span>mode={p.continuationMode}</span>
                    {p.providerSessionId && (
                      <code>session={p.providerSessionId}</code>
                    )}
                    {p.model && <span>model={p.model}</span>}
                    {p.effort && <span>effort={p.effort}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
};
