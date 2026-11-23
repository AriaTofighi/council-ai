import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { formatDuration } from "@/lib/utils";
import type { HydratedRun, StoredRunEvent } from "@/types";
import { AgentBoard } from "./AgentBoard";
import { describeLiveEvent } from "./live-events";

function useElapsed(since: string): number {
  const start = new Date(since).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return Math.max(0, now - start);
}

export function LiveProgress({ run, events }: { run: HydratedRun; events: StoredRunEvent[] }) {
  // A retry streams from its run_resumed event, so time this pass, not the original run.
  const elapsed = useElapsed(events[0]?.createdAt ?? run.createdAt);
  // Per-agent activity lives on the board; the headline feed shows orchestration steps.
  const steps = events.filter((e) => e.event.type !== "agent_activity");
  const latest = steps.length ? describeLiveEvent(steps[steps.length - 1]!) : null;
  const earlier = steps.slice(-5, -1);

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2 text-[0.8125rem]">
        <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" aria-live="polite">
          {latest?.text ?? "Starting"}
        </span>
        <span className="tabular text-subtle-foreground">{formatDuration(elapsed)}</span>
      </div>

      {earlier.length > 0 && (
        <ol className="space-y-0.5 pl-5.5 text-subtle-foreground">
          {earlier.map((evt) => (
            <li key={evt.seq} className="truncate">
              {describeLiveEvent(evt).text}
            </li>
          ))}
        </ol>
      )}

      <AgentBoard run={run} events={events} live />
    </div>
  );
}
