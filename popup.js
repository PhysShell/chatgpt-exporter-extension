'use strict';

const exportBtn     = document.getElementById('exportBtn');
const statusBox     = document.getElementById('statusBox');
const projectCount  = document.getElementById('projectCount');
const progressWrap  = document.getElementById('progressWrap');
const progressBar   = document.getElementById('progressBar');
const etaDisplay    = document.getElementById('etaDisplay');
const doneOverlay   = document.getElementById('doneOverlay');
const doneSub       = document.getElementById('doneSub');
const header        = document.getElementById('header');
const prevFile      = document.getElementById('prevFile');
const prevFileTxt   = document.getElementById('prevFileTxt');
const updateBtn     = document.getElementById('updateBtn');
const resumeBar     = document.getElementById('resumeBar');
const resumeText    = document.getElementById('resumeText');
const resumeBtn     = document.getElementById('resumeBtn');
const freshBtn      = document.getElementById('freshBtn');

let port  = null;
let tabId = null;

let previousExportData = null; // full array from loaded file
let knownConvsMap      = null; // { conversation_id: updated_at_iso }

// ── Formatters ─────────────────────────────────────────────
function formatEta(seconds) {
  if (seconds == null || seconds <= 0) return '';
  if (seconds < 10)  return '< 10 sec remaining';
  if (seconds < 60)  return `~${seconds} sec remaining`;
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `~${m}:${s} remaining`;
}

// ── UI helpers ─────────────────────────────────────────────
function setStatus(text, type = 'info') {
  doneOverlay.classList.remove('visible');
  statusBox.textContent = text;
  statusBox.className   = type;
}

function setProgress(pct) {
  progressWrap.classList.add('visible');
  progressBar.style.width = Math.min(100, Math.max(0, pct)) + '%';
}

function showDone(text) {
  statusBox.className = '';
  doneOverlay.classList.add('visible');
  header.classList.add('is-done');
  progressBar.classList.add('is-done');
  setProgress(100);
  etaDisplay.textContent = '';

  const lines = text.split('\n').filter(Boolean);
  doneSub.textContent = lines.slice(1).join('\n');

  exportBtn.disabled    = false;
  exportBtn.textContent = '📥 Export Again';
  if (knownConvsMap) updateBtn.disabled = false;
}

function resetToIdle() {
  doneOverlay.classList.remove('visible');
  header.classList.remove('is-done');
  progressBar.classList.remove('is-done');
  statusBox.className = '';
  etaDisplay.textContent = '';
  exportBtn.textContent = '📥 Export to JSON';
  if (knownConvsMap) updateBtn.disabled = false;
}

// ── On popup open: sync with content script state ──────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url?.includes('chatgpt.com')) {
    projectCount.textContent = '⚠️ Open chatgpt.com first!';
    exportBtn.disabled = true;
    return;
  }
  tabId = tab.id;

  let status;
  try {
    status = await chrome.tabs.sendMessage(tabId, { action: 'getStatus' });
  } catch {
    projectCount.textContent = '⚠️ Reload the chatgpt.com tab and try again.';
    exportBtn.disabled = true;
    return;
  }

  const n = status.projectCount || 0;
  projectCount.textContent = n > 0
    ? `✅ ${n} project${n !== 1 ? 's' : ''} detected`
    : '⚠️ No projects yet — hover over "More" in the sidebar';

  if (status.isExporting) {
    exportBtn.disabled = true;
    exportBtn.textContent = '⏳ Exporting…';
    setStatus(status.text || 'Export in progress…', 'info');
    setProgress(status.pct || 0);
    if (status.eta) etaDisplay.textContent = formatEta(status.eta);
    connectPort();

  } else if (status.lastResult) {
    const r = status.lastResult;
    if (r.type === 'done') {
      showDone(r.text);
    } else {
      setStatus('❌ ' + r.text, 'error');
    }
  }

  if (status.checkpoint && !status.isExporting) {
    const { count, total } = status.checkpoint;
    resumeText.textContent = `⚡ Interrupted at ${count}${total ? '/' + total : ''} conversations — resume or discard?`;
    resumeBar.classList.add('visible');
  }
}

// ── Long-lived port for live progress ─────────────────────
function connectPort() {
  if (!tabId) return;
  if (port) { try { port.disconnect(); } catch {} port = null; }
  port = chrome.tabs.connect(tabId, { name: 'export' });

  port.onMessage.addListener(msg => {
    switch (msg.type) {
      case 'progress':
        setStatus(msg.text, 'info');
        if (msg.pct != null) setProgress(msg.pct);
        etaDisplay.textContent = formatEta(msg.eta);
        break;

      case 'delta_done':
        if (previousExportData && Array.isArray(msg.delta)) {
          const merged  = [...previousExportData];
          const idxById = new Map(merged.map((c, i) => [c.conversation_id, i]));
          for (const conv of msg.delta) {
            const idx = idxById.get(conv.conversation_id);
            if (idx !== undefined) merged[idx] = conv;
            else merged.push(conv);
          }
          merged.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
          const today    = new Date().toISOString().slice(0, 10);
          const filename = `chatgpt_export_${today}.json`;
          const blob = new Blob([JSON.stringify(merged, null, 2)], { type: 'application/json' });
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href     = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          previousExportData = merged; // update in-memory for next chained update
          knownConvsMap = {};
          for (const c of merged) {
            if (c.conversation_id && c.updated_at) {
              knownConvsMap[c.conversation_id] = c.updated_at;
            }
          }
        }
        break;

      case 'done':
        showDone(msg.text);
        port = null;
        break;

      case 'error':
        resetToIdle();
        setStatus('❌ ' + msg.text, 'error');
        exportBtn.disabled = false;
        port = null;
        break;
    }
  });

  port.onDisconnect.addListener(() => { port = null; });
}

// ── Resume / Discard checkpoint ───────────────────────────
resumeBtn.addEventListener('click', () => {
  if (!tabId) return;
  resumeBar.classList.remove('visible');
  resetToIdle();
  exportBtn.disabled    = true;
  exportBtn.textContent = '⏳ Exporting…';
  setStatus('Resuming from checkpoint…', 'info');
  setProgress(0);
  connectPort();
  port.postMessage({ action: 'startExport', resumeFromCheckpoint: true });
});

freshBtn.addEventListener('click', () => {
  resumeBar.classList.remove('visible');
  if (tabId) chrome.tabs.sendMessage(tabId, { action: 'clearCheckpoint' });
});

// ── Export button ──────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  if (!tabId) return;
  resumeBar.classList.remove('visible');
  resetToIdle();
  exportBtn.disabled    = true;
  exportBtn.textContent = '⏳ Exporting…';
  setStatus('Starting…', 'info');
  setProgress(0);
  connectPort();
  port.postMessage({ action: 'startExport' });
});

// ── Previous export file picker ───────────────────────────
prevFile.addEventListener('change', async () => {
  const file = prevFile.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('not an array');
    previousExportData = data;
    knownConvsMap = {};
    let matched = 0;
    for (const conv of data) {
      if (conv.conversation_id && conv.updated_at) {
        knownConvsMap[conv.conversation_id] = conv.updated_at;
        matched++;
      }
    }
    const label = matched === data.length
      ? `✅ ${data.length} convs loaded`
      : `✅ ${data.length} convs (${matched} with timestamps)`;
    prevFileTxt.textContent = label;
    updateBtn.disabled = false;
  } catch {
    prevFileTxt.textContent = '❌ Invalid file — try again';
    previousExportData = null;
    knownConvsMap = null;
    updateBtn.disabled = true;
  }
});

// ── Incremental update button ─────────────────────────────
updateBtn.addEventListener('click', () => {
  if (!tabId || !knownConvsMap) return;

  resetToIdle();
  exportBtn.disabled    = true;
  updateBtn.disabled    = true;
  exportBtn.textContent = '⏳ Exporting…';
  setStatus('Starting incremental update…', 'info');
  setProgress(0);

  connectPort();
  port.postMessage({ action: 'startExport', knownConvs: knownConvsMap });
});

init();
