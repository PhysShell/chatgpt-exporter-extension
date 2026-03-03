'use strict';

const exportBtn    = document.getElementById('exportBtn');
const statusBox    = document.getElementById('statusBox');
const projectCount = document.getElementById('projectCount');
const progressWrap = document.getElementById('progressWrap');
const progressBar  = document.getElementById('progressBar');
const etaDisplay   = document.getElementById('etaDisplay');
const doneOverlay  = document.getElementById('doneOverlay');
const doneSub      = document.getElementById('doneSub');
const header       = document.getElementById('header');

let port  = null;
let tabId = null;

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
  // Hide regular status, show the big done overlay
  statusBox.className = '';
  doneOverlay.classList.add('visible');
  header.classList.add('is-done');
  progressBar.classList.add('is-done');
  setProgress(100);
  etaDisplay.textContent = '';

  // Parse detail lines out of the done text
  const lines = text.split('\n').filter(Boolean);
  doneSub.textContent = lines.slice(1).join('\n'); // everything after first line

  exportBtn.disabled   = false;
  exportBtn.textContent = '📥 Export Again';
}

function resetToIdle() {
  doneOverlay.classList.remove('visible');
  header.classList.remove('is-done');
  progressBar.classList.remove('is-done');
  statusBox.className = '';
  etaDisplay.textContent = '';
  exportBtn.textContent = '📥 Export to ZIP';
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

// ── Export button ──────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  if (!tabId) return;

  resetToIdle();
  exportBtn.disabled    = true;
  exportBtn.textContent = '⏳ Exporting…';
  setStatus('Starting…', 'info');
  setProgress(0);

  connectPort();
  port.postMessage({ action: 'startExport' });
});

init();
