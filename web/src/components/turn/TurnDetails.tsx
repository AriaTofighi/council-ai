import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProviderMark, StatusDot, humanize, runStatusTone } from "@/lib/providers";
import { cn, formatDuration } from "@/lib/utils";
import type { HydratedRun } from "@/types";
import { MarkdownView } from "../MarkdownView";

export type DetailsTab = "contributions" | "assignments" | "sessions" | "snapshot";

export function TurnDetails({
  run,
  tab,
  onTabChange,
  highlightedId,
}: {
  run: HydratedRun;
  tab: DetailsTab;
  onTabChange: (t: DetailsTab) => void;
  highlightedId: string | null;
}) {
  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as DetailsTab)}>
      <TabsList>
        <TabsTrigger value="contributions">
          Replies <Count n={run.contributions.length} />
        </TabsTrigger>
        <TabsTrigger value="assignments" disabled={run.assignments.length === 0}>
          Assignments <Count n={run.assignments.length} />
        </TabsTrigger>
        <TabsTrigger value="sessions" disabled={run.participants.length === 0}>
          Sessions
        </TabsTrigger>
        {run.snapshot && <TabsTrigger value="snapshot">Snapshot</TabsTrigger>}
      </TabsList>

      <TabsContent value="contributions" className="space-y-2">
        {run.contributions.length === 0 && <Empty>No replies yet.</Empty>}
        {run.contributions.map((c) => {
          const ok = c.outcome === "ok";
          return (
            <article
              key={c.id}
              id={`contrib-${run.id}-${c.id}`}
              className={cn(
                "scroll-mt-24 rounded-md border bg-card p-3 transition-[box-shadow,border-color,opacity] duration-(--duration-slow)",
                highlightedId === c.id && "border-signal",
                c.supersededBy && "opacity-60",
              )}
            >
              <header className="mb-2 flex flex-wrap items-center gap-2">
                <ProviderMark provider={c.provider} size="sm" />
                <span className="text-[0.8125rem] font-medium">{c.participantLabel}</span>
                <Badge variant="mono">{c.id}</Badge>
                <Badge variant="outline">{humanize(c.kind)}</Badge>
                {!ok && <Badge variant="danger">{humanize(c.outcome)}</Badge>}
                {c.continuationMode === "transcript_fallback" && <Badge variant="warning">transcript fallback</Badge>}
                {c.supersededBy && <Badge variant="outline">superseded by {c.supersededBy}</Badge>}
                <span className="ml-auto flex items-center gap-2 text-[0.6875rem] text-subtle-foreground tabular">
                  {c.usage?.totalTokens !== undefined && <span>{c.usage.totalTokens.toLocaleString()} tok</span>}
                  {c.usage?.costUsd !== undefined && <span>${c.usage.costUsd.toFixed(4)}</span>}
                  <span>{formatDuration(c.elapsedMs)}</span>
                </span>
              </header>
              {c.fallbackReason && (
                <p className="mb-2 rounded-md bg-warning-soft px-2.5 py-1.5 text-xs text-warning">
                  Fallback: {c.fallbackReason}
                </p>
              )}
              {ok ? (
                <MarkdownView text={c.content} />
              ) : (
                <p className="text-sm text-danger">{c.errorMessage ?? "Execution failed"}</p>
              )}
            </article>
          );
        })}
      </TabsContent>

      <TabsContent value="assignments" className="space-y-2">
        {run.assignments.map((a) => (
          <div key={a.id} className="rounded-md border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <ProviderMark provider={a.provider} size="sm" />
              <span className="text-[0.8125rem] font-medium">{a.participantLabel}</span>
              <Badge variant="mono">{a.id}</Badge>
              <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                <StatusDot tone={runStatusTone(a.status)} />
                {a.status}
              </span>
              {a.acceptedContributionId && (
                <Badge variant="signal" className="ml-auto">
                  accepted {a.acceptedContributionId}
                </Badge>
              )}
            </div>
            <div className="mt-2 text-sm font-medium">{a.title}</div>
            <p className="mt-1 whitespace-pre-wrap text-[0.8125rem] leading-relaxed text-muted-foreground">{a.task}</p>
          </div>
        ))}
      </TabsContent>

      <TabsContent value="sessions">
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full text-left text-xs">
            <thead className="text-subtle-foreground">
              <tr className="border-b">
                {["Participant", "Role", "Turns", "Continuation", "Model", "Effort", "Session"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {run.participants.map((p) => (
                <tr key={p.participantId}>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <ProviderMark provider={p.provider} size="xs" />
                      <span className="font-medium">{p.label}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{p.role}</td>
                  <td className="px-3 py-2 tabular">{p.turnCount}</td>
                  <td className="px-3 py-2 text-muted-foreground">{humanize(p.continuationMode)}</td>
                  <td className="px-3 py-2 font-mono text-muted-foreground">{p.model ?? "default"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{p.effort ?? "—"}</td>
                  <td className="max-w-40 truncate px-3 py-2 font-mono text-subtle-foreground" title={p.providerSessionId}>
                    {p.providerSessionId ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </TabsContent>

      {run.snapshot && (
        <TabsContent value="snapshot">
          <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 rounded-md border bg-card p-3 text-xs">
            <dt className="text-subtle-foreground">Snapshot</dt>
            <dd className="font-mono">{run.snapshot.id}</dd>
            <dt className="text-subtle-foreground">Source</dt>
            <dd className="truncate font-mono">{run.snapshot.sourcePath}</dd>
            <dt className="text-subtle-foreground">Digest</dt>
            <dd className="font-mono">{run.snapshot.digest.slice(0, 24)}…</dd>
            <dt className="text-subtle-foreground">Files</dt>
            <dd className="tabular">
              {run.snapshot.fileCount} · {Math.round(run.snapshot.totalBytes / 1024)} KB
            </dd>
            {run.snapshot.gitBranch && (
              <>
                <dt className="text-subtle-foreground">Branch</dt>
                <dd className="font-mono">
                  {run.snapshot.gitBranch} @ {run.snapshot.gitCommit?.slice(0, 7)}
                  {run.snapshot.gitDirty ? "*" : ""}
                </dd>
              </>
            )}
            <dt className="text-subtle-foreground">Shared with</dt>
            <dd className="flex flex-wrap gap-1.5">
              {run.snapshot.providersReceivingMaterial.map((p) => (
                <span key={p} className="flex items-center gap-1">
                  <ProviderMark provider={p} size="xs" /> {p}
                </span>
              ))}
            </dd>
          </dl>
        </TabsContent>
      )}
    </Tabs>
  );
}

function Count({ n }: { n: number }) {
  return <span className="tabular text-[0.625rem] text-subtle-foreground">{n}</span>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">{children}</div>;
}
