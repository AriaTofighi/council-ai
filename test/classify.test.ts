import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProcessFailure,
  extractJsonObject,
} from "../src/providers/classify.js";

test("classifyProcessFailure distinguishes missing_executable", () => {
  const err = Object.assign(new Error("spawn codex ENOENT"), {
    code: "ENOENT",
  }) as NodeJS.ErrnoException;
  const result = classifyProcessFailure({ spawnError: err });
  assert.equal(result.outcome, "missing_executable");
  assert.match(result.message, /ENOENT/);
});

test("classifyProcessFailure distinguishes timeout and cancelled", () => {
  assert.equal(
    classifyProcessFailure({ timedOut: true, cancelled: false }).outcome,
    "timeout",
  );
  assert.equal(
    classifyProcessFailure({ timedOut: false, cancelled: true }).outcome,
    "cancelled",
  );
});

test("classifyProcessFailure distinguishes login_required across provider messages", () => {
  const cases = [
    "Not logged in. Please run `claude auth login`.",
    "Error: authentication required (HTTP 401 Unauthorized)",
    "Invalid API key provided in environment",
    "OAuth token expired; please sign in via browser",
  ];
  for (const stderr of cases) {
    const res = classifyProcessFailure({ exitCode: 1, stderr });
    assert.equal(res.outcome, "login_required", `Expected login_required for: ${stderr}`);
  }
});

test("classifyProcessFailure defaults to execution_error for generic failures", () => {
  const res = classifyProcessFailure({
    exitCode: 2,
    stderr: "Unknown flag --bogus",
  });
  assert.equal(res.outcome, "execution_error");
  assert.match(res.message, /Unknown flag/);
});

test("extractJsonObject handles direct JSON, fenced JSON, and malformed text", () => {
  const direct = extractJsonObject('{"action":"finish","final_answer":"ok"}');
  assert.equal(direct.ok, true);

  const fenced = extractJsonObject(
    'Here is the action:\n```json\n{"action":"finish","final_answer":"done"}\n```',
  );
  assert.equal(fenced.ok, true);

  const empty = extractJsonObject("   ");
  assert.equal(empty.ok, false);

  const malformed = extractJsonObject("Not JSON at all.");
  assert.equal(malformed.ok, false);
});
