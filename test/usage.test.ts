import assert from "node:assert/strict";
import test from "node:test";
import { parseAgyUsage, parseClaudeReset, parseClaudeUsage, parseCodexUsage } from "../src/providers/usage.js";

test("parseClaudeUsage reads session and weekly lines from /usage text", () => {
  const text = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 58% used · resets Nov 23 at 4:50pm (America/Chicago)",
    "Current week (all models): 62% used · resets Nov 23 at 10pm (America/Chicago)",
    "Current week (Opus): 12% used · resets Nov 27 at 9am (America/Chicago)",
    "",
    "What's contributing to your usage?",
  ].join("\n");
  const usage = parseClaudeUsage(text, new Date("2026-11-23T20:00:00Z"));
  assert.equal(usage.ok, true);
  const windows = usage.groups[0]!.windows;
  assert.deepEqual(
    windows.map((w) => [w.label, w.kind, w.usedPercent, w.resetsText]),
    [
      ["Current session", "5h", 58, "Nov 23 at 4:50pm"],
      ["Current week (all models)", "weekly", 62, "Nov 23 at 10pm"],
      ["Current week (Opus)", "weekly", 12, "Nov 27 at 9am"],
    ],
  );
  assert.ok(windows[0]!.resetsAt);
});

test("parseClaudeReset honours the named zone and rolls past dates forward", () => {
  const now = new Date("2026-11-23T20:00:00Z");
  assert.equal(parseClaudeReset("Dec 1 at 12am (Europe/London)", now), "2026-12-01T00:00:00.000Z");
  assert.equal(parseClaudeReset("Dec 1 at 9:30am (UTC)", now), "2026-12-01T09:30:00.000Z");
  assert.equal(parseClaudeReset("Nov 20 at 9am (UTC)", now), "2027-11-20T09:00:00.000Z");
  assert.equal(parseClaudeReset("not a time", now), undefined);
});

test("parseClaudeUsage reports an error when there is no subscription usage", () => {
  const usage = parseClaudeUsage("/usage isn't available when using an API key");
  assert.equal(usage.ok, false);
  assert.match(usage.error ?? "", /API key/);
});

test("parseCodexUsage maps primary/secondary windows by duration", () => {
  const usage = parseCodexUsage({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        planType: "plus",
        primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1795479327 },
        secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1795574908 },
      },
    },
    rateLimitResetCredits: { availableCount: 2 },
  });
  assert.equal(usage.ok, true);
  assert.equal(usage.plan, "plus");
  assert.deepEqual(
    usage.groups[0]!.windows.map((w) => [w.kind, w.usedPercent]),
    [
      ["5h", 23],
      ["weekly", 81],
    ],
  );
  assert.equal(usage.groups[0]!.windows[0]!.resetsAt, new Date(1795479327 * 1000).toISOString());
  assert.deepEqual(usage.notes, ["2 free limit resets available"]);
});

test("parseAgyUsage turns remaining fractions into used percent per model group", () => {
  const usage = parseAgyUsage({
    command: {
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              { name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.682, reset_time: "2026-11-30T04:37:15Z" },
              { name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.8142, reset_time: "2026-11-24T00:17:20Z" },
            ],
          },
        ],
      },
    },
  });
  assert.equal(usage.ok, true);
  assert.equal(usage.groups[0]!.name, "Gemini Models");
  assert.deepEqual(
    usage.groups[0]!.windows.map((w) => [w.kind, w.usedPercent]),
    [
      ["weekly", 31.8],
      ["5h", 18.6],
    ],
  );
});
