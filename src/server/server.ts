import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { discoverProviderExecutable } from "../providers/discovery.js";
import {
  getEffectiveReadOnlyPolicy,
  listProviderModels,
} from "../providers/models.js";
import { checkProviders, type AdapterRegistry } from "../providers/registry.js";
import { CouncilDatabase, type StoredRunEvent } from "../storage/db.js";
import type { ProviderId } from "../types/provider.js";
import { inspectWorkspace } from "../workspace/snapshot.js";
import { pickFolder } from "./folder-picker.js";
import {
  CouncilRunManager,
  type StartTurnRequest,
} from "./run-manager.js";

const MAX_JSON_BODY_BYTES = 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch {
        reject(new Error("Invalid JSON request body"));
      }
    });

    req.on("error", reject);
  });
}

function serveStaticFile(
  res: ServerResponse,
  staticDir: string,
  reqPath: string,
): boolean {
  if (!fs.existsSync(staticDir)) return false;
  const normalized = path.posix.normalize(reqPath).replace(/^(\.\.[/\\])+/, "");
  const candidate = path.join(
    staticDir,
    normalized === "/" ? "index.html" : normalized.slice(1),
  );
  const realStatic = fs.realpathSync(staticDir);

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    const realCandidate = fs.realpathSync(candidate);
    if (
      realCandidate === realStatic ||
      realCandidate.startsWith(realStatic + path.sep)
    ) {
      const ext = path.extname(realCandidate).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const data = fs.readFileSync(realCandidate);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": data.length,
      });
      res.end(data);
      return true;
    }
  }

  const indexHtml = path.join(realStatic, "index.html");
  if (!reqPath.startsWith("/api/") && fs.existsSync(indexHtml)) {
    const data = fs.readFileSync(indexHtml);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": data.length,
    });
    res.end(data);
    return true;
  }

  return false;
}

export interface CreateCouncilServerOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  staticDir?: string;
  snapshotRootDir?: string;
  adapters?: AdapterRegistry;
  executableOverrides?: Partial<Record<ProviderId, string>>;
  /** Override the native folder picker (tests). */
  pickFolder?: typeof pickFolder;
}

export interface CouncilServerInstance {
  server: http.Server;
  db: CouncilDatabase;
  runManager: CouncilRunManager;
  start: () => Promise<{ host: string; port: number; url: string }>;
  close: () => Promise<void>;
}

export function createCouncilServer(
  options: CreateCouncilServerOptions = {},
): CouncilServerInstance {
  const db = new CouncilDatabase(
    options.dbPath ?? path.resolve(".council", "council.sqlite"),
  );
  const runManager = new CouncilRunManager(db, {
    adapters: options.adapters,
    snapshotRootDir: options.snapshotRootDir,
    executableOverrides: options.executableOverrides,
  });
  const staticDir = options.staticDir ?? path.resolve("web", "dist");
  const host = options.host ?? "127.0.0.1";
  const desiredPort = options.port ?? 4173;

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const method = req.method ?? "GET";
    const parsedUrl = new URL(req.url ?? "/", `http://${host}`);
    const pathname = parsedUrl.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Last-Event-ID");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true, timestamp: new Date().toISOString() });
      return;
    }

    if (method === "GET" && pathname === "/api/providers") {
      const providers: ProviderId[] = ["codex", "claude", "agy"];
      const entries = await Promise.all(
        providers.map(async (id) => {
          const override = options.executableOverrides?.[id];
          const [discovery, models] = await Promise.all([
            discoverProviderExecutable(id, override),
            listProviderModels(id, override),
          ]);
          return {
            id,
            discovery,
            models,
            efforts: ["low", "medium", "high", "xhigh", "max"],
            readOnlyPolicies: {
              withTools: getEffectiveReadOnlyPolicy(id, true),
              withoutTools: getEffectiveReadOnlyPolicy(id, false),
            },
          };
        }),
      );
      sendJson(res, 200, { providers: entries });
      return;
    }

    if (method === "POST" && pathname === "/api/providers/check") {
      const body = await readJsonBody<{
        providers?: ProviderId[];
        skipLive?: boolean;
        timeoutMs?: number;
      }>(req);
      const results = await checkProviders({
        providers: body.providers,
        skipLive: body.skipLive,
        timeoutMs: body.timeoutMs,
        executableOverrides: options.executableOverrides,
        adapters: runManager.adapters,
      });
      sendJson(res, 200, { results });
      return;
    }

    if (method === "POST" && pathname === "/api/workspace/inspect") {
      const body = await readJsonBody<{ path?: string }>(req);
      if (!body.path || !body.path.trim()) {
        sendJson(res, 400, { error: "Workspace path is required" });
        return;
      }
      try {
        const inspection = await inspectWorkspace(body.path);
        sendJson(res, 200, { inspection });
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (method === "POST" && pathname === "/api/workspace/pick") {
      // Opens a dialog on this machine, so only the local UI may trigger it.
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
        sendJson(res, 403, { error: "Folder picker is only available to the local UI" });
        return;
      }
      const body = await readJsonBody<{ startDir?: string }>(req);
      let startDir = body.startDir?.trim() || undefined;
      if (startDir && !fs.existsSync(startDir)) startDir = undefined;
      const result = await (options.pickFolder ?? pickFolder)({ startDir });
      sendJson(res, result.status === "unsupported" ? 501 : 200, result);
      return;
    }

    if (method === "GET" && pathname === "/api/projects") {
      sendJson(res, 200, { projects: db.listProjects() });
      return;
    }

    if (method === "POST" && pathname === "/api/projects") {
      const body = await readJsonBody<{ path?: string; name?: string }>(req);
      const raw = body.path?.trim();
      if (!raw) {
        sendJson(res, 400, { error: "Project path is required" });
        return;
      }
      let realPath: string;
      try {
        // Same normalization as workspace snapshots, so chats group under the project by path.
        realPath = fs.realpathSync(path.resolve(raw));
        if (!fs.statSync(realPath).isDirectory()) throw new Error("not a directory");
      } catch {
        sendJson(res, 400, { error: `Not a folder: ${raw}` });
        return;
      }
      const project = db.createProject({
        id: `proj_${crypto.randomUUID().slice(0, 8)}`,
        name: body.name?.trim() || path.basename(realPath) || realPath,
        path: realPath,
      });
      sendJson(res, 201, { project });
      return;
    }

    const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
    if (projectMatch && method === "DELETE") {
      const deleted = db.deleteProject(decodeURIComponent(projectMatch[1]!));
      sendJson(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Project not found" });
      return;
    }

    if (method === "GET" && pathname === "/api/chats") {
      const chats = db.listChats();
      sendJson(res, 200, { chats });
      return;
    }

    if (method === "POST" && pathname === "/api/chats") {
      const body = await readJsonBody<{
        title?: string;
        workspacePath?: string;
      }>(req);
      const chat = db.createChat({
        id: `chat_${crypto.randomUUID().slice(0, 8)}`,
        title: body.title?.trim() || "New Chat",
        workspacePath: body.workspacePath?.trim() || undefined,
      });
      sendJson(res, 201, { chat });
      return;
    }

    const chatMatch = /^\/api\/chats\/([^/]+)$/.exec(pathname);
    if (chatMatch) {
      const chatId = decodeURIComponent(chatMatch[1]!);
      if (method === "GET") {
        const data = db.getChatWithRuns(chatId);
        if (!data) {
          sendJson(res, 404, { error: "Chat not found" });
          return;
        }
        sendJson(res, 200, data);
        return;
      }
      if (method === "DELETE") {
        const deleted = db.deleteChat(chatId);
        if (!deleted) {
          sendJson(res, 404, { error: "Chat not found" });
          return;
        }
        sendJson(res, 200, { deleted: true });
        return;
      }
    }

    const turnMatch = /^\/api\/chats\/([^/]+)\/turns$/.exec(pathname);
    if (turnMatch && method === "POST") {
      const chatId = decodeURIComponent(turnMatch[1]!);
      const body = await readJsonBody<StartTurnRequest>(req);
      try {
        const run = await runManager.startTurn(chatId, body);
        sendJson(res, 202, { run });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = msg.includes("not found")
          ? 404
          : msg.includes("already running")
            ? 409
            : 400;
        sendJson(res, status, { error: msg });
      }
      return;
    }

    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(pathname);
    if (runMatch && method === "GET") {
      const runId = decodeURIComponent(runMatch[1]!);
      const run = db.getHydratedRun(runId);
      if (!run) {
        sendJson(res, 404, { error: "Run not found" });
        return;
      }
      sendJson(res, 200, { run });
      return;
    }

    const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(pathname);
    if (eventsMatch && method === "GET") {
      const runId = decodeURIComponent(eventsMatch[1]!);
      const run = db.getRun(runId);
      if (!run) {
        sendJson(res, 404, { error: "Run not found" });
        return;
      }

      const headerLast = req.headers["last-event-id"];
      const queryAfter = parsedUrl.searchParams.get("afterSeq");
      const rawAfter =
        queryAfter ?? (typeof headerLast === "string" ? headerLast : "0");
      const afterSeq = Math.max(0, Number.parseInt(rawAfter, 10) || 0);

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      let closed = false;
      const writeFrame = (stored: StoredRunEvent) => {
        if (closed) return;
        res.write(
          `id: ${stored.seq}\nevent: ${stored.event.type}\ndata: ${JSON.stringify(stored)}\n\n`,
        );
      };

      const unsubscribe = runManager.subscribeToRun(runId, afterSeq, (stored) => {
        writeFrame(stored);
      });

      const keepAlive = setInterval(() => {
        if (!closed) {
          res.write(": keepalive\n\n");
        }
      }, 15_000);
      keepAlive.unref();

      req.on("close", () => {
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
      });
      return;
    }

    const stopMatch = /^\/api\/runs\/([^/]+)\/stop$/.exec(pathname);
    if (stopMatch && method === "POST") {
      const runId = decodeURIComponent(stopMatch[1]!);
      const run = db.getRun(runId);
      if (!run) {
        sendJson(res, 404, { error: "Run not found" });
        return;
      }
      const stopped = runManager.stopRun(runId);
      sendJson(res, 200, { stopped });
      return;
    }

    const retryMatch =
      /^\/api\/runs\/([^/]+)\/assignments\/([^/]+)\/retry$/.exec(pathname);
    if (retryMatch && method === "POST") {
      const runId = decodeURIComponent(retryMatch[1]!);
      const assignmentId = decodeURIComponent(retryMatch[2]!);
      const body = await readJsonBody<{ synthesize?: boolean }>(req);
      try {
        const run = await runManager.retryAssignment(runId, assignmentId, {
          synthesize: body.synthesize,
        });
        sendJson(res, 200, { run });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = msg.includes("not found")
          ? 404
          : msg.includes("active")
            ? 409
            : 400;
        sendJson(res, status, { error: msg });
      }
      return;
    }

    const synthMatch = /^\/api\/runs\/([^/]+)\/synthesize$/.exec(pathname);
    if (synthMatch && method === "POST") {
      const runId = decodeURIComponent(synthMatch[1]!);
      try {
        const run = await runManager.synthesizeRun(runId);
        sendJson(res, 200, { run });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = msg.includes("not found")
          ? 404
          : msg.includes("actively")
            ? 409
            : 400;
        sendJson(res, status, { error: msg });
      }
      return;
    }

    if (method === "GET" && serveStaticFile(res, staticDir, pathname)) {
      return;
    }

    sendJson(res, 404, { error: `Not found: ${method} ${pathname}` });
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: message });
      } else {
        res.end();
      }
    });
  });

  return {
    server,
    db,
    runManager,
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(desiredPort, host, () => {
          server.removeListener("error", reject);
          const addr = server.address();
          const boundPort =
            addr && typeof addr === "object" ? addr.port : desiredPort;
          resolve({
            host,
            port: boundPort,
            url: `http://${host}:${boundPort}`,
          });
        });
      }),
    close: async () => {
      await runManager.waitForAllRuns();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      db.close();
    },
  };
}
