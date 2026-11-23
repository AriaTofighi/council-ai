import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  EffectiveReadOnlyPolicy,
  ProviderId,
  ProviderModelOption,
  ReasoningEffort,
} from "../types/provider.js";
import { discoverProviderExecutable } from "./discovery.js";

const execFileAsync = promisify(execFile);

export const EFFORT_LEVELS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const ALL_EFFORTS = EFFORT_LEVELS;
const TIERED_SLUG_RE = /^(.+)-(low|medium|high|xhigh|max)$/i;
const LEVEL_LABEL_RE = /\s*\((low|medium|high|xhigh|max)\)\s*$/i;

/** Model lists are re-read from the CLIs this often, and immediately after a CLI update. */
const MODEL_CACHE_TTL_MS = 2 * 60 * 1000;

const modelCache = new Map<ProviderId, { fetchedAt: number; models: ProviderModelOption[] }>();

/** Drops cached model lists so the next request re-reads them from the CLIs (call after updating a CLI). */
export function invalidateModelCaches(): void {
  modelCache.clear();
}

const isEffort = (v: unknown): v is ReasoningEffort =>
  typeof v === "string" && (ALL_EFFORTS as string[]).includes(v);

const sortEfforts = (efforts: Iterable<ReasoningEffort>): ReasoningEffort[] =>
  [...new Set(efforts)].sort((a, b) => ALL_EFFORTS.indexOf(a) - ALL_EFFORTS.indexOf(b));

const FALLBACK_CODEX_MODELS: ProviderModelOption[] = [
  "gpt-6.2-sol",
  "gpt-6.2-astra",
  "gpt-6.1-terra",
  "gpt-6-luna",
].map((id) => ({
  id,
  label: id,
  provider: "codex",
  efforts: ALL_EFFORTS,
  supportsEffort: true,
  isFast: /luna|terra/.test(id),
}));

// Claude Code takes aliases that always point at the latest model of each family.
const CLAUDE_MODELS: ProviderModelOption[] = [
  { id: "opus", label: "Claude Opus (latest)", provider: "claude", efforts: ALL_EFFORTS, supportsEffort: true },
  { id: "fable", label: "Claude Fable (latest)", provider: "claude", efforts: ALL_EFFORTS, supportsEffort: true },
  { id: "sonnet", label: "Claude Sonnet (latest)", provider: "claude", efforts: ALL_EFFORTS, supportsEffort: true, isFast: true },
  { id: "haiku", label: "Claude Haiku (latest)", provider: "claude", efforts: ALL_EFFORTS, supportsEffort: true, isFast: true },
];

/**
 * `agy models` lists one row per model *and* thinking level (`gemini-4-neon-high`), plus
 * models with no levels at all (`gemini-pro-orchestrator-neon`). agy accepts
 * `--model <family> --effort <level>` for tiered families, rejects a conflicting
 * `--effort` on a tiered slug, and rejects `--effort` entirely on untiered models.
 * So we group tiered rows into one model per family with exactly the listed levels.
 */
export function parseAgyModelsOutput(stdout: string): ProviderModelOption[] {
  const families = new Map<string, { label: string; efforts: ReasoningEffort[] }>();
  const order: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Fetching")) continue;
    const match = /^([a-z0-9][a-z0-9._-]*)\s+(.+)$/i.exec(line);
    if (!match) continue;
    const slug = match[1]!;
    const label = match[2]!.trim();
    const tier = TIERED_SLUG_RE.exec(slug);
    const id = tier ? tier[1]! : slug;
    const level = tier ? (tier[2]!.toLowerCase() as ReasoningEffort) : undefined;
    let family = families.get(id);
    if (!family) {
      family = { label: tier ? label.replace(LEVEL_LABEL_RE, "") : label, efforts: [] };
      families.set(id, family);
      order.push(id);
    }
    if (level) family.efforts.push(level);
  }
  return order.map((id) => {
    const family = families.get(id)!;
    const efforts = sortEfforts(family.efforts);
    return {
      id,
      label: family.label,
      provider: "agy" as const,
      efforts,
      supportsEffort: efforts.length > 0,
      isFast: /flash|lite/i.test(id),
    };
  });
}

/** Parses the codex model catalog (`codex debug models` or ~/.codex/models_cache.json). */
export function parseCodexCatalog(json: unknown): ProviderModelOption[] {
  const items =
    json && typeof json === "object" && Array.isArray((json as { models?: unknown }).models)
      ? ((json as { models: Array<Record<string, unknown>> }).models)
      : [];
  const options: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.slug !== "string") continue;
    const id = item.slug.trim();
    if (!id || seen.has(id) || item.visibility === "hide") continue;
    seen.add(id);
    const levels = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels
          .map((l) => (l && typeof l === "object" ? (l as { effort?: unknown }).effort : l))
          .filter(isEffort)
      : [];
    const efforts = levels.length > 0 ? sortEfforts(levels) : ALL_EFFORTS;
    const displayName =
      typeof item.display_name === "string" && item.display_name.trim() ? item.display_name.trim() : id;
    options.push({
      id,
      label: displayName,
      provider: "codex",
      efforts,
      defaultEffort: isEffort(item.default_reasoning_level) ? item.default_reasoning_level : undefined,
      supportsEffort: efforts.length > 0,
      isFast: /luna|terra|mini|flash/i.test(id),
    });
  }
  return options;
}

async function fetchCodexModels(executablePath?: string): Promise<ProviderModelOption[]> {
  // Prefer the live catalog from the installed CLI; fall back to its on-disk cache.
  try {
    const discovery = await discoverProviderExecutable("codex", executablePath);
    if (discovery.executablePath) {
      const { stdout } = await execFileAsync(discovery.executablePath, ["debug", "models"], {
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const parsed = parseCodexCatalog(JSON.parse(stdout));
      if (parsed.length > 0) return parsed;
    }
  } catch {
    // fall through to the cache file
  }
  try {
    const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
    const parsed = parseCodexCatalog(JSON.parse(fs.readFileSync(cachePath, "utf8")));
    if (parsed.length > 0) return parsed;
  } catch {
    // fall through to the static list
  }
  return FALLBACK_CODEX_MODELS;
}

async function fetchAgyModels(executablePath?: string): Promise<ProviderModelOption[] | undefined> {
  try {
    const discovery = await discoverProviderExecutable("agy", executablePath);
    if (!discovery.executablePath) return undefined;
    const { stdout } = await execFileAsync(discovery.executablePath, ["models"], { timeout: 20_000 });
    const parsed = parseAgyModelsOutput(stdout);
    return parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function listProviderModels(
  provider: ProviderId,
  executablePath?: string,
): Promise<ProviderModelOption[]> {
  if (provider === "claude") return CLAUDE_MODELS;

  const cached = modelCache.get(provider);
  if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) return cached.models;

  const models =
    provider === "codex" ? await fetchCodexModels(executablePath) : await fetchAgyModels(executablePath);
  if (models) {
    modelCache.set(provider, { fetchedAt: Date.now(), models });
    return models;
  }
  // agy unavailable right now: keep serving the last good list rather than inventing one.
  return cached?.models ?? [];
}

/**
 * Makes a model/effort pair valid for the CLI: maps agy per-level slugs
 * (`gemini-4-neon-high`) to family + effort, and drops an effort the model doesn't accept.
 */
export function normalizeModelSelection(
  provider: ProviderId,
  model: string | undefined,
  effort: ReasoningEffort | undefined,
  models: ProviderModelOption[],
): { model?: string; effort?: ReasoningEffort } {
  if (!model) return { model, effort };
  let id = model;
  let level = effort;
  let found = models.find((m) => m.id === id);
  if (!found && provider === "agy") {
    const tier = TIERED_SLUG_RE.exec(model);
    const family = tier ? models.find((m) => m.id === tier[1]) : undefined;
    if (tier && family) {
      found = family;
      id = family.id;
      level = tier[2]!.toLowerCase() as ReasoningEffort;
    }
  }
  if (!found) {
    // Unknown model: pass through, but never pair a per-level agy slug with --effort.
    return provider === "agy" && TIERED_SLUG_RE.test(model) ? { model } : { model, effort };
  }
  if (level && !found.efforts.includes(level)) level = undefined;
  return { model: id, effort: level };
}

/** Synchronous lookup of a model's accepted efforts from the last fetched list, if any. */
export function cachedModelEfforts(provider: ProviderId, model: string): ReasoningEffort[] | undefined {
  const models = provider === "claude" ? CLAUDE_MODELS : modelCache.get(provider)?.models;
  return models?.find((m) => m.id === model)?.efforts;
}

export function getEffectiveReadOnlyPolicy(
  provider: ProviderId,
  allowReadOnlyTools: boolean,
): EffectiveReadOnlyPolicy {
  switch (provider) {
    case "codex":
      return {
        provider,
        sandboxSummary:
          "Read-only filesystem sandbox (-s read-only / sandbox_mode=\"read-only\") inside immutable snapshot directory.",
        allowedOperations: allowReadOnlyTools
          ? ["Read files in snapshot", "Run read-only search/inspect commands"]
          : ["Prompt-only reasoning (no snapshot tool usage instructed)"],
        blockedOperations: [
          "Write or patch files",
          "Outbound network access",
          "Modifications to source workspace",
        ],
        flags: ["-s read-only", '-c sandbox_mode="read-only"', "-C <snapshotDir>"],
      };
    case "claude":
      return {
        provider,
        sandboxSummary:
          "Restricted mode (--restricted --strict-mcp-config --permission-mode dontAsk --permission-prompts none) confined to immutable snapshot directory.",
        allowedOperations: allowReadOnlyTools
          ? ["Read", "Glob", "Grep", "StructuredOutput"]
          : ["StructuredOutput / text response only (file & search tools disallowed)"],
        blockedOperations: [
          "Bash / PowerShell",
          "Edit / Write / MultiEdit / NotebookEdit",
          "WebFetch / WebSearch / MCP servers",
        ],
        flags: allowReadOnlyTools
          ? [
              "--restricted",
              "--strict-mcp-config",
              "--permission-mode dontAsk",
              "--permission-prompts none",
              "--disallowedTools Bash,PowerShell,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch",
            ]
          : [
              "--restricted",
              "--strict-mcp-config",
              "--permission-mode dontAsk",
              "--permission-prompts none",
              "--disallowedTools Bash,PowerShell,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch",
            ],
      };
    case "agy":
      return {
        provider,
        sandboxSummary:
          "Terminal sandbox (--sandbox) with explicit permissions.deny policy running in immutable snapshot directory.",
        allowedOperations: allowReadOnlyTools
          ? ["view_file", "list_dir", "grep_search", "find_by_name"]
          : ["Direct text/JSON reasoning (file, shell, web, and MCP tools denied)"],
        blockedOperations: allowReadOnlyTools
          ? ["write_file(*)", "command(*)", "execute_url(*)", "mcp(*)"]
          : [
              "write_file(*)",
              "read_file(*)",
              "command(*)",
              "read_url(*)",
              "execute_url(*)",
              "mcp(*)",
            ],
        flags: [
          "--sandbox",
          "--disable-slash-commands",
          "--settings {\"permissions\":{\"deny\":[...]}}",
        ],
      };
  }
}
