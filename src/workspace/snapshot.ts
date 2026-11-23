import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getEffectiveReadOnlyPolicy } from "../providers/models.js";
import type { ProviderId } from "../types/provider.js";
import type { WorkspaceSnapshotSummary } from "../types/session.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 512 * 1024;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".council",
  "coverage",
  ".next",
  "build",
  ".vite",
]);

export interface InspectedFileEntry {
  path: string;
  sizeBytes: number;
}

export interface WorkspaceInspection {
  sourcePath: string;
  isGitRepo: boolean;
  gitBranch?: string;
  gitCommit?: string;
  gitDirty?: boolean;
  files: InspectedFileEntry[];
  totalBytes: number;
  truncated: boolean;
}

function isInsideRoot(realRoot: string, candidateRealPath: string): boolean {
  if (candidateRealPath === realRoot) return true;
  const rel = path.relative(realRoot, candidateRealPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isLikelyBinary(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < bytesRead; i += 1) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

function walkDirectory(
  rootRealPath: string,
  currentDir: string,
  outPaths: string[],
  maxScan: number,
): void {
  if (outPaths.length >= maxScan) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (outPaths.length >= maxScan) break;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(currentDir, entry.name);
    let realTarget: string;
    try {
      realTarget = fs.realpathSync(full);
    } catch {
      continue;
    }
    if (!isInsideRoot(rootRealPath, realTarget)) continue;
    if (entry.isDirectory()) {
      walkDirectory(rootRealPath, full, outPaths, maxScan);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const stat = fs.statSync(realTarget);
      if (stat.isFile()) {
        outPaths.push(path.relative(rootRealPath, full).split(path.sep).join("/"));
      }
    }
  }
}

export async function inspectWorkspace(
  dirPath: string,
  options: { maxFiles?: number; maxTotalBytes?: number } = {},
): Promise<WorkspaceInspection> {
  if (!dirPath || !dirPath.trim()) {
    throw new Error("Workspace path is required");
  }
  const resolved = path.resolve(dirPath.trim());
  if (!fs.existsSync(resolved)) {
    throw new Error(`Workspace directory does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`);
  }
  const realRoot = fs.realpathSync(resolved);

  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const gitTop = await runGit(realRoot, ["rev-parse", "--show-toplevel"]);
  const isGitRepo = Boolean(gitTop);

  let gitBranch: string | undefined;
  let gitCommit: string | undefined;
  let gitDirty: boolean | undefined;
  let candidateRelPaths: string[] = [];

  if (isGitRepo) {
    const [commitOut, branchOut, statusOut, lsOut] = await Promise.all([
      runGit(realRoot, ["rev-parse", "HEAD"]),
      runGit(realRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runGit(realRoot, ["status", "--porcelain"]),
      runGit(realRoot, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ]),
    ]);
    gitCommit = commitOut?.trim() || undefined;
    gitBranch = branchOut?.trim() || undefined;
    gitDirty =
      statusOut !== undefined ? statusOut.trim().length > 0 : undefined;

    if (lsOut !== undefined) {
      candidateRelPaths = lsOut
        .split("\0")
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .sort((a, b) => a.localeCompare(b));
    }
  }

  if (candidateRelPaths.length === 0) {
    walkDirectory(realRoot, realRoot, candidateRelPaths, maxFiles * 3);
  }

  const files: InspectedFileEntry[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const rel of candidateRelPaths) {
    const parts = rel.split("/");
    if (parts.some((seg) => IGNORED_DIRS.has(seg))) continue;

    const abs = path.resolve(realRoot, rel);
    let realTarget: string;
    try {
      realTarget = fs.realpathSync(abs);
    } catch {
      continue;
    }
    if (!isInsideRoot(realRoot, realTarget)) continue;

    let fileStat: fs.Stats;
    try {
      fileStat = fs.statSync(realTarget);
    } catch {
      continue;
    }
    if (!fileStat.isFile()) continue;
    if (fileStat.size > MAX_SINGLE_FILE_BYTES) continue;
    if (isLikelyBinary(realTarget)) continue;

    if (
      files.length >= maxFiles ||
      totalBytes + fileStat.size > maxTotalBytes
    ) {
      truncated = true;
      break;
    }

    files.push({ path: rel, sizeBytes: fileStat.size });
    totalBytes += fileStat.size;
  }

  return {
    sourcePath: realRoot,
    isGitRepo,
    gitBranch,
    gitCommit,
    gitDirty,
    files,
    totalBytes,
    truncated,
  };
}

export interface CreateReadOnlySnapshotOptions {
  sourcePath: string;
  selectedPaths?: string[];
  snapshotRootDir: string;
  providers: ProviderId[];
  allowReadOnlyTools?: boolean;
}

export async function createReadOnlySnapshot(
  options: CreateReadOnlySnapshotOptions,
): Promise<WorkspaceSnapshotSummary> {
  const inspection = await inspectWorkspace(options.sourcePath);
  const realRoot = inspection.sourcePath;
  const allowReadOnlyTools = options.allowReadOnlyTools ?? true;

  let chosenRelPaths: string[];
  if (options.selectedPaths && options.selectedPaths.length > 0) {
    const validated: string[] = [];
    const seen = new Set<string>();
    for (const rawRel of options.selectedPaths) {
      const normalized = rawRel.replace(/\\/g, "/").trim();
      if (!normalized || path.isAbsolute(normalized)) {
        throw new Error(`Invalid selected relative path: "${rawRel}"`);
      }
      const abs = path.resolve(realRoot, normalized);
      if (!isInsideRoot(realRoot, abs)) {
        throw new Error(`Path escapes workspace root: "${rawRel}"`);
      }
      let realTarget: string;
      try {
        realTarget = fs.realpathSync(abs);
      } catch {
        throw new Error(`Selected file not found: "${rawRel}"`);
      }
      if (!isInsideRoot(realRoot, realTarget)) {
        throw new Error(`Symlink escapes workspace root: "${rawRel}"`);
      }
      const stat = fs.statSync(realTarget);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_SINGLE_FILE_BYTES || isLikelyBinary(realTarget)) {
        continue;
      }
      const canonicalRel = path
        .relative(realRoot, abs)
        .split(path.sep)
        .join("/");
      if (!seen.has(canonicalRel)) {
        seen.add(canonicalRel);
        validated.push(canonicalRel);
      }
    }
    chosenRelPaths = validated.sort((a, b) => a.localeCompare(b));
  } else {
    chosenRelPaths = inspection.files.map((f) => f.path);
  }

  fs.mkdirSync(options.snapshotRootDir, { recursive: true });
  const snapshotId = `snap_${crypto.randomUUID().slice(0, 8)}`;
  const snapshotDir = path.join(options.snapshotRootDir, snapshotId);
  fs.mkdirSync(snapshotDir, { recursive: true });

  const hash = crypto.createHash("sha256");
  const createdDirs = new Set<string>();
  const copiedFiles: string[] = [];
  let totalBytes = 0;

  for (const rel of chosenRelPaths) {
    const src = path.resolve(realRoot, rel);
    const dst = path.resolve(snapshotDir, rel);
    const dstDir = path.dirname(dst);
    fs.mkdirSync(dstDir, { recursive: true });

    let dirCursor = dstDir;
    while (dirCursor !== snapshotDir && dirCursor.startsWith(snapshotDir)) {
      createdDirs.add(dirCursor);
      dirCursor = path.dirname(dirCursor);
    }

    const content = fs.readFileSync(src);
    fs.writeFileSync(dst, content);
    totalBytes += content.length;
    hash.update(rel);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
    copiedFiles.push(dst);
  }

  // Lock files to read-only (0o444) and directories bottom-up (0o555)
  for (const f of copiedFiles) {
    fs.chmodSync(f, 0o444);
  }
  const dirsBottomUp = Array.from(createdDirs).sort(
    (a, b) => b.length - a.length,
  );
  for (const dir of dirsBottomUp) {
    fs.chmodSync(dir, 0o555);
  }
  fs.chmodSync(snapshotDir, 0o555);

  const uniqueProviders = Array.from(new Set(options.providers));
  const effectivePermissions = uniqueProviders.map((provider) =>
    getEffectiveReadOnlyPolicy(provider, allowReadOnlyTools),
  );

  return {
    id: snapshotId,
    sourcePath: realRoot,
    snapshotPath: snapshotDir,
    digest: hash.digest("hex"),
    fileCount: chosenRelPaths.length,
    totalBytes,
    gitBranch: inspection.gitBranch,
    gitCommit: inspection.gitCommit,
    gitDirty: inspection.gitDirty,
    filesPreview: chosenRelPaths,
    providersReceivingMaterial: uniqueProviders,
    effectivePermissions,
    createdAt: new Date().toISOString(),
  };
}

function makeWritableRecursive(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  try {
    fs.chmodSync(dirPath, 0o755);
  } catch {
    return;
  }
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      makeWritableRecursive(full);
    } else {
      try {
        fs.chmodSync(full, 0o644);
      } catch {
        // Ignore chmod errors
      }
    }
  }
}

export function removeSnapshotDir(snapshotDir: string): void {
  if (!fs.existsSync(snapshotDir)) return;
  makeWritableRecursive(snapshotDir);
  fs.rmSync(snapshotDir, { recursive: true, force: true });
}
