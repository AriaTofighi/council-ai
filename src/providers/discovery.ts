import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ExecutableDiscovery,
  ExecutableSource,
  ProviderId,
} from "../types/provider.js";

const execFileAsync = promisify(execFile);

const ENV_VAR_BY_PROVIDER: Record<ProviderId, string> = {
  codex: "COUNCIL_CODEX_PATH",
  claude: "COUNCIL_CLAUDE_PATH",
  agy: "COUNCIL_AGY_PATH",
};

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function findClaudeBundleExecutables(): string[] {
  const baseDir = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Claude",
    "claude-code",
  );
  const found: Array<{ path: string; mtimeMs: number; version: string }> = [];

  try {
    if (!fs.existsSync(baseDir)) return [];
    const versions = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const verEntry of versions) {
      if (!verEntry.isDirectory()) continue;
      const verDir = path.join(baseDir, verEntry.name);
      let hashes: fs.Dirent[];
      try {
        hashes = fs.readdirSync(verDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const hashEntry of hashes) {
        if (!hashEntry.isDirectory()) continue;
        const candidate = path.join(
          verDir,
          hashEntry.name,
          "claude.app",
          "Contents",
          "MacOS",
          "claude",
        );
        try {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) {
            found.push({
              path: candidate,
              mtimeMs: stat.mtimeMs,
              version: verEntry.name,
            });
          }
        } catch {
          // Ignore missing candidate
        }
      }
    }
  } catch {
    return [];
  }

  found.sort((a, b) => {
    const verCmp = b.version.localeCompare(a.version, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (verCmp !== 0) return verCmp;
    return b.mtimeMs - a.mtimeMs;
  });

  return found.map((entry) => entry.path);
}

function getMacOsCandidatePaths(provider: ProviderId): string[] {
  const home = os.homedir();
  switch (provider) {
    case "codex":
      return [
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
        "/Applications/Codex.app/Contents/Resources/codex",
        path.join(home, ".local", "bin", "codex"),
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
      ];
    case "claude":
      return [
        path.join(home, ".local", "bin", "claude"),
        path.join(home, ".claude", "local", "claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        ...findClaudeBundleExecutables(),
      ];
    case "agy":
      return [
        path.join(home, ".local", "bin", "agy"),
        path.join(home, ".antigravity", "antigravity", "bin", "agy"),
        path.join(home, ".gemini", "antigravity", "bin", "agy"),
        "/opt/homebrew/bin/agy",
        "/usr/local/bin/agy",
      ];
  }
}

async function readExecutableVersion(
  executablePath: string,
): Promise<string | undefined> {
  try {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const { stdout, stderr } = await execFileAsync(
      executablePath,
      ["--version"],
      {
        timeout: 5000,
        env,
      },
    );
    const combined = `${stdout}\n${stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return combined;
  } catch {
    return undefined;
  }
}

export async function discoverProviderExecutable(
  provider: ProviderId,
  overridePath?: string,
): Promise<ExecutableDiscovery> {
  const candidatesChecked: string[] = [];

  if (overridePath !== undefined && overridePath.trim().length > 0) {
    const resolved = path.resolve(expandHome(overridePath.trim()));
    candidatesChecked.push(resolved);
    if (isExecutableFile(resolved)) {
      const version = await readExecutableVersion(resolved);
      return {
        provider,
        executablePath: resolved,
        source: "override",
        version,
        candidatesChecked,
      };
    }
    return {
      provider,
      executablePath: null,
      source: "override",
      candidatesChecked,
    };
  }

  const envVarName = ENV_VAR_BY_PROVIDER[provider];
  const envPath = process.env[envVarName];
  if (envPath !== undefined && envPath.trim().length > 0) {
    const resolved = path.resolve(expandHome(envPath.trim()));
    candidatesChecked.push(resolved);
    if (isExecutableFile(resolved)) {
      const version = await readExecutableVersion(resolved);
      return {
        provider,
        executablePath: resolved,
        source: "env",
        version,
        candidatesChecked,
      };
    }
    return {
      provider,
      executablePath: null,
      source: "env",
      candidatesChecked,
    };
  }

  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, provider);
    if (!candidatesChecked.includes(candidate)) {
      candidatesChecked.push(candidate);
    }
    if (isExecutableFile(candidate)) {
      const version = await readExecutableVersion(candidate);
      return {
        provider,
        executablePath: candidate,
        source: "path",
        version,
        candidatesChecked,
      };
    }
  }

  for (const candidate of getMacOsCandidatePaths(provider)) {
    if (!candidatesChecked.includes(candidate)) {
      candidatesChecked.push(candidate);
    }
    if (isExecutableFile(candidate)) {
      const source: ExecutableSource = candidate.includes(".app/")
        ? "macos-app-bundle"
        : "path";
      const version = await readExecutableVersion(candidate);
      return {
        provider,
        executablePath: candidate,
        source,
        version,
        candidatesChecked,
      };
    }
  }

  return {
    provider,
    executablePath: null,
    source: "not-found",
    candidatesChecked,
  };
}
