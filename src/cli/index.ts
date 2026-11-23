#!/usr/bin/env node
import { runCheckCommand } from "./check.js";
import { runDelegateCommand, runVerifyM2Command } from "./delegate.js";
import { runServeCommand } from "./serve.js";

function printHelp(): void {
  console.log(`council - Lead-directed coding agent team CLI

Usage:
  council check [options]       Discover and test Codex, Claude Code, and Antigravity CLIs
  council delegate [options]    Run a lead-directed delegation or roundtable conversation
  council verify-m2 [options]   Run Milestone 2 acceptance checks (cross-provider + same-CLI isolation)
  council serve [options]       Start the local HTTP + SSE service and chat UI
  council --help                Show this help

Run "council <command> --help" for command-specific options.`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    process.exitCode = 0;
    return;
  }

  if (command === "check") {
    process.exitCode = await runCheckCommand(rest);
    return;
  }

  if (command === "delegate") {
    process.exitCode = await runDelegateCommand(rest);
    return;
  }

  if (command === "verify-m2") {
    process.exitCode = await runVerifyM2Command(rest);
    return;
  }

  if (command === "serve") {
    process.exitCode = await runServeCommand(rest);
    return;
  }

  console.error(`Unknown command "${command}". Run "council --help" for usage.`);
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
