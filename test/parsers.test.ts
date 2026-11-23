import assert from "node:assert/strict";
import test from "node:test";
import { parseAgyOutput } from "../src/providers/agy.js";
import { parseClaudeOutput } from "../src/providers/claude.js";
import { parseCodexJsonl } from "../src/providers/codex.js";

test("parseCodexJsonl parses thread_id, agent_message, and usage", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "0199a213-thread" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "reasoning", text: "Checking..." },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_2", type: "agent_message", text: "COUNCIL_OK" },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 15 },
    }),
  ].join("\n");

  const parsed = parseCodexJsonl(stdout);
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.threadId, "0199a213-thread");
  assert.equal(parsed.text, "COUNCIL_OK");
  assert.equal(parsed.usage?.inputTokens, 120);
  assert.equal(parsed.usage?.cachedInputTokens, 80);
  assert.equal(parsed.usage?.outputTokens, 15);
  assert.deepEqual(parsed.errors, []);
});

test("parseCodexJsonl flags non-JSON stdout as malformed", () => {
  const parsed = parseCodexJsonl("plain error string not jsonl");
  assert.equal(parsed.malformed, true);
  assert.equal(parsed.validEvents, 0);
});

test("parseClaudeOutput parses stream-json with structured_output and cost", () => {
  const stdout = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-sess-111",
    }),
    JSON.stringify({
      type: "assistant",
      session_id: "claude-sess-111",
      message: {
        content: [{ type: "text", text: "Working on it." }],
      },
    }),
    JSON.stringify({
      type: "result",
      session_id: "claude-sess-111",
      is_error: false,
      result: '{"action":"finish"}',
      structured_output: { action: "finish", final_answer: "Ready" },
      total_cost_usd: 0.0123,
      usage: { input_tokens: 500, output_tokens: 45, cache_read_input_tokens: 300 },
    }),
  ].join("\n");

  const parsed = parseClaudeOutput(stdout);
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.sessionId, "claude-sess-111");
  assert.equal(parsed.isError, false);
  assert.deepEqual(parsed.structuredOutput, {
    action: "finish",
    final_answer: "Ready",
  });
  assert.equal(parsed.usage?.costUsd, 0.0123);
  assert.equal(parsed.usage?.cachedInputTokens, 300);
});

test("parseClaudeOutput captures StructuredOutput tool_use fallback and errors", () => {
  const stdout = JSON.stringify({
    type: "assistant",
    session_id: "claude-sess-222",
    message: {
      content: [
        {
          type: "tool_use",
          name: "StructuredOutput",
          input: { action: "finish", final_answer: "From tool" },
        },
      ],
    },
  });
  const parsed = parseClaudeOutput(stdout);
  assert.deepEqual(parsed.structuredOutput, {
    action: "finish",
    final_answer: "From tool",
  });

  const errParsed = parseClaudeOutput(
    JSON.stringify({
      type: "result",
      is_error: true,
      result: "Not logged in",
    }),
  );
  assert.equal(errParsed.isError, true);
  assert.ok(errParsed.errors.includes("Not logged in"));
});

test("parseAgyOutput handles stream-json, single json envelope, and malformed output", () => {
  const stream = [
    JSON.stringify({ event: "init", conversation_id: "agy-conv-1" }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "agy-conv-1",
        step_type: "agent_response",
        text_delta: "Hello ",
      },
    }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "agy-conv-1",
        status: "SUCCESS",
        response: "Hello world",
        usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 4, total_tokens: 110 },
      },
    }),
  ].join("\n");

  const parsedStream = parseAgyOutput(stream);
  assert.equal(parsedStream.malformed, false);
  assert.equal(parsedStream.conversationId, "agy-conv-1");
  assert.equal(parsedStream.status, "SUCCESS");
  assert.equal(parsedStream.text, "Hello world");
  assert.equal(parsedStream.usage?.thinkingTokens, 4);

  const singleErr = parseAgyOutput(
    JSON.stringify({
      conversation_id: "",
      status: "ERROR",
      response: "",
      error: "authentication required",
    }),
  );
  assert.equal(singleErr.status, "ERROR");
  assert.equal(singleErr.error, "authentication required");

  const bad = parseAgyOutput("<html>502 Bad Gateway</html>");
  assert.equal(bad.malformed, true);
});
