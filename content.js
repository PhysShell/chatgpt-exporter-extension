'use strict';
// =============================================================
// ChatGPT Exporter – Content Script
// - Export continues even if the popup is closed
// - Reconnecting the popup shows live progress
// - Only requirement: keep the chatgpt.com tab open
// =============================================================

(function () {
  const BASE = 'https://chatgpt.com/backend-api';
  const RateLimit = window.ChatGPTExporterRateLimit || {};
  const RL_CONFIG = RateLimit.DEFAULTS || {
    listDelayMs: 1200,
    detailDelayMs: 4000,
    otherDelayMs: 1200,
    minListDelayMs: 1000,
    minDetailDelayMs: 3500,
    minOtherDelayMs: 1000,
    maxListDelayMs: 30000,
    maxDetailDelayMs: 120000,
    maxOtherDelayMs: 30000,
    listInitialBackoffMs: 10000,
    detailInitialBackoffMs: 60000,
    otherInitialBackoffMs: 10000,
    networkInitialBackoffMs: 2500,
    maxBackoffMs: 15 * 60 * 1000,
    maxRetries: 4,
    cooldownFactor: 1.5,
    recoveryStepMs: 250,
    recoveryThreshold: 40,
    detailStartCooldownMs: 30000,
    detailBatchSize: 75,
    detailBatchCooldownMs: 45000,
    retrySweepCooldownMs: 10 * 60 * 1000,
  };

  // ── Persistent state (survives popup close/reopen) ─────────
  let isExporting  = false;
  let exportPort   = null;   // current popup port (may be null)
  let currentPct   = 0;
  let currentText  = '';
  let currentEta   = null;   // seconds remaining (null = unknown)
  let lastResult   = null;   // { type: 'done'|'error', text }
  const projects   = {};     // { "g-p-hex32": "Project Name" }
  let activeKnownConvs = null; // Map<id, updated_at_iso> set at export start for incremental mode

  // ── Utilities ──────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function isoFromUnix(t) {
    return (t != null) ? new Date(Math.floor(t) * 1000).toISOString() : null;
  }

  // ── Crash-recovery checkpoint ──────────────────────────────
  const CHECKPOINT_KEY      = 'chatgpt_exporter_checkpoint';
  const CHECKPOINT_INTERVAL = 50; // save every N successfully fetched conversations

  async function saveCheckpoint(data) {
    try { await chrome.storage.local.set({ [CHECKPOINT_KEY]: data }); }
    catch (e) { console.warn('[ChatGPT Exporter] checkpoint save failed:', e); }
  }

  async function loadCheckpoint() {
    try {
      const r = await chrome.storage.local.get(CHECKPOINT_KEY);
      return r[CHECKPOINT_KEY] || null;
    } catch { return null; }
  }

  async function clearCheckpoint() {
    try { await chrome.storage.local.remove(CHECKPOINT_KEY); } catch {}
  }

  // ── Rate limiter state (adaptive, endpoint-aware) ──────────
  const RL = {
    listDelayMs:       RL_CONFIG.listDelayMs,
    detailDelayMs:     RL_CONFIG.detailDelayMs,
    otherDelayMs:      RL_CONFIG.otherDelayMs,
    maxRetries:        RL_CONFIG.maxRetries,
    globalPauseUntil:  0,
    successStreak:     { list: 0, detail: 0, other: 0 },
  };

  function delayKey(kind) {
    return kind === 'detail' ? 'detailDelayMs' : kind === 'list' ? 'listDelayMs' : 'otherDelayMs';
  }

  function minDelayFor(kind) {
    return kind === 'detail' ? RL_CONFIG.minDetailDelayMs
      : kind === 'list' ? RL_CONFIG.minListDelayMs
        : RL_CONFIG.minOtherDelayMs;
  }

  function maxDelayFor(kind) {
    return kind === 'detail' ? RL_CONFIG.maxDetailDelayMs
      : kind === 'list' ? RL_CONFIG.maxListDelayMs
        : RL_CONFIG.maxOtherDelayMs;
  }

  function delayFor(kind) {
    return RL[delayKey(kind)];
  }

  function setDelayFor(kind, value) {
    RL[delayKey(kind)] = Math.max(minDelayFor(kind), Math.min(maxDelayFor(kind), Math.ceil(value)));
  }

  function requestKindFromUrl(url) {
    if (/\/conversation\/[^/?#]+/.test(url)) return 'detail';
    if (/\/conversations(?:[?#]|$)/.test(url) || /\/gizmos\/[^/]+\/conversations(?:[?#]|$)/.test(url)) return 'list';
    return 'other';
  }

  function formatDuration(ms) {
    if (RateLimit.formatDuration) return RateLimit.formatDuration(ms);
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  function computeBackoffMs(args) {
    if (RateLimit.computeBackoffMs) {
      return RateLimit.computeBackoffMs({ ...args, config: RL_CONFIG });
    }
    const initial = args.kind === 'detail' ? RL_CONFIG.detailInitialBackoffMs : RL_CONFIG.listInitialBackoffMs;
    return Math.min(RL_CONFIG.maxBackoffMs, initial * (2 ** Math.max(0, args.attempt || 0)));
  }

  function onRateLimited(kind) {
    RL.successStreak[kind] = 0;
    setDelayFor(kind, delayFor(kind) * RL_CONFIG.cooldownFactor);
  }

  function onSuccess(kind) {
    RL.successStreak[kind]++;
    if (RL.successStreak[kind] >= RL_CONFIG.recoveryThreshold && delayFor(kind) > minDelayFor(kind)) {
      setDelayFor(kind, delayFor(kind) - RL_CONFIG.recoveryStepMs);
      RL.successStreak[kind] = 0;
    }
  }

  async function waitForGlobalPause() {
    const wait = RL.globalPauseUntil - Date.now();
    if (wait > 0) await sleep(wait);
  }

  function armGlobalPause(waitMs) {
    RL.globalPauseUntil = Math.max(RL.globalPauseUntil, Date.now() + Math.max(0, waitMs));
  }

  // ── Auth ───────────────────────────────────────────────────
  async function getAccessToken() {
    try {
      const r = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
      if (!r.ok) return null;
      return (await r.json()).accessToken || null;
    } catch { return null; }
  }

  // Sentinel so callers distinguish "gave up / rate-limited" from "404 / truly missing".
  const RL_EXHAUSTED = Symbol('rate_limit_exhausted');
  const AUTH_EXHAUSTED = Symbol('auth_exhausted');

  function makeAuthHeaders(accessToken) {
    return accessToken
      ? { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' }
      : { Accept: 'application/json' };
  }

  function makeApiFetch(token) {
    let accessToken = token || null;

    return async function apiFetch(url, { retries = RL.maxRetries, kind = requestKindFromUrl(url) } = {}) {
      let attempt = 0;
      let authRefreshes = 0;
      while (true) {
        await waitForGlobalPause();
        let r;
        try {
          r = await fetch(url, { credentials: 'include', headers: makeAuthHeaders(accessToken) });
        } catch (e) {
          if (attempt >= retries) {
            console.warn('[ChatGPT Exporter] network error, giving up:', e.message, url);
            return null;
          }
          const wait = computeBackoffMs({ status: 'network', attempt, kind });
          console.warn(`[ChatGPT Exporter] network error, retry ${attempt + 1}/${retries} in ${formatDuration(wait)}:`, e.message);
          await sleep(wait);
          attempt++;
          continue;
        }

        if (r.status === 401) {
          console.warn('[ChatGPT Exporter] HTTP 401, refreshing session token:', url);
          progress('ChatGPT session token expired. Refreshing session...', currentPct, null);

          if (authRefreshes >= 2) {
            console.warn('[ChatGPT Exporter] authentication refresh failed, giving up:', url);
            return AUTH_EXHAUSTED;
          }

          authRefreshes++;
          const refreshedToken = await getAccessToken();
          if (refreshedToken && refreshedToken !== accessToken) {
            accessToken = refreshedToken;
            await sleep(1000);
            continue;
          }

          if (accessToken) {
            // Some endpoints accept cookie auth; retry once without a stale Bearer.
            accessToken = null;
            await sleep(1000);
            continue;
          }

          return AUTH_EXHAUSTED;
        }

        if (r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504) {
          onRateLimited(kind);
          const retryAfterHeader = r.headers.get('Retry-After');
          const wait = computeBackoffMs({ status: r.status, attempt, kind, retryAfterHeader });
          armGlobalPause(wait);
          if (wait >= 15000) {
            progress(
              `ChatGPT returned HTTP ${r.status}. Cooling down ${formatDuration(wait)} before retrying...`,
              currentPct,
              null
            );
          }
          if (attempt >= retries) {
            console.warn(`[ChatGPT Exporter] exhausted retries on HTTP ${r.status}, cooled down ${formatDuration(wait)}:`, url);
            await sleep(wait);
            return RL_EXHAUSTED;
          }
          console.warn(
            `[ChatGPT Exporter] HTTP ${r.status}, cooldown ${formatDuration(wait)} ` +
            `(attempt ${attempt + 1}/${retries}, ${kind} gap ${delayFor(kind)}ms)` +
            (retryAfterHeader ? `, Retry-After: ${retryAfterHeader}` : '')
          );
          await sleep(wait);
          attempt++;
          continue;
        }

        if (!r.ok) {
          console.warn('[ChatGPT Exporter] HTTP', r.status, url);
          return null;
        }
        onSuccess(kind);
        return r.json().catch(() => null);
      }
    };
  }

  function gapSleep(kind = 'other') { return sleep(delayFor(kind)); }

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

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
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
      created_at:      isoFromUnix(convData.create_time),
      updated_at:      isoFromUnix(convData.update_time),
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
      loadCheckpoint().then(cp => {
        sendResponse({
          isExporting,
          pct:          currentPct,
          text:         currentText,
          eta:          currentEta,
          lastResult,
          projectCount: Object.keys(projects).length,
          checkpoint:   cp ? { count: cp.fetchedCount, total: cp.totalHint, startedAt: cp.startedAt } : null,
        });
      });
      return true; // async response
    }
    if (msg.action === 'clearCheckpoint') {
      clearCheckpoint().then(() => sendResponse({}));
      return true;
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
      activeKnownConvs = msg.knownConvs ? new Map(Object.entries(msg.knownConvs)) : null;
      runExport(!!msg.resumeFromCheckpoint).catch(e => fail('Unexpected error: ' + e.message));
    });

    // Popup closed – export continues, port reference cleared
    port.onDisconnect.addListener(() => { exportPort = null; });
  });

  // ══════════════════════════════════════════════════════════
  // MAIN EXPORT
  // ══════════════════════════════════════════════════════════
  async function runExport(resumeMode = false) {
    progress('Getting auth token…', 2);
    const token = await getAccessToken();
    let apiFetch = makeApiFetch(token); // `let` so auth restore can swap it

    // Wait for the user to log back in instead of failing immediately.
    // Returns true if auth was restored, false if we gave up (30 min timeout).
    async function restoreAuth() {
      progress('ChatGPT session expired — log back in at chatgpt.com, export resumes automatically…', currentPct, null);
      for (let w = 0; w < 60; w++) {
        await sleep(30_000);
        const fresh = await getAccessToken();
        if (fresh) { apiFetch = makeApiFetch(fresh); return true; }
      }
      return false;
    }

    // Load checkpoint (resume) or clear stale one (fresh start)
    let checkpointFetchedIds   = new Set();
    let checkpointConversations = [];
    const checkpointStartedAt  = resumeMode ? null : new Date().toISOString();

    if (resumeMode) {
      const cp = await loadCheckpoint();
      if (cp) {
        checkpointFetchedIds    = new Set(cp.fetchedIds || []);
        checkpointConversations = cp.conversations || [];
        progress(
          `Resuming: ${checkpointFetchedIds.size} conversations already saved — re-fetching conversation list…`,
          5
        );
      } else {
        resumeMode = false;
        progress('No saved checkpoint found — starting fresh…', 2);
      }
    } else {
      await clearCheckpoint();
    }

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
          `${BASE}/gizmos/${gizmoId}/conversations?cursor=${encodeURIComponent(cursor)}`,
          { kind: 'list' }
        );
        if (data === AUTH_EXHAUSTED) {
          if (!await restoreAuth()) { fail('Session could not be restored after 30 min. Restart the export.'); return; }
          continue;
        }
        if (!data || data === RL_EXHAUSTED) break;
        const items = Array.isArray(data) ? data : (data.items || data.conversations || []);
        if (!items.length) break;
        projectConvMeta[gizmoId].push(...items);
        console.log('[ChatGPT Exporter] project fetched:', projects[gizmoId], projectConvMeta[gizmoId].length, 'next cursor:', data.cursor || data.next_cursor);
        const next = data.cursor || data.next_cursor || null;
        if (!next || next === cursor) break;
        cursor = next;
        await gapSleep('list');
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
    const pageSize = 50;
    while (true) {
      const url = `${BASE}/conversations?offset=${regularConvMeta.length}&limit=${pageSize}`;
      const data = await apiFetch(url, { kind: 'list' });

      if (data === AUTH_EXHAUSTED) {
        if (!await restoreAuth()) { fail('Session could not be restored after 30 min. Restart the export.'); return; }
        continue;
      }
      if (!data || data === RL_EXHAUSTED) break;

      const items = data.items || [];

      console.log(
        '[ChatGPT Exporter] regular fetched batch:',
        items.length,
        'total:',
        regularConvMeta.length + items.length,
        'url:',
        url
      );

      if (!items.length) break;

      regularConvMeta.push(...items);

      if (items.length < pageSize) break;

      await gapSleep('list');
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

    if (total > 200) {
      progress(
        `Cooling down ${formatDuration(RL_CONFIG.detailStartCooldownMs)} before full conversation downloads...`,
        34,
        null
      );
      await sleep(RL_CONFIG.detailStartCooldownMs);
    }

    // 5. Fetch details + flatten to JSON
    // Seed from checkpoint so a crash mid-run loses at most CHECKPOINT_INTERVAL fetches.
    const fetchedIds    = checkpointFetchedIds;        // Set<id> of already-fetched convs
    const conversations = checkpointConversations;     // array, pre-populated on resume
    const deferred      = [];  // rate-limit-exhausted → sweep later
    const missing       = [];  // genuine nulls (404 etc)
    const detailStart   = Date.now();
    const today         = new Date().toISOString().slice(0, 10);
    const isIncremental = !!(activeKnownConvs && activeKnownConvs.size > 0);
    let   skippedCount  = 0;

    function failWithPartial(reason) {
      clearCheckpoint();
      if (conversations.length) {
        const tag      = isIncremental ? 'delta_partial' : 'partial';
        const filename = `chatgpt_export_${tag}_${today}_${conversations.length}_of_${total}.json`;
        downloadJson(conversations, filename);
        const skippedNote = isIncremental ? `, ${skippedCount} unchanged` : '';
        fail(`${reason}\nSaved partial file: ${filename}\nExported so far: ${conversations.length}/${total}${skippedNote}.`);
        return;
      }
      fail(reason);
    }

    for (let i = 0; i < allMeta.length; i++) {
      const conv = allMeta[i];
      const pct  = 35 + Math.round((i + 1) / total * 60);

      // Resume: skip conversations already saved in a previous (crashed) run
      if (fetchedIds.has(conv.id)) {
        if (fetchedIds.size % 100 === 0 || i === allMeta.length - 1) {
          progress(`Resuming: skipping already-saved ${fetchedIds.size}/${total}…`, pct);
        }
        continue;
      }

      // Incremental: skip conversations that haven't changed since previous export
      if (activeKnownConvs) {
        const storedUpdatedAt  = activeKnownConvs.get(conv.id);
        const currentUpdatedAt = isoFromUnix(conv.update_time);
        if (storedUpdatedAt && currentUpdatedAt && storedUpdatedAt === currentUpdatedAt) {
          skippedCount++;
          if (skippedCount % 100 === 0 || i === allMeta.length - 1) {
            progress(`Checking ${i + 1}/${total}: ${skippedCount} unchanged so far…`, pct);
          }
          continue; // no API call, no sleep
        }
      }

      let eta = null;
      if (i > 0) {
        const elapsed = (Date.now() - detailStart) / 1000;
        eta = Math.round(elapsed / i * (total - i));
      }

      progress(
        `Downloading (${i + 1}/${total}): "${(conv.title || 'Untitled').slice(0, 40)}" [gap ${delayFor('detail')}ms]`,
        pct,
        eta
      );

      const data = await apiFetch(`${BASE}/conversation/${conv.id}`, { kind: 'detail' });
      if (data === AUTH_EXHAUSTED) {
        if (!await restoreAuth()) { failWithPartial('Session could not be restored after 30 min.'); return; }
        i--; continue; // retry same conversation with fresh token
      } else if (data === RL_EXHAUSTED) {
        deferred.push(conv);
      } else if (!data) {
        missing.push(conv);
      } else {
        conversations.push(conversationToFlat(data, conv._project_name || null));
        fetchedIds.add(conv.id);
        if (fetchedIds.size % CHECKPOINT_INTERVAL === 0) {
          await saveCheckpoint({
            fetchedIds:   [...fetchedIds],
            conversations,
            fetchedCount: fetchedIds.size,
            totalHint:    total,
            startedAt:    checkpointStartedAt,
          });
        }
      }
      if ((i + 1) % RL_CONFIG.detailBatchSize === 0 && i + 1 < allMeta.length) {
        progress(
          `Batch pause ${formatDuration(RL_CONFIG.detailBatchCooldownMs)} after ${i + 1}/${total} conversations...`,
          pct,
          eta
        );
        await sleep(RL_CONFIG.detailBatchCooldownMs);
      }
      await gapSleep('detail');
    }

    // 5b. Retry sweep for rate-limited conversations with cooler pace.
    if (deferred.length) {
      const originalDetailDelay = RL.detailDelayMs;
      setDelayFor('detail', Math.max(delayFor('detail') * 2, 15000));
      console.log(`[ChatGPT Exporter] retry sweep: ${deferred.length} rate-limited convs, gap ${delayFor('detail')}ms`);
      progress(
        `Cooling down ${formatDuration(RL_CONFIG.retrySweepCooldownMs)} before retrying ${deferred.length} rate-limited conversations...`,
        95,
        null
      );
      await sleep(RL_CONFIG.retrySweepCooldownMs);
      for (let i = 0; i < deferred.length; i++) {
        const conv = deferred[i];
        const pct  = 95 + Math.round((i + 1) / deferred.length * 2);
        progress(`Retry (${i + 1}/${deferred.length}): "${(conv.title || 'Untitled').slice(0, 40)}"`, pct);
        const data = await apiFetch(`${BASE}/conversation/${conv.id}`, { retries: RL.maxRetries + 1, kind: 'detail' });
        if (data === AUTH_EXHAUSTED) {
          if (!await restoreAuth()) { failWithPartial('Session could not be restored after 30 min.'); return; }
          i--; continue;
        } else if (data && data !== RL_EXHAUSTED) {
          conversations.push(conversationToFlat(data, conv._project_name || null));
        } else {
          missing.push(conv);
        }
        await gapSleep('detail');
      }
      RL.detailDelayMs = originalDetailDelay;
    }

    if (missing.length) {
      console.warn(`[ChatGPT Exporter] ${missing.length} conversations could not be fetched:`,
        missing.map(c => c.id));
    }

    // 6. Build JSON & trigger download
    await clearCheckpoint();
    progress('Creating JSON…', 98);

    const missSuffix = missing.length
      ? `\n${missing.length} could not be fetched (see console).`
      : '';

    if (isIncremental) {
      const deltaFilename = `chatgpt_delta_${today}_${conversations.length}new.json`;
      const doneText =
        `Done! ${conversations.length} new/updated, ${skippedCount} unchanged.\n` +
        `Delta file: ${deltaFilename}` + missSuffix;
      if (exportPort) {
        try {
          exportPort.postMessage({ type: 'delta_done', delta: conversations, skipped: skippedCount });
          done(doneText);
          return;
        } catch { exportPort = null; }
      }
      // Popup not connected — save delta directly so nothing is lost
      downloadJson(conversations, deltaFilename);
      done(doneText);
    } else {
      downloadJson(conversations, `chatgpt_export_${today}.json`);
      done(
        `Done! ${conversations.length} conversations exported.\n` +
        `File: chatgpt_export_${today}.json` + missSuffix
      );
    }
  }

})();
