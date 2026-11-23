import React, { useState } from "react";
import { ChevronRight, EyeOff, FolderGit2, RotateCw, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Hint } from "@/components/ui/tooltip";
import { ProviderMark, StatusDot, providerMeta, runStatusTone } from "@/lib/providers";
import { cn, formatDuration } from "@/lib/utils";
import type { HydratedRun, StoredRunEvent } from "@/types";
import { MarkdownView } from "../MarkdownView";
import { CitePill } from "./CitePill";
import { LiveProgress } from "./LiveProgress";
import { TurnDetails, type DetailsTab } from "./TurnDetails";

interface TurnViewProps {
  run: HydratedRun;
  liveEvents: StoredRunEvent[];
  busyAction: string | null;
  onRetryAssignment: (runId: string, assignmentId: string) => void;
  onSynthesizeRun: (runId: string) => void;
}

export const TurnView: React.FC<TurnViewProps> = ({
  run,
  liveEvents,
  busyAction,
  onRetryAssignment,
  onSynthesizeRun,
}) => {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tab, setTab] = useState<DetailsTab>("contributions");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const running = run.status === "running";
  const validContributionIds = new Set(run.contributions.map((c) => c.id));
  const retryable = run.assignments.filter((a) => a.status === "failed" || a.status === "interrupted");
  const canSynthesize = run.contributions.some((c) => c.outcome === "ok");
  const participant = (id: string) => run.participants.find((p) => p.participantId === id);

  const openCitation = (cid: string) => {
    setDetailsOpen(true);
    setTab("contributions");
    setHighlightedId(cid);
    window.setTimeout(() => {
      document.getElementById(`contrib-${run.id}-${cid}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    window.setTimeout(() => setHighlightedId((h) => (h === cid ? null : h)), 2000);
  };

  return (
    <article className={cn("space-y-5 py-8", running && "animate-rise")} aria-label={`Turn ${run.turnIndex}`}>
      <header className="space-y-2">
        <p className="whitespace-pre-wrap text-[0.9375rem] font-medium leading-relaxed">{run.userMessage}</p>
        <MetaRow run={run} />
      </header>

      {running && <LiveProgress run={run} events={liveEvents} />}

      {/* While a retry or re-synthesis runs, the previous answer and errors are stale. */}
      {!running && run.finalAnswer && (
        <section>
          <MarkdownView text={run.finalAnswer} validCitationIds={validContributionIds} onCiteClick={openCitation} />
          {run.usedContributionIds.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {run.usedContributionIds.map((cid) => (
                <CitePill key={cid} id={cid} onClick={() => openCitation(cid)} />
              ))}
            </div>
          )}
        </section>
      )}

      {!running && run.participantSummaries.length > 0 && (
        <ul className="space-y-1.5">
          {run.participantSummaries.map((s) => {
            const p = participant(s.participant_id);
            return (
              <li key={s.participant_id} className="flex gap-2.5 text-[0.8125rem] leading-relaxed">
                <ProviderMark provider={p?.provider ?? "claude"} size="sm" className="h-[1.4rem]" />
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">{p?.label ?? s.participant_id}</span> {s.added}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {!running && run.disagreements.length > 0 && <Note tone="warning" title="Disagreements" items={run.disagreements} />}
      {!running && run.unresolvedIssues.length > 0 && <Note tone="neutral" title="Unresolved" items={run.unresolvedIssues} />}
      {!running && run.errorMessage && <Note tone="danger" title="Error" items={[run.errorMessage]} />}

      {!running && (retryable.length > 0 || (canSynthesize && !run.finalAnswer)) && (
        <div className="flex flex-wrap items-center gap-1">
          {retryable.map((a) => (
            <Button
              key={a.id}
              variant="outline"
              size="xs"
              disabled={busyAction !== null}
              onClick={() => onRetryAssignment(run.id, a.id)}
            >
              <RotateCw className={cn(busyAction === `retry:${run.id}:${a.id}` && "animate-spin")} />
              Retry {a.participantLabel}
            </Button>
          ))}
          {canSynthesize && (
            <Button variant="ghost" size="xs" disabled={busyAction !== null} onClick={() => onSynthesizeRun(run.id)}>
              <Wand2 className={cn(busyAction === `synth:${run.id}` && "animate-pulse")} />
              Synthesize
            </Button>
          )}
        </div>
      )}

      {(run.contributions.length > 0 || run.assignments.length > 0) && (
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group/dt -ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-xs text-subtle-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <ChevronRight className="size-3 transition-transform duration-(--duration-base) group-data-[state=open]/dt:rotate-90" />
              <span className="tabular">
                {run.contributions.length} {run.contributions.length === 1 ? "reply" : "replies"}
              </span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <TurnDetails run={run} tab={tab} onTabChange={setTab} highlightedId={highlightedId} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </article>
  );
};

function MetaRow({ run }: { run: HydratedRun }) {
  const lead = run.leadConfig;
  const tone = runStatusTone(run.status);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle-foreground">
      {run.status !== "completed" && (
        <span
          className={cn(
            "flex items-center gap-1.5",
            tone === "danger" && "text-danger",
            tone === "warning" && "text-warning",
          )}
        >
          <StatusDot tone={tone} />
          {run.status}
        </span>
      )}
      <span className="flex items-center gap-1">
        {run.mode === "roundtable" ? "Roundtable" : "Divide"}
        {run.independentFirstOpinions && <EyeOff className="size-3" aria-label="Blind first opinions" />}
      </span>
      <Hint
        label={
          <span className="flex flex-col gap-0.5">
            {[lead, ...run.teammatesConfig].map((p, i) => (
              <span key={p.id}>
                {i === 0 ? "Lead · " : ""}
                {p.label} · {p.model ?? providerMeta(p.provider).name}
                {p.effort ? ` · ${p.effort}` : ""}
              </span>
            ))}
          </span>
        }
      >
        <span className="flex cursor-default items-center gap-1.5">
          <ProviderMark provider={lead.provider} size="xs" />
          {run.teammatesConfig.length > 0 && <span className="h-2.5 w-px bg-border-strong" />}
          {run.teammatesConfig.map((t) => (
            <ProviderMark key={t.id} provider={t.provider} size="xs" />
          ))}
        </span>
      </Hint>
      {run.snapshot && (
        <Hint label={`${run.snapshot.sourcePath} · ${run.snapshot.fileCount} files`}>
          <span className="flex cursor-default items-center gap-1">
            <FolderGit2 className="size-3" />
            <span className="font-mono">{(run.snapshot.gitCommit ?? run.snapshot.digest).slice(0, 7)}</span>
          </span>
        </Hint>
      )}
      {run.elapsedMs !== undefined && <span className="tabular">{formatDuration(run.elapsedMs)}</span>}
    </div>
  );
}

const NOTE_TONE = {
  warning: "border-warning",
  danger: "border-danger",
  neutral: "border-border-strong",
} as const;

function Note({ tone, title, items }: { tone: keyof typeof NOTE_TONE; title: string; items: string[] }) {
  return (
    <section className={cn("border-l-2 pl-3 text-[0.8125rem] leading-relaxed", NOTE_TONE[tone])}>
      <div className="font-medium">{title}</div>
      {items.length === 1 ? (
        <p className="text-muted-foreground">{items[0]}</p>
      ) : (
        <ul className="list-disc pl-4 text-muted-foreground marker:text-subtle-foreground">
          {items.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
