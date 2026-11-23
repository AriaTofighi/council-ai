import { execFile } from "node:child_process";
import type { ProviderId } from "../types/provider.js";
import { discoverProviderExecutable } from "./discovery.js";
import { invalidateModelCaches } from "./models.js";

export type CliUpdateState = "pending" | "updating" | "updated" | "current" | "failed" | "skipped";

export interface CliUpdateStatus {
  provider: ProviderId;
  state: CliUpdateState;
  versionBefore?: string;
  versionAfter?: string;
  message?: string;
  finishedAt?: string;
}

const PROVIDERS: ProviderId[] = ["claude", "codex", "agy"];
const UPDATE_TIMEOUT_MS = 5 * 60_000;

const statuses = new Map<ProviderId, CliUpdateStatus>();
let inFlight: Promise<CliUpdateStatus[]> | undefined;

export function getCliUpdateStatuses(): CliUpdateStatus[] {
  return PROVIDERS.map((provider) => statuses.get(provider) ?? { provider, state: "pending" as const });
}

export function cliUpdatesRunning(): boolean {
  return getCliUpdateStatuses().some((s) => s.state === "updating");
}

function runUpdate(executable: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // Each of claude, codex and agy ships an `update` subcommand that upgrades in place
    // (or through the package manager that installed it).
    execFile(
      executable,
      ["update"],
      { timeout: UPDATE_TIMEOUT_MS, env: { ...process.env, CI: "1" }, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        resolve({ ok: !err, output: output || (err?.message ?? "") });
      },
    );
  });
}

function lastLine(text: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.at(-1)?.slice(0, 300);
}

async function updateOne(
  provider: ProviderId,
  override: string | undefined,
  log: (line: string) => void,
): Promise<CliUpdateStatus> {
  const before = await discoverProviderExecutable(provider, override);
  if (!before.executablePath) {
    return { provider, state: "skipped", message: "Not installed", finishedAt: new Date().toISOString() };
  }
  // A CLI bundled inside a desktop app (e.g. codex in ChatGPT.app) is updated by that app.
  const bundle = /\/([^/]+\.app)\/Contents\//.exec(before.executablePath);
  if (bundle) {
    log(`[cli-update] ${provider}: bundled with ${bundle[1]}, which keeps it up to date`);
    return {
      provider,
      state: "skipped",
      versionBefore: before.version,
      versionAfter: before.version,
      message: `Updated by ${bundle[1]}`,
      finishedAt: new Date().toISOString(),
    };
  }
  statuses.set(provider, { provider, state: "updating", versionBefore: before.version });
  log(`[cli-update] ${provider}: checking for updates (current ${before.version ?? "unknown"})`);

  const result = await runUpdate(before.executablePath);
  const after = await discoverProviderExecutable(provider, override);
  const versionAfter = after.version ?? before.version;
  const changed = Boolean(versionAfter && before.version && versionAfter !== before.version);
  const status: CliUpdateStatus = {
    provider,
    state: changed ? "updated" : result.ok ? "current" : "failed",
    versionBefore: before.version,
    versionAfter,
    message: changed || !result.ok ? lastLine(result.output) : undefined,
    finishedAt: new Date().toISOString(),
  };
  log(
    `[cli-update] ${provider}: ${status.state}` +
      (changed ? ` ${before.version} → ${versionAfter}` : "") +
      (status.state === "failed" && status.message ? ` (${status.message})` : ""),
  );
  return status;
}

/**
 * Updates every installed provider CLI in parallel, then drops cached model lists so the
 * UI picks up any models or thinking levels a new CLI version added. Safe to call repeatedly;
 * concurrent calls share one run.
 */
export function updateProviderClis(
  options: { executableOverrides?: Partial<Record<ProviderId, string>>; log?: (line: string) => void } = {},
): Promise<CliUpdateStatus[]> {
  if (inFlight) return inFlight;
  const log = options.log ?? ((line: string) => console.log(line));
  for (const provider of PROVIDERS) statuses.set(provider, { provider, state: "updating" });
  inFlight = Promise.all(
    PROVIDERS.map(async (provider) => {
      let status: CliUpdateStatus;
      try {
        status = await updateOne(provider, options.executableOverrides?.[provider], log);
      } catch (err) {
        status = {
          provider,
          state: "failed",
          message: err instanceof Error ? err.message : String(err),
          finishedAt: new Date().toISOString(),
        };
      }
      statuses.set(provider, status);
      return status;
    }),
  ).finally(() => {
    invalidateModelCaches();
    inFlight = undefined;
  });
  return inFlight;
}
