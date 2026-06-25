# Agent Memory — Onyx Agent Monitor

## Project Overview
- **Repo**: `E:\OneDrive\onyx-monitor` (relocated from `C:\temp\onyx-monitor-repo`)
- **Remote**: `AirZone1/Onyx-Agent-Monitor` on GitHub
- **Purpose**: Mobile-friendly web dashboard to monitor Antigravity IDE agent conversations, with CDP-based interaction (Accept/Reject/Stop/Send)
- **Stack**: Node.js server (`server.js`) + single-file frontend (`index.html`) — no build step
- **Port**: 3847 (default)
- **Launch**: `node server.js` or `start.bat` (includes Cloudflare Tunnel menu)

## Architecture
- `server.js` — Express-based API server (~85KB)
  - Scans `~/.gemini/antigravity-ide/brain/` for conversation transcripts
  - Exposes REST API for conversations, messages, agent status
  - Optional CDP (Chrome DevTools Protocol) bridge for remote IDE control
  - WebSocket support for real-time updates
- `index.html` — Full PWA frontend (~80KB, self-contained)
  - All CSS/JS inline
  - Installable via `manifest.json` + `sw.js`
  - Responsive mobile-first design

## Key Features (as of commit e6f682f)

### Multi-Workspace Support (Phase 2 — completed 2026-06-25)
- `detectWorkspace(convId)` — parses transcript tool-call file paths to identify workspace
- `WORKSPACE_LABELS` — maps dir names → friendly labels (ortho-app → OrthoTest, worklist → Worklist, etc.)
- `WORKSPACE_COLORS` — consistent color palette for badges
- `_activePerWorkspace` — per-workspace active conversation tracking
- **API endpoints**:
  - `GET /api/workspaces` — workspace list with conv count, activity, color
  - `GET /api/conversations?workspace=X` — filter by workspace
  - `GET /api/agent/active-conversation?workspace=X` — active conv for workspace
- **Frontend**:
  - Horizontal scrollable workspace tab bar (colored pills)
  - Workspace badge on conversation cards (in "All" view)
  - Green pulsing indicator for active workspaces
  - Filter persisted in `localStorage`

### CDP Remote Control
- Accept/Reject pending tool calls
- Stop running agents
- Send messages to agent
- Requires `--remote-debugging-port` on Antigravity IDE

## Phase 3 — Future (Optional)
- Per-workspace CDP routing: route Accept/Reject/Stop/Send to correct IDE window based on selected workspace
- Depends on Antigravity exposing `--remote-debugging-port` per window

## Important Patterns
- Single-file frontend: ALL styles and scripts are inline in `index.html`
- No npm dependencies for the frontend
- Server uses: express, ws, cors, open, puppeteer-core (optional for CDP)
- Conversation data comes from Antigravity's local brain directory structure

## Recent History
| Date       | Commit    | Summary |
|------------|-----------|---------|
| 2026-06-25 | e6f682f   | feat: multi-workspace support + relocated to OneDrive |
