/**
 * Mobile Agent Monitor Ã¢â‚¬â€ lightweight server
 * Run: node tools/mobile-monitor/server.js
 * Then open http://<your-local-ip>:3847 on your phone
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3847;
const CDP_PORTS_TO_TRY = [9000, 9001, 9222]; // Common debugging ports

// Workspace display names (directory name -> friendly label)
const WORKSPACE_LABELS = {
  'ortho-app': 'OrthoTest',
  'worklist': 'Worklist',
  'nanopdf-rs': 'NanoPDF',
  'onyx-monitor': 'OnyxMonitor',
  'miunex': 'Miunex',
  'bhelper': 'BHelper',
  'OrthoDoc': 'OrthoDoc',
  'bokertovv': 'BokerTov',
  'game': 'Game',
};

// Workspace color palette (consistent badge colors)
const WORKSPACE_COLORS = [
  '#6c5ce7', '#00b894', '#e17055', '#74b9ff', '#fdcb6e',
  '#a29bfe', '#55efc4', '#fab1a0', '#81ecec', '#ffeaa7',
];

// CDP WebSocket connection for injecting messages
let cdpWs = null;
let cdpIdCounter = 1;
let cdpContextId = null;

function cdpCall(method, params) {
  return new Promise((resolve, reject) => {
    if (!cdpWs || cdpWs.readyState !== 1) return reject(new Error('CDP not connected'));
    const id = cdpIdCounter++;
    const handler = (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.id === id) {
          cdpWs.removeListener('message', handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      } catch {}
    };
    cdpWs.on('message', handler);
    cdpWs.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { cdpWs.removeListener('message', handler); reject(new Error('CDP timeout')); }, 5000);
  });
}

function tryPort(port) {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

async function discoverCDPPort() {
  // Try common ports first
  for (const port of CDP_PORTS_TO_TRY) {
    const targets = await tryPort(port);
    if (targets && targets.length > 0) return { port, targets };
  }
  
  // Auto-discover: find Antigravity process listening ports
  try {
    const { execSync } = require('child_process');
    // Find Antigravity main process using PowerShell (wmic is deprecated and spams errors)
    const procs = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*Antigravity*\' -and $_.CommandLine -like \'*remote-debugging-port*\' } | Select-Object -ExpandProperty ProcessId"', { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    const pids = procs.split('\n').map(l => l.trim()).filter(p => /^\d+$/.test(p));
    
    for (const pid of pids) {
      // Get listening ports for this process
      const netstat = execSync(`netstat -ano | findstr "${pid}" | findstr "LISTENING"`, { encoding: 'utf8', timeout: 3000 });
      const ports = netstat.split('\n')
        .map(l => l.match(/:(\d+)\s+.*LISTENING/))
        .filter(Boolean)
        .map(m => parseInt(m[1]))
        .filter(p => p > 1024 && p < 65535);
      
      for (const port of ports) {
        const targets = await tryPort(port);
        if (targets && targets.length > 0) {
          console.log(`  ✅ CDP: Auto-discovered on port ${port}`);
          return { port, targets };
        }
      }
    }
  } catch {}
  
  return null;
}

async function connectCDP() {
  try {
    const discovered = await discoverCDPPort();
    if (!discovered) { console.log('  âš ï¸ CDP: No debugging port found'); return false; }
    
    const { targets: targetsJson, port: cdpPort } = discovered;
    const target = targetsJson.find(t => t.url?.includes('workbench.html') || t.title?.includes('workbench'));
    if (!target) { console.log('  Ã¢Å¡Â Ã¯Â¸Â CDP: No workbench target found'); return false; }
    
    // Connect WebSocket
    const WebSocket = require('ws');
    if (cdpWs) try { cdpWs.close(); } catch {}
    
    cdpWs = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      cdpWs.on('open', resolve);
      cdpWs.on('error', reject);
    });
    
    // Track execution contexts
    const contexts = [];
    cdpWs.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.method === 'Runtime.executionContextCreated') {
          contexts.push(data.params.context);
        }
      } catch {}
    });
    
    await cdpCall('Runtime.enable', {});
    await new Promise(r => setTimeout(r, 500));
    
    // Find the context with the chat editor
    const FIND_SCRIPT = `(() => {
      const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
      return { found: !!editor, tag: editor?.tagName };
    })()`;
    
    for (const ctx of contexts) {
      try {
        const result = await cdpCall('Runtime.evaluate', { expression: FIND_SCRIPT, returnByValue: true, contextId: ctx.id });
        if (result.result?.value?.found) {
          cdpContextId = ctx.id;
          console.log(`  Ã¢Å“â€¦ CDP connected, context ${ctx.id}, editor: ${result.result.value.tag}`);
          return true;
        }
      } catch {}
    }
    
    console.log('  Ã¢Å¡Â Ã¯Â¸Â CDP: Connected but no chat editor found');
    return false;
  } catch (err) {
    console.log(`  Ã¢Å¡Â Ã¯Â¸Â CDP connect failed: ${err.message}`);
    return false;
  }
}

async function cdpInjectMessage(text) {
  if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) {
    const ok = await connectCDP();
    if (!ok) return { ok: false, reason: 'CDP not connected' };
  }
  
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const SCRIPT = `(async () => {
    const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
    if (!editor) return { ok: false, reason: "no editor found" };
    
    editor.focus();
    
    if (editor.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(editor, "${escaped}");
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, "${escaped}");
    }
    
    await new Promise(r => setTimeout(r, 200));
    
    // Try submit button selectors
    const btn = document.querySelector('button[class*="arrow"]') || 
               document.querySelector('button[aria-label*="Send"]') ||
               document.querySelector('button[aria-label*="submit"]') ||
               document.querySelector('button[type="submit"]');
    
    if (btn) {
      btn.click();
    } else {
      // Fallback: Enter key
      editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13 }));
    }
    return { ok: true };
  })()`;
  
  try {
    const res = await cdpCall('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, awaitPromise: true, contextId: cdpContextId });
    return res.result?.value || { ok: false };
  } catch (e) {
    cdpContextId = null; // Reset for retry
    return { ok: false, reason: e.message };
  }
}

// Click a button in the workbench DOM by visible label.
// Uses the same simple pattern as the proven autorun script:
// [...document.querySelectorAll('button')].find(b => b.textContent.trim().includes(needle))
// Retries up to maxAttempts because the Accept/Reject row is rendered async.
async function cdpClickButton(needle, maxAttempts = 8, intervalMs = 200) {
  if (!cdpWs || cdpWs.readyState !== 1) {
    const ok = await connectCDP();
    if (!ok) return { ok: false, reason: 'CDP not connected' };
  }

  const escaped = needle.replace(/'/g, "\\'");
  // Antigravity's chat panel uses styled <span class="cursor-pointer">
  // for action buttons (Accept all / Reject all). Native <button> only
  // covers the workbench chrome. Search both.
  const SCRIPT = `(() => {
    const needle = '${escaped}';
    const candidates = [...document.querySelectorAll('button, span.cursor-pointer, [role="button"], a[role="button"]')];
    const exact = candidates.find(b => b.textContent.trim() === needle);
    const startsWith = candidates.find(b => b.textContent.trim().startsWith(needle));
    const contains = candidates.find(b => b.textContent.trim().includes(needle));
    const btn = exact || startsWith || contains;
    if (!btn) return { ok: false, total: candidates.length };
    btn.click();
    return { ok: true, label: btn.textContent.trim().slice(0, 60), tag: btn.tagName, match: exact ? 'exact' : (startsWith ? 'startsWith' : 'contains') };
  })()`;

  // Collect all currently-known execution contexts. Re-enabling Runtime
  // re-emits executionContextCreated for every existing context.
  const contexts = new Map();
  const collector = (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.method === 'Runtime.executionContextCreated') {
        contexts.set(data.params.context.id, data.params.context);
      }
    } catch {}
  };
  cdpWs.on('message', collector);
  await cdpCall('Runtime.enable', {});
  await new Promise(r => setTimeout(r, 250));
  cdpWs.removeListener('message', collector);

  // Order: cached primary context first, then the rest sorted by id
  const ctxIds = [];
  if (cdpContextId && contexts.has(cdpContextId)) ctxIds.push(cdpContextId);
  for (const id of contexts.keys()) if (id !== cdpContextId) ctxIds.push(id);
  if (ctxIds.length === 0 && cdpContextId) ctxIds.push(cdpContextId);

  let bestNoMatch = { ok: false, total: 0 };
  for (let i = 0; i < maxAttempts; i++) {
    for (const ctxId of ctxIds) {
      try {
        const res = await cdpCall('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: ctxId });
        const v = res.result?.value;
        if (v?.ok) return { ...v, attempts: i + 1, ctx: ctxId };
        if (v && (v.total || 0) > (bestNoMatch.total || 0)) bestNoMatch = { ...v, ctx: ctxId };
      } catch {}
    }
    if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  return { ...bestNoMatch, attempts: maxAttempts, contextsTried: ctxIds.length, reason: 'button not found after retries' };
}

// Execute a VS Code command via CDP keyboard simulation (F1 + type + Enter)
async function executeVSCodeCommand(commandId) {
  if (!cdpWs || cdpWs.readyState !== 1) await connectCDP();
  
  // Press F1 to open command palette
  await cdpCall('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F1', code: 'F1', windowsVirtualKeyCode: 112, nativeVirtualKeyCode: 112 });
  await cdpCall('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F1', code: 'F1', windowsVirtualKeyCode: 112, nativeVirtualKeyCode: 112 });
  
  await new Promise(r => setTimeout(r, 400));
  
  // Type the command
  for (const char of commandId) {
    await cdpCall('Input.dispatchKeyEvent', { type: 'char', text: char });
  }
  
  await new Promise(r => setTimeout(r, 400));
  
  // Press Enter
  await cdpCall('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdpCall('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  
  // Press Escape to close palette if still open
  await new Promise(r => setTimeout(r, 200));
  await cdpCall('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdpCall('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  
  return { ok: true, command: commandId };
}

// Watch directory for conversation logs
const BRAIN_DIRS = [
  path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain'),
  path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
].filter(d => fs.existsSync(d));
const BRAIN_DIR = BRAIN_DIRS[0]; // Primary (newest)

// SSE clients
const sseClients = new Set();

// Tunnel state
let tunnelProcess = null;
let tunnelUrl = null;

// Approval queue
const approvalQueue = [];
let approvalIdCounter = 0;

// Chat system
const CHAT_FILE = path.join(__dirname, 'chat-messages.json');

function loadChat() {
  try {
    return JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
  } catch {
    return { messages: [], unread: 0 };
  }
}

function saveChat(data) {
  fs.writeFileSync(CHAT_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function addChatMessage(role, text) {
  const data = loadChat();
  const msg = {
    id: Date.now(),
    role, // 'user' (from phone) or 'agent' (from IDE agent)
    text,
    timestamp: new Date().toISOString(),
    read: role === 'user' ? false : true
  };
  data.messages.push(msg);
  if (role === 'user') data.unread++;
  saveChat(data);
  return msg;
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function extractUserRequest(content) {
  if (!content) return '';
  let text = content;
  const match = text.match(/<USER_REQUEST>\s*([\s\S]*?)<\/USER_REQUEST>/);
  if (match) text = match[1].trim();
  // Strip file:// URLs, @mentions, XML tags, markdown links
  text = text.replace(/file:\/\/\/[^\s)]+/g, '');
  text = text.replace(/@\[[^\]]*\]/g, '');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/^#+\s*/gm, '');
  text = text.trim();
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  return (lines[0] || text).substring(0, 200);
}

// Normalize a tool-call arg value: strip wrapping quotes and unescape backslashes
// (transcript stores args as JSON-encoded strings, e.g. '"e:\\\\OneDrive\\\\worklist\\\\..."')
function normalizeArgPath(val) {
  if (typeof val !== 'string') return '';
  let s = val;
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  s = s.replace(/\\\\/g, '\\');
  return s;
}

// Detect workspace from conversation transcript tool call paths
function detectWorkspace(convId) {
  if (global._workspaceCache && global._workspaceCache[convId]) return global._workspaceCache[convId];

  const wsRegex = /[eE]:[\\\\\/]+OneDrive[\\\\\/]+([^\\\\\/\"\s`]+)/;

  for (const brainDir of BRAIN_DIRS) {
    const basePath = path.join(brainDir, convId, '.system_generated', 'logs');
    const candidates = ['transcript.jsonl', 'transcript_full.jsonl'];
    
    for (const fname of candidates) {
      const transcriptPath = path.join(basePath, fname);
      try {
        if (!fs.existsSync(transcriptPath)) continue;
        const raw = fs.readFileSync(transcriptPath, 'utf8');
        const lines = raw.split('\n').filter(l => l.trim()).slice(0, 30);
        
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.tool_calls && entry.tool_calls.length > 0) {
              for (const tc of entry.tool_calls) {
                const args = tc.args || {};
                const rawPath = args.AbsolutePath || args.TargetFile || 
                                 args.SearchPath || args.Cwd || 
                                 args.DirectoryPath || '';
                const filePath = normalizeArgPath(rawPath);
                const wsMatch = filePath.match(wsRegex);
                if (wsMatch && wsMatch[1] && !wsMatch[1].startsWith('.')) {
                  if (!global._workspaceCache) global._workspaceCache = {};
                  global._workspaceCache[convId] = wsMatch[1];
                  return wsMatch[1];
                }
              }
            }
            if (entry.content) {
              const cm = entry.content.match(wsRegex);
              if (cm && cm[1] && cm[1].length > 2 && !cm[1].startsWith('.')) {
                if (!global._workspaceCache) global._workspaceCache = {};
                global._workspaceCache[convId] = cm[1];
                return cm[1];
              }
            }
          } catch {}
        }
      } catch {}
    }
  }
  return null;
}

function getWorkspaceLabel(ws) {
  if (!ws) return 'Other';
  return WORKSPACE_LABELS[ws] || ws;
}

function getWorkspaceColor(ws) {
  if (!ws) return WORKSPACE_COLORS[WORKSPACE_COLORS.length - 1];
  const knownKeys = Object.keys(WORKSPACE_LABELS);
  const idx = knownKeys.indexOf(ws);
  if (idx >= 0) return WORKSPACE_COLORS[idx % WORKSPACE_COLORS.length];
  let hash = 0;
  for (let i = 0; i < ws.length; i++) hash = (hash * 31 + ws.charCodeAt(i)) & 0x7fffffff;
  return WORKSPACE_COLORS[hash % WORKSPACE_COLORS.length];
}

function getConversations() {
  try {
    const allDirs = [];
    for (const brainDir of BRAIN_DIRS) {
      try {
        const entries = fs.readdirSync(brainDir, { withFileTypes: true }).filter(d => d.isDirectory());
        for (const d of entries) allDirs.push({ name: d.name, brainDir });
      } catch {}
    }
    const seen = new Set();
    const uniqueDirs = [];
    for (const d of allDirs) {
      if (!seen.has(d.name)) { seen.add(d.name); uniqueDirs.push(d); }
    }

    const results = uniqueDirs.map(d => {
      const logsDir = path.join(d.brainDir, d.name, '.system_generated', 'logs');
      const artifactDir = path.join(d.brainDir, d.name);
      let lastMod = 0, preview = '', title = '';

      const logCandidates = ['overview.txt', 'transcript.jsonl', 'transcript_full.jsonl'];
      for (const fname of logCandidates) {
        if (preview) break;
        const fp = path.join(logsDir, fname);
        try {
          if (!fs.existsSync(fp)) continue;
          const stat = fs.statSync(fp);
          if (!lastMod || stat.mtimeMs > lastMod) lastMod = stat.mtimeMs;
          const raw = fs.readFileSync(fp, 'utf8');
          const lines = raw.split('\n').filter(l => l.trim()).slice(0, 30);
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (!preview && entry.type === 'USER_INPUT' && entry.content) {
                preview = extractUserRequest(entry.content);
              }
            } catch {}
          }
        } catch {}
      }

      title = preview ? preview.split('\n')[0].substring(0, 100) : '';
      const cachedTitle = (global._convTitleCache || {})[d.name];
      const workspace = detectWorkspace(d.name);
      return {
        id: d.name, lastMod, preview,
        title: cachedTitle || title,
        path: artifactDir, workspace,
        workspaceLabel: getWorkspaceLabel(workspace),
        workspaceColor: getWorkspaceColor(workspace),
      };
    })
    .sort((a, b) => b.lastMod - a.lastMod)
    .slice(0, 50);
    return results;
  } catch { return []; }
}

function parseLogLine(line, state = { currentModel: 'Agent' }) {
  try {
    const entry = JSON.parse(line);
    
    if (entry.content && entry.content.includes('<USER_SETTINGS_CHANGE>')) {
      const m = entry.content.match(/from .*? to (.*?)\. No need/);
      if (m) state.currentModel = m[1];
    }
    
    if (entry.type === 'USER_INPUT') {
      const content = extractUserRequest(entry.content || '');
      return `👤 USER:\n${content}\n`;
    }
    if (entry.source === 'MODEL') {
      let text = entry.content || '';
      let tools = '';
      if (entry.tool_calls && entry.tool_calls.length > 0) {
        tools = '\n  🔧 Tools: ' + entry.tool_calls.map(t => {
          let action = t.args?.toolAction?.replace(/"/g, '') || t.name;
          // Extract filename for file-related tools
          if (t.name === 'multi_replace_file_content' || t.name === 'replace_file_content' || t.name === 'write_to_file') {
            const file = (t.args?.TargetFile || '').split(/[\\/]/).pop().replace(/"/g, '');
            if (file) action += ` [${file}]`;
          } else if (t.name === 'view_file') {
            const file = (t.args?.AbsolutePath || '').split(/[\\/]/).pop().replace(/"/g, '');
            if (file) action += ` [${file}]`;
          } else if (t.name === 'grep_search') {
            const file = (t.args?.SearchPath || '').split(/[\\/]/).pop().replace(/"/g, '');
            if (file) action += ` [${file}]`;
          } else if (t.name === 'run_command') {
            const cmd = (t.args?.CommandLine || '').replace(/"/g, '').substring(0, 50);
            if (cmd) action += ` [${cmd}]`;
          }
          return action;
        }).join('\n  🔧 Tools: ');
      }
      return `🤖 AGENT|${state.currentModel}:\n${text}${tools}\n`;
    }
    return null;
  } catch {
    return null;
  }
}

function getConversationLog(convId) {
  for (const brainDir of BRAIN_DIRS) {
    const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
    const candidates = [
      path.join(logsDir, 'overview.txt'),
      path.join(logsDir, 'transcript.jsonl'),
      path.join(logsDir, 'transcript_full.jsonl'),
    ];
    for (const logPath of candidates) {
      try {
        if (!fs.existsSync(logPath)) continue;
        const raw = fs.readFileSync(logPath, 'utf8');
        const lines = raw.split('\n').filter(l => l.trim());
        let initialModel = 'Agent';
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.content && entry.content.includes('<USER_SETTINGS_CHANGE>')) {
              const m = entry.content.match(/from (.*?) to (.*?)\\. No need/);
              if (m && m[1] && m[1] !== 'None') { initialModel = m[1]; break; }
            }
          } catch {}
        }
        const state = { currentModel: initialModel };
        const parsed = lines.map(l => parseLogLine(l, state)).filter(Boolean);
        if (parsed.length > 0) return parsed.join('\n---\n\n');
      } catch {}
    }
  }
  return 'Log not found.';
}

function getArtifacts(convId) {
  for (const brainDir of BRAIN_DIRS) {
    const artDir = path.join(brainDir, convId);
    if (!fs.existsSync(artDir)) continue;
    const artifacts = [];
    try {
      const files = fs.readdirSync(artDir);
      for (const f of files) {
        if (f.startsWith('.')) continue;
        const ext = path.extname(f).toLowerCase();
        const fp = path.join(artDir, f);
        try {
          const stat = fs.statSync(fp);
          if (!stat.isFile()) continue;
          if (['.md', '.txt', '.json'].includes(ext) && stat.size < 500000) {
            const content = fs.readFileSync(fp, 'utf8');
            artifacts.push({ name: f, size: stat.size, modified: stat.mtimeMs, content: content.substring(0, 5000), type: 'text' });
          } else if (['.png', '.webp', '.jpg', '.jpeg'].includes(ext)) {
            artifacts.push({ name: f, size: stat.size, modified: stat.mtimeMs, content: `[Image: ${(stat.size/1024).toFixed(1)}KB]`, type: 'image' });
          }
        } catch {}
      }
      for (const sub of ['browser', 'scratch']) {
        const subDir = path.join(artDir, sub);
        if (!fs.existsSync(subDir)) continue;
        try {
          for (const sf of fs.readdirSync(subDir)) {
            if (sf.startsWith('.') || !sf.endsWith('.md')) continue;
            const fp = path.join(subDir, sf);
            const stat = fs.statSync(fp);
            if (stat.isFile() && stat.size > 0 && stat.size < 500000) {
              const content = fs.readFileSync(fp, 'utf8');
              artifacts.push({ name: `${sub}/${sf}`, size: stat.size, modified: stat.mtimeMs, content: content.substring(0, 5000), type: 'text' });
            }
          }
        } catch {}
      }
      artifacts.sort((a, b) => b.modified - a.modified);
      if (artifacts.length > 0) return artifacts;
    } catch {}
  }
  return [];
}

// File watcher for live updates
let watchers = new Map();
function watchConversation(convId) {
  if (watchers.has(convId)) return;
  const logDir = path.join(BRAIN_DIR, convId, '.system_generated', 'logs');
  try {
    const watcher = fs.watch(logDir, { recursive: false }, (event, filename) => {
      if (filename === 'overview.txt') {
        const data = JSON.stringify({ type: 'log_update', convId, timestamp: Date.now() });
        for (const client of sseClients) {
          client.write(`data: ${data}\n\n`);
        }
      }
    });
    watchers.set(convId, watcher);
  } catch {}
}

// Global watcher: track which conversation was most recently written to by Antigravity
let _lastActiveConvId = null;
let _lastActiveTime = 0;
let _activePerWorkspace = {};
function startGlobalBrainWatcher() {
  for (const brainDir of BRAIN_DIRS) {
    try {
      fs.watch(brainDir, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const parts = filename.split(path.sep);
        if (parts.length > 0 && global._workspaceCache) {
          delete global._workspaceCache[parts[0]];
        }
        const data = JSON.stringify({ type: 'brain_update', event, filename, timestamp: Date.now() });
        for (const client of sseClients) {
          client.write(`data: ${data}\n\n`);
        }
      });
    } catch {}
  }
  console.log('  Global brain watcher started');
}

function serveHTML(res) {
  const htmlPath = path.join(__dirname, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Routes
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveHTML(res);
  }
  
  if (url.pathname === '/api/server/stop' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    console.log('\nðŸ›‘ Server shutdown requested via UI. Shutting down...');
    setTimeout(() => process.exit(0), 1000);
    return;
  }

  if (url.pathname === '/api/server/restart' && req.method === 'POST') {
    console.log('\nðŸ”„ Server soft-restart requested via UI. Resetting state...');
    
    // Close CDP websocket
    if (cdpWs) { try { cdpWs.close(); } catch {} cdpWs = null; }
    cdpIdCounter = 1;
    cdpContextId = null;
    
    // Close all SSE clients
    sseClients.forEach(c => { try { c.end(); } catch {} });
    sseClients.clear();
    
    // Close file watchers
    watchers.forEach((w) => { try { w.close(); } catch {} });
    watchers.clear();
    
    // Clear approval queue
    approvalQueue.length = 0;
    
    console.log('✅ State reset complete. Reconnecting CDP...');
    // Reconnect CDP
    connectCDP();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Server state reset' }));
    return;
  }

  if (url.pathname === '/api/server/hard-restart' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    console.log('\nâš¡ Hard restart requested via UI. Restarting process...');
    const { spawn } = require('child_process');
    const cwd = process.cwd();
    const batLines = [
      '@echo off',
      'timeout /t 2 /nobreak >nul',
      `cd /d "${cwd}"`,
      'node server.js'
    ];
    const batPath = path.join(__dirname, '_restart.bat');
    fs.writeFileSync(batPath, batLines.join('\r\n') + '\r\n');
    const child = spawn('cmd.exe', ['/c', 'start', 'OnyxAM', '/D', cwd, 'cmd.exe', '/c', batPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    setTimeout(() => process.exit(0), 500);
    return;
  }

  // Static files (PWA assets, uploads)
  const STATIC_TYPES = { '.json': 'application/json', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const ext = path.extname(url.pathname).toLowerCase();
  if (STATIC_TYPES[ext] && !url.pathname.startsWith('/api/')) {
    const filePath = path.join(__dirname, url.pathname);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext] });
      return res.end(data);
    }
  }

  // Tunnel control
  if (url.pathname === '/api/tunnel/status' && req.method === 'GET') {
    // Check both our managed process and any external cloudflared
    if (tunnelProcess) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ running: true, url: tunnelUrl }));
    }
    // Check for externally started cloudflared
    const { execSync } = require('child_process');
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq cloudflared.exe" /NH', { encoding: 'utf8', timeout: 3000 });
      const running = out.includes('cloudflared');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ running, url: tunnelUrl }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ running: false, url: null }));
    }
  }

  if (url.pathname === '/api/tunnel/start' && req.method === 'POST') {
    if (tunnelProcess) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, url: tunnelUrl, message: 'Already running' }));
    }
    const cfPath = path.join(__dirname, 'cloudflared.exe');
    if (!fs.existsSync(cfPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'cloudflared.exe not found' }));
    }
    const { spawn } = require('child_process');
    tunnelProcess = spawn(cfPath, ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    tunnelUrl = null;
    tunnelProcess.stderr.on('data', (d) => {
      const line = d.toString();
      const urlMatch = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch) tunnelUrl = urlMatch[0];
    });
    tunnelProcess.on('close', () => { tunnelProcess = null; tunnelUrl = null; });
    // Wait for cloudflared to establish tunnel and provide URL
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: tunnelUrl }));
    }, 12000);
    return;
  }

  if (url.pathname === '/api/tunnel/stop' && req.method === 'POST') {
    if (tunnelProcess) {
      tunnelProcess.kill();
      tunnelProcess = null;
      tunnelUrl = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Debug: list all CDP targets (webviews, iframes, workbench)
  if (url.pathname === '/api/debug/cdp-targets') {
    try {
      const targets = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (r) => {
          let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
        }).on('error', reject);
      });
      const summary = targets.map(t => ({ type: t.type, title: t.title?.slice(0, 80), url: t.url?.slice(0, 120), id: t.id }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ count: targets.length, targets: summary }, null, 2));
    } catch (e) {
      res.writeHead(500); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Debug: dump visible button-like elements across all execution contexts
  if (url.pathname === '/api/debug/buttons') {
    try {
      if (!cdpWs || cdpWs.readyState !== 1) await connectCDP();
      const SCRIPT = `(() => {
        const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const list = [];
        for (const el of document.querySelectorAll('button, a[role="button"], [role="button"], [class*="action-label"]')) {
          if (!el.offsetParent && el.getClientRects().length === 0) continue;
          const t = norm(el.textContent).slice(0, 60);
          const a = norm(el.getAttribute('aria-label')).slice(0, 60);
          if (!t && !a) continue;
          list.push({ text: t, aria: a, cls: (el.className || '').slice(0, 60) });
        }
        return list;
      })()`;
      const r = await cdpCall('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: cdpContextId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.result?.value || [], null, 2));
    } catch (e) {
      res.writeHead(500); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Accept/Reject â€” CDP click with bridge fallback
  async function bridgeCall(bridgePath) {
    return new Promise((resolve, reject) => {
      const r = http.request({ hostname: '127.0.0.1', port: 3848, path: bridgePath, method: 'POST', timeout: 5000 }, resp => {
        let d = ''; resp.on('data', c => d += c);
        resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ ok: false }); } });
      });
      r.on('error', reject);
      r.end();
    });
  }
  if (url.pathname === '/api/code/accept-cdp' && req.method === 'POST') {
    const click = await cdpClickButton('Accept all');
    if (click.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, action: 'accepted', method: 'cdp' }));
    }
    try {
      const data = await bridgeCall('/accept');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, action: 'accepted', method: 'bridge', data }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'CDP and bridge both failed' }));
    }
  }
  if (url.pathname === '/api/code/reject-cdp' && req.method === 'POST') {
    const click = await cdpClickButton('Reject all');
    if (click.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, action: 'rejected', method: 'cdp' }));
    }
    try {
      const data = await bridgeCall('/reject');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, action: 'rejected', method: 'bridge', data }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'CDP and bridge both failed' }));
    }
  }

  // Get available models and current selection via CDP
  if (url.pathname === '/api/agent/models' && req.method === 'GET') {
    try {
      // Try CDP first
      if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) {
        try { await connectCDP(); } catch {}
      }
      // If CDP still unavailable, extract model from conversation transcripts
      if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) {
        let modelName = null;
        const convs = getConversations();
        for (const conv of convs.slice(0, 3)) {
          for (const brainDir of BRAIN_DIRS) {
            const tp = path.join(brainDir, conv.id, '.system_generated', 'logs', 'transcript.jsonl');
            try {
              if (!fs.existsSync(tp)) continue;
              const raw = fs.readFileSync(tp, 'utf8');
              const lines = raw.split('\n').filter(l => l.trim()).slice(0, 15);
              for (const line of lines) {
                try {
                  const entry = JSON.parse(line);
                  if (entry.content) {
                    const mMatch = entry.content.match(/(?:gemini-[0-9a-z.-]+|claude-[0-9a-z.-]+|gpt-[0-9a-z.-]+)/i);
                    if (mMatch) { modelName = mMatch[0]; break; }
                  }
                } catch {}
              }
              if (modelName) break;
            } catch {}
          }
          if (modelName) break;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          current: modelName || 'Agent',
          models: [],
          method: modelName ? 'transcript' : 'fallback',
          cdp: false
        }));
      }
      // CDP is available — proceed with original DOM inspection
      await connectCDP();
      const SCRIPT = `(() => {
        // Find current model from aria-label on the model selector
        let current = '';
        const currentBtn = document.querySelector('[aria-label*="Select model, current: "]');
        if (currentBtn) {
          current = currentBtn.getAttribute('aria-label').replace('Select model, current: ', '').trim();
        }
        
        // Model options - looking at generic flex items in the dropdown
        const items = document.querySelectorAll('[class*="px-2"][class*="py-1"][class*="justify-between"]');
        const models = [];
        for (const el of items) {
          let name = el.textContent.trim();
          name = name.replace(/New$/, '').trim(); // Remove "New" badge if present
          if (name.length > 2 && name.length < 50) {
            models.push({ value: name, label: name });
            if (!current && (el.querySelector('[class*="check"]') || el.className.includes('bg-'))) {
              current = name;
            }
          }
        }
        
        if (models.length > 0 || current) {
          return { ok: true, models, current: current || (models[0]?.value), method: 'aria-label' };
        }
        
        // Fallback: find model name text
        const spans = document.querySelectorAll('span');
        for (const s of spans) {
          const t = s.textContent.trim();
          if ((t.includes('Gemini') || t.includes('Claude') || t.includes('GPT')) && t.length < 40 && s.children.length === 0) {
            return { ok: true, current: t, models: [], method: 'text' };
          }
        }
        return { ok: false };
      })()`;
      const r = await cdpCall('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: cdpContextId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.result?.value || { ok: false }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Switch model via CDP
  if (url.pathname === '/api/agent/model' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { model } = JSON.parse(body);
        if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) await connectCDP();
        const escaped = model.replace(/'/g, "\\'");
        const SCRIPT = `(() => {
          const buttons = document.querySelectorAll('button.cursor-pointer[class*="px-2"][class*="py-1"][class*="justify-between"]');
          for (const btn of buttons) {
            const span = btn.querySelector('span.font-medium');
            if (span && span.textContent.trim().includes('${escaped}')) {
              btn.click();
              return { ok: true, selected: span.textContent.trim() };
            }
          }
          return { ok: false, reason: 'Model not found' };
        })()`;
        const r = await cdpCall('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: cdpContextId });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.result?.value || { ok: false }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Check if agent is actively working (has a visible stop/cancel button)
  if (url.pathname === '/api/agent/status' && req.method === 'GET') {
    try {
      if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) await connectCDP();
      const SCRIPT = `(() => {
        const selectors = [
          'button[aria-label*="Stop"]', 'button[aria-label*="Cancel"]',
          'button[aria-label*="stop"]', 'button[title*="Stop"]',
          'button.stop-button', 'button[class*="stop"]'
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) return { working: true, selector: sel };
        }
        return { working: false };
      })()`;
      const r = await cdpCall('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: cdpContextId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.result?.value || { working: false }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ working: false }));
    }
    return;
  }

  // Detect pending tool approvals (Run command, Browser, etc.)
  if (url.pathname === '/api/agent/approvals' && req.method === 'GET') {
    try {
      if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) await connectCDP();
      const SCRIPT = `(() => {
        // Only detect genuine tool approval dialogs
        // These always have BOTH "Allow" and "Don't Allow" buttons visible
        const allBtns = document.querySelectorAll('button');
        let allowBtn = null;
        let dontAllowBtn = null;
        let alwaysAllowBtn = null;
        
        for (const btn of allBtns) {
          if (btn.offsetParent === null) continue;
          const text = btn.textContent.trim();
          if (text === 'Allow') allowBtn = btn;
          else if (text === "Don't Allow") dontAllowBtn = btn;
          else if (text === 'Always Allow') alwaysAllowBtn = btn;
        }
        
        // Must have both Allow and Don't Allow â€” this is the approval dialog signature
        if (!allowBtn || !dontAllowBtn) return { pending: false };
        
        // Try to detect what tool is requesting
        let toolName = 'Tool';
        // The approval container is the parent of these buttons
        const container = allowBtn.closest('[class*="chat"], [class*="confirmation"], div') || allowBtn.parentElement?.parentElement;
        if (container) {
          const text = (container.textContent || '').toLowerCase();
          if (text.includes('browser')) toolName = 'Browser';
          else if (text.includes('command') || text.includes('terminal')) toolName = 'Command';
          else if (text.includes('file')) toolName = 'File';
        }
        
        const buttons = ['Allow', "Don't Allow"];
        if (alwaysAllowBtn) buttons.push('Always Allow');
        
        return { pending: true, toolName, buttons };
      })()`;
      const r = await cdpCall('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: cdpContextId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.result?.value || { pending: false }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pending: false }));
    }
    return;
  }

  // Click an approval button (Allow, Don't Allow, Skip, etc.)
  if (url.pathname === '/api/agent/approve' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { action } = JSON.parse(body); // "Allow", "Don't Allow", "Always Allow", "Skip"
        if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) await connectCDP();
        const escaped = action.replace(/'/g, "\\'");
        const SCRIPT = `(() => {
          const allBtns = document.querySelectorAll('button');
          for (const btn of allBtns) {
            if (btn.offsetParent === null) continue;
            const text = btn.textContent.trim();
            if (text === '${escaped}' || text.startsWith('${escaped}')) {
              btn.click();
              return { ok: true, clicked: text };
            }
          }
          return { ok: false, reason: 'Button not found: ${escaped}' };
        })()`;
        const r = await cdpCall('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: cdpContextId });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.result?.value || { ok: false }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Stop agent activity via CDP (click stop/cancel button)
  if (url.pathname === '/api/agent/stop' && req.method === 'POST') {
    try {
      if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) await connectCDP();
      const SCRIPT = `(() => {
        // Try multiple selectors for stop/cancel buttons
        const selectors = [
          'button[aria-label*="Stop"]',
          'button[aria-label*="Cancel"]', 
          'button[aria-label*="stop"]',
          'button[title*="Stop"]',
          'button[title*="Cancel"]',
          'button.stop-button',
          'button[class*="stop"]',
          'button[class*="cancel"]'
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) {
            btn.click();
            return { ok: true, method: 'selector', selector: sel };
          }
        }
        // Fallback: try pressing Escape
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        return { ok: true, method: 'escape' };
      })()`;
      const r = await cdpCall('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: cdpContextId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.result?.value || { ok: true, method: 'escape' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  // Sync conversation titles from Antigravity picker (scrape + close)
  if (url.pathname === '/api/conversations/sync-titles' && req.method === 'POST') {
    (async () => {
      try {
        // Open picker
        try {
          await new Promise((resolve, reject) => {
            http.request({ hostname: '127.0.0.1', port: 3848, path: '/exec', method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); })
            .on('error', reject)
            .end(JSON.stringify({ command: 'antigravity.openConversationPicker' }));
          });
        } catch {}
        
        await new Promise(r => setTimeout(r, 1500));
        if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) await connectCDP();
        
        // DEBUG: First check what's in the DOM
        const debugScript = `(() => {
          const widget = document.querySelector('.quick-input-widget');
          const rows = document.querySelectorAll('.quick-input-list [role="option"]');
          const allRows = document.querySelectorAll('.monaco-list-row');
          const options = document.querySelectorAll('[role="option"]');
          return {
            widgetExists: !!widget,
            widgetHidden: widget?.classList?.contains('hidden'),
            quickInputRows: rows.length,
            allMonacoRows: allRows.length,
            roleOptions: options.length,
            bodyChildCount: document.body.children.length,
            firstRowHTML: allRows[0]?.outerHTML?.substring(0, 300) || 'none'
          };
        })()`;
        const debugResult = await cdpCall('Runtime.evaluate', { expression: debugScript, returnByValue: true, contextId: cdpContextId });
        console.log('  DEBUG picker DOM:', JSON.stringify(debugResult.result?.value));
        // Also try without contextId
        const debugResult2 = await cdpCall('Runtime.evaluate', { expression: debugScript, returnByValue: true });
        console.log('  DEBUG picker DOM (no ctx):', JSON.stringify(debugResult2.result?.value));
        
        // Scrape picker items via DOM
        let pickerItems = [];
        const scrapeScript2 = `(() => {
            const items = document.querySelectorAll('.quick-input-list [role="option"]');
            return Array.from(items).map(item => {
              const title = item.getAttribute('aria-label') || item.textContent?.trim() || '';
              const desc = item.querySelector('.label-description');
              const timeText = (desc ? desc.textContent : '').trim();
              return { title, timeText };
            }).filter(t => t.title.length > 3 
              && !t.title.toLowerCase().startsWith('show ')
              && !t.title.toLowerCase().includes('open in')
              && !t.title.toLowerCase().includes('continue conversation'));
          })()`;
          
          let scrapeResult = await cdpCall('Runtime.evaluate', { expression: scrapeScript2, returnByValue: true, contextId: cdpContextId });
          if (!scrapeResult.result?.value?.length) {
            scrapeResult = await cdpCall('Runtime.evaluate', { expression: scrapeScript2, returnByValue: true });
          }
          pickerItems = scrapeResult.result?.value || [];
          console.log('  Picker items found:', pickerItems.length, pickerItems.map(i => i.title));
        
        // Close the picker
        await cdpCall('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await cdpCall('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        
        // Match picker items to our conversations by timestamp
        if (!global._convTitleCache) global._convTitleCache = {};
        const convs = getConversations();
        const now = Date.now();
        
        for (const item of pickerItems) {
          // Parse relative time: "X secs ago", "X mins ago", "X hrs ago", "X days ago"
          let ageMs = 0;
          const m = item.timeText.match(/(\d+)\s*(sec|min|hour|hr|day)/i);
          if (m) {
            const n = parseInt(m[1]);
            const unit = m[2].toLowerCase();
            if (unit.startsWith('sec')) ageMs = n * 1000;
            else if (unit.startsWith('min')) ageMs = n * 60000;
            else if (unit.startsWith('hr') || unit.startsWith('hour')) ageMs = n * 3600000;
            else if (unit.startsWith('day')) ageMs = n * 86400000;
          }
          
          const approxTime = now - ageMs;
          
          // Find the conversation with the closest lastMod time
          let bestMatch = null;
          let bestDiff = Infinity;
          for (const conv of convs) {
            // Skip if already cached
            if (global._convTitleCache[conv.id] && global._convTitleCache[conv.id] !== item.title) continue;
            const diff = Math.abs(conv.lastMod - approxTime);
            if (diff < bestDiff && diff < 300000) { // Within 5 minutes
              bestDiff = diff;
              bestMatch = conv;
            }
          }
          
          if (bestMatch) {
            global._convTitleCache[bestMatch.id] = item.title;
          }
        }
        
        console.log('  Title cache synced:', Object.keys(global._convTitleCache).length, 'entries');
        // Save cache to disk
        try {
          fs.writeFileSync(path.join(__dirname, 'title-cache.json'), JSON.stringify(global._convTitleCache, null, 2), 'utf8');
        } catch {}
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: pickerItems.length, cache: global._convTitleCache, items: pickerItems }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
    return;
  }


  // Detect current active conversation in Antigravity
  if (url.pathname === '/api/agent/active-conversation' && req.method === 'GET') {
    try {
      const wsFilter = url.searchParams.get('workspace') || null;
      let activeConvId = _lastActiveConvId;
      let activeTime = _lastActiveTime;
      if (wsFilter && _activePerWorkspace[wsFilter]) {
        activeConvId = _activePerWorkspace[wsFilter].convId;
        activeTime = _activePerWorkspace[wsFilter].time;
      }
      const age = Date.now() - activeTime;
      if (activeConvId && age < 30000) {
        // A conversation was recently written to â€” this is the active one
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          ok: true, 
          convId: activeConvId,
          age: Math.round(age / 1000),
          workspace: detectWorkspace(activeConvId),
          workspaceLabel: getWorkspaceLabel(detectWorkspace(activeConvId)),
          method: 'brain-watcher'
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Switch conversation via bridge extension + CDP
  if (url.pathname === '/api/conversation/switch' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { convId, preview } = JSON.parse(body);
        global._targetConvId = convId;
        
        // Step 1: Open conversation picker via bridge extension
        try {
          await new Promise((resolve, reject) => {
            http.request({ hostname: '127.0.0.1', port: 3848, path: '/exec', method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); })
            .on('error', reject)
            .end(JSON.stringify({ command: 'antigravity.openConversationPicker' }));
          });
        } catch {}
        
        await new Promise(r => setTimeout(r, 500)); // Wait for picker to open
        
        // Step 2: Scrape titles from the open picker and build title cache
        if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) await connectCDP();
        
        // Wait for picker to fully render
        await new Promise(r => setTimeout(r, 400));
        
        // Read all visible titles from the picker list
        const scrapeScript = `(() => {
          const items = document.querySelectorAll('.quick-input-list [role="option"]');
          return Array.from(items).map(item => {
            const label = item.querySelector('.label-name, .monaco-highlighted-label, .label-main');
            const desc = item.querySelector('.label-description');
            return {
              title: (label ? label.textContent : item.textContent || '').trim(),
              desc: (desc ? desc.textContent : '').trim()
            };
          }).filter(t => t.title.length > 3 && !t.title.toLowerCase().includes('open in') && !t.title.toLowerCase().includes('continue conversation'));
        })()`;
        try {
          const scrapeResult = await cdpCall('Runtime.evaluate', { expression: scrapeScript, returnByValue: true, contextId: cdpContextId });
          const pickerItems = scrapeResult.result?.value || [];
          if (pickerItems.length > 0) {
            if (!global._convTitleCache) global._convTitleCache = {};
            global._pickerTitles = pickerItems;
            const convs = getConversations();
            for (const item of pickerItems) {
              for (const conv of convs) {
                const t = item.title.toLowerCase();
                const p = (conv.preview || '').toLowerCase();
                const words = t.split(/\s+/).filter(w => w.length > 3);
                const matchCount = words.filter(w => p.includes(w)).length;
                if (matchCount >= 2 || t.includes(conv.id.substring(0, 8))) {
                  global._convTitleCache[conv.id] = item.title;
                }
              }
            }
          }
        } catch {}
        
        // Step 3: Use cached title for text search
        const cachedTitle = (global._convTitleCache || {})[convId];
        
        if (cachedTitle) {
          // Type the cached title
          await cdpCall('Input.insertText', { text: cachedTitle });
          await new Promise(r => setTimeout(r, 500));
        } else {
          // No cached title - use English keywords from preview as fallback
          const engWords = (preview || '').match(/[a-zA-Z]{3,}/g) || [];
          const fallback = engWords.slice(0, 4).join(' ') || convId.substring(0, 8);
          await cdpCall('Input.insertText', { text: fallback });
          await new Promise(r => setTimeout(r, 500));
        }
        
        // Press Enter to select
        await cdpCall('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await cdpCall('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        
        // Wait for "Open in current window" dialog
        await new Promise(r => setTimeout(r, 800));
        
        // Press Enter to confirm
        await cdpCall('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await cdpCall('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          ok: true, 
          method: cachedTitle ? 'cached-title' : 'fallback',
          search: cachedTitle || 'fallback'
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Message queue status
  if (url.pathname === '/api/chat/queue' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(global._messageQueue || []));
  }

  // Cancel a queued message
  if (url.pathname === '/api/chat/cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const queue = global._messageQueue || [];
        const idx = queue.findIndex(m => m.id === id);
        if (idx !== -1 && queue[idx].status === 'pending') {
          queue[idx].status = 'cancelled';
          queue[idx].cancelled = true;
          const sseData = JSON.stringify({ type: 'queue_update', queue });
          for (const client of sseClients) client.write(`data: ${sseData}\n\n`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
    return;
  }


  // Detect pending changes - CDP with bridge fallback
  if (url.pathname === '/api/code/pending' && req.method === 'GET') {
    // Try CDP first
    try {
      if (cdpWs && cdpWs.readyState === 1 && cdpContextId) {
        const SCRIPT = `(() => {
          const c = [...document.querySelectorAll('button, span.cursor-pointer')];
          const a = c.find(b => { const t = b.textContent.trim().toLowerCase(); return (t === 'accept all' || t === 'accept' || t === 'accept all changes') && b.offsetParent !== null; });
          if (!a) return { pending: false };
          let fc = null;
          for (const el of document.querySelectorAll('div, span')) {
            const t = (el.textContent || '').trim();
            const m = t.match(/^(\\d+)\\s+Files?\\s+With\\s+Changes$/i);
            if (m) { fc = parseInt(m[1]); break; }
          }
          return { pending: true, editedFiles: fc };
        })()`;
        const r = await cdpCall('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: cdpContextId });
        const v = r.result?.value || { pending: false };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(v));
      }
    } catch {}
    // Bridge fallback
    try {
      const data = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:3848/has-changes', resp => {
          let d = ''; resp.on('data', c => d += c);
          resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        }).on('error', reject);
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ pending: data.hasPendingChanges, dirtyFiles: data.dirtyFiles, method: 'bridge' }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ pending: false }));
    }
  }

  if (url.pathname === '/api/workspaces') {
    const convs = getConversations();
    const wsMap = {};
    for (const c of convs) {
      const ws = c.workspace || '__other__';
      if (!wsMap[ws]) wsMap[ws] = { name: ws, label: getWorkspaceLabel(ws === '__other__' ? null : ws), color: getWorkspaceColor(ws === '__other__' ? null : ws), conversations: 0, activeConvId: null, lastActivity: 0 };
      wsMap[ws].conversations++;
      if (c.lastMod > wsMap[ws].lastActivity) wsMap[ws].lastActivity = c.lastMod;
    }
    for (const [ws, info] of Object.entries(_activePerWorkspace)) {
      if (wsMap[ws]) {
        wsMap[ws].activeConvId = info.convId;
        wsMap[ws].isActive = (Date.now() - info.time) < 30000;
      }
    }
    const workspaces = Object.values(wsMap).sort((a, b) => b.lastActivity - a.lastActivity);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(workspaces));
  }

  if (url.pathname === '/api/conversations') {
    const wsFilter = url.searchParams.get('workspace') || null;
    let convs = getConversations();
    if (wsFilter) {
      convs = wsFilter === '__other__' ? convs.filter(c => !c.workspace) : convs.filter(c => c.workspace === wsFilter);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(convs));
  }

  if (url.pathname.startsWith('/api/conversation/')) {
    const parts = url.pathname.split('/');
    const convId = parts[3];
    const sub = parts[4];

    if (sub === 'log') {
      // Get tail of log
      const lines = parseInt(url.searchParams.get('lines') || '100');
      const full = getConversationLog(convId);
      const allLines = full.split('\n');
      const tail = allLines.slice(-lines).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(tail);
    }

    if (sub === 'full') {
      const full = getConversationLog(convId);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(full);
    }

    if (sub === 'artifacts') {
      const arts = getArtifacts(convId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(arts));
    }

    if (sub === 'watch') {
      watchConversation(convId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ watching: true }));
    }
  }

  // SSE endpoint for live updates
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Approval system
  if (url.pathname === '/api/approvals' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(approvalQueue.filter(a => a.status === 'pending')));
  }

  if (url.pathname === '/api/approve' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id, approved } = JSON.parse(body);
        const item = approvalQueue.find(a => a.id === id);
        if (item) {
          item.status = approved ? 'approved' : 'rejected';
          item.resolvedAt = Date.now();
          // Notify SSE clients
          const data = JSON.stringify({ type: 'approval_resolved', id, status: item.status });
          for (const client of sseClients) client.write(`data: ${data}\n\n`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
    return;
  }

  // Queue an approval request (called by agent/scripts)
  if (url.pathname === '/api/request-approval' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { title, description, diff } = JSON.parse(body);
        const item = {
          id: ++approvalIdCounter,
          title, description, diff,
          status: 'pending',
          createdAt: Date.now()
        };
        approvalQueue.push(item);
        const data = JSON.stringify({ type: 'new_approval', item });
        for (const client of sseClients) client.write(`data: ${data}\n\n`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: item.id }));
      } catch {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
    return;
  }

  // Artifacts API Ã¢â‚¬â€ recursive scan of conversation dir
  const artMatch = url.pathname.match(/^\/api\/conversation\/([^/]+)\/artifacts$/);
  if (artMatch && req.method === 'GET') {
    const convDir = path.join(BRAIN_DIR, artMatch[1]);
    const TEXT_EXTS = ['.md', '.txt', '.json', '.html', '.htm', '.py', '.js', '.ts', '.tsx', '.jsx', '.css', '.yaml', '.yml', '.xml', '.csv', '.sh', '.log'];
    const IMAGE_EXTS = ['.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg'];
    const SKIP_NAMES = /\.metadata\.json$|\.resolved(\.\d+)?$/i;
    const MAX_SIZE = 2_000_000; // 2 MB cap per artifact (was 500 KB)
    const MAX_TOTAL = 1000;     // safety net
    const artifacts = [];

    function pushArtifact(absPath, relName, stat) {
      const ext = path.extname(absPath).toLowerCase();
      if (IMAGE_EXTS.includes(ext)) {
        artifacts.push({ name: relName, size: stat.size, modified: stat.mtimeMs, content: `[Image: ${(stat.size / 1024).toFixed(1)} KB]`, type: 'image', path: relName });
        return;
      }
      if (TEXT_EXTS.includes(ext) && stat.size < MAX_SIZE) {
        try {
          const content = fs.readFileSync(absPath, 'utf8');
          artifacts.push({ name: relName, size: stat.size, modified: stat.mtimeMs, content: content.substring(0, 5000), type: 'text', path: relName });
        } catch {}
        return;
      }
      // Unknown type: still surface basic info so user knows it's there
      artifacts.push({ name: relName, size: stat.size, modified: stat.mtimeMs, content: `[${ext || 'binary'}: ${(stat.size / 1024).toFixed(1)} KB]`, type: 'other', path: relName });
    }

    function walk(dir, relPrefix = '', depth = 0) {
      if (depth > 4 || artifacts.length >= MAX_TOTAL) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (artifacts.length >= MAX_TOTAL) return;
        const name = e.name;
        if (SKIP_NAMES.test(name)) continue;
        // Skip dotfiles only at depth 0 EXCEPT .system_generated/.tempmediaStorage which hold real artifacts
        if (depth === 0 && name.startsWith('.') && name !== '.system_generated' && name !== '.tempmediaStorage') continue;
        const abs = path.join(dir, name);
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        try {
          if (e.isDirectory()) {
            walk(abs, rel, depth + 1);
          } else if (e.isFile()) {
            const stat = fs.statSync(abs);
            if (stat.size > 0) pushArtifact(abs, rel, stat);
          }
        } catch {}
      }
    }

    try {
      walk(convDir);
      artifacts.sort((a, b) => b.modified - a.modified);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(artifacts));
    } catch (err) {
      console.error('Artifacts error:', err.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('[]');
    }
  }

  // Bulk delete artifacts older than N days (default 7) for one conversation
  const purgeMatch = url.pathname.match(/^\/api\/conversation\/([^/]+)\/artifacts\/purge$/);
  if (purgeMatch && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { olderThanDays = 7 } = body ? JSON.parse(body) : {};
        const cutoff = Date.now() - olderThanDays * 86400_000;
        const convDir = path.join(BRAIN_DIR, purgeMatch[1]);
        let deleted = 0, freed = 0;
        const walk = (dir, depth = 0) => {
          if (depth > 4) return;
          let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            const abs = path.join(dir, e.name);
            try {
              if (e.isDirectory()) walk(abs, depth + 1);
              else if (e.isFile()) {
                const st = fs.statSync(abs);
                if (st.mtimeMs < cutoff) {
                  freed += st.size;
                  fs.unlinkSync(abs);
                  deleted++;
                }
              }
            } catch {}
          }
        };
        walk(convDir);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted, freedKB: Math.round(freed / 1024), olderThanDays }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Cleanup temp artifacts (dom_*, media_* files)
  if (url.pathname === '/api/artifacts/cleanup' && req.method === 'POST') {
    let cleaned = 0;
    try {
      // Clean .tempmediaStorage in all conversations
      const convDirs = fs.readdirSync(BRAIN_DIR).filter(d => !d.startsWith('.'));
      for (const d of convDirs) {
        const mediaDir = path.join(BRAIN_DIR, d, '.tempmediaStorage');
        if (fs.existsSync(mediaDir)) {
          const files = fs.readdirSync(mediaDir);
          for (const f of files) {
            if (f.startsWith('dom_') || f.startsWith('media_')) {
              try { fs.unlinkSync(path.join(mediaDir, f)); cleaned++; } catch {}
            }
          }
        }
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, cleaned }));
  }

  // Delete specific artifact
  const delMatch = url.pathname.match(/^\/api\/conversation\/([^/]+)\/artifact\/delete$/);
  if (delMatch && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        if (!name || name.includes('..')) {
          res.writeHead(400);
          return res.end('Invalid name');
        }
        const fp = path.join(BRAIN_DIR, delMatch[1], name);
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      } catch {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
    return;
  }

  // Chat system routes
  if (url.pathname === '/api/chat/messages' && req.method === 'GET') {
    const data = loadChat();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  }

  // Image upload from mobile
  if (url.pathname === '/api/chat/upload' && req.method === 'POST') {
    const contentType = req.headers['content-type'] || '';
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) {
      res.writeHead(400);
      return res.end('No boundary');
    }
    
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const buf = Buffer.concat(chunks);
        const boundaryBuf = Buffer.from('--' + boundary);
        
        // Parse multipart manually
        let text = '';
        let imageFile = null;
        let imageName = 'image.png';
        
        const parts = [];
        let start = 0;
        while (true) {
          const idx = buf.indexOf(boundaryBuf, start);
          if (idx === -1) break;
          if (start > 0) parts.push(buf.slice(start, idx - 2)); // -2 for \r\n
          start = idx + boundaryBuf.length + 2; // skip boundary + \r\n
        }
        
        for (const part of parts) {
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;
          const headers = part.slice(0, headerEnd).toString();
          const body = part.slice(headerEnd + 4);
          
          if (headers.includes('name="text"')) {
            text = body.toString().trim();
          } else if (headers.includes('name="image"')) {
            imageFile = body;
            const fnMatch = headers.match(/filename="([^"]+)"/);
            if (fnMatch) imageName = fnMatch[1];
          }
        }
        
        if (!imageFile || imageFile.length < 100) {
          res.writeHead(400);
          return res.end('No image');
        }
        
        // Save image
        const ext = path.extname(imageName) || '.png';
        const fname = `mobile_${Date.now()}${ext}`;
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        const fpath = path.join(uploadDir, fname);
        fs.writeFileSync(fpath, imageFile);
        
        // Build message with image reference
        const absPath = fpath.replace(/\//g, '\\');
        const chatText = text 
          ? `${text}\n\nÃ°Å¸â€œÅ½ [Image attached: ${absPath}]`
          : `Ã°Å¸â€œÅ½ [Image attached: ${absPath}]`;
        
        const msg = addChatMessage('user', chatText);
        msg.imagePath = absPath;
        
        // Notify SSE
        const sseData = JSON.stringify({ type: 'new_chat', message: msg });
        for (const client of sseClients) client.write(`data: ${sseData}\n\n`);
        
        // Track in queue for status updates
        if (!global._messageQueue) global._messageQueue = [];
        const qi = { id: msg.id, text: chatText.slice(0, 50), status: 'pending', timestamp: msg.timestamp };
        global._messageQueue.push(qi);
        if (global._messageQueue.length > 20) global._messageQueue = global._messageQueue.slice(-20);

        // Check CDP before attempting injection
        if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) {
          qi.status = 'failed';
          qi.reason = 'No CDP';
        } else {
          try {
            const result = await cdpInjectMessage(chatText);
            qi.status = result.ok ? 'sent' : 'failed';
            qi.reason = result.ok ? undefined : result.reason;
          } catch { qi.status = 'failed'; qi.reason = 'CDP error'; }
        }

        const qData = JSON.stringify({ type: 'queue_update', queue: global._messageQueue });
        for (const client of sseClients) client.write(`data: ${qData}\n\n`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: msg.id, path: absPath, message: msg, queued: true }));
      } catch (err) {
        console.error('Upload error:', err);
        res.writeHead(500);
        res.end('Upload failed');
      }
    });
    return;
  }

  // Send message via queue with CDP injection
  if (url.pathname === '/api/chat/send' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { text, convId } = JSON.parse(body);
        if (!text || !text.trim()) {
          res.writeHead(400);
          return res.end('Empty message');
        }
        if (!global._messageQueue) global._messageQueue = [];
        const msg = addChatMessage('user', text.trim());
        const queueItem = { id: msg.id, text: text.trim(), status: 'pending', convId: convId || global._targetConvId, timestamp: msg.timestamp };
        global._messageQueue.push(queueItem);
        if (global._messageQueue.length > 20) global._messageQueue = global._messageQueue.slice(-20);

        const sseData = JSON.stringify({ type: 'new_chat', message: msg });
        for (const client of sseClients) client.write(`data: ${sseData}\n\n`);
        const queueData = JSON.stringify({ type: 'queue_update', queue: global._messageQueue });
        for (const client of sseClients) client.write(`data: ${queueData}\n\n`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...msg, queued: true }));

        const qi = global._messageQueue.find(m => m.id === msg.id);
        if (qi && qi.cancelled) { qi.status = 'cancelled'; return; }

        // Check CDP before attempting injection
        if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) {
          try { await connectCDP(); } catch {}
        }
        if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) {
          qi.status = 'failed';
          qi.reason = 'No CDP - restart IDE with debug port';
          const nocdpData = JSON.stringify({ type: 'queue_update', queue: global._messageQueue });
          for (const client of sseClients) client.write(`data: ${nocdpData}\n\n`);
        } else {
        try {
          // Re-switch conversation before inject to ensure correct target
          const targetId = convId || global._targetConvId;
          if (targetId) {
            const preview = (global._targetConvPreview || '').replace(/^[\d.,: ]+\u2014\s*/, '').trim() || targetId.substring(0, 8);
            const escaped = preview.replace(/'/g, "\\'");
            const switchScript = `(() => {
              const panel = document.querySelector('.antigravity-agent-side-panel');
              if (panel) {
                const items = panel.querySelectorAll('[class*="justify-between"][class*="px-2"]');
                for (const item of items) {
                  const t = (item.textContent || '').trim();
                  if (t && (t.includes('${escaped}') || t.includes('${targetId.substring(0, 8)}'))) {
                    item.click();
                    return { ok: true };
                  }
                }
              }
              return { ok: false };
            })()`;
            try {
              if (!cdpWs || cdpWs.readyState !== 1 || !cdpContextId) await connectCDP();
              await cdpCall('Runtime.evaluate', { expression: switchScript, returnByValue: true, contextId: cdpContextId });
              await new Promise(r => setTimeout(r, 300)); // wait for UI to settle
            } catch {}
          }
          const result = await cdpInjectMessage(text.trim());
          qi.status = result.ok ? 'sent' : 'failed';
          qi.reason = result.ok ? undefined : result.reason;
        } catch (e) {
          qi.status = 'failed';
          qi.reason = 'CDP error';
        }
        } // end CDP-connected block

        const updData = JSON.stringify({ type: 'queue_update', queue: global._messageQueue });
        for (const client of sseClients) client.write(`data: ${updData}\n\n`);
      } catch {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
    return;
  }

  // Agent replies (called from IDE via curl/fetch or agent reads)
  if (url.pathname === '/api/chat/reply' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        const msg = addChatMessage('agent', text.trim());
        const sseData = JSON.stringify({ type: 'new_chat', message: msg });
        for (const client of sseClients) client.write(`data: ${sseData}\n\n`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(msg));
      } catch {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
    return;
  }

  // Mark messages as read
  if (url.pathname === '/api/chat/mark-read' && req.method === 'POST') {
    const data = loadChat();
    data.messages.forEach(m => m.read = true);
    data.unread = 0;
    saveChat(data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Clear chat history
  if (url.pathname === '/api/chat/clear' && req.method === 'POST') {
    saveChat({ messages: [], unread: 0 });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Get unread count (for agent polling)
  if (url.pathname === '/api/chat/unread' && req.method === 'GET') {
    const data = loadChat();
    const unread = data.messages.filter(m => m.role === 'user' && !m.read);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ count: unread.length, messages: unread }));
  }

  // Code accept/reject Ã¢â‚¬â€ proxy to VS Code extension bridge
  if ((url.pathname === '/api/code/accept' || url.pathname === '/api/code/reject') && req.method === 'POST') {
    const bridgePath = url.pathname === '/api/code/accept' ? '/accept' : '/reject';
    const bridgeReq = http.request({
      hostname: '127.0.0.1',
      port: 3848,
      path: bridgePath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (bridgeRes) => {
      let d = '';
      bridgeRes.on('data', c => d += c);
      bridgeRes.on('end', () => {
        res.writeHead(bridgeRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(d);
      });
    });
    bridgeReq.on('error', () => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'VS Code bridge not running' }));
    });
    bridgeReq.end();
    return;
  }
  // Check pending changes via bridge
  if (url.pathname === '/api/bridge/has-changes' && req.method === 'GET') {
    const bridgeReq = http.request({
      hostname: '127.0.0.1',
      port: 3848,
      path: '/has-changes',
      method: 'GET'
    }, (bridgeRes) => {
      let d = '';
      bridgeRes.on('data', c => d += c);
      bridgeRes.on('end', () => {
        res.writeHead(bridgeRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(d);
      });
    });
    bridgeReq.on('error', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hasPendingChanges: false, bridgeOffline: true }));
    });
    bridgeReq.end();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});


// Load persistent title cache
try {
  const cachePath = path.join(__dirname, 'title-cache.json');
  if (fs.existsSync(cachePath)) {
    global._convTitleCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    console.log('  Loaded title cache:', Object.keys(global._convTitleCache).length, 'entries');
  }
} catch {}


server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('  Ã¢â€¢â€Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢â€”');
  console.log('  Ã¢â€¢â€˜   📱 Mobile Agent Monitor                Ã¢â€¢â€˜');
  console.log('  Ã¢â€¢Â Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â£');
  console.log(`  Ã¢â€¢â€˜   Local:   http://localhost:${PORT}        Ã¢â€¢â€˜`);
  console.log(`  Ã¢â€¢â€˜   Phone:   http://${ip}:${PORT}    Ã¢â€¢â€˜`);
  console.log('  Ã¢â€¢â€˜                                          Ã¢â€¢â€˜');
  console.log('  Ã¢â€¢â€˜   Open the Phone URL on your mobile      Ã¢â€¢â€˜');
  console.log('  Ã¢â€¢â€˜   browser to start monitoring.           Ã¢â€¢â€˜');
  console.log('  Ã¢â€¢Å¡Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â');
  console.log('');

  // Auto-watch the most recent conversation
  const convs = getConversations();
  if (convs.length > 0) {
    watchConversation(convs[0].id);
    console.log(`  Watching: ${convs[0].id.substring(0, 8)}...`);
  }
});
