import path from "node:path";
import { updateProviderClis } from "../providers/updater.js";
import { createCouncilServer } from "../server/server.js";
import {
  getBooleanFlag,
  getExecutableOverrides,
  getNumberFlag,
  getStringFlag,
  parseArgv,
} from "./args.js";

export async function runServeCommand(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (getBooleanFlag(parsed, "help")) {
    console.log(`Usage: council serve [options]

Starts the local Council HTTP + SSE service and serves the web UI (if built in web/dist).

Options:
  --port <n>             Port to listen on (default: 4173)
  --host <addr>          Bind address (default: 127.0.0.1)
  --db <path>            SQLite database file (default: .council/council.sqlite)
  --static-dir <dir>     Frontend build directory (default: web/dist)
  --codex-path <path>    Override codex executable path
  --claude-path <path>   Override claude executable path
  --agy-path <path>      Override agy executable path
  --no-update-clis       Don't update the claude, codex and agy CLIs on startup
                         (also: COUNCIL_SKIP_CLI_UPDATE=1)`);
    return 0;
  }

  const port = getNumberFlag(parsed, "port") ?? 4173;
  const host = getStringFlag(parsed, "host") ?? "127.0.0.1";
  const dbPath = getStringFlag(parsed, "db") ?? path.resolve(".council", "council.sqlite");
  const staticDir = getStringFlag(parsed, "static-dir") ?? path.resolve("web", "dist");
  const executableOverrides = getExecutableOverrides(parsed);

  const instance = createCouncilServer({
    dbPath,
    port,
    host,
    staticDir,
    executableOverrides,
  });

  const bound = await instance.start();
  console.log(`Council local service listening at ${bound.url}`);
  console.log(`SQLite storage: ${dbPath}`);

  // Keep the agent CLIs current so new models and thinking levels show up in the UI.
  const skipUpdates =
    getBooleanFlag(parsed, "no-update-clis") || /^(1|true|yes)$/i.test(process.env.COUNCIL_SKIP_CLI_UPDATE ?? "");
  if (!skipUpdates) {
    void updateProviderClis({ executableOverrides });
  }

  const shutdown = async () => {
    console.log("\nShutting down Council server...");
    await instance.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise(() => {
    // Keep server alive until SIGINT/SIGTERM
  });
  return 0;
}
