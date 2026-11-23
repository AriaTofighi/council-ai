# council-ai

Local lead-directed coding agent team orchestrating **Codex**, **Claude Code**, and **Antigravity (`agy`)** CLI sessions.

## Capabilities (v1 — Milestones 1–6)
- **CLI Connection & Diagnostics (`council check`):** Discovers `codex`, `claude`, and `agy`, verifies live execution, captures session IDs & usage/cost, and classifies `missing_executable`, `login_required`, `timeout`, `cancelled`, `malformed_output`, and `execution_error`.
- **Two Modes (`council delegate` & Web UI):**
  - **Divide & Conquer:** Lead decomposes work into parallel independent assignments, launches dependent work after prerequisites return, and checks conflicts via targeted `follow_up`.
  - **Roundtable:** Lead picks who opens (or collects blind **Independent first opinions** in parallel), passes attributed discussion in order, supports targeted author replies back into the shared discussion, and synthesizes recommendations, per-agent contributions, and open disagreements.
- **Per-Turn Switching & Context Continuity:** Switch `Lead`, `Team` (including a second isolated session of the lead CLI), `Mode`, **Model**, and **Thinking/Effort** level on any turn in the same chat; explicit user decisions stay attributed and original contributions remain retrievable verbatim (`retrieve_contribution`).
- **Persistence & Recovery (`node:sqlite`):** Saves chats, snapshots, participant identities, pre-dispatch assignments, contributions, and SSE run events in SQLite; recovers interrupted runs on restart and supports single-assignment retry reusing completed work.
- **Read-Only Repository Snapshots:** Creates immutable (`0o444`/`0o555`) snapshots of selected local git/workspace files so all participants analyze the exact same revision, while displaying which providers receive the material and their effective read-only permissions.
- **Local Web Chat UI (`council serve`):** React + SSE workbench on `http://127.0.0.1:4173` with Lead/Team/Mode/Model/Effort controls, a Low-Usage preset for testing, live status, Stop button, clickable citations, and expandable discussion drawer.

## Quick Start

```bash
npm install
npm --prefix web install
npm run build:all
npm test

# Start local service + chat UI at http://127.0.0.1:4173
npm run serve

# CLI checks & runs
npm run dev:check
npm run dev:delegate -- --lead claude --team codex,agy --mode roundtable --workspace . --lead-model sonnet --lead-effort low --team-effort low
npm run dev:verify-m2
```

## Executable Path Overrides
Override CLI locations via `--codex-path`, `--claude-path`, `--agy-path`, or environment variables (`COUNCIL_CODEX_PATH`, `COUNCIL_CLAUDE_PATH`, `COUNCIL_AGY_PATH`).
