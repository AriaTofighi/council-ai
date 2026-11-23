import type {
  ParticipantConfig,
  PriorTurnContext,
  WorkspaceSnapshotSummary,
} from "../types/session.js";

const DEFAULT_MAX_HISTORY_CHARS = 18_000;
const SUMMARIZED_CONTRIBUTION_PREVIEW_CHARS = 280;

export function formatWorkspaceSnapshotContext(
  snapshot: WorkspaceSnapshotSummary,
): string {
  const gitBits = [
    snapshot.gitBranch ? `branch=${snapshot.gitBranch}` : undefined,
    snapshot.gitCommit ? `commit=${snapshot.gitCommit.slice(0, 12)}` : undefined,
    snapshot.gitDirty !== undefined
      ? `dirty=${snapshot.gitDirty ? "yes" : "no"}`
      : undefined,
  ].filter(Boolean);

  const files = snapshot.filesPreview.slice(0, 120);
  const moreCount = Math.max(0, snapshot.fileCount - files.length);

  return [
    "<read_only_repository_snapshot>",
    `Snapshot ID: ${snapshot.id}`,
    `Source Repository: ${snapshot.sourcePath}`,
    `Immutable Read-Only Working Copy: ${snapshot.snapshotPath}`,
    `Revision Digest (SHA-256): ${snapshot.digest}`,
    gitBits.length > 0 ? `Git Metadata: ${gitBits.join(", ")}` : undefined,
    `Included Files: ${snapshot.fileCount} (${snapshot.totalBytes} bytes)`,
    files.length > 0 ? "Files:" : undefined,
    ...files.map((f) => `  - ${f}`),
    moreCount > 0 ? `  ... (+${moreCount} more files)` : undefined,
    "",
    "Repository analysis rules:",
    "- All teammates and the lead are inspecting this exact immutable read-only snapshot revision.",
    "- Inspect files directly where tools are enabled and cite exact relative file paths and line numbers (e.g., src/foo.ts:12-30).",
    "</read_only_repository_snapshot>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderTurnsWithTruncation(
  priorTurns: PriorTurnContext[],
  currentLead: ParticipantConfig,
  summarizeOlder: boolean,
): string {
  const lines: string[] = ["<prior_conversation_history>"];
  const lastTurn = priorTurns[priorTurns.length - 1];
  if (
    lastTurn &&
    (lastTurn.leadParticipantId !== currentLead.id ||
      lastTurn.leadProvider !== currentLead.provider)
  ) {
    lines.push(
      `[LEAD SWITCH NOTICE]: Prior turn #${lastTurn.turnIndex} was led by "${lastTurn.leadLabel}" (${lastTurn.leadProvider}). You ("${currentLead.label}", ${currentLead.provider}) are now leading Turn #${lastTurn.turnIndex + 1}. Keep explicit USER decisions and verified evidence intact.`,
      "",
    );
  }

  for (let idx = 0; idx < priorTurns.length; idx += 1) {
    const turn = priorTurns[idx]!;
    const isOlder = summarizeOlder && idx < priorTurns.length - 1;
    lines.push(
      `=== Turn ${turn.turnIndex} (mode=${turn.mode}, lead=${turn.leadLabel} [${turn.leadProvider}]) ===`,
    );
    lines.push(`[USER MESSAGE / DECISION - Turn ${turn.turnIndex}]:`);
    lines.push(turn.userMessage.trim());

    if (turn.userDecisions.length > 0) {
      lines.push("User-confirmed decisions:");
      for (const d of turn.userDecisions) {
        lines.push(`  * [USER DECISION] ${d}`);
      }
    }

    lines.push(
      `[AGENT RECOMMENDATION - Turn ${turn.turnIndex} by ${turn.leadLabel}]:`,
    );
    lines.push(turn.finalAnswer.trim());

    if (turn.disagreements.length > 0) {
      lines.push(`Open disagreements from Turn ${turn.turnIndex}:`);
      for (const dis of turn.disagreements) {
        lines.push(`  - ${dis}`);
      }
    }

    if (turn.unresolvedIssues.length > 0) {
      lines.push(`Open questions / unresolved issues from Turn ${turn.turnIndex}:`);
      for (const issue of turn.unresolvedIssues) {
        lines.push(`  - ${issue}`);
      }
    }

    if (turn.contributions.length > 0) {
      lines.push(
        `Attributed evidence from Turn ${turn.turnIndex} (full verbatim text available via retrieve_contribution):`,
      );
      for (const c of turn.contributions) {
        const clean = c.content.trim();
        const body =
          isOlder && clean.length > SUMMARIZED_CONTRIBUTION_PREVIEW_CHARS
            ? `${clean.slice(0, SUMMARIZED_CONTRIBUTION_PREVIEW_CHARS)}... [TRUNCATED — call retrieve_contribution("${c.id}") for full original]`
            : clean;
        lines.push(
          `  - [${c.id}] ${c.participantLabel} (${c.provider}, ${c.kind}, ${c.outcome}): ${body}`,
        );
      }
    }
    lines.push("");
  }

  lines.push("</prior_conversation_history>");
  return lines.join("\n");
}

export function formatPriorConversationContext(
  priorTurns: PriorTurnContext[],
  options: { currentLead: ParticipantConfig; maxChars?: number },
): string {
  if (priorTurns.length === 0) return "";
  const maxChars = options.maxChars ?? DEFAULT_MAX_HISTORY_CHARS;
  const full = renderTurnsWithTruncation(
    priorTurns,
    options.currentLead,
    false,
  );
  if (full.length <= maxChars) {
    return full;
  }
  return renderTurnsWithTruncation(priorTurns, options.currentLead, true);
}
