import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCouncilServer } from "../src/server/server.js";
import type { AdapterRegistry } from "../src/providers/registry.js";
import type {
  ProviderAdapter,
  ProviderCheckResult,
  ProviderId,
  ProviderSessionHandle,
  StartSessionOptions,
  TurnInput,
  TurnResult,
} from "../src/types/provider.js";

class ServerMockAdapter implements ProviderAdapter {
  constructor(
    readonly id: ProviderId,
    private readonly fn: (
      handle: ProviderSessionHandle,
      input: TurnInput,
      turn: number,
    ) => Promise<TurnResult>,
  ) {}

  async checkAvailability(): Promise<ProviderCheckResult> {
    return {
      provider: this.id,
      discovery: {
        provider: this.id,
        executablePath: `/mock/${this.id}`,
        source: "override",
        version: "1.0",
        candidatesChecked: [],
      },
      outcome: "ok",
      elapsedMs: 1,
    };
  }

  async startSession(options: StartSessionOptions): Promise<ProviderSessionHandle> {
    return {
      participantId: options.participantId,
      provider: this.id,
      executablePath: `/mock/${this.id}`,
      continuationMode: "native",
      systemPrompt: options.systemPrompt,
      cwd: options.cwd,
      readOnly: true,
      allowReadOnlyTools: true,
      model: options.model,
      effort: options.effort,
      turnCount: 0,
      history: [],
    };
  }

  async sendTurn(handle: ProviderSessionHandle, input: TurnInput): Promise<TurnResult> {
    handle.turnCount += 1;
    return this.fn(handle, input, handle.turnCount);
  }

  cancel(): boolean {
    return false;
  }
}

test("HTTP + SSE server executes turns, replays SSE afterSeq, supports stop, and serves static UI", async () => {
  const tmpStatic = fs.mkdtempSync(path.join(os.tmpdir(), "council-web-dist-"));
  fs.writeFileSync(path.join(tmpStatic, "index.html"), "<html><body>Council UI</body></html>", "utf8");

  const claude = new ServerMockAdapter("claude", async (_h, _i, turn) => {
    if (turn === 1) {
      return {
        outcome: "ok",
        text: "delegate",
        structured: {
          action: "delegate",
          assignments: [
            { participant_id: "mate_codex_1", title: "Audit", task: "Inspect repo", context_notes: null },
          ],
          follow_up: null,
          retrieve_contribution_id: null,
          final_answer: null,
          used_contribution_ids: null,
          unresolved_issues: null,
          participant_summaries: null,
          disagreements: null,
        },
        providerSessionId: "s-claude-1",
        continuationMode: "native",
        elapsedMs: 1,
      };
    }
    return {
      outcome: "ok",
      text: "finish",
      structured: {
        action: "finish",
        assignments: null,
        follow_up: null,
        retrieve_contribution_id: null,
        final_answer: "Server verified answer referencing c_1.",
        used_contribution_ids: ["c_1"],
        unresolved_issues: [],
        participant_summaries: [{ participant_id: "mate_codex_1", added: "Audited repo" }],
        disagreements: [],
      },
      providerSessionId: "s-claude-1",
      continuationMode: "native",
      elapsedMs: 1,
    };
  });

  const codex = new ServerMockAdapter("codex", async () => ({
    outcome: "ok",
    text: "Codex server check complete",
    providerSessionId: "s-codex-1",
    continuationMode: "native",
    elapsedMs: 1,
  }));

  const agy = new ServerMockAdapter("agy", async (_h, input) => {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 2000);
      input.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      });
    }).catch(() => {});
    return {
      outcome: input.signal?.aborted ? "cancelled" : "ok",
      text: "",
      continuationMode: "native",
      elapsedMs: 5,
    };
  });

  const adapters: AdapterRegistry = { codex, claude, agy };
  const srv = createCouncilServer({
    dbPath: ":memory:",
    port: 0,
    staticDir: tmpStatic,
    adapters,
  });

  const bound = await srv.start();
  try {
    const health = await fetch(`${bound.url}/api/health`).then((r) => r.json() as Promise<{ ok: boolean }>);
    assert.equal(health.ok, true);

    const staticHtml = await fetch(`${bound.url}/`).then((r) => r.text());
    assert.match(staticHtml, /Council UI/);

    const chatRes = await fetch(`${bound.url}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "API Test" }),
    }).then((r) => r.json() as Promise<{ chat: { id: string } }>);

    const turnRes = await fetch(`${bound.url}/api/chats/${chatRes.chat.id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Run divide conquer",
        mode: "divide_conquer",
        independentFirstOpinions: false,
        lead: { provider: "claude", label: "claude lead" },
        teammates: [{ provider: "codex", label: "codex mate" }],
        allowReadOnlyTools: false,
      }),
    }).then((r) => r.json() as Promise<{ run: { id: string } }>);

    await srv.runManager.waitForRun(turnRes.run.id);

    const runGet = await fetch(`${bound.url}/api/runs/${turnRes.run.id}`).then(
      (r) => r.json() as Promise<{ run: { status: string; finalAnswer: string } }>,
    );
    assert.equal(runGet.run.status, "completed");
    assert.match(runGet.run.finalAnswer, /c_1/);

    // Verify SSE replay & afterSeq deduplication
    const abortSse = new AbortController();
    const sseResp = await fetch(
      `${bound.url}/api/runs/${turnRes.run.id}/events?afterSeq=1`,
      { signal: abortSse.signal },
    );
    const reader = sseResp.body!.getReader();
    let sseText = "";
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !sseText.includes("run_finished")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      sseText += new TextDecoder().decode(chunk.value);
    }
    abortSse.abort();
    assert.equal(sseText.includes("id: 1\n"), false);
    assert.match(sseText, /event: run_finished/);

    // Verify stopping an active slow run
    const slowTurn = await fetch(`${bound.url}/api/chats/${chatRes.chat.id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Slow stop test",
        mode: "divide_conquer",
        independentFirstOpinions: false,
        lead: { provider: "agy", label: "agy lead" },
        teammates: [],
        allowReadOnlyTools: false,
      }),
    }).then((r) => r.json() as Promise<{ run: { id: string } }>);

    const stopRes = await fetch(`${bound.url}/api/runs/${slowTurn.run.id}/stop`, {
      method: "POST",
      body: "{}",
    }).then((r) => r.json() as Promise<{ stopped: boolean }>);
    assert.equal(stopRes.stopped, true);
    await srv.runManager.waitForRun(slowTurn.run.id);
    const stoppedRun = await fetch(`${bound.url}/api/runs/${slowTurn.run.id}`).then(
      (r) => r.json() as Promise<{ run: { status: string } }>,
    );
    assert.equal(stoppedRun.run.status, "cancelled");
  } finally {
    await srv.close();
    fs.rmSync(tmpStatic, { recursive: true, force: true });
  }
});

test("folder picker endpoint returns the chosen folder and rejects foreign origins", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "council-pick-"));
  const calls: Array<{ startDir?: string }> = [];
  const instance = createCouncilServer({
    dbPath: path.join(tmp, "db.sqlite"),
    port: 0,
    staticDir: tmp,
    pickFolder: async (opts) => {
      calls.push(opts ?? {});
      return { status: "picked", path: "/picked/repo" };
    },
  });
  const { url } = await instance.start();
  try {
    const ok = await fetch(`${url}/api/workspace/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:5175" },
      body: JSON.stringify({ startDir: tmp }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { status: "picked", path: "/picked/repo" });
    assert.equal(calls[0]?.startDir, tmp);

    const missingStart = await fetch(`${url}/api/workspace/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startDir: path.join(tmp, "nope") }),
    });
    assert.equal(missingStart.status, 200);
    assert.equal(calls[1]?.startDir, undefined);

    const foreign = await fetch(`${url}/api/workspace/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(foreign.status, 403);
    assert.equal(calls.length, 2);
  } finally {
    await instance.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("projects API saves folders by real path, dedupes, and removes without touching chats", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-proj-")));
  const repo = path.join(tmp, "my-repo");
  fs.mkdirSync(repo);
  const instance = createCouncilServer({ dbPath: path.join(tmp, "db.sqlite"), port: 0, staticDir: tmp });
  const { url } = await instance.start();
  const post = (body: unknown) =>
    fetch(`${url}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const created = await post({ path: `${repo}/` });
    assert.equal(created.status, 201);
    const { project } = (await created.json()) as { project: { id: string; name: string; path: string } };
    assert.equal(project.name, "my-repo");
    assert.equal(project.path, repo);

    const again = (await (await post({ path: repo })).json()) as { project: { id: string } };
    assert.equal(again.project.id, project.id);

    assert.equal((await post({ path: path.join(tmp, "missing") })).status, 400);

    await fetch(`${url}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "In project", workspacePath: repo }),
    });
    const listed = (await (await fetch(`${url}/api/projects`)).json()) as { projects: unknown[] };
    assert.equal(listed.projects.length, 1);

    const del = await fetch(`${url}/api/projects/${project.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const after = (await (await fetch(`${url}/api/projects`)).json()) as { projects: unknown[] };
    assert.equal(after.projects.length, 0);
    const chats = (await (await fetch(`${url}/api/chats`)).json()) as { chats: Array<{ title: string }> };
    assert.ok(chats.chats.some((c) => c.title === "In project"));
  } finally {
    await instance.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
