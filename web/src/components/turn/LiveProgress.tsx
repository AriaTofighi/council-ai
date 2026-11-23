import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { ProviderMark, StatusDot, runStatusTone } from "@/lib/providers";
import { formatDuration } from "@/lib/utils";
import type { HydratedRun, StoredRunEvent } from "@/types";
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
  const elapsed = useElapsed(run.createdAt);
  const latest = events.length ? describeLiveEvent(events[events.length - 1]!) : null;
  const earlier = events.slice(-5, -1);

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

      {run.assignments.length > 0 && (
        <ul className="divide-y rounded-md border">
          {run.assignments.map((a) => (
            <li key={a.id} className="flex items-center gap-2.5 px-3 py-1.5">
              <ProviderMark provider={a.provider} size="xs" />
              <span className="shrink-0 font-medium">{a.participantLabel}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{a.title}</span>
              <StatusDot tone={runStatusTone(a.status)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
