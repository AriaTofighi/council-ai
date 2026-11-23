import { useEffect, useState } from "react";
import type { Tone } from "@/lib/providers";
import { cn } from "@/lib/utils";
import type { ProviderUsage, UsageWindow } from "@/types";

const ORDER: Record<UsageWindow["kind"], number> = { "5h": 0, weekly: 1, other: 2 };

/** Short name for a window: "5-hour", "Weekly", "Weekly (Opus)". */
export function windowName(w: UsageWindow): string {
  const qualifier = /\(([^)]+)\)/.exec(w.label)?.[1];
  const base = w.kind === "5h" ? "5-hour" : w.kind === "weekly" ? "Weekly" : w.label;
  return qualifier && qualifier !== "all models" && w.kind !== "other" ? `${base} (${qualifier})` : base;
}

export function usageTone(pct: number): Tone {
  return pct >= 90 ? "danger" : pct >= 70 ? "warning" : "signal";
}

/** Highest usage across a subscription's windows, for a one-glance indicator. */
export function peakUsage(usage: ProviderUsage | undefined): number | undefined {
  const all = usage?.groups.flatMap((g) => g.windows) ?? [];
  return all.length ? Math.max(...all.map((w) => w.usedPercent)) : undefined;
}

function resetsIn(w: UsageWindow, now: number): string | undefined {
  if (w.resetsAt) {
    const ms = new Date(w.resetsAt).getTime() - now;
    if (ms <= 0) return "resetting now";
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `resets in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `resets in ${hours}h ${mins % 60}m`;
    return `resets in ${Math.round(hours / 24)}d`;
  }
  return w.resetsText ? `resets ${w.resetsText}` : undefined;
}

const BAR: Record<Tone, string> = {
  signal: "bg-signal",
  warning: "bg-warning",
  danger: "bg-danger",
  success: "bg-success",
  neutral: "bg-subtle-foreground",
};

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** 5-hour and weekly meters for one subscription, grouped the way the provider groups them. */
export function UsageMeters({ usage }: { usage: ProviderUsage | undefined }) {
  const now = useMinuteClock();
  if (!usage) return <p className="text-xs text-subtle-foreground">Loading usage…</p>;
  if (!usage.ok && usage.groups.length === 0) {
    return <p className="text-xs text-muted-foreground">{usage.error ?? "Usage unavailable"}</p>;
  }
  return (
    <div className="space-y-3">
      {usage.groups.map((group, gi) => (
        <div key={group.name ?? gi} className="space-y-1.5">
          {group.name && (
            <p className="text-[0.6875rem] font-medium text-muted-foreground" title={group.description}>
              {group.name}
            </p>
          )}
          {[...group.windows]
            .sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
            .map((w) => {
              const tone = usageTone(w.usedPercent);
              return (
                <div key={w.label} className="space-y-1">
                  <div className="flex items-baseline gap-2 text-xs">
                    <span className="text-foreground/90">{windowName(w)}</span>
                    <span className="tabular text-muted-foreground">{Math.round(w.usedPercent)}% used</span>
                    <span className="flex-1" />
                    <span className="text-[0.6875rem] text-subtle-foreground" title={w.resetsAt ? new Date(w.resetsAt).toLocaleString() : undefined}>
                      {resetsIn(w, now)}
                    </span>
                  </div>
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-border"
                    role="meter"
                    aria-label={`${group.name ? `${group.name} ` : ""}${windowName(w)} usage`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(w.usedPercent)}
                  >
                    <div className={cn("h-full rounded-full", BAR[tone])} style={{ width: `${Math.max(1, w.usedPercent)}%` }} />
                  </div>
                </div>
              );
            })}
        </div>
      ))}
      {usage.notes.map((n) => (
        <p key={n} className="text-[0.6875rem] text-subtle-foreground">
          {n}
        </p>
      ))}
      {usage.error && usage.ok && (
        <p className="text-[0.6875rem] text-warning">Couldn’t refresh: {usage.error}</p>
      )}
    </div>
  );
}
