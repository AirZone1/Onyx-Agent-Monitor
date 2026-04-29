// Inspect the picker DOM to find the right selectors
const WebSocket = require('ws');
const http = require('http');

(async () => {
  const r = await fetch('http://127.0.0.1:9229/json');
  const targets = await r.json();
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  let id = 1;
  
  const send = (m, p) => new Promise(resolve => {
    const i = id++;
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    ws.on('message', d => {
      const j = JSON.parse(d.toString());
      if (j.id === i) resolve(j);
    });
  });
  
  ws.on('open', async () => {
    const script = `(() => {
      const quickInput = document.querySelector('.quick-input-list');
      const rows = document.querySelectorAll('.quick-input-list .monaco-list-row');
      const allQuickInput = document.querySelectorAll('[class*="quick-input"]');
      
      // Try broader selectors
      const listRows = document.querySelectorAll('.monaco-list-row');
      const listItems = document.querySelectorAll('[role="option"]');
      
      return {
        quickInputList: quickInput ? 'found' : 'not found',
        monacoListRows: rows.length,
        allQuickInputCount: allQuickInput.length,
        broadListRows: listRows.length,
        roleOptionItems: listItems.length,
        // Get first few items with broader selector
        firstItems: Array.from(listRows).slice(0, 3).map(r => ({
          text: r.textContent?.substring(0, 80),
          classes: r.className?.substring(0, 100)
        })),
        // Check for dialog
        dialogVisible: !!document.querySelector('.quick-input-widget:not(.hidden)')
      };
    })()`;
    
    // Try without contextId first
    const result = await send('Runtime.evaluate', { expression: script, returnByValue: true });
    console.log(JSON.stringify(result.result?.result?.value, null, 2));
    
    ws.close();
    process.exit(0);
  });
})();
