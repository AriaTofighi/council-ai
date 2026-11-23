import React from "react";
import { ArrowUpCircle, ChevronRight, Gauge, LoaderCircle, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ProviderMark, StatusDot, humanize, runStatusTone, type Tone } from "@/lib/providers";
import { cn, formatDuration, relativeTime } from "@/lib/utils";
import type { CliUpdateStatus, ProviderCatalogEntry, ProviderCheckResult, ProviderId, ProviderUsage } from "@/types";
import { UsageMeters } from "./UsageMeters";

interface AgentsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: ProviderCatalogEntry[];
  checkResults: ProviderCheckResult[];
  checking: ProviderId[];
  cliUpdates: CliUpdateStatus[];
  onTest: (providers?: ProviderId[]) => void;
  onUpdate: () => void;
  usage: ProviderUsage[];
  refreshingUsage: boolean;
  onRefreshUsage: () => void;
}

const cleanVersion = (v?: string) => v?.replace(/\s*\(.*\)\s*$/, "").replace(/^codex-cli\s+/, "");

function updateLine(u: CliUpdateStatus | undefined): { tone: Tone; text: string } {
  switch (u?.state) {
    case "updating":
      return { tone: "signal", text: "Checking for updates…" };
    case "updated":
      return { tone: "success", text: `Updated ${cleanVersion(u.versionBefore)} → ${cleanVersion(u.versionAfter)}` };
    case "current":
      return { tone: "success", text: "Up to date" };
    case "skipped":
      return { tone: "neutral", text: u.message ?? "Not updated" };
    case "failed":
      return { tone: "danger", text: `Update failed${u.message ? `: ${u.message}` : ""}` };
    default:
      return { tone: "neutral", text: "Not checked this session" };
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-subtle-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** Everything about each agent CLI in one place: install, version, updates, live test, models. */
export const AgentsSheet: React.FC<AgentsSheetProps> = ({
  open,
  onOpenChange,
  providers,
  checkResults,
  checking,
  cliUpdates,
  onTest,
  onUpdate,
  usage,
  refreshingUsage,
  onRefreshUsage,
}) => {
  const updating = cliUpdates.some((u) => u.state === "updating");
  const lastUpdate = cliUpdates
    .map((u) => u.finishedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Agents & usage</SheetTitle>
          <SheetDescription className="text-xs">
            The CLIs Council drives. They update when Council starts
            {lastUpdate ? ` · last checked ${relativeTime(lastUpdate)}` : ""}.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-wrap gap-2 px-5 pb-3">
          <Button variant="outline" size="sm" disabled={updating} onClick={onUpdate}>
            {updating ? <LoaderCircle className="animate-spin" /> : <ArrowUpCircle />}
            {updating ? "Updating…" : "Check for updates"}
          </Button>
          <Button variant="outline" size="sm" disabled={checking.length > 0} onClick={() => onTest()}>
            {checking.length > 0 ? <LoaderCircle className="animate-spin" /> : <PlayCircle />}
            Test all
          </Button>
          <Button variant="outline" size="sm" disabled={refreshingUsage} onClick={onRefreshUsage}>
            {refreshingUsage ? <LoaderCircle className="animate-spin" /> : <Gauge />}
            Refresh usage
          </Button>
        </div>

        <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-5">
          {providers.map((p) => {
            const check = checkResults.find((r) => r.provider === p.id);
            const update = cliUpdates.find((u) => u.provider === p.id);
            const installed = Boolean(p.discovery.executablePath);
            const isChecking = checking.includes(p.id);
            const upd = updateLine(update);
            const subscription = usage.find((u) => u.provider === p.id);
            const health = isChecking
              ? { tone: "signal" as Tone, text: "Testing…" }
              : check
                ? {
                    tone: runStatusTone(check.outcome),
                    text: `${check.outcome === "ok" ? "Responded" : humanize(check.outcome)} in ${formatDuration(check.elapsedMs)}`,
                  }
                : { tone: installed ? ("neutral" as Tone) : ("danger" as Tone), text: installed ? "Not tested yet" : "Not found" };

            return (
              <section key={p.id} className="space-y-3 rounded-lg border bg-card p-3.5" aria-label={p.id}>
                <div className="flex items-center gap-2.5">
                  <ProviderMark provider={p.id} size="sm" />
                  <span className="text-sm font-medium">{p.id}</span>
                  <span className="font-mono text-xs text-muted-foreground">{cleanVersion(p.discovery.version) ?? ""}</span>
                  {subscription?.plan && (
                    <span className="rounded border px-1.5 py-px text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                      {subscription.plan}
                    </span>
                  )}
                  <span className="flex-1" />
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={!installed || isChecking}
                    onClick={() => onTest([p.id])}
                  >
                    {isChecking ? <LoaderCircle className="animate-spin" /> : <PlayCircle />}
                    Test
                  </Button>
                </div>

                <div className="space-y-2 rounded-md bg-muted/40 p-2.5" aria-label={`${p.id} usage`}>
                  <UsageMeters usage={subscription} />
                </div>

                <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
                  <Row label="Status">
                    <span className="flex items-center gap-1.5">
                      <StatusDot tone={health.tone} />
                      {health.text}
                    </span>
                    {check?.errorMessage && !isChecking && (
                      <p className="mt-0.5 line-clamp-3 text-danger">{check.errorMessage}</p>
                    )}
                  </Row>
                  <Row label="Updates">
                    <span className="flex items-start gap-1.5">
                      <StatusDot tone={upd.tone} className="mt-1" />
                      <span className={cn("min-w-0", update?.state === "failed" && "text-danger")}>{upd.text}</span>
                    </span>
                  </Row>
                  <Row label="Path">
                    <span className="block truncate font-mono text-[0.6875rem] text-muted-foreground" title={p.discovery.executablePath ?? ""}>
                      {p.discovery.executablePath ?? "—"}
                    </span>
                  </Row>
                </dl>

                <Collapsible>
                  <CollapsibleTrigger className="group/models flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <ChevronRight className="size-3 transition-transform group-data-[state=open]/models:rotate-90" />
                    {p.models.length} models
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ul className="mt-2 divide-y rounded-md border">
                      {p.models.map((m) => (
                        <li key={m.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                          <span className="min-w-0 flex-1 truncate" title={m.id}>
                            {m.label}
                          </span>
                          <span className="shrink-0 text-[0.6875rem] text-subtle-foreground">
                            {m.efforts.length > 0 ? m.efforts.join(" · ") : "no thinking levels"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              </section>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
};
