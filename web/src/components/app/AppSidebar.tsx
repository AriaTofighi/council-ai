import React, { useMemo, useState } from "react";
import { ChevronRight, Folder, FolderOpen, FolderPlus, MoreHorizontal, Plus, RefreshCw, SquarePen, Trash2, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { StatusDot, humanize, runStatusTone } from "@/lib/providers";
import { cn, relativeTime } from "@/lib/utils";
import type { ChatRecord, CliUpdateStatus, ProviderUsage, ProjectRecord, ProviderCatalogEntry, ProviderCheckResult } from "@/types";
import { ThemeToggle } from "./ThemeToggle";
import { peakUsage, usageTone, windowName } from "./UsageMeters";

const COLLAPSED_KEY = "council.projects.collapsed";

function readCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

interface AppSidebarProps {
  chats: ChatRecord[];
  projects: ProjectRecord[];
  addingProject?: boolean;
  onAddProject: () => void;
  onNewChatInProject: (project: ProjectRecord) => void;
  onRemoveProject: (project: ProjectRecord) => void;
  activeChatId: string | null;
  providers: ProviderCatalogEntry[];
  checkResults: ProviderCheckResult[];
  checkingProviders: boolean;
  cliUpdates?: CliUpdateStatus[];
  /** Providers being live-tested right now. */
  checkingIds?: string[];
  usage?: ProviderUsage[];
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onDeleteChat: (chatId: string) => void;
  onCheckProviders: () => void;
  onOpenAgents: () => void;
}

export const AppSidebar: React.FC<AppSidebarProps> = ({
  chats,
  projects,
  addingProject,
  onAddProject,
  onNewChatInProject,
  onRemoveProject,
  activeChatId,
  providers,
  checkResults,
  checkingProviders,
  cliUpdates = [],
  checkingIds,
  usage = [],
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onCheckProviders,
  onOpenAgents,
}) => {
  const [pendingDelete, setPendingDelete] = useState<ChatRecord | null>(null);
  const checkByProvider = new Map(checkResults.map((r) => [r.provider, r]));
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggleProject = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  };

  // A chat belongs to the project whose folder it is working in.
  const { byProject, loose } = useMemo(() => {
    const projectByPath = new Map(projects.map((p) => [p.path, p.id]));
    const grouped = new Map<string, ChatRecord[]>();
    const rest: ChatRecord[] = [];
    for (const chat of chats) {
      const pid = chat.workspacePath ? projectByPath.get(chat.workspacePath) : undefined;
      if (pid) grouped.set(pid, [...(grouped.get(pid) ?? []), chat]);
      else rest.push(chat);
    }
    return { byProject: grouped, loose: rest };
  }, [chats, projects]);

  const renderChat = (chat: ChatRecord, nested: boolean) => {
    const active = chat.id === activeChatId;
    return (
      <li key={chat.id} className="group/chat relative">
        <button
          type="button"
          onClick={() => onSelectChat(chat.id)}
          aria-current={active ? "page" : undefined}
          title={chat.workspacePath ?? undefined}
          className={cn(
            "flex h-8 w-full items-center gap-2 rounded-md text-left text-[0.8125rem] outline-none",
            nested ? "pl-7 pr-2.5" : "px-2.5",
            "transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring/30",
            active
              ? "bg-sidebar-accent text-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
          )}
        >
          <span className="min-w-0 flex-1 truncate">{chat.title}</span>
          <span className="tabular shrink-0 text-[0.6875rem] text-subtle-foreground group-hover/chat:invisible group-focus-within/chat:invisible">
            {relativeTime(chat.updatedAt)}
          </span>
        </button>
        <button
          type="button"
          aria-label={`Delete ${chat.title}`}
          onClick={() => setPendingDelete(chat)}
          className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-subtle-foreground opacity-0 outline-none transition-opacity hover:text-danger focus-visible:opacity-100 group-hover/chat:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      </li>
    );
  };

  const sectionLabel = "eyebrow flex h-7 items-center px-2.5 text-subtle-foreground";

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-11 shrink-0 items-center px-2">
        <Hint label="New chat  ⇧⌘O" side="right">
          <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-foreground" onClick={onNewChat}>
            <SquarePen className="size-3.5" />
            New chat
          </Button>
        </Hint>
      </div>

      <nav className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Conversations">
        <div className="group/section flex items-center pr-1">
          <span className={cn(sectionLabel, "flex-1")}>Projects</span>
          <Hint label="Add project" side="right">
            <button
              type="button"
              aria-label="Add project"
              disabled={addingProject}
              onClick={onAddProject}
              className="grid size-6 place-items-center rounded text-subtle-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
            >
              <FolderPlus className="size-3.5" />
            </button>
          </Hint>
        </div>
        {projects.length === 0 && (
          <button
            type="button"
            onClick={onAddProject}
            disabled={addingProject}
            className="mb-1 flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[0.8125rem] text-subtle-foreground outline-none hover:bg-sidebar-accent/60 hover:text-foreground"
          >
            <Plus className="size-3.5" />
            {addingProject ? "Choosing folder…" : "Add a folder"}
          </button>
        )}
        <ul className="flex flex-col gap-px">
          {projects.map((project) => {
            const open = !collapsed.has(project.id);
            const projectChats = byProject.get(project.id) ?? [];
            const FolderIcon = open ? FolderOpen : Folder;
            return (
              <li key={project.id}>
                <div className="group/project relative">
                  <button
                    type="button"
                    onClick={() => toggleProject(project.id)}
                    aria-expanded={open}
                    title={project.path}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 pr-16 text-left text-[0.8125rem] text-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/30"
                  >
                    <FolderIcon className="size-3.5 shrink-0 text-subtle-foreground" />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    <ChevronRight
                      className={cn(
                        "size-3 shrink-0 text-subtle-foreground transition-transform duration-(--duration-fast)",
                        open && "rotate-90",
                      )}
                    />
                  </button>
                  <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/project:opacity-100">
                    <Hint label={`New chat in ${project.name}`} side="right">
                      <button
                        type="button"
                        aria-label={`New chat in ${project.name}`}
                        onClick={() => onNewChatInProject(project)}
                        className="grid size-6 place-items-center rounded text-subtle-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
                      >
                        <SquarePen className="size-3.5" />
                      </button>
                    </Hint>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`${project.name} options`}
                          className="grid size-6 place-items-center rounded text-subtle-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
                        >
                          <MoreHorizontal className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side="right">
                        <DropdownMenuItem onSelect={() => onNewChatInProject(project)}>
                          <SquarePen />
                          New chat
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onRemoveProject(project)}>
                          <X />
                          Remove project
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                {open && (
                  <ul className="flex flex-col gap-px">
                    {projectChats.map((chat) => renderChat(chat, true))}
                    {projectChats.length === 0 && (
                      <li className="flex h-7 items-center pl-7 text-xs text-subtle-foreground">No chats yet</li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>

        {loose.length > 0 && (
          <>
            <div className={cn(sectionLabel, "mt-3")}>Chats</div>
            <ul className="flex flex-col gap-px">{loose.map((chat) => renderChat(chat, false))}</ul>
          </>
        )}
      </nav>

      <div className="flex h-11 shrink-0 items-center gap-3 border-t border-sidebar-border px-3">
        <ul className="flex min-w-0 flex-1 items-center gap-3">
          {providers.map((p) => {
            const check = checkByProvider.get(p.id);
            const found = Boolean(p.discovery.executablePath);
            const status = check ? check.outcome : found ? "ready" : "missing";
            const updating = cliUpdates.find((u) => u.provider === p.id)?.state === "updating";
            const testing = checkingIds ? checkingIds.includes(p.id) : checkingProviders;
            const sub = usage.find((u) => u.provider === p.id);
            const peak = peakUsage(sub);
            // Near a usage limit outranks "ready": that's what decides if a run will get cut off.
            const nearLimit = peak !== undefined && peak >= 70;
            const tone = testing || updating ? "signal" : nearLimit ? usageTone(peak) : runStatusTone(status);
            return (
              <li key={p.id}>
                <Hint
                  side="top"
                  label={
                    <span className="flex flex-col gap-0.5">
                      <span>
                        {p.id} · {updating ? "updating CLI…" : humanize(status)}
                      </span>
                      <span className="font-mono opacity-70">
                        {p.discovery.version ?? p.discovery.executablePath ?? "not found"}
                      </span>
                      {check?.errorMessage && <span className="opacity-70">{check.errorMessage}</span>}
                      {sub?.groups.map((g, gi) => (
                        <span key={g.name ?? gi} className="tabular">
                          {g.name ? `${g.name}: ` : ""}
                          {g.windows.map((w) => `${windowName(w)} ${Math.round(w.usedPercent)}%`).join(" · ")}
                        </span>
                      ))}
                    </span>
                  }
                >
                  <button
                    type="button"
                    onClick={onOpenAgents}
                    aria-label={`${p.id} details`}
                    className="flex items-center gap-1.5 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
                  >
                    <StatusDot tone={tone} />
                    {p.id}
                  </button>
                </Hint>
              </li>
            );
          })}
        </ul>
        <Hint label="Test agents live">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={checkingProviders}
            onClick={onCheckProviders}
            aria-label="Test agents"
          >
            <RefreshCw className={cn(checkingProviders && "animate-spin")} />
          </Button>
        </Hint>
        <ThemeToggle />
      </div>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>All turns and run history will be permanently removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-destructive-foreground hover:bg-danger/90"
              onClick={() => pendingDelete && onDeleteChat(pendingDelete.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
