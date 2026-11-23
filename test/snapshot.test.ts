import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createReadOnlySnapshot,
  inspectWorkspace,
  removeSnapshotDir,
} from "../src/workspace/snapshot.js";

test("read-only snapshot locks revision, blocks symlink escapes, and preserves source workspace", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-snap-test-"));
  const repoDir = path.join(tempRoot, "repo");
  const snapRoot = path.join(tempRoot, "snapshots");
  const outsideFile = path.join(tempRoot, "secret.txt");

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(outsideFile, "OUTSIDE_SECRET", "utf8");
    fs.writeFileSync(path.join(repoDir, "app.ts"), "export const x = 1;\n", "utf8");
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "ignored.txt\n", "utf8");
    fs.writeFileSync(path.join(repoDir, "ignored.txt"), "IGNORED\n", "utf8");
    fs.symlinkSync(outsideFile, path.join(repoDir, "escape.txt"));

    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["add", "app.ts", ".gitignore"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

    const inspection = await inspectWorkspace(repoDir);
    assert.equal(inspection.isGitRepo, true);
    assert.ok(inspection.gitCommit);
    const paths = inspection.files.map((f) => f.path);
    assert.ok(paths.includes("app.ts"));
    assert.equal(paths.includes("ignored.txt"), false);
    assert.equal(paths.includes("escape.txt"), false);

    const snapshot = await createReadOnlySnapshot({
      sourcePath: repoDir,
      snapshotRootDir: snapRoot,
      providers: ["claude", "codex", "agy"],
      allowReadOnlyTools: true,
    });

    assert.deepEqual(snapshot.providersReceivingMaterial, ["claude", "codex", "agy"]);
    assert.equal(snapshot.effectivePermissions.length, 3);

    // Source modification after snapshot must NOT affect snapshot
    fs.writeFileSync(path.join(repoDir, "app.ts"), "export const x = 999;\n", "utf8");
    const snapApp = fs.readFileSync(path.join(snapshot.snapshotPath, "app.ts"), "utf8");
    assert.equal(snapApp, "export const x = 1;\n");

    // Writing inside snapshot must fail with EACCES / EPERM
    assert.throws(
      () => fs.writeFileSync(path.join(snapshot.snapshotPath, "app.ts"), "hack", "utf8"),
      /(EACCES|EPERM)/,
    );

    // Cleanup removes locked snapshot cleanly
    removeSnapshotDir(snapshot.snapshotPath);
    assert.equal(fs.existsSync(snapshot.snapshotPath), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
