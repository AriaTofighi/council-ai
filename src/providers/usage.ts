import { execFile, spawn } from "node:child_process";
import os from "node:os";
import type { ProviderId } from "../types/provider.js";
import { discoverProviderExecutable } from "./discovery.js";

/** One rolling quota window, normalized across providers. */
export interface UsageWindow {
  /** As the provider names it, e.g. "Current session", "Weekly Limit Remaining". */
  label: string;
  kind: "5h" | "weekly" | "other";
  usedPercent: number;
  /** ISO time the window resets, when the provider gives a parseable one. */
  resetsAt?: string;
  /** The provider's own reset wording, when it doesn't give a timestamp. */
  resetsText?: string;
}

export interface UsageGroup {
  /** Set when a subscription splits quota by model family (agy). */
  name?: string;
  description?: string;
  windows: UsageWindow[];
}

export interface ProviderUsage {
  provider: ProviderId;
  ok: boolean;
  plan?: string;
  groups: UsageGroup[];
  notes: string[];
  error?: string;
  fetchedAt: string;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<ProviderId, ProviderUsage>();
const inflight = new Map<ProviderId, Promise<ProviderUsage>>();

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

function runJson(cmd: string, args: string[], timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Run from a temp dir so the CLI doesn't record a session under the user's project.
    execFile(cmd, args, { timeout: timeoutMs, cwd: os.tmpdir(), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().trim().split("\n").at(-1) || err.message));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Unexpected output from the CLI"));
      }
    });
  });
}

// ── agy: `agy -p /usage --output-format json` returns structured groups ─────────

export function parseAgyUsage(json: unknown): Omit<ProviderUsage, "provider" | "fetchedAt"> {
  const data = (json as { command?: { data?: { groups?: unknown[] } } })?.command?.data;
  const groups: UsageGroup[] = [];
  for (const g of data?.groups ?? []) {
    const group = g as { name?: string; description?: string; buckets?: unknown[] };
    const windows: UsageWindow[] = [];
    for (const b of group.buckets ?? []) {
      const bucket = b as { name?: string; window?: string; remaining_fraction?: number; reset_time?: string };
      if (typeof bucket.remaining_fraction !== "number") continue;
      windows.push({
        label: bucket.name ?? bucket.window ?? "Limit",
        kind: bucket.window === "5h" ? "5h" : bucket.window === "weekly" ? "weekly" : "other",
        usedPercent: clampPct((1 - bucket.remaining_fraction) * 100),
        resetsAt: bucket.reset_time,
      });
    }
    if (windows.length) groups.push({ name: group.name, description: group.description, windows });
  }
  if (groups.length === 0) {
    const response = (json as { response?: string })?.response?.trim();
    return { ok: false, groups, notes: [], error: response || "agy reported no quota (an API key login has no plan quota)" };
  }
  return { ok: true, groups, notes: [] };
}

// ── Claude Code: `claude -p /usage` returns text lines ─────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Offset (ms) of an IANA zone from UTC at a given instant, or undefined for an unknown zone. */
function zoneOffsetMs(timeZone: string, at: Date): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return asUtc - Math.floor(at.getTime() / 1000) * 1000;
  } catch {
    return undefined;
  }
}

/** Wall-clock components in `timeZone` (or the server's zone) → ISO instant. */
function wallClockToIso(y: number, mo: number, d: number, h: number, mi: number, timeZone?: string): string {
  if (timeZone) {
    const guess = new Date(Date.UTC(y, mo, d, h, mi));
    const offset = zoneOffsetMs(timeZone, guess);
    if (offset !== undefined) {
      // Re-check the offset at the corrected instant so DST boundaries land right.
      const first = new Date(guess.getTime() - offset);
      const offset2 = zoneOffsetMs(timeZone, first) ?? offset;
      return new Date(guess.getTime() - offset2).toISOString();
    }
  }
  return new Date(y, mo, d, h, mi).toISOString();
}

/**
 * Parses Claude Code's reset wording, e.g. "Nov 23 at 4:50pm (America/Chicago)" or
 * "4:50pm (America/Chicago)", honouring the zone it names.
 */
export function parseClaudeReset(text: string, now = new Date()): string | undefined {
  const m = /(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,?\s*(\d{4}))?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return undefined;
  const timeZone = /\(([A-Za-z_]+\/[A-Za-z_/+-]+|UTC)\)/.exec(text)?.[1];
  let hour = Number(m[4]) % 12;
  if (m[6]!.toLowerCase() === "pm") hour += 12;
  const minute = m[5] ? Number(m[5]) : 0;

  // "Today" in the named zone, so a bare time or a yearless date resolves correctly.
  const zoneNow = timeZone ? new Date(now.getTime() + (zoneOffsetMs(timeZone, now) ?? 0)) : now;
  const utcParts = timeZone
    ? { y: zoneNow.getUTCFullYear(), mo: zoneNow.getUTCMonth(), d: zoneNow.getUTCDate() }
    : { y: now.getFullYear(), mo: now.getMonth(), d: now.getDate() };

  let y = utcParts.y;
  let mo = utcParts.mo;
  let d = utcParts.d;
  if (m[1]) {
    mo = MONTHS.indexOf(m[1].toLowerCase());
    if (mo < 0) return undefined;
    d = Number(m[2]);
    if (m[3]) y = Number(m[3]);
  }
  let iso = wallClockToIso(y, mo, d, hour, minute, timeZone);
  // Already past: a bare time means tomorrow; a yearless date means next year.
  if (new Date(iso).getTime() < now.getTime() - 60_000) {
    if (!m[1]) iso = wallClockToIso(y, mo, d + 1, hour, minute, timeZone);
    else if (!m[3]) iso = wallClockToIso(y + 1, mo, d, hour, minute, timeZone);
  }
  return iso;
}

export function parseClaudeUsage(text: string, now = new Date()): Omit<ProviderUsage, "provider" | "fetchedAt"> {
  const windows: UsageWindow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^Current (session|week)(?:\s*\(([^)]+)\))?:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·•-]\s*resets\s+(.+))?$/i.exec(line);
    if (!m) continue;
    const isSession = m[1]!.toLowerCase() === "session";
    const resetsText = m[4]?.trim();
    windows.push({
      label: isSession ? "Current session" : `Current week${m[2] ? ` (${m[2]})` : ""}`,
      kind: isSession ? "5h" : "weekly",
      usedPercent: clampPct(Number(m[3])),
      resetsAt: resetsText ? parseClaudeReset(resetsText, now) : undefined,
      resetsText: resetsText?.replace(/\s*\([^)]*\)\s*$/, ""),
    });
  }
  if (windows.length === 0) {
    return { ok: false, groups: [], notes: [], error: text.split("\n")[0]?.trim() || "Claude Code reported no usage" };
  }
  const notes = /using your subscription/i.test(text) ? [] : [text.split("\n")[0]!.trim()];
  return { ok: true, groups: [{ windows }], notes };
}

// ── codex: app-server `account/rateLimits/read` ─────────────────────────────────

interface CodexWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

function codexWindow(w: CodexWindow | null | undefined, fallback: string): UsageWindow | undefined {
  if (!w || typeof w.usedPercent !== "number") return undefined;
  const mins = w.windowDurationMins ?? 0;
  const kind = mins === 300 ? "5h" : mins === 10080 ? "weekly" : "other";
  return {
    label: kind === "5h" ? "5-hour limit" : kind === "weekly" ? "Weekly limit" : mins ? `${Math.round(mins / 60)}-hour limit` : fallback,
    kind,
    usedPercent: clampPct(w.usedPercent),
    resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : undefined,
  };
}

export function parseCodexUsage(result: unknown): Omit<ProviderUsage, "provider" | "fetchedAt"> {
  const r = result as {
    rateLimits?: Record<string, unknown>;
    rateLimitsByLimitId?: Record<string, Record<string, unknown>>;
    rateLimitResetCredits?: { availableCount?: number };
  };
  const snapshots = Object.values(r?.rateLimitsByLimitId ?? {});
  if (snapshots.length === 0 && r?.rateLimits) snapshots.push(r.rateLimits);
  const groups: UsageGroup[] = [];
  let plan: string | undefined;
  for (const s of snapshots) {
    plan ??= typeof s.planType === "string" ? s.planType : undefined;
    const windows = [
      codexWindow(s.primary as CodexWindow, "Primary limit"),
      codexWindow(s.secondary as CodexWindow, "Secondary limit"),
    ].filter((w): w is UsageWindow => Boolean(w));
    if (windows.length) {
      groups.push({
        name: snapshots.length > 1 ? String(s.limitName ?? s.limitId ?? "") || undefined : undefined,
        windows,
      });
    }
  }
  const notes: string[] = [];
  const resets = r?.rateLimitResetCredits?.availableCount ?? 0;
  if (resets > 0) notes.push(`${resets} free limit reset${resets === 1 ? "" : "s"} available`);
  if (groups.length === 0) return { ok: false, plan, groups, notes, error: "Codex reported no rate limits for this account" };
  return { ok: true, plan, groups, notes };
}

function codexRateLimits(executable: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server"], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    const done = (err: Error | null, value?: unknown) => {
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new Error("Timed out asking Codex for its rate limits")), timeoutMs);
    const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    child.on("error", (err) => done(err));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("exit", (code) => {
      if (code && code !== 0) done(new Error(stderr.trim().split("\n").at(-1) || `codex exited with ${code}`));
    });
    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: null });
        } else if (msg.id === 2) {
          if (msg.error) done(new Error(msg.error.message ?? "Codex rate limit request failed"));
          else done(null, msg.result);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "council", title: "Council", version: "0.1.0" } } });
  });
}

// ── public API ──────────────────────────────────────────────────────────────────

async function fetchUsage(provider: ProviderId, override?: string): Promise<ProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const discovery = await discoverProviderExecutable(provider, override);
  if (!discovery.executablePath) {
    return { provider, ok: false, groups: [], notes: [], error: "CLI not installed", fetchedAt };
  }
  const exe = discovery.executablePath;
  try {
    if (provider === "agy") {
      return { provider, fetchedAt, ...parseAgyUsage(await runJson(exe, ["-p", "/usage", "--output-format", "json"], 45_000)) };
    }
    if (provider === "claude") {
      const json = (await runJson(exe, ["-p", "/usage", "--output-format", "json"], 45_000)) as { result?: string };
      return { provider, fetchedAt, ...parseClaudeUsage(json.result ?? "") };
    }
    return { provider, fetchedAt, ...parseCodexUsage(await codexRateLimits(exe, 30_000)) };
  } catch (err) {
    return { provider, ok: false, groups: [], notes: [], error: err instanceof Error ? err.message : String(err), fetchedAt };
  }
}

/** Reads each subscription's current 5-hour / weekly usage. Cached for a minute unless forced. */
export async function getProviderUsage(
  providers: ProviderId[],
  options: { force?: boolean; executableOverrides?: Partial<Record<ProviderId, string>> } = {},
): Promise<ProviderUsage[]> {
  return Promise.all(
    providers.map((provider) => {
      const cached = cache.get(provider);
      if (!options.force && cached && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_TTL_MS) {
        return cached;
      }
      const pending = inflight.get(provider);
      if (pending) return pending;
      const job = fetchUsage(provider, options.executableOverrides?.[provider])
        .then((usage) => {
          // Keep the last good reading if a refresh fails, but surface the error.
          const prev = cache.get(provider);
          const result = !usage.ok && prev?.ok ? { ...prev, error: usage.error } : usage;
          cache.set(provider, result);
          return result;
        })
        .finally(() => inflight.delete(provider));
      inflight.set(provider, job);
      return job;
    }),
  );
}
