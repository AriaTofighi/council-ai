import assert from "node:assert/strict";
import test from "node:test";
import { buildAgyArgs } from "../src/providers/agy.js";
import { buildClaudeArgs } from "../src/providers/claude.js";
import { buildCodexArgs } from "../src/providers/codex.js";
import {
  getEffectiveReadOnlyPolicy,
  parseAgyModelsOutput,
} from "../src/providers/models.js";

test("buildCodexArgs includes model and reasoning effort on initial and resume turns", () => {
  const initArgs = buildCodexArgs(
    { cwd: "/tmp/snap", readOnly: true, model: "gpt-6-luna", effort: "low" },
    undefined,
    "/tmp/schema.json",
  );
  assert.ok(initArgs.includes("-s"));
  assert.ok(initArgs.includes("read-only"));
  assert.ok(initArgs.includes("gpt-6-luna"));
  assert.ok(initArgs.includes('model_reasoning_effort="low"'));

  const resumeArgs = buildCodexArgs(
    { cwd: "/tmp/snap", readOnly: true, model: "gpt-6-luna", effort: "low" },
    "thread-123",
    undefined,
  );
  assert.equal(resumeArgs[0], "exec");
  assert.equal(resumeArgs[1], "resume");
  assert.ok(resumeArgs.includes('sandbox_mode="read-only"'));
  assert.ok(resumeArgs.includes('model_reasoning_effort="low"'));
  assert.ok(resumeArgs.includes("thread-123"));
});

test("buildClaudeArgs passes model, effort, and restricted read-only flags", () => {
  const args = buildClaudeArgs(
    {
      readOnly: true,
      allowReadOnlyTools: true,
      model: "sonnet",
      effort: "low",
      systemPrompt: "Lead prompt",
    },
    undefined,
    "uuid-1",
    undefined,
  );
  assert.ok(args.includes("--restricted"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("sonnet"));
  assert.ok(args.includes("--effort"));
  assert.ok(args.includes("low"));
  assert.ok(args.includes("--session-id"));
  assert.ok(args.includes("uuid-1"));
});

test("buildAgyArgs avoids passing --effort when tiered model slug already encodes effort", () => {
  const tieredArgs = buildAgyArgs(
    {
      readOnly: true,
      allowReadOnlyTools: true,
      model: "gemini-3.8-flash-low",
      effort: "low",
    },
    "Hello",
    undefined,
    { timeoutMs: 30_000 },
  );
  assert.ok(tieredArgs.includes("--model"));
  assert.ok(tieredArgs.includes("gemini-3.8-flash-low"));
  assert.equal(tieredArgs.includes("--effort"), false);

  const untieredArgs = buildAgyArgs(
    {
      readOnly: true,
      allowReadOnlyTools: false,
      model: "gemini-pro-orchestrator-neon",
      effort: "low",
    },
    "Hello",
    "conv-1",
    { timeoutMs: 30_000 },
  );
  assert.ok(untieredArgs.includes("--effort"));
  assert.ok(untieredArgs.includes("low"));
  assert.ok(untieredArgs.includes("--conversation"));
  assert.ok(untieredArgs.includes("conv-1"));
});

test("parseAgyModelsOutput classifies tiered slugs and fast models", () => {
  const raw = [
    "Fetching available models...",
    "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
    "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
  ].join("\n");
  const models = parseAgyModelsOutput(raw);
  assert.equal(models.length, 2);
  assert.equal(models[0]?.id, "gemini-3.8-flash-low");
  assert.equal(models[0]?.supportsEffort, false);
  assert.equal(models[0]?.isFast, true);
  assert.equal(models[1]?.id, "gemini-pro-orchestrator-neon");
  assert.equal(models[1]?.supportsEffort, true);
});

test("getEffectiveReadOnlyPolicy describes read-only policies for all providers", () => {
  for (const p of ["codex", "claude", "agy"] as const) {
    const policy = getEffectiveReadOnlyPolicy(p, true);
    assert.equal(policy.provider, p);
    assert.ok(policy.flags.length > 0);
    assert.ok(policy.blockedOperations.length > 0);
  }
});
