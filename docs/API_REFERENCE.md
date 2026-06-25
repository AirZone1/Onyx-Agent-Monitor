# Onyx Agent Monitor — API Reference

## Base URL
```
http://localhost:3847
```

## Endpoints

### Conversations

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| GET | `/api/conversations` | `?workspace=name` | List all conversations (optionally filtered by workspace) |
| GET | `/api/conversations/:id` | — | Get conversation details |
| GET | `/api/conversations/:id/messages` | — | Get messages for a conversation |

### Workspaces

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| GET | `/api/workspaces` | — | List workspaces with conv count, active status, and color |

### Agent Status

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| GET | `/api/agent/status` | — | Current agent status (idle/active) |
| GET | `/api/agent/active-conversation` | `?workspace=name` | Get active conversation (optionally scoped to workspace) |

### CDP Actions (requires connected IDE)

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/cdp/accept` | — | Accept pending tool call |
| POST | `/api/cdp/reject` | — | Reject pending tool call |
| POST | `/api/cdp/stop` | — | Stop running agent |
| POST | `/api/cdp/send` | `{ message: string }` | Send message to agent |

### WebSocket

| Path | Description |
|------|-------------|
| `ws://localhost:3847` | Real-time updates (new messages, status changes) |

## Data Shapes

### Workspace Object
```json
{
  "name": "ortho-app",
  "label": "OrthoTest",
  "color": "#4FC3F7",
  "conversationCount": 5,
  "isActive": true
}
```

### Conversation Object
```json
{
  "id": "uuid-string",
  "title": "Conversation Title",
  "workspace": "ortho-app",
  "workspaceLabel": "OrthoTest",
  "workspaceColor": "#4FC3F7",
  "lastModified": "2026-06-25T17:00:00Z",
  "isActive": false,
  "messageCount": 42
}
```

## File Structure
```
E:\OneDrive\onyx-monitor\
├── server.js          # Express API server + CDP bridge
├── index.html         # Full PWA frontend (self-contained)
├── start.bat          # Launcher with Cloudflare Tunnel menu
├── manifest.json      # PWA manifest
├── sw.js              # Service worker
├── icon-192.png       # PWA icon
├── icon-512.png       # PWA icon
├── inspect-picker.js  # CDP element picker helper
├── .agent/workflows/agent-memory.md
└── docs/API_REFERENCE.md
```
