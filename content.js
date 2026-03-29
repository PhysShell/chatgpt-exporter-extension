'use strict';
// =============================================================
// ChatGPT Exporter – Content Script
// - Export continues even if the popup is closed
// - Reconnecting the popup shows live progress
// - Only requirement: keep the chatgpt.com tab open
// =============================================================

(function () {
  const BASE = 'https://chatgpt.com/backend-api';

  // ── Persistent state (survives popup close/reopen) ─────────
  let isExporting  = false;
  let exportPort   = null;   // current popup port (may be null)
  let currentPct   = 0;
  let currentText  = '';
  let currentEta   = null;   // seconds remaining (null = unknown)
  let lastResult   = null;   // { type: 'done'|'error', text }
  const projects   = {};     // { "g-p-hex32": "Project Name" }

  // ── Utilities ──────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Auth ───────────────────────────────────────────────────
  async function getAccessToken() {
    try {
      const r = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
      if (!r.ok) return null;
      return (await r.json()).accessToken || null;
    } catch { return null; }
  }

  function makeApiFetch(token) {
    return async function apiFetch(url) {
      try {
        const headers = token ? { Authorization: 'Bearer ' + token } : {};
        const r = await fetch(url, { credentials: 'include', headers });
        if (!r.ok) { console.warn('[ChatGPT Exporter] HTTP', r.status, url); return null; }
        return r.json().catch(() => null);
      } catch (e) {
        console.warn('[ChatGPT Exporter] fetch error:', e.message);
        return null;
      }
    };
  }

  // ── Progress (safe even when popup is closed) ──────────────
  function progress(text, pct, eta = null) {
    currentText = text;
    currentEta  = eta;
    if (pct != null) currentPct = pct;
    if (exportPort) {
      try { exportPort.postMessage({ type: 'progress', text, pct: currentPct, eta }); }
      catch { exportPort = null; }
    }
  }

  function done(text) {
    lastResult  = { type: 'done', text };
    isExporting = false;
    currentPct  = 100;
    currentEta  = null;
    playDoneSound();
    if (exportPort) {
      try { exportPort.postMessage({ type: 'done', text }); }
      catch {}
      exportPort = null;
    }
  }

  function fail(text) {
    lastResult  = { type: 'error', text };
    isExporting = false;
    currentEta  = null;
    if (exportPort) {
      try { exportPort.postMessage({ type: 'error', text }); }
      catch {}
      exportPort = null;
    }
  }

  // ── Befejezési hangjelzés (Web Audio API, engedély nélkül) ─
  function playDoneSound() {
    try {
      const ctx  = new AudioContext();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);

      // Két emelkedő hang: "ta-dum"
      [[880, 0, 0.12], [1320, 0.15, 0.25]].forEach(([freq, start, end]) => {
        const osc = ctx.createOscillator();
        osc.connect(gain);
        osc.type            = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, ctx.currentTime + start);
        gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + start + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + end);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + end);
      });
    } catch { /* AudioContext not available */ }
  }

  // ══════════════════════════════════════════════════════════
  // CONVERSATION → FLAT JSON
  // ══════════════════════════════════════════════════════════
  function extractText(content) {
    const ct = content.content_type || 'text';
    let text = '';
    if (ct === 'text') {
      text = (content.parts || []).filter(p => typeof p === 'string').join('\n');
    } else if (['multimodal_text', 'code', 'tether_browsing_display'].includes(ct)) {
      for (const part of (content.parts || [])) {
        if (typeof part === 'string') text += part + '\n';
        else if (part && typeof part === 'object') {
          if (part.content_type === 'image_asset_pointer') text += '[Image]\n';
          else if (part.text) text += part.text + '\n';
        }
      }
    }
    return text;
  }

  function extractMessages(convData) {
    const mapping = convData.mapping || {};
    let   nodeId  = convData.current_node;
    const visited = new Set();
    const path    = [];
    while (nodeId && !visited.has(nodeId)) {
      visited.add(nodeId);
      const node = mapping[nodeId] || {};
      const msg  = node.message;
      if (msg) {
        const role    = (msg.author || {}).role || '';
        const content = msg.content || {};
        if ((role === 'user' || role === 'assistant') && content) {
          const text = extractText(content).trim();
          if (text) path.push({ role, text });
        }
      }
      nodeId = node.parent;
    }
    path.reverse();
    return path;
  }

  function conversationToFlat(convData, projectName) {
    return {
      project:         projectName || null,
      conversation_id: convData.id || '',
      title:           (convData.title || 'Untitled').replace(/\n+/g, ' '),
      created_at:      convData.create_time
                         ? new Date(convData.create_time * 1000).toISOString()
                         : null,
      messages: extractMessages(convData).map(m => ({
        role:    m.role,
        content: m.text,
      })),
    };
  }

  // ── Project detection ──────────────────────────────────────
  function extractGizmoId(href) {
    const m = href.match(/\/g\/(g-p-[a-f0-9]+)/);
    return m ? m[1] : null;
  }

  function captureProjectsFromDOM() {
    document.querySelectorAll('a[href*="/g/g-p-"]').forEach(a => {
      const id = extractGizmoId(a.href);
      if (!id || projects[id]) return;
      const li   = a.closest('li, [role="option"], [role="listitem"], [role="menuitem"]');
      const name = (li?.innerText || a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      projects[id] = name || 'Unnamed project';
    });
  }

  const domObserver = new MutationObserver(captureProjectsFromDOM);
  domObserver.observe(document.body, { childList: true, subtree: true });
  captureProjectsFromDOM();

  async function tryOpenMoreProjects() {
    const btn = [...document.querySelectorAll('button, a, li')]
      .find(el => ['Továbbiak', 'More', 'Show more'].includes((el.textContent || '').trim()));
    if (btn) {
      btn.click();
      await sleep(1200);
      captureProjectsFromDOM();
      await sleep(400);
      captureProjectsFromDOM();
    }
  }

  // ── Chrome message & port listeners ───────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'getProjects') {
      sendResponse({ count: Object.keys(projects).length });
      return false;
    }
    if (msg.action === 'getStatus') {
      sendResponse({
        isExporting,
        pct:         currentPct,
        text:        currentText,
        eta:         currentEta,
        lastResult,
        projectCount: Object.keys(projects).length,
      });
      return false;
    }
  });

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'export') return;

    // If a previous popup disconnected mid-export, reconnect it
    exportPort = port;

    // Immediately push current state to the (re)opened popup
    if (isExporting) {
      port.postMessage({ type: 'progress', text: currentText, pct: currentPct, eta: currentEta });
    } else if (lastResult) {
      port.postMessage(lastResult);
    }

    port.onMessage.addListener(msg => {
      if (msg.action !== 'startExport') return;
      if (isExporting) {
        // Already running – just send current state (popup already updated above)
        port.postMessage({ type: 'progress', text: currentText, pct: currentPct });
        return;
      }
      lastResult  = null;
      isExporting = true;
      runExport().catch(e => fail('Unexpected error: ' + e.message));
    });

    // Popup closed – export continues, port reference cleared
    port.onDisconnect.addListener(() => { exportPort = null; });
  });

  // ══════════════════════════════════════════════════════════
  // MAIN EXPORT
  // ══════════════════════════════════════════════════════════
  async function runExport() {
    progress('Getting auth token…', 2);
    const token    = await getAccessToken();
    const apiFetch = makeApiFetch(token);

    // 1. Discover projects
    progress('Detecting projects…', 5);
    await tryOpenMoreProjects();
    const projectIds = Object.keys(projects);
    progress(`Found ${projectIds.length} project${projectIds.length !== 1 ? 's' : ''}`, 10);

    // 2. Project conversations
    const projectConvMeta = {};
    for (let pi = 0; pi < projectIds.length; pi++) {
      const gizmoId = projectIds[pi];
      projectConvMeta[gizmoId] = [];
      let cursor = '0';
      while (true) {
        const data = await apiFetch(
          `${BASE}/gizmos/${gizmoId}/conversations?cursor=${encodeURIComponent(cursor)}`
        );
        if (!data) break;
        const items = Array.isArray(data) ? data : (data.items || data.conversations || []);
        if (!items.length) break;
        projectConvMeta[gizmoId].push(...items);
        const next = data.cursor || data.next_cursor || null;
        if (!next || !data.has_more) break;
        cursor = next;
        await sleep(300);
      }
      const pct = 10 + Math.round((pi + 1) / projectIds.length * 20);
      progress(
        `Projects (${pi + 1}/${projectIds.length}): "${projects[gizmoId].slice(0, 35)}" – ${projectConvMeta[gizmoId].length} convs`,
        pct
      );
    }

    // 3. Regular conversations
    progress('Fetching regular conversations…', 32);
    const regularConvMeta = [];
    let cursor = '0';
    while (true) {
      const data = await apiFetch(`${BASE}/conversations?cursor=${encodeURIComponent(cursor)}`);
      if (!data) break;
      const items = data.items || [];
      regularConvMeta.push(...items);
      const next = data.cursor || data.next_cursor || null;
      if (!next || !data.has_more || !items.length) break;
      cursor = next;
      await sleep(300);
    }

    // 4. Deduplicate
    const seenIds = new Set();
    const allMeta = [];
    for (const [gizmoId, convs] of Object.entries(projectConvMeta)) {
      for (const c of convs) {
        if (!c.id || seenIds.has(c.id)) continue;
        seenIds.add(c.id);
        allMeta.push({ ...c, _gizmo_id: gizmoId, _project_name: projects[gizmoId] });
      }
    }
    for (const c of regularConvMeta) {
      if (!c.id || seenIds.has(c.id)) continue;
      seenIds.add(c.id);
      allMeta.push(c);
    }
    const total = allMeta.length;
    if (!total) { fail('No conversations found.'); return; }

    // 5. Fetch details + flatten to JSON
    const conversations = [];
    const detailStart   = Date.now();

    for (let i = 0; i < allMeta.length; i++) {
      const conv = allMeta[i];
      const pct  = 35 + Math.round((i + 1) / total * 62);

      // ETA: elapsed / done * remaining
      let eta = null;
      if (i > 0) {
        const elapsed = (Date.now() - detailStart) / 1000;
        eta = Math.round(elapsed / i * (total - i));
      }

      progress(`Downloading (${i + 1}/${total}): "${(conv.title || 'Untitled').slice(0, 40)}"`, pct, eta);

      const data = await apiFetch(`${BASE}/conversation/${conv.id}`);
      if (!data) { await sleep(300); continue; }

      conversations.push(conversationToFlat(data, conv._project_name || null));
      await sleep(300);
    }

    // 6. Build JSON & trigger download
    progress('Creating JSON…', 98);
    const today = new Date().toISOString().slice(0, 10);
    const blob  = new Blob([JSON.stringify(conversations, null, 2)], { type: 'application/json' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href      = url;
    a.download  = `chatgpt_export_${today}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    done(
      `Done! ${conversations.length} conversations exported.\n` +
      `File: chatgpt_export_${today}.json`
    );
  }

})();
