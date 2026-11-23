import { useEffect, useState } from "react";
import { ProviderMark, StatusDot, type Tone } from "@/lib/providers";
import { cn } from "@/lib/utils";
import type { HydratedRun, ProviderId, StoredRunEvent } from "@/types";

type AgentState = "waiting" | "working" | "done" | "failed" | "stopped";

interface AgentView {
  id: string;
  label: string;
  provider: ProviderId;
  role: "lead" | "teammate";
  model?: string;
  effort?: string;
  state: AgentState;
  /** What it was asked to do, e.g. an assignment title or "Final synthesis". */
  task?: string;
  /** When the current/last piece of work started. */
  since?: number;
  /** When the work ended (done/failed). */
  endedAt?: number;
  /** Latest thing the CLI reported while working. */
  activity?: string;
  activityAt?: number;
  outcome?: string;
}

const QUIET_AFTER_MS = 30_000;

/** Readable wording for the tool calls agents report ("Read src/a.ts" → "Reading src/a.ts"). */
function describeTool(detail: string): string {
  const [tool = "", ...rest] = detail.split(" ");
  const arg = rest.join(" ");
  const verbs: Record<string, string> = {
    Read: "Reading",
    view_file: "Reading",
    read_file: "Reading",
    Grep: "Searching",
    grep_search: "Searching",
    Glob: "Finding files",
    find_by_name: "Finding files",
    list_dir: "Listing",
    LS: "Listing",
    shell: "Running",
    exec_command: "Running",
  };
  if (tool === "StructuredOutput") return "Writing its answer";
  const verb = verbs[tool];
  return verb ? `${verb}${arg ? ` ${arg}` : ""}` : detail;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

const OUTCOME_TEXT: Record<string, string> = {
  timeout: "Timed out",
  cancelled: "Stopped",
  auth_error: "Not signed in",
  rate_limited: "Rate limited",
  quota_exhausted: "Out of quota",
  execution_error: "Failed",
};

/** Folds the live event stream into one current state per agent. */
export function deriveAgents(run: HydratedRun, events: StoredRunEvent[]): AgentView[] {
  const agents = new Map<string, AgentView>();
  const lead = run.leadConfig;
  agents.set(lead.id, { ...lead, role: "lead", state: "waiting" });
  for (const mate of run.teammatesConfig) agents.set(mate.id, { ...mate, role: "teammate", state: "waiting" });

  // Baseline from what's already settled, for agents not involved in the current pass.
  for (const a of run.assignments) {
    const agent = agents.get(a.participantId);
    if (!agent) continue;
    agent.task = a.title;
    agent.state =
      a.status === "completed" ? "done" : a.status === "failed" ? "failed" : a.status === "interrupted" ? "stopped" : agent.state;
  }

  const at = (e: StoredRunEvent) => new Date(e.createdAt).getTime();
  const start = (id: string | undefined, task: string, when: number) => {
    const agent = id ? agents.get(id) : undefined;
    if (!agent) return;
    Object.assign(agent, { state: "working", task, since: when, endedAt: undefined, activity: undefined, activityAt: undefined, outcome: undefined });
  };
  const finish = (id: string | undefined, outcome: string | undefined, when: number) => {
    const agent = id ? agents.get(id) : undefined;
    if (!agent) return;
    agent.state = !outcome || outcome === "ok" ? "done" : outcome === "cancelled" ? "stopped" : "failed";
    agent.outcome = outcome;
    agent.endedAt = when;
  };

  for (const evt of events) {
    const e = evt.event as Record<string, unknown> & { type: string };
    const when = at(evt);
    switch (e.type) {
      case "assignment_started": {
        const a = e.assignment as { participantId?: string; title?: string };
        start(a.participantId, a.title ?? "Assignment", when);
        break;
      }
      case "roundtable_turn_started":
        start(e.participantId as string, `Round ${String(e.round)}${e.isBlind ? " · blind opening" : ""}`, when);
        break;
      case "followup_started":
        start(e.participantId as string, `Follow-up: ${String(e.question ?? "")}`, when);
        break;
      case "lead_thinking":
        start(e.participantId as string, e.mustFinish ? "Writing the final answer" : `Planning (step ${String(e.turn)})`, when);
        break;
      case "assignment_completed":
      case "roundtable_turn_completed":
      case "followup_completed": {
        const c = e.contribution as { participantId?: string; outcome?: string };
        finish(c.participantId, c.outcome, when);
        break;
      }
      case "lead_action": {
        const action = (e.action as { action?: string } | undefined)?.action ?? "decided";
        const agent = agents.get(lead.id);
        if (agent) {
          // The lead hands off and waits for teammates; it isn't "done" with the run.
          finish(lead.id, "ok", when);
          agent.state = "waiting";
          agent.task = `Decided: ${action.replace(/_/g, " ")}`;
        }
        break;
      }
      case "agent_activity": {
        const agent = agents.get(e.participantId as string);
        if (!agent) break;
        const detail = typeof e.detail === "string" ? e.detail : "";
        agent.activity =
          e.kind === "writing"
            ? "Writing its reply"
            : e.kind === "error"
              ? `Error: ${detail}`
              : e.kind === "tool"
                ? describeTool(detail)
                : detail || String(e.kind);
        agent.activityAt = when;
        break;
      }
      case "run_finished":
        for (const agent of agents.values()) {
          if (agent.state === "working") {
            agent.state = "stopped";
            agent.endedAt = when;
          }
        }
        break;
    }
  }
  return [...agents.values()];
}

const STATE_TONE: Record<AgentState, Tone> = {
  waiting: "neutral",
  working: "signal",
  done: "success",
  failed: "danger",
  stopped: "warning",
};

/** One row per agent: what it's doing, for how long against its time limit, and when it last spoke. */
export function AgentBoard({
  run,
  events,
  live,
}: {
  run: HydratedRun;
  events: StoredRunEvent[];
  live: boolean;
}) {
  const now = useNow(live);
  const agents = deriveAgents(run, events);
  const budget = run.limits?.perCallTimeoutMs;

  return (
    <ul className="divide-y rounded-md border" aria-label="Agents">
      {agents.map((agent) => {
        const working = agent.state === "working";
        const elapsed = agent.since ? (agent.endedAt ?? now) - agent.since : undefined;
        const lastHeard = agent.activityAt ?? agent.since;
        const quiet = working && lastHeard !== undefined && now - lastHeard > QUIET_AFTER_MS;
        const overBudget = working && budget && elapsed !== undefined && elapsed > budget;
        const status =
          agent.state === "working"
            ? "Working"
            : agent.state === "done"
              ? "Done"
              : agent.state === "failed"
                ? (OUTCOME_TEXT[agent.outcome ?? ""] ?? "Failed")
                : agent.state === "stopped"
                  ? "Stopped"
                  : "Waiting";
        const detail = working
          ? agent.activity
            ? `${agent.activity} · ${ago(now - (agent.activityAt ?? now))}`
            : `Started, no output yet · ${ago(now - (agent.since ?? now))}`
          : agent.task;

        return (
          <li key={agent.id} className="space-y-1 px-3 py-2">
            <div className="flex items-center gap-2 text-xs">
              <ProviderMark provider={agent.provider} size="xs" />
              <span className="shrink-0 font-medium">{agent.label}</span>
              <span className="min-w-0 truncate text-subtle-foreground">
                {[agent.model ?? "default", agent.effort].filter(Boolean).join(" · ")}
              </span>
              <span className="flex-1" />
              {elapsed !== undefined && agent.state !== "waiting" && (
                <span className={cn("tabular text-[0.6875rem]", overBudget ? "text-danger" : "text-subtle-foreground")}>
                  {clock(elapsed)}
                  {working && budget ? ` / ${clock(budget)}` : ""}
                </span>
              )}
              <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                <StatusDot tone={quiet ? "warning" : STATE_TONE[agent.state]} />
                {status}
              </span>
            </div>
            {working && agent.task && (
              <div className="truncate pl-6 text-[0.6875rem] text-muted-foreground" title={agent.task}>
                {agent.task}
              </div>
            )}
            {detail && (
              <div
                className={cn(
                  "truncate pl-6 text-[0.6875rem]",
                  quiet ? "text-warning" : working ? "text-foreground/80" : "text-subtle-foreground",
                )}
                title={detail}
              >
                {quiet ? "Quiet · " : ""}
                {detail}
              </div>
            )}
            {working && budget ? (
              <div className="ml-6 h-0.5 overflow-hidden rounded-full bg-border">
                <div
                  className={cn("h-full rounded-full transition-[width] duration-1000 ease-linear", overBudget ? "bg-danger" : "bg-signal")}
                  style={{ width: `${Math.min(100, ((elapsed ?? 0) / budget) * 100)}%` }}
                />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
