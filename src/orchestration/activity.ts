import type { ProviderEvent, ProviderId } from "../types/provider.js";
import type { RunEvent } from "../types/session.js";

const WRITING_INTERVAL_MS = 4_000;
const STATUS_INTERVAL_MS = 1_500;
const MAX_DETAIL = 160;

const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat;
};

/**
 * Turns a CLI's raw stream (tool calls, status lines, text deltas) into throttled
 * `agent_activity` run events, so the UI can show what each agent is doing
 * without persisting every token.
 */
export function createActivityForwarder(
  runId: string,
  emit: ((event: RunEvent) => void) | undefined,
): (participantId: string, provider: ProviderId, evt: ProviderEvent) => void {
  const lastWriting = new Map<string, number>();
  const lastStatus = new Map<string, number>();
  return (participantId, provider, evt) => {
    if (!emit) return;
    const now = Date.now();
    const base = { type: "agent_activity" as const, runId, participantId, provider };
    switch (evt.type) {
      case "tool_use":
        lastWriting.delete(participantId);
        emit({ ...base, kind: "tool", detail: clip(evt.detail ? `${evt.toolName} ${evt.detail}` : evt.toolName) });
        return;
      case "status":
        if (now - (lastStatus.get(participantId) ?? 0) < STATUS_INTERVAL_MS) return;
        lastStatus.set(participantId, now);
        emit({ ...base, kind: "status", detail: clip(evt.message) });
        return;
      case "text_delta":
        if (now - (lastWriting.get(participantId) ?? 0) < WRITING_INTERVAL_MS) return;
        lastWriting.set(participantId, now);
        emit({ ...base, kind: "writing" });
        return;
      case "error":
        emit({ ...base, kind: "error", detail: clip(evt.message || evt.outcome) });
        return;
      default:
        return;
    }
  };
}
