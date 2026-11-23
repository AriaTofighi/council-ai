import { spawn, type ChildProcess } from "node:child_process";

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

export interface RunCliProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  processKey?: string;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: NodeJS.ErrnoException;
  elapsedMs: number;
}

export class ActiveProcessTracker {
  private readonly processes = new Map<string, Set<ChildProcess>>();

  register(key: string, child: ChildProcess): () => void {
    let set = this.processes.get(key);
    if (!set) {
      set = new Set<ChildProcess>();
      this.processes.set(key, set);
    }
    set.add(child);
    return () => {
      const current = this.processes.get(key);
      if (!current) return;
      current.delete(child);
      if (current.size === 0) {
        this.processes.delete(key);
      }
    };
  }

  cancel(key: string): boolean {
    const set = this.processes.get(key);
    if (!set || set.size === 0) return false;
    let killedAny = false;
    for (const child of set) {
      killedAny = terminateChild(child) || killedAny;
    }
    return killedAny;
  }
}

function terminateChild(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null) {
    return false;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    return false;
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore if already exited
      }
    }
  }, KILL_GRACE_MS);
  timer.unref();
  return true;
}

function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_BUFFER_BYTES) return current;
  const remaining = MAX_BUFFER_BYTES - current.length;
  return chunk.length <= remaining ? current + chunk : current + chunk.slice(0, remaining);
}

export function runCliProcess(
  options: RunCliProcessOptions,
  tracker?: ActiveProcessTracker,
): Promise<ProcessResult> {
  const startTime = Date.now();

  if (options.signal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: true,
      elapsedMs: 0,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let stdout = "";
    let stderr = "";
    let stdoutRemainder = "";
    let stderrRemainder = "";
    let spawnError: NodeJS.ErrnoException | undefined;

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const unregister =
      tracker && options.processKey
        ? tracker.register(options.processKey, child)
        : () => {};

    let timeoutTimer: NodeJS.Timeout | undefined;

    const onAbort = () => {
      cancelled = true;
      terminateChild(child);
    };

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      unregister();
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (stdoutRemainder.length > 0 && options.onStdoutLine) {
        options.onStdoutLine(stdoutRemainder);
      }
      if (stderrRemainder.length > 0 && options.onStderrLine) {
        options.onStderrLine(stderrRemainder);
      }

      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        cancelled,
        spawnError,
        elapsedMs: Date.now() - startTime,
      });
    };

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateChild(child);
      }, options.timeoutMs);
      timeoutTimer.unref();
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
      if (options.onStdoutLine) {
        const combined = stdoutRemainder + chunk;
        const lines = combined.split(/\r?\n/);
        stdoutRemainder = lines.pop() ?? "";
        for (const line of lines) {
          options.onStdoutLine(line);
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
      if (options.onStderrLine) {
        const combined = stderrRemainder + chunk;
        const lines = combined.split(/\r?\n/);
        stderrRemainder = lines.pop() ?? "";
        for (const line of lines) {
          options.onStderrLine(line);
        }
      }
    });

    child.stdin.on("error", () => {
      // Ignore EPIPE when child exits before consuming stdin
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnError = err;
      finish(null, null);
    });

    child.on("close", (code, signal) => {
      finish(code, signal);
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}
