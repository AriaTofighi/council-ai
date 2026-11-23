import { execFile } from "node:child_process";

export type FolderPickResult =
  | { status: "picked"; path: string }
  | { status: "cancelled" }
  | { status: "unsupported"; reason: string };

interface PickerCommand {
  cmd: string;
  args: string[];
  /** Exit codes that mean "user closed the dialog". */
  cancelCodes: number[];
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function pickerCommands(prompt: string, startDir?: string): PickerCommand[] {
  switch (process.platform) {
    case "darwin": {
      const location = startDir
        ? ` default location (POSIX file "${escapeAppleScript(startDir)}")`
        : "";
      // `activate` brings the dialog to the front instead of behind the browser.
      const script = [
        "tell application \"System Events\" to activate",
        `set chosen to choose folder with prompt "${escapeAppleScript(prompt)}"${location}`,
        "POSIX path of chosen",
      ].join("\n");
      // osascript exits 1 with "User canceled. (-128)" on cancel.
      return [{ cmd: "osascript", args: ["-e", script], cancelCodes: [1] }];
    }
    case "win32": {
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
        `$d.Description = '${prompt.replace(/'/g, "''")}'`,
        startDir ? `$d.SelectedPath = '${startDir.replace(/'/g, "''")}'` : "",
        "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath } else { exit 1 }",
      ]
        .filter(Boolean)
        .join("; ");
      return [
        { cmd: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", ps], cancelCodes: [1] },
      ];
    }
    default: {
      const start = startDir ? `${startDir.replace(/\/?$/, "/")}` : "";
      return [
        {
          cmd: "zenity",
          args: ["--file-selection", "--directory", `--title=${prompt}`, ...(start ? [`--filename=${start}`] : [])],
          cancelCodes: [1],
        },
        {
          cmd: "kdialog",
          args: ["--getexistingdirectory", start || ".", "--title", prompt],
          cancelCodes: [1],
        },
      ];
    }
  }
}

function run(command: PickerCommand): Promise<FolderPickResult | "missing"> {
  return new Promise((resolve) => {
    execFile(command.cmd, command.args, { timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return resolve("missing");
        const exit = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null;
        if (exit !== null && command.cancelCodes.includes(exit)) return resolve({ status: "cancelled" });
        return resolve({
          status: "unsupported",
          reason: (stderr || err.message).toString().trim() || "Folder picker failed",
        });
      }
      const picked = stdout.toString().trim();
      if (!picked) return resolve({ status: "cancelled" });
      // macOS returns a trailing slash; keep "/" itself intact.
      resolve({ status: "picked", path: picked.length > 1 ? picked.replace(/[\\/]+$/, "") : picked });
    });
  });
}

/** Opens the operating system's native folder chooser on the machine running the server. */
export async function pickFolder(options: { prompt?: string; startDir?: string } = {}): Promise<FolderPickResult> {
  const prompt = options.prompt ?? "Choose a repository folder";
  for (const command of pickerCommands(prompt, options.startDir)) {
    const result = await run(command);
    if (result !== "missing") return result;
  }
  return {
    status: "unsupported",
    reason: "No native folder picker is available on this system (install zenity or kdialog).",
  };
}
