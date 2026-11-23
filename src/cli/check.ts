import { checkProviders } from "../providers/registry.js";
import type { ProviderCheckResult, UsageInfo } from "../types/provider.js";
import {
  getBooleanFlag,
  getExecutableOverrides,
  getNumberFlag,
  getStringFlag,
  parseArgv,
  parseProviderList,
} from "./args.js";

function formatUsage(usage?: UsageInfo): string {
  if (!usage) return "-";
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in=${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`out=${usage.outputTokens}`);
  if (usage.totalTokens !== undefined) parts.push(`total=${usage.totalTokens}`);
  if (usage.costUsd !== undefined) {
    parts.push(`cost=$${usage.costUsd.toFixed(4)}`);
  }
  return parts.length > 0 ? parts.join(" ") : "-";
}

function printHumanCheckReport(results: ProviderCheckResult[]): void {
  console.log("Provider Connection Check");
  console.log("=".repeat(78));
  for (const r of results) {
    const exe = r.discovery.executablePath ?? "(not found)";
    const ver = r.discovery.version ?? "-";
    const session = r.providerSessionId ?? "-";
    const usage = formatUsage(r.usage);
    const snippet = r.responseText
      ? r.responseText.replace(/\s+/g, " ").trim().slice(0, 120)
      : r.details ?? "-";

    console.log(
      `[${r.provider}] outcome=${r.outcome} elapsed=${r.elapsedMs}ms`,
    );
    console.log(
      `  executable : ${exe} (source=${r.discovery.source}, version=${ver})`,
    );
    console.log(`  session_id : ${session}`);
    console.log(`  usage      : ${usage}`);
    if (r.outcome === "ok") {
      console.log(`  output     : ${snippet}`);
    } else {
      console.log(`  error      : ${r.errorMessage ?? "Unknown error"}`);
    }
    console.log("-".repeat(78));
  }
}

export async function runCheckCommand(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (getBooleanFlag(parsed, "help")) {
    console.log(`Usage: council check [options]

Options:
  --providers <list>     Comma-separated providers (default: codex,claude,agy)
  --codex-path <path>    Override codex executable path
  --claude-path <path>   Override claude executable path
  --agy-path <path>      Override agy executable path
  --cwd <dir>            Working directory for live checks
  --timeout <ms>         Timeout per provider call in milliseconds (default: 45000)
  --prompt <text>        Custom connectivity prompt
  --skip-live            Discover executables and versions only
  --allow-partial        Exit 0 as long as at least one provider succeeds
  --json                 Print results as JSON`);
    return 0;
  }

  const providers = parseProviderList(getStringFlag(parsed, "providers"));
  const executableOverrides = getExecutableOverrides(parsed);
  const cwd = getStringFlag(parsed, "cwd") ?? process.cwd();
  const timeoutMs = getNumberFlag(parsed, "timeout");
  const prompt = getStringFlag(parsed, "prompt");
  const skipLive = getBooleanFlag(parsed, "skip-live");
  const allowPartial = getBooleanFlag(parsed, "allow-partial");
  const asJson = getBooleanFlag(parsed, "json");

  const results = await checkProviders({
    providers,
    executableOverrides,
    cwd,
    timeoutMs,
    prompt,
    skipLive,
  });

  if (asJson) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    printHumanCheckReport(results);
  }

  const okCount = results.filter((r) => r.outcome === "ok").length;
  if (allowPartial) {
    return okCount > 0 ? 0 : 1;
  }
  return okCount === results.length ? 0 : 1;
}
