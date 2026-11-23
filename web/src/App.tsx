import React, { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeft } from "lucide-react";
import { toast } from "sonner";
import {
  checkProvidersApi,
  createChatApi,
  deleteChatApi,
  fetchProviders,
  getChatApi,
  getRunApi,
  createProjectApi,
  deleteProjectApi,
  inspectWorkspaceApi,
  listProjectsApi,
  fetchUsageApi,
  pickFolderApi,
  updateClisApi,
  listChatsApi,
  retryAssignmentApi,
  startTurnApi,
  stopRunApi,
  subscribeRunEvents,
  synthesizeRunApi,
  ServiceUnavailableError,
} from "./api";
import { AgentsSheet } from "./components/app/AgentsSheet";
import { AppSidebar } from "./components/app/AppSidebar";
import { Suggestions } from "./components/app/Suggestions";
import { Composer, type ComposerHandle } from "./components/composer/Composer";
import { ModeSwitch } from "./components/composer/ModeSwitch";
import { RunSettings } from "./components/composer/RunSettings";
import { TeamSheet } from "./components/team/TeamSheet";
import { TurnView } from "./components/turn/TurnView";
import { WorkspaceSheet } from "./components/workspace/WorkspaceSheet";
import { Button } from "./components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "./components/ui/sheet";
import { Hint } from "./components/ui/tooltip";
import { useMediaQuery } from "./hooks/use-media-query";
import { normalizeParticipant, type RunLimitsForm } from "./lib/run-config";
import { defaultTeamFor, hasSavedConfig, loadConfig, saveConfig } from "./lib/persisted-config";
import { cn } from "./lib/utils";
import type {
  ChatRecord,
  CliUpdateStatus,
  HydratedRun,
  ProviderUsage,
  OrchestrationMode,
  ParticipantSpec,
  ProviderCatalogEntry,
  ProviderCheckResult,
  ProjectRecord,
  ProviderId,
  ReasoningEffort,
  StoredRunEvent,
  WorkspaceInspection,
} from "./types";

const SIDEBAR_KEY = "council.sidebar";

function getInitialChatIdFromHash(): string | null {
  const match = /chat=([^&]+)/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]!) : null;
}

function readSidebarPref(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "closed";
  } catch {
    return true;
  }
}

const OFFLINE_TOAST = "council-offline";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const App: React.FC = () => {
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [addingProject, setAddingProject] = useState(false);
  const [activeChatId, setActiveChatId] = useState<string | null>(getInitialChatIdFromHash);
  const [runs, setRuns] = useState<HydratedRun[]>([]);
  // False until the first conversation has loaded, so we never flash the new-chat layout.
  const [contentReady, setContentReady] = useState(false);
  const [providers, setProviders] = useState<ProviderCatalogEntry[]>([]);
  const [cliUpdates, setCliUpdates] = useState<CliUpdateStatus[]>([]);
  const [checkResults, setCheckResults] = useState<ProviderCheckResult[]>([]);
  const [checkingIds, setCheckingIds] = useState<ProviderId[]>([]);
  const checkingProviders = checkingIds.length > 0;
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [usage, setUsage] = useState<ProviderUsage[]>([]);
  const [refreshingUsage, setRefreshingUsage] = useState(false);

  // Last-used config is restored from localStorage once, then saved on every change.
  const [firstRun] = useState(() => !hasSavedConfig());
  const [initialConfig] = useState(loadConfig);
  const [lead, setLead] = useState<ParticipantSpec>(initialConfig.lead);
  const [teammates, setTeammates] = useState<ParticipantSpec[]>(initialConfig.teammates);
  const [mode, setMode] = useState<OrchestrationMode>(initialConfig.mode);
  const [independentFirstOpinions, setIndependentFirstOpinions] = useState(initialConfig.independentFirstOpinions);
  const [allowReadOnlyTools, setAllowReadOnlyTools] = useState(initialConfig.allowReadOnlyTools);
  const [limits, setLimits] = useState<RunLimitsForm>(initialConfig.limits);

  const [workspacePath, setWorkspacePath] = useState(initialConfig.workspacePath);
  const [inspection, setInspection] = useState<WorkspaceInspection | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>(initialConfig.selectedPaths);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [liveEventsByRun, setLiveEventsByRun] = useState<Record<string, StoredRunEvent[]>>({});

  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarPref);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const activeSubsRef = useRef<Map<string, () => void>>(new Map());
  const workspacePathRef = useRef(workspacePath);
  // attachRunStream is defined before loadUsage; reach it through a ref.
  const loadUsageRef = useRef<(refresh?: boolean) => Promise<void>>(async () => {});
  workspacePathRef.current = workspacePath;
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);

  // ── Data ────────────────────────────────────────────────────
  const refreshChat = useCallback(
    async (chatId: string) => {
      try {
        const data = await getChatApi(chatId);
        setRuns(data.runs);
        if (data.chat.workspacePath && !workspacePath) setWorkspacePath(data.chat.workspacePath);
      } catch (err) {
        toast.error(errorText(err));
      }
    },
    [workspacePath],
  );

  const attachRunStream = useCallback(
    (runId: string, chatId: string) => {
      if (activeSubsRef.current.has(runId)) return;
      // Start clean and follow only the current pass (a retry replays from its run_resumed).
      setLiveEventsByRun((prev) => ({ ...prev, [runId]: [] }));
      const unsub = subscribeRunEvents(runId, 0, (stored) => {
        setLiveEventsByRun((prev) => ({ ...prev, [runId]: [...(prev[runId] ?? []), stored] }));
        const t = stored.event.type;
        if (
          t === "assignment_started" ||
          t === "assignment_completed" ||
          t === "roundtable_turn_completed" ||
          t === "followup_completed" ||
          t === "lead_action" ||
          t === "run_resumed"
        ) {
          void getRunApi(runId).then((updated) => setRuns((prev) => prev.map((r) => (r.id === runId ? updated : r))));
        }
        if (t === "run_finished") {
          void loadUsageRef.current(true);
          activeSubsRef.current.get(runId)?.();
          activeSubsRef.current.delete(runId);
          void refreshChat(chatId);
          void listChatsApi().then(setChats);
        }
      }, undefined, { sinceResume: true });
      activeSubsRef.current.set(runId, unsub);
    },
    [refreshChat],
  );

  // ── Provider catalog (models + thinking levels) ─────────────
  const loadProviders = useCallback(async () => {
    try {
      const res = await fetchProviders();
      setProviders(res.providers);
      setCliUpdates((prev) => {
        for (const u of res.cliUpdates) {
          const was = prev.find((p) => p.provider === u.provider)?.state;
          if (u.state === "updated" && was !== "updated") {
            toast.success(`${u.provider} CLI updated`, {
              description: `${u.versionBefore ?? "?"} → ${u.versionAfter ?? "?"} · model list refreshed`,
            });
          } else if (u.state === "failed" && was === "updating") {
            toast.error(`Couldn’t update the ${u.provider} CLI`, { description: u.message });
          }
        }
        return res.cliUpdates;
      });
    } catch {
      // bootstrap handles the offline state
    }
  }, []);

  // ── Subscription usage (5-hour / weekly) ────────────────────
  const loadUsage = useCallback(async (refresh = false) => {
    if (refresh) setRefreshingUsage(true);
    try {
      setUsage(await fetchUsageApi(refresh));
    } catch {
      // offline state is handled by bootstrap
    } finally {
      if (refresh) setRefreshingUsage(false);
    }
  }, []);

  loadUsageRef.current = loadUsage;

  // On load, every 5 minutes, and when the tab regains focus (the server caches for a minute).
  useEffect(() => {
    void loadUsage();
    const timer = window.setInterval(() => void loadUsage(), 5 * 60_000);
    const onFocus = () => void loadUsage();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadUsage]);

  // The server updates the CLIs on startup; poll until that finishes so new models appear.
  const updatingClis = cliUpdates.some((u) => u.state === "updating");
  useEffect(() => {
    if (!updatingClis) return;
    const timer = window.setInterval(() => void loadProviders(), 4000);
    return () => window.clearInterval(timer);
  }, [updatingClis, loadProviders]);

  // Re-read the catalog when the tab regains focus, so model lists never go stale.
  useEffect(() => {
    const onFocus = () => void loadProviders();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadProviders]);

  // First launch: start with a team made of the CLIs this machine actually has.
  const firstRunTeamApplied = useRef(false);
  useEffect(() => {
    if (!firstRun || firstRunTeamApplied.current || providers.length === 0) return;
    firstRunTeamApplied.current = true;
    const installed = providers.filter((p) => p.discovery.executablePath).map((p) => p.id);
    const team = defaultTeamFor(installed);
    setLead(team.lead);
    setTeammates(team.teammates);
  }, [firstRun, providers]);

  // Fix saved or stale selections (old agy per-level slugs, levels a model doesn't accept).
  useEffect(() => {
    if (providers.length === 0) return;
    setLead((prev) => normalizeParticipant(prev, providers));
    setTeammates((prev) => {
      const next = prev.map((t) => normalizeParticipant(t, providers));
      return next.every((t, i) => t === prev[i]) ? prev : next;
    });
  }, [providers]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;

    const bootstrap = async () => {
      try {
        const list = await listChatsApi();
        if (cancelled) return;
        toast.dismiss(OFFLINE_TOAST);
        void loadProviders();
        void listProjectsApi()
          .then(setProjects)
          .catch(() => {});
        setChats(list);
        const fromHash = getInitialChatIdFromHash();
        const targetId = fromHash && list.some((c) => c.id === fromHash) ? fromHash : (list[0]?.id ?? null);
        if (targetId) {
          setActiveChatId(targetId);
        } else {
          const created = await createChatApi({ title: "New Chat" });
          setChats([created]);
          setActiveChatId(created.id);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ServiceUnavailableError) {
          // One persistent notice (fixed id, so no duplicates); retry quietly until it's up.
          toast.error("Council service isn’t running", {
            id: OFFLINE_TOAST,
            duration: Infinity,
            description: "Start it with npm run dev:serve — reconnecting automatically.",
          });
          retryTimer = window.setTimeout(() => void bootstrap(), 3000);
        } else {
          toast.error(errorText(err));
        }
      }
    };
    void bootstrap();

    const subs = activeSubsRef.current;
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      for (const unsub of subs.values()) unsub();
      subs.clear();
    };
  }, []);

  useEffect(() => {
    if (!activeChatId) return;
    window.location.hash = `chat=${encodeURIComponent(activeChatId)}`;
    for (const unsub of activeSubsRef.current.values()) unsub();
    activeSubsRef.current.clear();

    void getChatApi(activeChatId)
      .then((data) => {
        setRuns(data.runs);
        setContentReady(true);
        const chatPath = data.chat.workspacePath;
        if (chatPath && chatPath !== workspacePathRef.current) {
          setWorkspacePath(chatPath);
          setInspection(null);
          setSelectedPaths([]);
          // Load the new folder's file list so the chat is ready to go.
          void inspectWorkspaceApi(chatPath)
            .then((res) => {
              if (workspacePathRef.current === chatPath) setInspection(res);
            })
            .catch(() => {});
        }
        for (const run of data.runs) {
          if (run.status === "running") attachRunStream(run.id, activeChatId);
        }
        requestAnimationFrame(() => {
          if (data.runs.length > 0) scrollToEnd("auto");
          else scrollRef.current?.scrollTo({ top: 0 });
        });
      })
      .catch((err) => toast.error(errorText(err)));
  }, [activeChatId, attachRunStream]);

  // ── Scrolling ───────────────────────────────────────────────
  const scrollToEnd = (behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  };
  const runCount = runs.length;
  useEffect(() => {
    if (runCount > 0) requestAnimationFrame(() => scrollToEnd());
  }, [runCount]);

  // ── Actions ─────────────────────────────────────────────────
  const handleNewChat = useCallback(async () => {
    try {
      const created = await createChatApi({ title: "New Chat", workspacePath: workspacePath.trim() || undefined });
      setChats((prev) => [created, ...prev]);
      setActiveChatId(created.id);
      setRuns([]);
      setMobileNavOpen(false);
      scrollRef.current?.scrollTo({ top: 0 });
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (err) {
      toast.error(errorText(err));
    }
  }, [workspacePath]);

  const handleNewChatInProject = async (project: ProjectRecord) => {
    try {
      const created = await createChatApi({ title: "New Chat", workspacePath: project.path });
      setChats((prev) => [created, ...prev]);
      if (project.path !== workspacePath) {
        setWorkspacePath(project.path);
        setInspection(null);
        setSelectedPaths([]);
        void handleInspectWorkspace(project.path);
      }
      setActiveChatId(created.id);
      setRuns([]);
      setMobileNavOpen(false);
      scrollRef.current?.scrollTo({ top: 0 });
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const handleAddProject = async () => {
    setAddingProject(true);
    try {
      const picked = await pickFolderApi(workspacePath.trim() || undefined);
      if (picked.status === "unsupported") {
        toast.error(picked.reason);
        return;
      }
      if (picked.status !== "picked") return;
      const project = await createProjectApi(picked.path);
      setProjects((prev) =>
        prev.some((p) => p.id === project.id)
          ? prev
          : [...prev, project].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
      );
      await handleNewChatInProject(project);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setAddingProject(false);
    }
  };

  const handleRemoveProject = async (project: ProjectRecord) => {
    try {
      await deleteProjectApi(project.id);
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
      toast(`Removed ${project.name}`, { description: "Its chats are kept under Chats." });
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const handleSelectChat = (id: string) => {
    setActiveChatId(id);
    setMobileNavOpen(false);
  };

  const handleDeleteChat = async (chatId: string) => {
    try {
      await deleteChatApi(chatId);
      const updated = await listChatsApi();
      setChats(updated);
      toast.success("Conversation deleted");
      if (chatId === activeChatId) {
        if (updated[0]) {
          setActiveChatId(updated[0].id);
        } else {
          const created = await createChatApi({ title: "New Chat" });
          setChats([created]);
          setActiveChatId(created.id);
        }
      }
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const handleCheckProviders = async (ids?: ProviderId[]) => {
    const targets = ids ?? providers.map((p) => p.id);
    setCheckingIds((prev) => [...new Set([...prev, ...targets])]);
    try {
      const results = await checkProvidersApi(ids);
      setCheckResults((prev) => [...prev.filter((r) => !results.some((n) => n.provider === r.provider)), ...results]);
      const ok = results.filter((r) => r.outcome === "ok").length;
      if (results.length === 1) {
        if (ok) toast.success(`${results[0]!.provider} responded`);
        else toast.warning(`${results[0]!.provider}: ${results[0]!.errorMessage ?? results[0]!.outcome}`);
      } else if (ok === results.length) toast.success(`All ${ok} agents responded`);
      else toast.warning(`${ok} of ${results.length} agents responded`);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setCheckingIds((prev) => prev.filter((id) => !targets.includes(id)));
    }
  };

  const handleUpdateClis = async () => {
    try {
      setCliUpdates(await updateClisApi());
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const pickFastConfig = (provider: ProviderId): { model?: string; effort?: ReasoningEffort } => {
    const models = providers.find((p) => p.id === provider)?.models ?? [];
    if (provider === "agy") {
      const fast = models.find((m) => m.id === "gemini-3.8-flash") ?? models.find((m) => m.isFast);
      const effort = fast?.efforts.includes("low") ? "low" : undefined;
      return { model: fast?.id, effort };
    }
    if (provider === "claude") {
      const fast = models.find((m) => m.id === "sonnet") ?? models[0];
      return { model: fast?.id ?? "sonnet", effort: "low" };
    }
    const fast = models.find((m) => m.id === "gpt-6-luna") ?? models.find((m) => m.isFast);
    return { model: fast?.id, effort: "low" };
  };

  const handleApplyFastPreset = () => {
    setLead({ ...lead, ...pickFastConfig(lead.provider) });
    setTeammates((prev) => prev.map((t) => ({ ...t, ...pickFastConfig(t.provider) })));
    toast("Low-usage preset applied");
  };

  const handleInspectWorkspace = async (pathOverride?: string, keepSelection = false) => {
    const target = (pathOverride ?? workspacePath).trim();
    if (!target) return;
    setInspecting(true);
    setInspectError(null);
    try {
      const res = await inspectWorkspaceApi(target);
      setInspection(res);
      setWorkspacePath(res.sourcePath);
      if (keepSelection) {
        const available = new Set(res.files.map((f) => f.path));
        setSelectedPaths((prev) => {
          const kept = prev.filter((p) => available.has(p));
          // An empty list means "all files"; don't widen a selection without saying so.
          if (prev.length > 0 && kept.length === 0) {
            toast.warning("Your saved file selection no longer exists", {
              description: "All files in the repository are selected. Untick any you don’t want shared.",
            });
          }
          return kept;
        });
      } else {
        setSelectedPaths([]);
      }
    } catch (err) {
      setInspectError(errorText(err));
    } finally {
      setInspecting(false);
    }
  };

  const [picking, setPicking] = useState(false);
  const handleBrowseWorkspace = async () => {
    setPicking(true);
    setInspectError(null);
    try {
      const res = await pickFolderApi(workspacePath.trim() || undefined);
      if (res.status === "picked") {
        setWorkspacePath(res.path);
        await handleInspectWorkspace(res.path);
      } else if (res.status === "unsupported") {
        setInspectError(res.reason);
      }
    } catch (err) {
      setInspectError(errorText(err));
    } finally {
      setPicking(false);
    }
  };

  useEffect(() => {
    saveConfig({
      lead,
      teammates,
      mode,
      independentFirstOpinions,
      allowReadOnlyTools,
      limits,
      workspacePath,
      selectedPaths,
    });
  }, [lead, teammates, mode, independentFirstOpinions, allowReadOnlyTools, limits, workspacePath, selectedPaths]);

  // Re-inspect the restored repo on load so its file list is ready, keeping the saved file selection.
  const restoredInspectRef = useRef(false);
  useEffect(() => {
    if (restoredInspectRef.current || !initialConfig.workspacePath) return;
    restoredInspectRef.current = true;
    void handleInspectWorkspace(initialConfig.workspacePath, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClearWorkspace = () => {
    setWorkspacePath("");
    setInspection(null);
    setSelectedPaths([]);
    setInspectError(null);
  };

  const runningRun = runs.find((r) => r.status === "running");
  const activeRunning = Boolean(runningRun);

  const handleSend = async () => {
    if (!prompt.trim() || submitting || activeRunning) return;
    setSubmitting(true);
    try {
      let chatId = activeChatId;
      if (!chatId) {
        const created = await createChatApi({ title: "New Chat" });
        setChats((prev) => [created, ...prev]);
        chatId = created.id;
        setActiveChatId(created.id);
      }
      const run = await startTurnApi(chatId, {
        prompt: prompt.trim(),
        mode,
        independentFirstOpinions,
        lead,
        teammates,
        workspacePath: workspacePath.trim() || undefined,
        selectedPaths: selectedPaths.length > 0 ? selectedPaths : undefined,
        allowReadOnlyTools,
        limits,
      });
      setPrompt("");
      setRuns((prev) => [...prev, run]);
      attachRunStream(run.id, chatId);
      void listChatsApi().then(setChats);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleStopRun = async (runId: string) => {
    setBusyAction(`stop:${runId}`);
    try {
      await stopRunApi(runId);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRetryAssignment = async (runId: string, assignmentId: string) => {
    setBusyAction(`retry:${runId}:${assignmentId}`);
    try {
      const updated = await retryAssignmentApi(runId, assignmentId, true);
      setRuns((prev) => prev.map((r) => (r.id === runId ? updated : r)));
      if (activeChatId) attachRunStream(runId, activeChatId);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleSynthesizeRun = async (runId: string) => {
    setBusyAction(`synth:${runId}`);
    try {
      const updated = await synthesizeRunApi(runId);
      setRuns((prev) => prev.map((r) => (r.id === runId ? updated : r)));
      if (activeChatId) attachRunStream(runId, activeChatId);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusyAction(null);
    }
  };

  // ── Chrome ──────────────────────────────────────────────────
  const toggleSidebar = useCallback(() => {
    if (!isDesktop) {
      setMobileNavOpen((v) => !v);
      return;
    }
    setSidebarOpen((v) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, v ? "closed" : "open");
      } catch {
        /* storage unavailable */
      }
      return !v;
    });
  }, [isDesktop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void handleNewChat();
      } else if (e.key === "/" && !mod) {
        const t = e.target as HTMLElement | null;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        e.preventDefault();
        composerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar, handleNewChat]);

  const activeChat = chats.find((c) => c.id === activeChatId);
  const configLocked = activeRunning || submitting;
  const activeProviders: ProviderId[] = [lead.provider, ...teammates.map((t) => t.provider)];

  const sidebar = (
    <AppSidebar
      chats={chats}
      projects={projects}
      addingProject={addingProject}
      onAddProject={() => void handleAddProject()}
      onNewChatInProject={(p) => void handleNewChatInProject(p)}
      onRemoveProject={(p) => void handleRemoveProject(p)}
      activeChatId={activeChatId}
      providers={providers}
      checkResults={checkResults}
      checkingProviders={checkingProviders}
      cliUpdates={cliUpdates}
      checkingIds={checkingIds}
      usage={usage}
      onSelectChat={handleSelectChat}
      onNewChat={handleNewChat}
      onDeleteChat={handleDeleteChat}
      onCheckProviders={() => void handleCheckProviders()}
      onOpenAgents={() => setAgentsOpen(true)}
    />
  );

  const composer = (
    <Composer
      ref={composerRef}
      value={prompt}
      onChange={setPrompt}
      onSubmit={() => void handleSend()}
      onStop={() => runningRun && void handleStopRun(runningRun.id)}
      running={activeRunning}
      submitting={submitting}
      stopping={runningRun ? busyAction === `stop:${runningRun.id}` : false}
      toolbar={
        <>
          <TeamSheet
            lead={lead}
            teammates={teammates}
            catalog={providers}
            disabled={configLocked}
            onChangeLead={setLead}
            onChangeTeammates={setTeammates}
            onApplyFastPreset={handleApplyFastPreset}
          />
          <ModeSwitch
            mode={mode}
            independentFirstOpinions={independentFirstOpinions}
            disabled={configLocked}
            onChangeMode={setMode}
            onChangeIndependent={setIndependentFirstOpinions}
          />
          <WorkspaceSheet
            workspacePath={workspacePath}
            inspection={inspection}
            selectedPaths={selectedPaths}
            inspecting={inspecting}
            inspectError={inspectError}
            activeProviders={activeProviders}
            allowReadOnlyTools={allowReadOnlyTools}
            catalog={providers}
            disabled={configLocked}
            onChangePath={setWorkspacePath}
            onInspect={() => void handleInspectWorkspace()}
            picking={picking}
            onBrowse={handleBrowseWorkspace}
            onClearWorkspace={handleClearWorkspace}
            onChangeSelectedPaths={setSelectedPaths}
          />
          <RunSettings
            limits={limits}
            allowReadOnlyTools={allowReadOnlyTools}
            disabled={configLocked}
            onChangeLimits={setLimits}
            onChangeAllowReadOnlyTools={setAllowReadOnlyTools}
          />
        </>
      }
    />
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <AgentsSheet
        open={agentsOpen}
        onOpenChange={setAgentsOpen}
        providers={providers}
        checkResults={checkResults}
        checking={checkingIds}
        cliUpdates={cliUpdates}
        onTest={(ids) => void handleCheckProviders(ids)}
        onUpdate={() => void handleUpdateClis()}
        usage={usage}
        refreshingUsage={refreshingUsage}
        onRefreshUsage={() => void loadUsage(true)}
      />
      {/* Desktop sidebar */}
      <aside
        aria-label="Sidebar"
        className={cn(
          "hidden shrink-0 overflow-hidden border-r border-sidebar-border md:block",
          "transition-[width,opacity] duration-(--duration-slow) ease-out",
          sidebarOpen ? "w-60 opacity-100" : "w-0 border-r-0 opacity-0",
        )}
        inert={!sidebarOpen || undefined}
      >
        <div className="h-full w-60">{sidebar}</div>
      </aside>

      {/* Mobile sidebar */}
      <Sheet open={mobileNavOpen && !isDesktop} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-60 p-0 [&>button:last-child]:hidden" aria-describedby={undefined}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-1.5 px-2">
          <Hint label="Toggle sidebar  ⌘B">
            <Button variant="ghost" size="icon-xs" onClick={toggleSidebar} aria-label="Toggle sidebar">
              <PanelLeft />
            </Button>
          </Hint>
          <h2 className="min-w-0 truncate text-[0.8125rem] text-muted-foreground">{runs.length > 0 ? activeChat?.title : ""}</h2>
        </header>

        {!contentReady ? (
          <div className="flex-1" />
        ) : runs.length === 0 ? (
          <div ref={scrollRef} className="scroll-quiet flex flex-1 flex-col overflow-y-auto px-4">
            <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-3 pb-[12vh]">
              {composer}
              <Suggestions
                onPick={(text) => {
                  setPrompt(text);
                  composerRef.current?.focus();
                }}
              />
            </div>
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="scroll-quiet flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl divide-y px-4 pb-8 sm:px-6">
                {runs.map((run) => (
                  <TurnView
                    key={run.id}
                    run={run}
                    liveEvents={liveEventsByRun[run.id] ?? []}
                    busyAction={busyAction}
                    onRetryAssignment={handleRetryAssignment}
                    onSynthesizeRun={handleSynthesizeRun}
                  />
                ))}
              </div>
            </div>
            <div className="shrink-0 px-4 pb-4 sm:px-6">
              <div className="mx-auto w-full max-w-3xl">{composer}</div>
            </div>
          </>
        )}
      </main>
    </div>
  );
};
