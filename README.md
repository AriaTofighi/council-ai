# council-ai

A local web app that gets **Claude Code**, **Codex**, and **Antigravity (`agy`)** to work on a question together, using the subscriptions you already pay for. One agent leads: it splits the work between teammates (or runs a roundtable discussion), reads their replies, and writes a final answer with citations back to who said what.

Everything runs on your machine. Council drives the official CLIs you have installed and signed in to. It never sees your passwords or API keys, and each run's quota comes out of your own plans.

## What you need

- **macOS or Linux.** On Windows, use WSL. Codex itself recommends WSL on Windows.
- **Node.js 22.13 or newer.** Council stores chats with the built-in `node:sqlite`. It's developed on Node 24.
- **At least one of the three agent CLIs, installed and signed in.** Two or more is where it gets useful; any combination works.

| Agent | Subscription | Install | Sign in |
|---|---|---|---|
| Claude Code (`claude`) | Claude Pro, Max, Team or Enterprise | `curl -fsSL https://claude.ai/install.sh \| bash` ([docs](https://docs.claude.com/en/docs/claude-code/setup)) | Run `claude` once and follow the login prompt |
| Codex (`codex`) | ChatGPT Plus, Pro, Business, Edu or Enterprise | `npm i -g @openai/codex` ([docs](https://developers.openai.com/codex/cli/)) | Run `codex` once and choose **Sign in with ChatGPT** |
| Antigravity (`agy`) | A Google account (AI Pro or Ultra for higher limits) | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` ([docs](https://antigravity.google/docs/cli/install)) | Run `agy` once and finish the Google sign-in |

Sign in with your **subscription**, not an API key, if you want Council's usage meters (5-hour and weekly limits). API-key logins still work for running agents, but they have no plan quota to show.

If you have the Codex app or ChatGPT desktop app, Council also finds the `codex` bundled inside it, so a separate install isn't needed.

## Set up

```bash
git clone https://github.com/AriaTofighi/council-ai.git
cd council-ai
npm install
npm --prefix web install
npm run build:all
```

Check that Council can find and reach your agents. This sends each CLI a tiny test prompt:

```bash
npm run council -- check --allow-partial
```

You should see `ok` for each CLI you've signed in to. `missing_executable` means it isn't installed or isn't on your `PATH`. `login_required` means you still need to sign in.

## Run it

```bash
npm run serve
```

Open **http://127.0.0.1:4173**. On first launch Council builds a team from whichever CLIs it finds: the first of Claude, Codex and agy leads, and the rest join as teammates. Then:

1. **Pick a repository** (folder icon in the message box, or **Projects → +** in the sidebar). Agents get a read-only snapshot of it and can't change your files.
2. **Choose Roundtable or Divide**, and adjust the team, models and thinking levels (the team button in the message box).
3. Ask your question. Each agent's progress shows live; open **Agents & usage** (click an agent name at the bottom of the sidebar) to see CLI versions, test each one, and watch your 5-hour and weekly limits.

Your chats and saved projects are stored locally in `.council/council.sqlite`, which git ignores.

### Useful options

```bash
npm run serve -- --port 8080            # different port
npm run serve -- --no-update-clis       # don't run each CLI's self-update on startup
```

By default Council runs `claude update`, `codex update` and `agy update` in the background when it starts, so new models and thinking levels show up. A CLI bundled inside a desktop app is left for that app to update.

If a CLI lives somewhere unusual, point Council at it with `--claude-path`, `--codex-path` and `--agy-path`, or with the `COUNCIL_CLAUDE_PATH`, `COUNCIL_CODEX_PATH` and `COUNCIL_AGY_PATH` environment variables.

### Limits and cost

Every run spends quota from your own subscriptions, and a roundtable with three strong models uses a lot. In the **Limits** menu (sliders icon in the message box) you can cap lead calls, total calls, per-call timeout and an overall deadline. Leave any of them empty for no limit. **Low-usage preset** in the team panel switches everyone to fast, cheap models, which is handy for trying things out.

## How it works

- **Divide & Conquer:** the lead splits the work into parallel assignments, follows up with specific agents, and combines the results.
- **Roundtable:** the lead picks who opens (or collects blind first opinions from everyone in parallel), passes the discussion around in order, and summarizes agreements and open disagreements.
- **Read-only snapshots:** each run works on an immutable copy of the files you selected, so every agent sees the same revision. Each CLI is started in its own read-only or sandboxed mode.
- **Per-turn switching:** change lead, team, mode, model or thinking level on any turn of the same chat. Earlier contributions stay attributed and can be re-read word for word.
- **Recovery:** if the server restarts mid-run, the run is marked interrupted, and you can retry a single agent's assignment without redoing the rest.

There's also a command-line version: `npm run council -- delegate --help`.

## Developing

```bash
npm run dev:serve   # API server; restarts itself when server code changes (port 4173)
npm run dev:web     # UI with hot reload (Vite proxies /api to port 4173)
npm test            # runs the compiled tests, so run npm run build first
```

Set `COUNCIL_API_URL` if your API server isn't on `http://127.0.0.1:4173`.

## License

MIT — see [LICENSE](LICENSE).
