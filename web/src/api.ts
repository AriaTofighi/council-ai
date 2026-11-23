import type {
  ChatRecord,
  HydratedRun,
  OrchestrationMode,
  ParticipantSpec,
  ProviderCatalogEntry,
  ProviderCheckResult,
  ProviderId,
  StoredRunEvent,
  WorkspaceInspection,
} from "./types";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export async function fetchProviders(): Promise<ProviderCatalogEntry[]> {
  const res = await requestJson<{ providers: ProviderCatalogEntry[] }>(
    "/api/providers",
  );
  return res.providers;
}

export async function checkProvidersApi(
  providers?: ProviderId[],
): Promise<ProviderCheckResult[]> {
  const res = await requestJson<{ results: ProviderCheckResult[] }>(
    "/api/providers/check",
    {
      method: "POST",
      body: JSON.stringify({ providers, timeoutMs: 45_000 }),
    },
  );
  return res.results;
}

export async function inspectWorkspaceApi(
  workspacePath: string,
): Promise<WorkspaceInspection> {
  const res = await requestJson<{ inspection: WorkspaceInspection }>(
    "/api/workspace/inspect",
    {
      method: "POST",
      body: JSON.stringify({ path: workspacePath }),
    },
  );
  return res.inspection;
}

export async function listChatsApi(): Promise<ChatRecord[]> {
  const res = await requestJson<{ chats: ChatRecord[] }>("/api/chats");
  return res.chats;
}

export async function createChatApi(params?: {
  title?: string;
  workspacePath?: string;
}): Promise<ChatRecord> {
  const res = await requestJson<{ chat: ChatRecord }>("/api/chats", {
    method: "POST",
    body: JSON.stringify(params ?? {}),
  });
  return res.chat;
}

export async function getChatApi(
  chatId: string,
): Promise<{ chat: ChatRecord; runs: HydratedRun[] }> {
  return requestJson<{ chat: ChatRecord; runs: HydratedRun[] }>(
    `/api/chats/${encodeURIComponent(chatId)}`,
  );
}

export async function deleteChatApi(chatId: string): Promise<void> {
  await requestJson(`/api/chats/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
  });
}

export async function startTurnApi(
  chatId: string,
  payload: {
    prompt: string;
    mode: OrchestrationMode;
    independentFirstOpinions: boolean;
    lead: ParticipantSpec;
    teammates: ParticipantSpec[];
    workspacePath?: string;
    selectedPaths?: string[];
    allowReadOnlyTools: boolean;
    limits: {
      maxLeadCalls: number;
      maxTotalCalls: number;
      perCallTimeoutMs: number;
      hardDeadlineMs: number;
      reserveSynthesisCall: boolean;
    };
  },
): Promise<HydratedRun> {
  const res = await requestJson<{ run: HydratedRun }>(
    `/api/chats/${encodeURIComponent(chatId)}/turns`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
  return res.run;
}

export async function getRunApi(runId: string): Promise<HydratedRun> {
  const res = await requestJson<{ run: HydratedRun }>(
    `/api/runs/${encodeURIComponent(runId)}`,
  );
  return res.run;
}

export async function stopRunApi(runId: string): Promise<boolean> {
  const res = await requestJson<{ stopped: boolean }>(
    `/api/runs/${encodeURIComponent(runId)}/stop`,
    { method: "POST", body: "{}" },
  );
  return res.stopped;
}

export async function retryAssignmentApi(
  runId: string,
  assignmentId: string,
  synthesize = true,
): Promise<HydratedRun> {
  const res = await requestJson<{ run: HydratedRun }>(
    `/api/runs/${encodeURIComponent(runId)}/assignments/${encodeURIComponent(assignmentId)}/retry`,
    { method: "POST", body: JSON.stringify({ synthesize }) },
  );
  return res.run;
}

export async function synthesizeRunApi(runId: string): Promise<HydratedRun> {
  const res = await requestJson<{ run: HydratedRun }>(
    `/api/runs/${encodeURIComponent(runId)}/synthesize`,
    { method: "POST", body: "{}" },
  );
  return res.run;
}

export function subscribeRunEvents(
  runId: string,
  afterSeq: number,
  onEvent: (stored: StoredRunEvent) => void,
  onError?: () => void,
): () => void {
  let closed = false;
  let lastSeq = afterSeq;
  let es: EventSource | null = null;
  let reconnectTimer: number | null = null;

  const connect = () => {
    if (closed) return;
    const url = `/api/runs/${encodeURIComponent(runId)}/events?afterSeq=${lastSeq}`;
    es = new EventSource(url);
    const eventTypes = [
      "run_started",
      "roundtable_opening_planned",
      "roundtable_turn_started",
      "roundtable_turn_completed",
      "lead_thinking",
      "lead_action",
      "assignment_started",
      "assignment_completed",
      "followup_started",
      "followup_completed",
      "contribution_retrieved",
      "session_fallback",
      "diagnostic",
      "run_finished",
    ];
    for (const type of eventTypes) {
      es.addEventListener(type, (msg) => {
        try {
          const parsed = JSON.parse((msg as MessageEvent).data) as StoredRunEvent;
          if (parsed.seq <= lastSeq) return;
          lastSeq = parsed.seq;
          onEvent(parsed);
          if (type === "run_finished") {
            closed = true;
            es?.close();
          }
        } catch {
          // Ignore malformed event
        }
      });
    }
    es.onerror = () => {
      es?.close();
      if (closed) return;
      onError?.();
      reconnectTimer = window.setTimeout(connect, 1500);
    };
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
    }
    es?.close();
  };
}
