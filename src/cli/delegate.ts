import fs from "node:fs";
import path from "node:path";
import { runLeadDelegation, runOrchestratedTurn } from "../orchestration/index.js";
import { checkProviders } from "../providers/registry.js";
import type { ProviderId, ReasoningEffort } from "../types/provider.js";
import type { OrchestrationMode } from "../types/protocol.js";
import type {
  DelegationRunResult,
  ParticipantConfig,
  RunEvent,
  WorkspaceSnapshotSummary,
} from "../types/session.js";
import { createReadOnlySnapshot } from "../workspace/snapshot.js";
import {
  getBooleanFlag,
  getExecutableOverrides,
  getNumberFlag,
  getStringFlag,
  parseArgv,
  parseProviderId,
  parseProviderList,
} from "./args.js";

function parseEffortFlag(raw: string | undefined): ReasoningEffort | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max") {
    return v;
  }
  throw new Error(`Invalid effort "${raw}". Expected low|medium|high|xhigh|max`);
}

function parseModeFlag(raw: string | undefined): OrchestrationMode {
  if (!raw) return "divide_conquer";
  const v = raw.trim().toLowerCase();
  if (v === "divide_conquer" || v === "divide-conquer") return "divide_conquer";
  if (v === "roundtable") return "roundtable";
  throw new Error(`Invalid mode "${raw}". Expected divide_conquer or roundtable`);
}

function buildTeamConfigs(options: {
  leadProvider: ProviderId;
  teamProviders: ProviderId[];
  overrides: Partial<Record<ProviderId, string>>;
  privateContext?: string;
  leadModel?: string;
  leadEffort?: ReasoningEffort;
  teamModel?: string;
  teamEffort?: ReasoningEffort;
}): { lead: ParticipantConfig; teammates: ParticipantConfig[] } {
  const counts = new Map<ProviderId, number>();
  const nextIndex = (p: ProviderId): number => {
    const val = (counts.get(p) ?? 0) + 1;
    counts.set(p, val);
    return val;
  };

  const leadIdx = nextIndex(options.leadProvider);
  const lead: ParticipantConfig = {
    id: `lead_${options.leadProvider}_${leadIdx}`,
    label: `${options.leadProvider} lead`,
    provider: options.leadProvider,
    role: "lead",
    executablePath: options.overrides[options.leadProvider],
    model: options.leadModel,
    effort: options.leadEffort,
  };

  const teammates: ParticipantConfig[] = options.teamProviders.map((provider) => {
    const idx = nextIndex(provider);
    const sameAsLead = provider === options.leadProvider;
    const roleLabel = sameAsLead ? "specialist" : "teammate";
    return {
      id: `mate_${provider}_${idx}`,
      label: `${provider} ${roleLabel} #${idx}`,
      provider,
      role: "teammate",
      executablePath: options.overrides[provider],
      model: options.teamModel,
      effort: options.teamEffort,
      privateContext: options.privateContext,
    };
  });

  return { lead, teammates };
}

function logRunEvent(event: RunEvent): void {
  switch (event.type) {
    case "run_started":
      console.log(
        `[run ${event.runId}] mode=${event.mode}${event.independentFirstOpinions ? " (independent-openings)" : ""} lead=${event.lead.id} (${event.lead.provider}), team=[${event.teammates.map((t) => `${t.id}:${t.provider}`).join(", ")}]`,
      );
      break;
    case "roundtable_opening_planned":
      console.log(
        `[roundtable] opener=${event.plan.opening_participant_id} order=[${event.plan.discussion_order.join(", ")}]`,
      );
      break;
    case "roundtable_turn_started":
      console.log(
        `[round ${event.round}] ${event.participantId} (${event.provider}) ${event.isBlind ? "blind opening" : "responding"}...`,
      );
      break;
    case "roundtable_turn_completed":
      console.log(
        `  <- [${event.contribution.id}] ${event.assignment.participantId} (${event.assignment.provider}) outcome=${event.contribution.outcome} session=${event.contribution.providerSessionId ?? "-"} (${event.contribution.elapsedMs}ms)`,
      );
      break;
    case "lead_thinking":
      console.log(
        `[turn ${event.turn}] ${event.participantId} (${event.provider}) planning next action${event.mustFinish ? " [FINAL SYNTHESIS REQUIRED]" : ""}...`,
      );
      break;
    case "lead_action":
      if (event.action.action === "delegate") {
        console.log(
          `[turn ${event.turn}] lead chose DELEGATE (${event.action.assignments.length} assignment(s), ${event.elapsedMs}ms):`,
        );
        for (const a of event.action.assignments) {
          console.log(`  -> ${a.participant_id}: "${a.title}"`);
        }
      } else if (event.action.action === "follow_up") {
        console.log(
          `[turn ${event.turn}] lead chose FOLLOW_UP -> ${event.action.follow_up.participant_id} (${event.action.follow_up.assignment_id}, ${event.elapsedMs}ms)`,
        );
      } else if (event.action.action === "retrieve_contribution") {
        console.log(
          `[turn ${event.turn}] lead chose RETRIEVE -> ${event.action.retrieve_contribution_id} (${event.elapsedMs}ms)`,
        );
      } else {
        console.log(
          `[turn ${event.turn}] lead chose FINISH (${event.elapsedMs}ms)`,
        );
      }
      break;
    case "assignment_completed":
      console.log(
        `  <- [${event.contribution.id}] ${event.assignment.participantId} (${event.assignment.provider}) outcome=${event.contribution.outcome} session=${event.contribution.providerSessionId ?? "-"} mode=${event.contribution.continuationMode} (${event.contribution.elapsedMs}ms)`,
      );
      break;
    case "followup_completed":
      console.log(
        `  <- [${event.contribution.id}] ${event.contribution.participantId} follow-up outcome=${event.contribution.outcome} session=${event.contribution.providerSessionId ?? "-"} mode=${event.contribution.continuationMode} (${event.contribution.elapsedMs}ms)`,
      );
      break;
    case "session_fallback":
      console.log(
        `  [fallback] ${event.participantId} (${event.provider}): ${event.reason}`,
      );
      break;
    case "diagnostic":
      if (event.diagnostic.level !== "info") {
        console.log(
          `  [${event.diagnostic.level}] ${event.diagnostic.code}: ${event.diagnostic.message}`,
        );
      }
      break;
    case "run_finished":
      console.log(
        `[run ${event.runId}] finished status=${event.status} elapsed=${event.elapsedMs}ms`,
      );
      break;
  }
}

function printDelegationResult(result: DelegationRunResult): void {
  console.log("\n" + "=".repeat(78));
  console.log("Final Answer");
  console.log("=".repeat(78));
  console.log(result.finalAnswer);

  if (result.participantSummaries.length > 0) {
    console.log("\nWhat Each Agent Added:");
    for (const s of result.participantSummaries) {
      console.log(`  - ${s.participant_id}: ${s.added}`);
    }
  }

  if (result.disagreements.length > 0) {
    console.log("\nDisagreements:");
    for (const d of result.disagreements) {
      console.log(`  - ${d}`);
    }
  }

  console.log("\nUsed Contribution IDs:", result.usedContributionIds.join(", ") || "(none)");
  console.log(
    "Unresolved Issues:",
    result.unresolvedIssues.length > 0
      ? result.unresolvedIssues.join("; ")
      : "(none)",
  );

  console.log("\nParticipants & Session Isolation:");
  for (const p of [result.leadParticipant, ...result.teammates]) {
    console.log(
      `  - ${p.participantId} (${p.provider}, ${p.role}): session=${p.providerSessionId ?? "-"} turns=${p.turnCount} mode=${p.continuationMode}${p.fallbackReason ? ` reason="${p.fallbackReason}"` : ""}`,
    );
  }

  if (result.contributions.length > 0) {
    console.log("\nContributions:");
    for (const c of result.contributions) {
      const preview = c.content
        ? c.content.replace(/\s+/g, " ").trim().slice(0, 140)
        : c.errorMessage ?? "-";
      console.log(
        `  - ${c.id} [${c.assignmentId}] ${c.participantId} (${c.kind}, ${c.outcome}): ${preview}`,
      );
    }
  }
}

export async function runDelegateCommand(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (getBooleanFlag(parsed, "help")) {
    console.log(`Usage: council delegate [options]

Options:
  --lead <provider>            Lead provider: codex | claude | agy (default: claude)
  --team <list>                Comma-separated teammate providers (default: codex)
  --mode <mode>                divide_conquer (default) or roundtable
  --independent-openings       In roundtable mode, collect blind opening positions in parallel
  --prompt <text>              User request for the lead (required)
  --workspace <dir>            Create and share a read-only repo snapshot across all agents
  --teammate-fixture <path>    Private constraint/reference file visible ONLY to teammates
  --lead-model <id>            Model override for the lead
  --lead-effort <level>        Thinking effort for the lead (low|medium|high|xhigh|max)
  --team-model <id>            Model override for teammates
  --team-effort <level>        Thinking effort for teammates (low|medium|high|xhigh|max)
  --cwd <dir>                  Working directory (default: current directory)
  --max-lead-calls <n>         Max lead turns (default: 6)
  --max-total-calls <n>        Max total CLI calls (default: 14)
  --timeout <ms>               Per-call timeout in ms (default: 90000)
  --deadline <ms>              Hard deadline in ms (default: 240000)
  --no-tools                   Disable file inspection tools during the run
  --codex-path <path>          Override codex executable path
  --claude-path <path>         Override claude executable path
  --agy-path <path>            Override agy executable path
  --json                       Output final DelegationRunResult as JSON`);
    return 0;
  }

  const leadProvider = parseProviderId(getStringFlag(parsed, "lead") ?? "claude");
  const teamProviders = parseProviderList(getStringFlag(parsed, "team") ?? "codex");
  const mode = parseModeFlag(getStringFlag(parsed, "mode"));
  const independentFirstOpinions = getBooleanFlag(parsed, "independent-openings");
  const prompt = getStringFlag(parsed, "prompt")?.trim();
  // Every run spends the user's subscription quota, so never run a built-in example by default.
  if (!prompt) {
    console.error('Missing --prompt. Example: council delegate --prompt "Review the auth flow" --workspace .');
    console.error('Run "council delegate --help" for all options.');
    return 1;
  }
  const fixturePath = getStringFlag(parsed, "teammate-fixture");
  const privateContext = fixturePath
    ? fs.readFileSync(path.resolve(fixturePath), "utf8")
    : undefined;

  const cwd = getStringFlag(parsed, "cwd") ?? process.cwd();
  const workspaceDir = getStringFlag(parsed, "workspace");
  const overrides = getExecutableOverrides(parsed);
  const asJson = getBooleanFlag(parsed, "json");
  const noTools = getBooleanFlag(parsed, "no-tools");

  const { lead, teammates } = buildTeamConfigs({
    leadProvider,
    teamProviders,
    overrides,
    privateContext,
    leadModel: getStringFlag(parsed, "lead-model"),
    leadEffort: parseEffortFlag(getStringFlag(parsed, "lead-effort")),
    teamModel: getStringFlag(parsed, "team-model"),
    teamEffort: parseEffortFlag(getStringFlag(parsed, "team-effort")),
  });

  let snapshot: WorkspaceSnapshotSummary | undefined;
  if (workspaceDir) {
    snapshot = await createReadOnlySnapshot({
      sourcePath: workspaceDir,
      snapshotRootDir: path.resolve(".council", "snapshots"),
      providers: [lead.provider, ...teammates.map((t) => t.provider)],
      allowReadOnlyTools: !noTools,
    });
  }

  const limits: Record<string, number> = {};
  const maxLeadCalls = getNumberFlag(parsed, "max-lead-calls");
  const maxTotalCalls = getNumberFlag(parsed, "max-total-calls");
  const timeout = getNumberFlag(parsed, "timeout");
  const deadline = getNumberFlag(parsed, "deadline");
  if (maxLeadCalls !== undefined) limits.maxLeadCalls = maxLeadCalls;
  if (maxTotalCalls !== undefined) limits.maxTotalCalls = maxTotalCalls;
  if (timeout !== undefined) limits.perCallTimeoutMs = timeout;
  if (deadline !== undefined) limits.hardDeadlineMs = deadline;

  const result = await runOrchestratedTurn({
    prompt,
    mode,
    independentFirstOpinions,
    lead,
    teammates,
    snapshot,
    cwd: snapshot?.snapshotPath ?? cwd,
    allowReadOnlyTools: !noTools,
    limits,
    onEvent: asJson ? undefined : logRunEvent,
  });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printDelegationResult(result);
  }

  return result.status === "completed" ? 0 : 1;
}

interface M2CaseSpec {
  name: string;
  lead: ProviderId;
  teammate: ProviderId;
  sameCli: boolean;
}

interface M2CaseReport {
  name: string;
  status: string;
  passed: boolean;
  reasons: string[];
  leadSessionId?: string;
  teammateSessionId?: string;
  distinctSessions: boolean;
  delegations: number;
  usedContributionIds: string[];
  matchedConstraintTerms: string[];
  elapsedMs: number;
}

const CONSTRAINT_KEYWORDS = [
  "ios-fieldapp",
  "q3",
  "amount_cents",
  "idempotency_key",
  "compatibility shim",
  "shim",
  "quarterly",
];

function evaluateM2Case(
  spec: M2CaseSpec,
  result: DelegationRunResult,
): M2CaseReport {
  const reasons: string[] = [];

  if (result.status !== "completed") {
    reasons.push(`Expected status=completed, got ${result.status}`);
  }
  if (result.assignments.length === 0) {
    reasons.push("Lead did not delegate any assignment to teammate");
  }

  const okContribs = result.contributions.filter((c) => c.outcome === "ok");
  if (okContribs.length === 0) {
    reasons.push("No teammate contribution succeeded");
  }

  if (result.usedContributionIds.length === 0) {
    reasons.push("Lead did not cite any used_contribution_ids");
  }

  const lowerAnswer = result.finalAnswer.toLowerCase();
  const matchedConstraintTerms = CONSTRAINT_KEYWORDS.filter((kw) =>
    lowerAnswer.includes(kw),
  );
  if (matchedConstraintTerms.length < 2) {
    reasons.push(
      `Final answer did not clearly incorporate hidden fixture constraints (matched: [${matchedConstraintTerms.join(", ")}])`,
    );
  }

  const leadSessionId = result.leadParticipant.providerSessionId;
  const teammateSessionId = result.teammates[0]?.providerSessionId;
  const distinctSessions =
    result.leadParticipant.participantId !== result.teammates[0]?.participantId &&
    (!leadSessionId || !teammateSessionId || leadSessionId !== teammateSessionId);

  if (spec.sameCli) {
    if (result.leadParticipant.participantId === result.teammates[0]?.participantId) {
      reasons.push("Lead and teammate participant IDs collided");
    }
    if (leadSessionId && teammateSessionId && leadSessionId === teammateSessionId) {
      reasons.push(
        `Same-CLI isolation failed: both used session ${leadSessionId}`,
      );
    }
  }

  return {
    name: spec.name,
    status: result.status,
    passed: reasons.length === 0,
    reasons,
    leadSessionId,
    teammateSessionId,
    distinctSessions,
    delegations: result.assignments.length,
    usedContributionIds: result.usedContributionIds,
    matchedConstraintTerms,
    elapsedMs: result.elapsedMs,
  };
}

export async function runVerifyM2Command(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (getBooleanFlag(parsed, "help")) {
    console.log(`Usage: council verify-m2 [options]

Runs Milestone 2 live delegation acceptance checks against the migration-constraint fixture:
  - Cross-provider delegation with each available provider as lead
  - Same-CLI isolated session delegation

Options:
  --providers <list>     Comma-separated providers to include (default: codex,claude,agy)
  --fixture <path>       Fixture path (default: fixtures/migration-constraint.md)
  --timeout <ms>         Per-call timeout in ms (default: 90000)
  --codex-path <path>    Override codex executable path
  --claude-path <path>   Override claude executable path
  --agy-path <path>      Override agy executable path
  --json                 Output JSON report`);
    return 0;
  }

  const requestedProviders = parseProviderList(
    getStringFlag(parsed, "providers"),
  );
  const overrides = getExecutableOverrides(parsed);
  const fixturePath = path.resolve(
    getStringFlag(parsed, "fixture") ?? "fixtures/migration-constraint.md",
  );
  const fixtureContent = fs.readFileSync(fixturePath, "utf8");
  const timeoutMs = getNumberFlag(parsed, "timeout") ?? 90_000;
  const asJson = getBooleanFlag(parsed, "json");

  if (!asJson) {
    console.log("Checking provider availability before Milestone 2 matrix...");
  }
  const checks = await checkProviders({
    providers: requestedProviders,
    executableOverrides: overrides,
    timeoutMs: Math.min(timeoutMs, 45_000),
  });

  const readyProviders = checks
    .filter((c) => c.outcome === "ok")
    .map((c) => c.provider);

  if (readyProviders.length === 0) {
    console.error("No providers passed live availability check.");
    return 1;
  }

  const cases: M2CaseSpec[] = [];
  if (readyProviders.length >= 2) {
    for (let i = 0; i < readyProviders.length; i += 1) {
      const lead = readyProviders[i]!;
      const teammate = readyProviders[(i + 1) % readyProviders.length]!;
      cases.push({
        name: `cross:${lead}->${teammate}`,
        lead,
        teammate,
        sameCli: false,
      });
    }
  }

  for (const provider of readyProviders) {
    cases.push({
      name: `isolated:${provider}->${provider}`,
      lead: provider,
      teammate: provider,
      sameCli: true,
    });
  }

  const prompt = [
    "We want to migrate BillingService from /v1/invoices to /v2/invoices in a single weekend cutover and immediately disable /v1/invoices.",
    "You do NOT have direct access to the client audit notes. Delegate to your teammate to inspect client constraints and wire compatibility requirements, then revise the rollout plan to account for their findings.",
  ].join(" ");

  const reports: M2CaseReport[] = [];

  for (const spec of cases) {
    if (!asJson) {
      console.log(`\n--- Running ${spec.name} ---`);
    }
    const { lead, teammates } = buildTeamConfigs({
      leadProvider: spec.lead,
      teamProviders: [spec.teammate],
      overrides,
      privateContext: fixtureContent,
    });

    const result = await runLeadDelegation({
      prompt,
      lead,
      teammates,
      cwd: process.cwd(),
      allowReadOnlyTools: false,
      limits: {
        maxLeadCalls: 5,
        maxTotalCalls: 10,
        perCallTimeoutMs: timeoutMs,
        hardDeadlineMs: timeoutMs * 4,
      },
      onEvent: asJson ? undefined : logRunEvent,
    });

    const report = evaluateM2Case(spec, result);
    reports.push(report);
    if (!asJson) {
      console.log(
        `Result [${report.name}]: ${report.passed ? "PASS" : "FAIL"} (${report.elapsedMs}ms) matched=[${report.matchedConstraintTerms.join(", ")}] leadSession=${report.leadSessionId ?? "-"} mateSession=${report.teammateSessionId ?? "-"}`,
      );
      if (report.reasons.length > 0) {
        for (const r of report.reasons) {
          console.log(`  FAIL REASON: ${r}`);
        }
      }
    }
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          checks,
          readyProviders,
          reports,
        },
        null,
        2,
      ),
    );
  } else {
    console.log("\n" + "=".repeat(78));
    console.log("Milestone 2 Acceptance Matrix");
    console.log("=".repeat(78));
    for (const r of reports) {
      console.log(
        `${r.passed ? "PASS" : "FAIL"} | ${r.name} | status=${r.status} | delegations=${r.delegations} | cited=${r.usedContributionIds.join(",") || "-"} | distinctSessions=${r.distinctSessions} | ${r.elapsedMs}ms`,
      );
    }
  }

  const allPassed = reports.every((r) => r.passed);
  return allPassed ? 0 : 1;
}
