import React, { useMemo, useState } from "react";
import { FolderGit2, FolderOpen, GitBranch, GitCommitHorizontal, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Hint } from "@/components/ui/tooltip";
import { ProviderMark } from "@/lib/providers";
import { cn } from "@/lib/utils";
import type { ProviderCatalogEntry, ProviderId, WorkspaceInspection } from "@/types";

interface WorkspaceSheetProps {
  workspacePath: string;
  inspection: WorkspaceInspection | null;
  selectedPaths: string[];
  inspecting: boolean;
  inspectError: string | null;
  activeProviders: ProviderId[];
  allowReadOnlyTools: boolean;
  catalog: ProviderCatalogEntry[];
  disabled?: boolean;
  onChangePath: (path: string) => void;
  onInspect: () => void;
  picking?: boolean;
  onBrowse: () => void;
  onClearWorkspace: () => void;
  onChangeSelectedPaths: (paths: string[]) => void;
}

export const WorkspaceSheet: React.FC<WorkspaceSheetProps> = ({
  workspacePath,
  inspection,
  selectedPaths,
  inspecting,
  inspectError,
  activeProviders,
  allowReadOnlyTools,
  catalog,
  disabled,
  onChangePath,
  onInspect,
  picking,
  onBrowse,
  onClearWorkspace,
  onChangeSelectedPaths,
}) => {
  const [filter, setFilter] = useState("");
  const uniqueProviders = Array.from(new Set(activeProviders));

  const includedCount = inspection
    ? selectedPaths.length > 0
      ? selectedPaths.length
      : inspection.files.length
    : 0;

  const visibleFiles = useMemo(() => {
    if (!inspection) return [];
    const q = filter.trim().toLowerCase();
    return q ? inspection.files.filter((f) => f.path.toLowerCase().includes(q)) : inspection.files;
  }, [inspection, filter]);

  const toggleFile = (filePath: string) => {
    if (selectedPaths.length === 0 && inspection) {
      onChangeSelectedPaths(inspection.files.map((f) => f.path).filter((p) => p !== filePath));
      return;
    }
    onChangeSelectedPaths(
      selectedPaths.includes(filePath)
        ? selectedPaths.filter((p) => p !== filePath)
        : [...selectedPaths, filePath],
    );
  };

  const repoName = workspacePath.split("/").filter(Boolean).pop();
  const attached = Boolean(workspacePath.trim());

  return (
    <Sheet>
      <Hint label={attached ? workspacePath : "Repository"}>
        <SheetTrigger asChild>
          <button
            type="button"
            aria-label="Repository"
            className={cn(
              "flex h-7 max-w-44 items-center gap-1.5 rounded-md px-2 text-xs outline-none",
              "transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/30",
              attached ? "text-foreground" : "text-subtle-foreground hover:text-foreground",
            )}
          >
            <FolderGit2 className="size-3.5 shrink-0" />
            {attached && <span className="truncate">{repoName}</span>}
          </button>
        </SheetTrigger>
      </Hint>

      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Repository</SheetTitle>
          <SheetDescription className="sr-only">Read-only snapshot shared with every agent</SheetDescription>
        </SheetHeader>

        <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onInspect();
            }}
          >
            <div className="relative flex-1">
              <FolderGit2 className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle-foreground" />
              <Input
                value={workspacePath}
                disabled={disabled}
                placeholder="/path/to/repository"
                aria-label="Repository path"
                spellCheck={false}
                onChange={(e) => onChangePath(e.target.value)}
                className="pl-9 font-mono text-[0.8125rem]"
              />
              {attached && (
                <button
                  type="button"
                  aria-label="Clear repository"
                  disabled={disabled}
                  onClick={onClearWorkspace}
                  className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full text-subtle-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
            <Hint label="Choose folder">
              <Button
                type="button"
                variant="outline"
                aria-label="Choose folder"
                disabled={disabled || picking || inspecting}
                onClick={onBrowse}
              >
                <FolderOpen className="size-4" />
                {picking ? "Choosing…" : "Browse"}
              </Button>
            </Hint>
            <Button type="submit" variant="outline" disabled={disabled || inspecting || !attached}>
              {inspecting ? "…" : "Inspect"}
            </Button>
          </form>

          {inspectError && (
            <div className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{inspectError}</div>
          )}


          {inspection && (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {inspection.gitBranch && (
                  <span className="flex items-center gap-1">
                    <GitBranch className="size-3" />
                    {inspection.gitBranch}
                  </span>
                )}
                {inspection.gitCommit && (
                  <span className="flex items-center gap-1 font-mono">
                    <GitCommitHorizontal className="size-3" />
                    {inspection.gitCommit.slice(0, 7)}
                    {inspection.gitDirty ? "*" : ""}
                  </span>
                )}
                <span className="tabular">
                  {includedCount}/{inspection.files.length} files · {Math.round(inspection.totalBytes / 1024)} KB
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle-foreground">
                Shared with
                {uniqueProviders.map((p) => (
                  <span key={p} className="flex items-center gap-1">
                    <ProviderMark provider={p} size="xs" />
                    {p}
                  </span>
                ))}
              </div>

              <Tabs defaultValue="files" className="min-h-0 flex-1">
                <TabsList>
                  <TabsTrigger value="files">Files</TabsTrigger>
                  <TabsTrigger value="perms">
                    Permissions
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="files" className="flex min-h-0 flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground" />
                      <Input
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filter files"
                        className="h-8 pl-8 text-xs"
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={disabled || selectedPaths.length === 0}
                      onClick={() => onChangeSelectedPaths([])}
                    >
                      Select all
                    </Button>
                  </div>
                  <ul className="scroll-quiet max-h-[42vh] overflow-y-auto rounded-md border bg-card">
                    {visibleFiles.map((f) => {
                      const checked = selectedPaths.length === 0 || selectedPaths.includes(f.path);
                      return (
                        <li key={f.path} className="border-b last:border-b-0">
                          <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-accent">
                            <Checkbox
                              checked={checked}
                              disabled={disabled}
                              onCheckedChange={() => toggleFile(f.path)}
                            />
                            <span
                              className={cn(
                                "min-w-0 flex-1 truncate font-mono text-[0.75rem]",
                                !checked && "text-subtle-foreground line-through decoration-border-strong",
                              )}
                              title={f.path}
                            >
                              {f.path}
                            </span>
                            <span className="tabular text-[0.6875rem] text-subtle-foreground">
                              {f.sizeBytes < 1024 ? `${f.sizeBytes} B` : `${(f.sizeBytes / 1024).toFixed(1)} KB`}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                    {visibleFiles.length === 0 && (
                      <li className="px-3 py-6 text-center text-xs text-subtle-foreground">No matching files</li>
                    )}
                  </ul>
                  {inspection.truncated && (
                    <p className="text-[0.6875rem] text-warning">File list truncated — very large repository.</p>
                  )}
                </TabsContent>

                <TabsContent value="perms" className="space-y-2">
                  {uniqueProviders.map((pid) => {
                    const entry = catalog.find((c) => c.id === pid);
                    const policy = allowReadOnlyTools
                      ? entry?.readOnlyPolicies.withTools
                      : entry?.readOnlyPolicies.withoutTools;
                    if (!policy) return null;
                    return (
                      <div key={pid} className="space-y-2 rounded-md border bg-card p-3">
                        <div className="flex items-center gap-2">
                          <ProviderMark provider={pid} size="sm" />
                          <span className="text-sm font-medium">{pid}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">{policy.sandboxSummary}</p>
                        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1 text-xs">
                          <dt className="text-success">Allowed</dt>
                          <dd>{policy.allowedOperations.join(", ")}</dd>
                          <dt className="text-danger">Blocked</dt>
                          <dd>{policy.blockedOperations.join(", ")}</dd>
                        </dl>
                        <div className="flex flex-wrap gap-1">
                          {policy.flags.map((flag) => (
                            <Badge key={flag} variant="mono">
                              {flag}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>

      </SheetContent>
    </Sheet>
  );
};
