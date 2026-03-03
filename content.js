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

  function safeFilename(name, maxLen = 80) {
    return (name || 'Untitled')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, maxLen) || 'Untitled';
  }

  function formatDate(unixTs) {
    if (!unixTs) return '0000-00-00';
    return new Date(unixTs * 1000).toISOString().slice(0, 10);
  }

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
  // MARKDOWN CONVERSION
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
          if (text) path.push({ role, text, time: msg.create_time || 0 });
        }
      }
      nodeId = node.parent;
    }
    path.reverse();
    return path;
  }

  function conversationToMarkdown(convData) {
    const title      = (convData.title || 'Untitled').replace(/\n+/g, ' ');
    const createTime = convData.create_time || 0;
    const updateTime = convData.update_time || 0;
    const convId     = convData.id || '';
    const lines      = [`# ${title}`, ''];
    if (createTime) lines.push(`**Created:** ${new Date(createTime * 1000).toLocaleString()}`);
    if (updateTime && updateTime !== createTime)
      lines.push(`**Updated:** ${new Date(updateTime * 1000).toLocaleString()}`);
    if (convId) lines.push(`**ID:** \`${convId}\``);
    lines.push('', '---', '');
    const messages = extractMessages(convData);
    if (!messages.length) {
      lines.push('*(Empty or unreadable conversation)*');
    } else {
      for (const msg of messages) {
        lines.push(msg.role === 'user' ? '### You' : '### ChatGPT');
        lines.push('', msg.text, '', '---', '');
      }
    }
    return lines.join('\n');
  }

  // ══════════════════════════════════════════════════════════
  // MINIMAL ZIP BUILDER (no external deps, store method)
  // ══════════════════════════════════════════════════════════
  const CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();

  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++)
      crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xFFFF, true); return b; }
  function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0,   true); return b; }

  function concat(arrays) {
    const total  = arrays.reduce((s, a) => s + a.length, 0);
    const result = new Uint8Array(total);
    let   pos    = 0;
    for (const a of arrays) { result.set(a, pos); pos += a.length; }
    return result;
  }

  // files: Array of { path: string, data: Uint8Array }
  function buildZip(files) {
    const enc         = new TextEncoder();
    const localChunks = [];
    const centralDir  = [];
    let   offset      = 0;

    for (const { path, data } of files) {
      const nameBytes = enc.encode(path);
      const crc       = crc32(data);
      const size      = data.length;

      const local = concat([
        new Uint8Array([0x50, 0x4B, 0x03, 0x04]),
        u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size),
        u16(nameBytes.length), u16(0),
        nameBytes, data,
      ]);
      const central = concat([
        new Uint8Array([0x50, 0x4B, 0x01, 0x02]),
        u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
        u32(offset), nameBytes,
      ]);

      localChunks.push(local);
      centralDir.push(central);
      offset += local.length;
    }

    const cdSize = centralDir.reduce((s, c) => s + c.length, 0);
    const eocd   = concat([
      new Uint8Array([0x50, 0x4B, 0x05, 0x06]),
      u16(0), u16(0),
      u16(files.length), u16(files.length),
      u32(cdSize), u32(offset), u16(0),
    ]);

    return concat([...localChunks, ...centralDir, eocd]);
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

    // 5. Fetch details + convert to Markdown
    const zipFiles      = [];
    const usedNames     = {};
    const detailStart   = Date.now();
    const enc           = new TextEncoder();

    for (let i = 0; i < allMeta.length; i++) {
      const conv    = allMeta[i];
      const pct     = 35 + Math.round((i + 1) / total * 62);

      // ETA: elapsed / done * remaining
      let eta = null;
      if (i > 0) {
        const elapsed = (Date.now() - detailStart) / 1000;
        eta = Math.round(elapsed / i * (total - i));
      }

      progress(`Downloading (${i + 1}/${total}): "${(conv.title || 'Untitled').slice(0, 40)}"`, pct, eta);

      const data = await apiFetch(`${BASE}/conversation/${conv.id}`);
      if (!data) { await sleep(300); continue; }

      const projName   = conv._project_name;
      const folderPath = projName
        ? `chatgpt_export/Projects/${safeFilename(projName)}/`
        : 'chatgpt_export/Conversations/';

      const date     = formatDate(data.create_time || conv.create_time);
      const baseFile = `${date}_${safeFilename(data.title || conv.title || 'Untitled')}`;
      usedNames[folderPath] = usedNames[folderPath] || {};
      let filename = baseFile + '.md';
      let counter  = 1;
      while (usedNames[folderPath][filename]) filename = `${baseFile}_${counter++}.md`;
      usedNames[folderPath][filename] = true;

      zipFiles.push({ path: folderPath + filename, data: enc.encode(conversationToMarkdown(data)) });
      await sleep(300);
    }

    // 6. Build ZIP & trigger download
    progress('Creating ZIP…', 98);
    const today   = new Date().toISOString().slice(0, 10);
    const zipData = buildZip(zipFiles);
    const blob    = new Blob([zipData], { type: 'application/zip' });
    const url     = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    a.href        = url;
    a.download    = `chatgpt_export_${today}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    done(
      `Done! ${zipFiles.length} conversations exported.\n` +
      `File: chatgpt_export_${today}.zip`
    );
  }

})();
