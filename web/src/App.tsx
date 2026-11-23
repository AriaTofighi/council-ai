import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  checkProvidersApi,
  createChatApi,
  deleteChatApi,
  fetchProviders,
  getChatApi,
  getRunApi,
  inspectWorkspaceApi,
  listChatsApi,
  retryAssignmentApi,
  startTurnApi,
  stopRunApi,
  subscribeRunEvents,
  synthesizeRunApi,
} from "./api";
import { ControlBar, type RunLimitsForm } from "./components/ControlBar";
import { Sidebar } from "./components/Sidebar";
import { TurnCard } from "./components/TurnCard";
import { WorkspaceBar } from "./components/WorkspaceBar";
import type {
  ChatRecord,
  HydratedRun,
  OrchestrationMode,
  ParticipantSpec,
  ProviderCatalogEntry,
  ProviderCheckResult,
  ProviderId,
  ReasoningEffort,
  StoredRunEvent,
  WorkspaceInspection,
} from "./types";

const DEFAULT_LIMITS: RunLimitsForm = {
  maxLeadCalls: 6,
  maxTotalCalls: 14,
  perCallTimeoutMs: 90_000,
  hardDeadlineMs: 240_000,
  reserveSynthesisCall: true,
};

function getInitialChatIdFromHash(): string | null {
  const match = /chat=([^&]+)/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]!) : null;
}

export const App: React.FC = () => {
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(
    getInitialChatIdFromHash,
  );
  const [runs, setRuns] = useState<HydratedRun[]>([]);
  const [providers, setProviders] = useState<ProviderCatalogEntry[]>([]);
  const [checkResults, setCheckResults] = useState<ProviderCheckResult[]>([]);
  const [checkingProviders, setCheckingProviders] = useState(false);

  const [lead, setLead] = useState<ParticipantSpec>({
    provider: "claude",
    label: "claude lead",
  });
  const [teammates, setTeammates] = useState<ParticipantSpec[]>([
    { id: "init_codex", provider: "codex", label: "codex teammate #1" },
    { id: "init_agy", provider: "agy", label: "agy teammate #1" },
  ]);
  const [mode, setMode] = useState<OrchestrationMode>("roundtable");
  const [independentFirstOpinions, setIndependentFirstOpinions] =
    useState(false);
  const [allowReadOnlyTools, setAllowReadOnlyTools] = useState(true);
  const [limits, setLimits] = useState<RunLimitsForm>(DEFAULT_LIMITS);

  const [workspacePath, setWorkspacePath] = useState("");
  const [inspection, setInspection] = useState<WorkspaceInspection | null>(
    null,
  );
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [liveEventsByRun, setLiveEventsByRun] = useState<
    Record<string, StoredRunEvent[]>
  >({});

  const activeSubsRef = useRef<Map<string, () => void>>(new Map());

  const refreshChat = useCallback(async (chatId: string) => {
    try {
      const data = await getChatApi(chatId);
      setRuns(data.runs);
      if (data.chat.workspacePath && !workspacePath) {
        setWorkspacePath(data.chat.workspacePath);
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  }, [workspacePath]);

  const attachRunStream = useCallback(
    (runId: string, chatId: string) => {
      if (activeSubsRef.current.has(runId)) return;
      const unsub = subscribeRunEvents(runId, 0, (stored) => {
        setLiveEventsByRun((prev) => ({
          ...prev,
          [runId]: [...(prev[runId] ?? []), stored],
        }));

        const t = stored.event.type;
        if (
          t === "assignment_started" ||
          t === "assignment_completed" ||
          t === "roundtable_turn_completed" ||
          t === "followup_completed" ||
          t === "lead_action"
        ) {
          void getRunApi(runId).then((updated) => {
            setRuns((prev) =>
              prev.map((r) => (r.id === runId ? updated : r)),
            );
          });
        }

        if (t === "run_finished") {
          activeSubsRef.current.get(runId)?.();
          activeSubsRef.current.delete(runId);
          void refreshChat(chatId);
          void listChatsApi().then(setChats);
        }
      });
      activeSubsRef.current.set(runId, unsub);
    },
    [refreshChat],
  );

  useEffect(() => {
    void fetchProviders().then(setProviders).catch(() => {});
    void listChatsApi().then(async (list) => {
      setChats(list);
      const fromHash = getInitialChatIdFromHash();
      const targetId =
        fromHash && list.some((c) => c.id === fromHash)
          ? fromHash
          : list[0]?.id ?? null;
      if (targetId) {
        setActiveChatId(targetId);
      } else {
        const created = await createChatApi({ title: "New Chat" });
        setChats([created]);
        setActiveChatId(created.id);
      }
    });

    return () => {
      for (const unsub of activeSubsRef.current.values()) {
        unsub();
      }
      activeSubsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!activeChatId) return;
    window.location.hash = `chat=${encodeURIComponent(activeChatId)}`;
    for (const unsub of activeSubsRef.current.values()) {
      unsub();
    }
    activeSubsRef.current.clear();

    void getChatApi(activeChatId).then((data) => {
      setRuns(data.runs);
      setWorkspacePath(data.chat.workspacePath ?? "");
      setInspection(null);
      setSelectedPaths([]);
      for (const run of data.runs) {
        if (run.status === "running") {
          attachRunStream(run.id, activeChatId);
        }
      }
    });
  }, [activeChatId, attachRunStream]);

  const handleNewChat = async () => {
    const created = await createChatApi({
      title: "New Chat",
      workspacePath: workspacePath.trim() || undefined,
    });
    setChats((prev) => [created, ...prev]);
    setActiveChatId(created.id);
    setRuns([]);
  };

  const handleDeleteChat = async (chatId: string) => {
    await deleteChatApi(chatId);
    const updated = await listChatsApi();
    setChats(updated);
    if (chatId === activeChatId) {
      if (updated[0]) {
        setActiveChatId(updated[0].id);
      } else {
        const created = await createChatApi({ title: "New Chat" });
        setChats([created]);
        setActiveChatId(created.id);
      }
    }
  };

  const handleCheckProviders = async () => {
    setCheckingProviders(true);
    try {
      const results = await checkProvidersApi();
      setCheckResults(results);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingProviders(false);
    }
  };

  const pickFastConfig = (
    provider: ProviderId,
  ): { model?: string; effort?: ReasoningEffort } => {
    const models = providers.find((p) => p.id === provider)?.models ?? [];
    if (provider === "agy") {
      const fast =
        models.find((m) => m.id === "gemini-3.8-flash-low") ??
        models.find((m) => m.isFast);
      return { model: fast?.id ?? "gemini-3.8-flash-low", effort: undefined };
    }
    if (provider === "claude") {
      const fast = models.find((m) => m.id === "sonnet") ?? models[0];
      return { model: fast?.id ?? "sonnet", effort: "low" };
    }
    const fast =
      models.find((m) => m.id === "gpt-6-luna") ??
      models.find((m) => m.isFast);
    return { model: fast?.id, effort: "low" };
  };

  const handleApplyFastPreset = () => {
    const leadFast = pickFastConfig(lead.provider);
    setLead({ ...lead, ...leadFast });
    setTeammates((prev) =>
      prev.map((t) => ({ ...t, ...pickFastConfig(t.provider) })),
    );
  };

  const handleInspectWorkspace = async () => {
    if (!workspacePath.trim()) return;
    setInspecting(true);
    setInspectError(null);
    try {
      const res = await inspectWorkspaceApi(workspacePath.trim());
      setInspection(res);
      setWorkspacePath(res.sourcePath);
      setSelectedPaths([]);
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : String(err));
    } finally {
      setInspecting(false);
    }
  };

  const handleClearWorkspace = () => {
    setWorkspacePath("");
    setInspection(null);
    setSelectedPaths([]);
    setInspectError(null);
  };

  const activeRunning = runs.some((r) => r.status === "running");

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || submitting || activeRunning) return;
    setErrorBanner(null);
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
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleStopRun = async (runId: string) => {
    setBusyAction(`stop:${runId}`);
    try {
      await stopRunApi(runId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRetryAssignment = async (runId: string, assignmentId: string) => {
    setBusyAction(`retry:${runId}:${assignmentId}`);
    setErrorBanner(null);
    try {
      const updated = await retryAssignmentApi(runId, assignmentId, true);
      setRuns((prev) => prev.map((r) => (r.id === runId ? updated : r)));
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleSynthesizeRun = async (runId: string) => {
    setBusyAction(`synth:${runId}`);
    setErrorBanner(null);
    try {
      const updated = await synthesizeRunApi(runId);
      setRuns((prev) => prev.map((r) => (r.id === runId ? updated : r)));
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const activeProviders: ProviderId[] = [
    lead.provider,
    ...teammates.map((t) => t.provider),
  ];

  return (
    <div className="app-shell">
      <Sidebar
        chats={chats}
        activeChatId={activeChatId}
        providers={providers}
        checkResults={checkResults}
        checkingProviders={checkingProviders}
        onSelectChat={setActiveChatId}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onCheckProviders={handleCheckProviders}
      />

      <main className="main-pane">
        <header className="top-controls">
          <ControlBar
            lead={lead}
            teammates={teammates}
            mode={mode}
            independentFirstOpinions={independentFirstOpinions}
            allowReadOnlyTools={allowReadOnlyTools}
            limits={limits}
            providers={providers}
            disabled={activeRunning || submitting}
            onChangeLead={setLead}
            onChangeTeammates={setTeammates}
            onChangeMode={setMode}
            onChangeIndependentFirstOpinions={setIndependentFirstOpinions}
            onChangeAllowReadOnlyTools={setAllowReadOnlyTools}
            onChangeLimits={setLimits}
            onApplyFastPreset={handleApplyFastPreset}
          />
          <WorkspaceBar
            workspacePath={workspacePath}
            inspection={inspection}
            selectedPaths={selectedPaths}
            inspecting={inspecting}
            inspectError={inspectError}
            activeProviders={activeProviders}
            allowReadOnlyTools={allowReadOnlyTools}
            catalog={providers}
            disabled={activeRunning || submitting}
            onChangePath={setWorkspacePath}
            onInspect={handleInspectWorkspace}
            onClearWorkspace={handleClearWorkspace}
            onChangeSelectedPaths={setSelectedPaths}
          />
        </header>

        {errorBanner && (
          <div className="error-banner">
            <span>{errorBanner}</span>
            <button type="button" onClick={() => setErrorBanner(null)}>
              ×
            </button>
          </div>
        )}

        <section className="timeline">
          {runs.length === 0 && (
            <div className="empty-state">
              <h2>Direct a team of coding agents</h2>
              <p>
                Choose a <strong>Lead</strong>, configure your{" "}
                <strong>Team</strong> (including model &amp; thinking effort per
                agent, or a second session of the lead CLI), pick{" "}
                <strong>Divide &amp; conquer</strong> or{" "}
                <strong>Roundtable</strong>, and optionally attach a read-only
                repository snapshot.
              </p>
            </div>
          )}
          {runs.map((run) => (
            <TurnCard
              key={run.id}
              run={run}
              liveEvents={liveEventsByRun[run.id] ?? []}
              busyAction={busyAction}
              onStopRun={handleStopRun}
              onRetryAssignment={handleRetryAssignment}
              onSynthesizeRun={handleSynthesizeRun}
            />
          ))}
        </section>

        <form className="composer" onSubmit={handleSend}>
          <textarea
            rows={2}
            placeholder={
              activeRunning
                ? "Waiting for current run to finish (or click Stop Run)..."
                : "Ask the team a question or switch mode/lead for a follow-up turn..."
            }
            disabled={submitting || activeRunning}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                void handleSend(e);
              }
            }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || activeRunning || !prompt.trim()}
          >
            {submitting ? "Starting..." : activeRunning ? "Running..." : "Send"}
          </button>
        </form>
      </main>
    </div>
  );
};
