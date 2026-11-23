import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  EffectiveReadOnlyPolicy,
  ProviderId,
  ProviderModelOption,
} from "../types/provider.js";
import { discoverProviderExecutable } from "./discovery.js";

const execFileAsync = promisify(execFile);

const AGY_CACHE_TTL_MS = 5 * 60 * 1000;
const TIERED_AGY_SLUG_RE = /-(low|medium|high|xhigh|max)$/i;

let cachedAgyModels:
  | { fetchedAt: number; models: ProviderModelOption[] }
  | undefined;

const FALLBACK_CODEX_MODELS: ProviderModelOption[] = [
  { id: "gpt-6.2-astra", label: "gpt-6.2-astra", provider: "codex", supportsEffort: true },
  { id: "gpt-6.2-sol", label: "gpt-6.2-sol", provider: "codex", supportsEffort: true },
  { id: "gpt-6.1-terra", label: "gpt-6.1-terra", provider: "codex", supportsEffort: true, isFast: true },
  { id: "gpt-6-luna", label: "gpt-6-luna", provider: "codex", supportsEffort: true, isFast: true },
];

const CLAUDE_MODELS: ProviderModelOption[] = [
  { id: "sonnet", label: "Claude Sonnet (alias)", provider: "claude", supportsEffort: true, isFast: true },
  { id: "haiku", label: "Claude Haiku (alias)", provider: "claude", supportsEffort: true, isFast: true },
  { id: "opus", label: "Claude Opus (alias)", provider: "claude", supportsEffort: true, isFast: false },
];

const FALLBACK_AGY_MODELS: ProviderModelOption[] = [
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", provider: "agy", supportsEffort: false, isFast: true },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", provider: "agy", supportsEffort: false, isFast: true },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", provider: "agy", supportsEffort: false, isFast: true },
  { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)", provider: "agy", supportsEffort: false, isFast: true },
  { id: "gemini-4-neon-medium", label: "Gemini 4 Neon (Medium)", provider: "agy", supportsEffort: false },
  { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)", provider: "agy", supportsEffort: false },
];

export function parseAgyModelsOutput(stdout: string): ProviderModelOption[] {
  const options: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Fetching")) continue;
    const match = /^([a-z0-9][a-z0-9._-]*)\s+(.+)$/i.exec(line);
    if (!match) continue;
    const id = match[1]!;
    const label = match[2]!.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label,
      provider: "agy",
      supportsEffort: !TIERED_AGY_SLUG_RE.test(id),
      isFast: /flash|low/i.test(id) || /flash|\(low\)/i.test(label),
    });
  }
  return options;
}

function listCodexModelsFromCache(): ProviderModelOption[] {
  const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
  try {
    if (!fs.existsSync(cachePath)) return FALLBACK_CODEX_MODELS;
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      models?: Array<Record<string, unknown>>;
    };
    const items = Array.isArray(parsed.models) ? parsed.models : [];
    const options: ProviderModelOption[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (!item || typeof item.slug !== "string") continue;
      const id = item.slug.trim();
      if (!id || id === "codex-auto-review" || seen.has(id)) continue;
      seen.add(id);
      const displayName =
        typeof item.display_name === "string" && item.display_name.trim()
          ? item.display_name.trim()
          : id;
      options.push({
        id,
        label: displayName,
        provider: "codex",
        supportsEffort: true,
        isFast: /luna|terra|mini|flash/i.test(id),
      });
    }
    return options.length > 0 ? options : FALLBACK_CODEX_MODELS;
  } catch {
    return FALLBACK_CODEX_MODELS;
  }
}

export async function listProviderModels(
  provider: ProviderId,
  executablePath?: string,
): Promise<ProviderModelOption[]> {
  if (provider === "codex") {
    return listCodexModelsFromCache();
  }
  if (provider === "claude") {
    return CLAUDE_MODELS;
  }

  if (cachedAgyModels && Date.now() - cachedAgyModels.fetchedAt < AGY_CACHE_TTL_MS) {
    return cachedAgyModels.models;
  }

  try {
    const discovery = await discoverProviderExecutable("agy", executablePath);
    if (!discovery.executablePath) return FALLBACK_AGY_MODELS;
    const { stdout } = await execFileAsync(discovery.executablePath, ["models"], {
      timeout: 8000,
    });
    const parsed = parseAgyModelsOutput(stdout);
    if (parsed.length > 0) {
      cachedAgyModels = { fetchedAt: Date.now(), models: parsed };
      return parsed;
    }
  } catch {
    // Fall back to static list if agy models fails
  }
  return FALLBACK_AGY_MODELS;
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
