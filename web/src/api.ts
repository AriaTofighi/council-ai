import type {
  ChatRecord,
  CliUpdateStatus,
  HydratedRun,
  OrchestrationMode,
  ParticipantSpec,
  ProviderCatalogEntry,
  ProviderCheckResult,
  ProviderId,
  ProjectRecord,
  ProviderUsage,
  StoredRunEvent,
  WorkspaceInspection,
} from "./types";

/** Thrown when the local Council service can't be reached (not running, or proxy failed). */
export class ServiceUnavailableError extends Error {
  constructor() {
    super("The Council service isn’t running");
    this.name = "ServiceUnavailableError";
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ServiceUnavailableError();
  }
  const body = await res.text();
  let data: (T & { error?: string }) | null = null;
  try {
    data = body ? (JSON.parse(body) as T & { error?: string }) : null;
  } catch {
    data = null;
  }
  if (!res.ok || data === null) {
    // The Vite dev proxy answers 5xx with an empty/non-JSON body when the backend is down.
    if (data === null && (res.status >= 500 || res.status === 0)) throw new ServiceUnavailableError();
    throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
  }
  return data;
}

export async function fetchProviders(): Promise<{
  providers: ProviderCatalogEntry[];
  cliUpdates: CliUpdateStatus[];
}> {
  const res = await requestJson<{ providers: ProviderCatalogEntry[]; cliUpdates?: CliUpdateStatus[] }>(
    "/api/providers",
  );
  return { providers: res.providers, cliUpdates: res.cliUpdates ?? [] };
}

/** Each subscription's 5-hour / weekly usage, as its CLI reports it. */
export async function fetchUsageApi(refresh = false): Promise<ProviderUsage[]> {
  const res = await requestJson<{ usage: ProviderUsage[] }>(`/api/usage${refresh ? "?refresh=1" : ""}`);
  return res.usage;
}

export async function updateClisApi(): Promise<CliUpdateStatus[]> {
  const res = await requestJson<{ cliUpdates: CliUpdateStatus[] }>("/api/providers/update", { method: "POST" });
  return res.cliUpdates;
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

export type FolderPickResult =
  | { status: "picked"; path: string }
  | { status: "cancelled" }
  | { status: "unsupported"; reason: string };

/** Asks the local Council service to open the OS folder chooser. */
export async function pickFolderApi(startDir?: string): Promise<FolderPickResult> {
  let res: Response;
  try {
    res = await fetch("/api/workspace/pick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startDir }),
    });
  } catch {
    throw new ServiceUnavailableError();
  }
  const data = (await res.json().catch(() => null)) as (FolderPickResult & { error?: string }) | null;
  if (!data) throw new ServiceUnavailableError();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function listProjectsApi(): Promise<ProjectRecord[]> {
  const res = await requestJson<{ projects: ProjectRecord[] }>("/api/projects");
  return res.projects;
}

export async function createProjectApi(projectPath: string): Promise<ProjectRecord> {
  const res = await requestJson<{ project: ProjectRecord }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ path: projectPath }),
  });
  return res.project;
}

export async function deleteProjectApi(projectId: string): Promise<void> {
  await requestJson(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
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
    /** null on a numeric field = no limit. */
    limits: {
      maxLeadCalls: number | null;
      maxTotalCalls: number | null;
      perCallTimeoutMs: number | null;
      hardDeadlineMs: number | null;
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
  options: { sinceResume?: boolean } = {},
): () => void {
  let closed = false;
  let lastSeq = afterSeq;
  let es: EventSource | null = null;
  let reconnectTimer: number | null = null;

  const connect = () => {
    if (closed) return;
    const url = `/api/runs/${encodeURIComponent(runId)}/events?afterSeq=${lastSeq}${options.sinceResume ? "&sinceResume=1" : ""}`;
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
      "agent_activity",
      "run_resumed",
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
