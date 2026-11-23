import type { ProviderId } from "../types/provider.js";

export interface ParsedCliFlags {
  flags: Map<string, string | boolean>;
  positionals: string[];
}

export function parseArgv(argv: string[]): ParsedCliFlags {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      const key = arg.slice(2, eqIdx);
      const val = arg.slice(eqIdx + 1);
      flags.set(key, val);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }

  return { flags, positionals };
}

export function getStringFlag(
  parsed: ParsedCliFlags,
  name: string,
): string | undefined {
  const val = parsed.flags.get(name);
  return typeof val === "string" ? val : undefined;
}

export function getBooleanFlag(
  parsed: ParsedCliFlags,
  name: string,
): boolean {
  const val = parsed.flags.get(name);
  if (val === true) return true;
  if (typeof val === "string") {
    return val === "true" || val === "1" || val === "yes";
  }
  return false;
}

export function getNumberFlag(
  parsed: ParsedCliFlags,
  name: string,
): number | undefined {
  const str = getStringFlag(parsed, name);
  if (str === undefined) return undefined;
  const num = Number(str);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid positive number for --${name}: "${str}"`);
  }
  return num;
}

export function parseProviderId(raw: string): ProviderId {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "codex" || normalized === "claude" || normalized === "agy") {
    return normalized;
  }
  throw new Error(
    `Unknown provider "${raw}". Expected one of: codex, claude, agy`,
  );
}

export function parseProviderList(raw: string | undefined): ProviderId[] {
  if (!raw || !raw.trim()) {
    return ["codex", "claude", "agy"];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map(parseProviderId);
}

export function getExecutableOverrides(
  parsed: ParsedCliFlags,
): Partial<Record<ProviderId, string>> {
  const overrides: Partial<Record<ProviderId, string>> = {};
  const codexPath = getStringFlag(parsed, "codex-path");
  const claudePath = getStringFlag(parsed, "claude-path");
  const agyPath = getStringFlag(parsed, "agy-path");
  if (codexPath) overrides.codex = codexPath;
  if (claudePath) overrides.claude = claudePath;
  if (agyPath) overrides.agy = agyPath;
  return overrides;
}
