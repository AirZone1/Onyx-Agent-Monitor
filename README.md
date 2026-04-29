# Onyx Agent Monitor

A mobile-first PWA for monitoring and interacting with AI coding agent sessions (Antigravity IDE) from your phone. Real-time chat, tool call visibility, and conversation management via Cloudflare Tunnel.

## Features

- **Real-time chat** — Send messages and see agent responses live
- **Tool call transparency** — View file edits, terminal commands, browser actions, and search results inline
- **Conversation switching** — Browse and switch between active agent conversations
- **Cloudflare Tunnel** — Secure HTTPS access from any device without port forwarding
- **PWA support** — Install as a native-feeling app on iOS/Android
- **Hebrew RTL** — Full BiDi support with Assistant font for Hebrew legibility
- **Auto-sync** — Polls IDE metadata for live session state

## Architecture

```
mobile-monitor/
├── server.js          # Express server (IDE scraping, chat relay, tunnel management)
├── index.html         # Full PWA single-page app (76KB)
├── inspect-picker.js  # DOM inspection utility
├── start.bat          # Windows launcher with tunnel auto-start
├── manifest.json      # PWA manifest
├── sw.js              # Service worker
├── icon-*.png         # App icons
├── vscode-ext/        # VS Code extension for IDE integration
└── uploads/           # Shared media
```

## Quick Start

```bash
npm install express node-fetch
node server.js
# Local: http://localhost:3200
# Remote: via Cloudflare Tunnel (auto-started by start.bat)
```

## How It Works

1. **Server** scrapes the Antigravity IDE's local state (conversation logs, tool outputs, file edits)
2. **Frontend** renders a mobile-optimized chat interface with tool call cards
3. **Tunnel** provides secure external access via `cloudflared`
4. **User** can send messages back to the agent from their phone

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/conversations` | List active conversations |
| `GET` | `/api/chat/:conversationId` | Get chat messages |
| `POST` | `/api/chat/:conversationId` | Send message to agent |
| `GET` | `/api/status` | Server/tunnel health check |

## License

Creative Commons Attribution 4.0 International (CC BY 4.0)
