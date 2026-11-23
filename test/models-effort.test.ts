import assert from "node:assert/strict";
import test from "node:test";
import { buildAgyArgs } from "../src/providers/agy.js";
import { buildClaudeArgs } from "../src/providers/claude.js";
import { buildCodexArgs } from "../src/providers/codex.js";
import {
  getEffectiveReadOnlyPolicy,
  normalizeModelSelection,
  parseAgyModelsOutput,
  parseCodexCatalog,
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

test("parseAgyModelsOutput groups per-level slugs into families with their exact levels", () => {
  const raw = [
    "Fetching available models...",
    "gemini-4-neon-high\tGemini 4 Neon (High)",
    "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
    "gemini-4-neon-low\tGemini 4 Neon (Low)",
    "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
    "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
    "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  ].join("\n");
  const models = parseAgyModelsOutput(raw);
  assert.deepEqual(
    models.map((m) => [m.id, m.label, m.efforts]),
    [
      ["gemini-4-neon", "Gemini 4 Neon", ["low", "high", "xhigh"]],
      ["gemini-pro-orchestrator-neon", "Orchestrator (Neon)", []],
      ["gemini-3.8-flash", "Gemini 3.8 Flash", ["low"]],
      ["gpt-oss-120b", "GPT-OSS 120B", ["medium"]],
    ],
  );
  assert.equal(models[1]?.supportsEffort, false);
  assert.equal(models[2]?.isFast, true);
});

test("normalizeModelSelection drops efforts a model rejects and migrates per-level agy slugs", () => {
  const agy = parseAgyModelsOutput(
    ["gemini-4-neon-high\tGemini 4 Neon (High)", "gemini-4-neon-low\tGemini 4 Neon (Low)", "gemini-pro-orchestrator-neon\tOrchestrator (Neon)"].join("\n"),
  );
  assert.deepEqual(normalizeModelSelection("agy", "gemini-pro-orchestrator-neon", "high", agy), {
    model: "gemini-pro-orchestrator-neon",
    effort: undefined,
  });
  assert.deepEqual(normalizeModelSelection("agy", "gemini-4-neon-high", "low", agy), {
    model: "gemini-4-neon",
    effort: "high",
  });
  assert.deepEqual(normalizeModelSelection("agy", "gemini-4-neon", "max", agy), {
    model: "gemini-4-neon",
    effort: undefined,
  });
  assert.deepEqual(normalizeModelSelection("agy", "gemini-4-neon", "low", agy), {
    model: "gemini-4-neon",
    effort: "low",
  });
});

test("parseCodexCatalog reads per-model reasoning levels and hides hidden models", () => {
  const models = parseCodexCatalog({
    models: [
      {
        slug: "gpt-6-luna",
        display_name: "GPT-6 Luna",
        visibility: "list",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "ultra" }],
      },
      { slug: "codex-auto-review", visibility: "hide" },
    ],
  });
  assert.equal(models.length, 1);
  assert.deepEqual(models[0]?.efforts, ["low", "medium"]);
  assert.equal(models[0]?.defaultEffort, "medium");
});

test("getEffectiveReadOnlyPolicy describes read-only policies for all providers", () => {
  for (const p of ["codex", "claude", "agy"] as const) {
    const policy = getEffectiveReadOnlyPolicy(p, true);
    assert.equal(policy.provider, p);
    assert.ok(policy.flags.length > 0);
    assert.ok(policy.blockedOperations.length > 0);
  }
});
