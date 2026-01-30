(function () {
  'use strict';

  const MIN_NODES = 400;
  const MIN_FRACTION_IF_OVER_MIN = 0.95;

  const BATCH_SIZE = 30;
  const GRADIENT_STEPS = 10;

  const SAFE_MAX_TARGETS = 2500;
  const SAFE_STYLE_ID = 'waspline-safe-style';

  const SAFE_CHUNK_UNITS = 10;
  const SAFE_PHASE_STRENGTH = 0.65;
  const SAFE_APPLY_BATCH = 400;

  const SAFE_GMAIL_SPLIT_MAX_LINES = 600;

  const colorCache = new Map();

  let lastApply = null;
  let observer = null;
  let reapplyTimer = null;

  let isProcessing = false;
  let pendingApply = null;

  let generation = 0;

  let safeActive = false;
  let safeMO = null;
  let safeNextIndex = 0;
  let safeLastMessage = null;

  function isLikelyChatGPT() {
    const host = location.host || '';
    return host.includes('chatgpt.com') || host.includes('chat.openai.com');
  }

  function isLikelyGmail() {
    return location.host === 'mail.google.com';
  }

  function hex_to_rgb(hex) {
    if (colorCache.has(hex)) return colorCache.get(hex);
    const result = [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16)
    ];
    colorCache.set(hex, result);
    return result;
  }

  function computeGradientColors(baseColor, activeColor, steps, gradientSize) {
    const colors = new Array(steps);
    const factor = (Number.isFinite(gradientSize) ? gradientSize : 50) / 50;
    const denom = ((steps - 1) * factor) || 1;

    for (let i = 0; i < steps; i++) {
      let t = 1 - (i / denom);
      if (t < 0) t = 0;
      if (t > 1) t = 1;

      const r = (baseColor[0] * (1 - t) + activeColor[0] * t) | 0;
      const g = (baseColor[1] * (1 - t) + activeColor[1] * t) | 0;
      const b = (baseColor[2] * (1 - t) + activeColor[2] * t) | 0;
      colors[i] = `rgb(${r},${g},${b})`;
    }
    return colors;
  }

  function dedupePreserveOrder(nodes) {
    const seen = new Set();
    const out = [];
    for (const n of nodes) {
      if (!n || !n.tagName) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }

  function clampInt(n, min, max) {
    n = Number(n);
    if (!Number.isFinite(n)) n = min;
    n = Math.round(n);
    return Math.max(min, Math.min(max, n));
  }

  function parseHexColor(hex) {
    if (!hex || typeof hex !== 'string') return [0, 0, 0];
    const h = hex.trim();
    if (!/^#([0-9a-fA-F]{6})$/.test(h)) return [0, 0, 0];
    return [
      parseInt(h.slice(1, 3), 16),
      parseInt(h.slice(3, 5), 16),
      parseInt(h.slice(5, 7), 16)
    ];
  }

  function mixRgb(a, b, t) {
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    const r = (a[0] + (b[0] - a[0]) * t) | 0;
    const g = (a[1] + (b[1] - a[1]) * t) | 0;
    const bb = (a[2] + (b[2] - a[2]) * t) | 0;
    return [r, g, bb];
  }

  function rgbToCss(rgb) {
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  }

  // =========================
  // SAFE MODE
  // =========================
  function ensureSafeStyleInjected() {
    if (document.getElementById(SAFE_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = SAFE_STYLE_ID;
    style.textContent = `
      .waspline-safe {
        background: linear-gradient(
          var(--wasp-dir, 90deg),
          var(--wasp-c1),
          var(--wasp-mid, var(--wasp-base)),
          var(--wasp-c2)
        ) !important;

        -webkit-background-clip: text !important;
        background-clip: text !important;
        color: transparent !important;
        -webkit-text-fill-color: transparent !important;
      }

      li.waspline-safe::marker {
        color: var(--wasp-base) !important;
        -webkit-text-fill-color: var(--wasp-base) !important;
      }

      pre.waspline-safe, code.waspline-safe {
        background: unset !important;
        -webkit-background-clip: unset !important;
        background-clip: unset !important;
        color: unset !important;
        -webkit-text-fill-color: unset !important;
      }

      .waspline-safe-gmail-line {
        display: inline;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function setSafeCSSVars(colors, baseColorHex) {
    const c1 = colors?.[0] || '#0000FF';
    const c2 = colors?.[1] || '#FF0000';
    const base = baseColorHex || '#FFFFFF';
    document.documentElement.style.setProperty('--wasp-c1', c1);
    document.documentElement.style.setProperty('--wasp-c2', c2);
    document.documentElement.style.setProperty('--wasp-base', base);
  }

  function isSimpleTextPlusBr(el) {
    if (!el) return false;
    if (el.isContentEditable) return false;
    const editableParent = el.closest?.('[contenteditable="true"]');
    if (editableParent) return false;

    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType === Node.ELEMENT_NODE && child.nodeName === 'BR') continue;
      return false;
    }
    return true;
  }

  function splitGmailPlainTextBlocksIfSafe() {
    if (!isLikelyGmail()) return 0;

    const blocks = Array.from(document.querySelectorAll('div.a3s div[dir="ltr"]'));
    let converted = 0;

    for (const el of blocks) {
      if (!el || !el.dataset) continue;
      if (el.dataset.wasplineSafeSplit === '1') continue;
      if (!isSimpleTextPlusBr(el)) continue;

      el.dataset.wasplineSafeSplit = '1';
      el.dataset.wasplineSafeOrigHtml = el.innerHTML;

      const lines = [];
      let current = '';

      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          current += child.nodeValue || '';
        } else if (child.nodeType === Node.ELEMENT_NODE && child.nodeName === 'BR') {
          lines.push(current);
          current = '';
        }
      }
      lines.push(current);

      if (lines.length > SAFE_GMAIL_SPLIT_MAX_LINES) {
        el.innerHTML = el.dataset.wasplineSafeOrigHtml || el.innerHTML;
        delete el.dataset.wasplineSafeOrigHtml;
        delete el.dataset.wasplineSafeSplit;
        continue;
      }

      const frag = document.createDocumentFragment();
      for (let i = 0; i < lines.length; i++) {
        const span = document.createElement('span');
        span.className = 'waspline-safe-gmail-line';
        const t = lines[i];
        span.textContent = (t === '' ? '\u00A0' : t);
        frag.appendChild(span);
        if (i !== lines.length - 1) frag.appendChild(document.createElement('br'));
      }

      while (el.firstChild) el.removeChild(el.firstChild);
      el.appendChild(frag);

      converted++;
    }

    return converted;
  }

  function restoreGmailPlainTextBlocks() {
    if (!isLikelyGmail()) return;
    const blocks = Array.from(document.querySelectorAll('div.a3s div[dir="ltr"][data-waspline-safe-split="1"]'));
    for (const el of blocks) {
      const orig = el.dataset.wasplineSafeOrigHtml;
      if (orig !== undefined) {
        el.innerHTML = orig;
      }
      delete el.dataset.wasplineSafeOrigHtml;
      delete el.dataset.wasplineSafeSplit;
    }
  }

  function getSafeTargets() {
    if (isLikelyGmail()) {
      const sel = [
        'div.a3s div[dir="ltr"] span.waspline-safe-gmail-line',
        'div.a3s p',
        'div.a3s li',
        'div.a3s blockquote'
      ].join(',');

      let nodes = Array.from(document.querySelectorAll(sel));

      const active = document.activeElement;
      if (active && active.isContentEditable) {
        nodes = nodes.filter(el => !active.contains(el));
      }

      return dedupePreserveOrder(nodes).slice(0, SAFE_MAX_TARGETS);
    }

    if (isLikelyChatGPT()) {
      const root =
        document.querySelector('main') ||
        document.querySelector('[role="main"]') ||
        document.body;

      const sel = [
        '[data-message-author-role] p',
        '[data-message-author-role] li',
        '[data-message-author-role] blockquote'
      ].join(',');

      return dedupePreserveOrder(Array.from(root.querySelectorAll(sel))).slice(0, SAFE_MAX_TARGETS);
    }

    return dedupePreserveOrder(
      Array.from(document.querySelectorAll('article p, main p, p, li, blockquote'))
    ).slice(0, SAFE_MAX_TARGETS);
  }

  function safeApplyToElement(el, message) {
    if (!el || !el.classList) return;
    if (el.closest && el.closest('pre, code')) return;

    const txt = (el.innerText || el.textContent || '').trim();
    if (!txt) return;

    if (el.dataset.wasplineSafeIdx === undefined) {
      el.dataset.wasplineSafeIdx = String(safeNextIndex++);
    }

    const idx = parseInt(el.dataset.wasplineSafeIdx, 10);
    if (!Number.isFinite(idx)) return;

    // NEW: user-controlled cycle length (lines per sweep)
    const cycle = clampInt(message?.safe_cycle_lines ?? 6, 2, 30);

    // We keep chunking conceptually, but the *rate* of change is controlled by cycle.
    // This ensures adjacent lines differ when cycle is small.
    const local = idx % SAFE_CHUNK_UNITS;
    const pos = local % cycle;
    const denom = Math.max(1, cycle - 1);
    const u = pos / denom;

    const eased = 0.5 - 0.5 * Math.cos(Math.PI * u);

    const c1 = parseHexColor(message?.colors?.[0] || '#0000FF');
    const c2 = parseHexColor(message?.colors?.[1] || '#FF0000');
    const base = parseHexColor(message?.color_text || '#FFFFFF');

    const lineColor = mixRgb(c1, c2, eased);
    const mid = mixRgb(base, lineColor, SAFE_PHASE_STRENGTH);

    const dir = (idx % 2 === 0) ? '90deg' : '270deg';

    el.style.setProperty('--wasp-mid', rgbToCss(mid));
    el.style.setProperty('--wasp-dir', dir);

    el.classList.add('waspline-safe');
  }

  function safeResetAll() {
    safeActive = false;

    try { safeMO && safeMO.disconnect(); } catch (_) {}
    safeMO = null;

    document.querySelectorAll('.waspline-safe').forEach(el => {
      el.classList.remove('waspline-safe');
      try { el.style.removeProperty('--wasp-mid'); } catch (_) {}
      try { el.style.removeProperty('--wasp-dir'); } catch (_) {}
    });

    document.querySelectorAll('[data-waspline-safe-idx]').forEach(el => {
      delete el.dataset.wasplineSafeIdx;
    });
    safeNextIndex = 0;
    safeLastMessage = null;

    restoreGmailPlainTextBlocks();

    document.documentElement.style.removeProperty('--wasp-c1');
    document.documentElement.style.removeProperty('--wasp-c2');
    document.documentElement.style.removeProperty('--wasp-base');
  }

  function applySafeTargetsInBatches(targets, message) {
    let i = 0;
    const n = targets.length;

    function step() {
      const end = Math.min(i + SAFE_APPLY_BATCH, n);
      for (; i < end; i++) {
        safeApplyToElement(targets[i], message);
      }
      if (i < n && safeActive) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  }

  function startSafeMutationObserver() {
    if (safeMO) return;
    safeMO = new MutationObserver(() => {
      if (!safeActive || !safeLastMessage) return;

      if (isLikelyGmail() && document.activeElement && document.activeElement.isContentEditable) return;

      if (isLikelyGmail()) splitGmailPlainTextBlocksIfSafe();

      const targets = getSafeTargets();
      applySafeTargetsInBatches(targets, safeLastMessage);
    });
    safeMO.observe(document.documentElement, { childList: true, subtree: true });
  }

  function applySafeMode(message) {
    ensureSafeStyleInjected();
    safeActive = true;
    safeLastMessage = message;

    setSafeCSSVars(message.colors, message.color_text);

    if (isLikelyGmail()) splitGmailPlainTextBlocksIfSafe();

    const targets = getSafeTargets();
    applySafeTargetsInBatches(targets, message);

    startSafeMutationObserver();
  }

  // =========================
  // FULL MODE (unchanged)
  // =========================
  function getCandidateNodesFullMode() {
    const genericSelector = [
      'article p', 'main p', '.content p', '.post p', '.article p',
      'p', 'li', 'blockquote',
      'div.a3s p', 'div.a3s li', 'div.a3s blockquote'
    ].join(',');

    const chatSelectorInsideMessages = [
      '[data-message-author-role] p',
      '[data-message-author-role] li',
      '[data-message-author-role] blockquote',
      '[data-message-author-role] .markdown',
      '[data-message-author-role] .prose',
      '[data-message-author-role] [data-message-content]',
      '[data-message-author-role] div'
    ].join(',');

    if (isLikelyChatGPT()) {
      const transcript =
        document.querySelector('main') ||
        document.querySelector('[role="main"]') ||
        document.body;

      let nodes = Array.from(transcript.querySelectorAll(chatSelectorInsideMessages));

      nodes = nodes.filter(el => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'main' || tag === 'body' || tag === 'html') return false;
        const childBlocks = el.querySelectorAll('p, li, blockquote').length;
        if (childBlocks >= 3 && (tag === 'div' || tag === 'section')) return false;
        return true;
      });

      return dedupePreserveOrder(nodes);
    }

    return Array.from(document.querySelectorAll(genericSelector));
  }

  function computeMaxNodes(totalCandidates, nodeCoveragePercent) {
    const total = Math.max(0, totalCandidates | 0);
    const pct = clampInt(nodeCoveragePercent, 0, 100);

    let maxNodes = Math.max(MIN_NODES, Math.round(total * (pct / 100)));
    if (maxNodes > MIN_NODES) {
      maxNodes = Math.max(maxNodes, Math.ceil(total * MIN_FRACTION_IF_OVER_MIN));
    }
    return Math.min(maxNodes, total);
  }

  function findViewportAnchorIndex(nodes) {
    const viewportCenterY = window.innerHeight / 2;
    let bestIdx = 0;
    let bestDist = Infinity;

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!el || !el.getBoundingClientRect) continue;
      const r = el.getBoundingClientRect();
      const centerY = (r.top + r.bottom) / 2;
      const dist = Math.abs(centerY - viewportCenterY);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function getTargetNodes(nodeCoveragePercent) {
    const candidates = getCandidateNodesFullMode();
    const total = candidates.length;
    if (total === 0) return [];

    const maxNodes = computeMaxNodes(total, nodeCoveragePercent);
    if (maxNodes >= total) return candidates;

    const anchor = findViewportAnchorIndex(candidates);

    const halfBefore = Math.floor(maxNodes / 2);
    const halfAfter = maxNodes - halfBefore;

    let start = anchor - halfBefore;
    let end = anchor + halfAfter;

    if (start < 0) { end += -start; start = 0; }
    if (end > total) {
      const over = end - total;
      start = Math.max(0, start - over);
      end = total;
    }

    return candidates.slice(start, end);
  }

  function ensureOriginalColorCaptured(el) {
    if (!el || !el.dataset) return;
    if (el.dataset.wasplineOrigComputed !== undefined) return;

    const inline = el.style.color || '';
    const hadInline = inline !== '' ? '1' : '0';

    let computed = '';
    try { computed = getComputedStyle(el).color || ''; } catch (_) { computed = ''; }

    el.dataset.wasplineOrigInline = inline;
    el.dataset.wasplineHadInline = hadInline;
    el.dataset.wasplineOrigComputed = computed;
  }

  function resetColorsFullMode() {
    const touched = document.querySelectorAll(
      '[data-waspline-orig-computed], [data-waspline-orig-inline], [data-waspline-had-inline]'
    );

    for (const el of touched) {
      const hadInline = el.dataset.wasplineHadInline === '1';
      const origInline = el.dataset.wasplineOrigInline ?? '';

      el.style.removeProperty('color');

      if (hadInline) {
        if (origInline === '') el.style.removeProperty('color');
        else el.style.color = origInline;
      }

      delete el.dataset.wasplineOrigInline;
      delete el.dataset.wasplineHadInline;
      delete el.dataset.wasplineOrigComputed;
    }

    document.querySelectorAll('[data-waspline-processed="1"]').forEach(n => delete n.dataset.wasplineProcessed);
  }

  function colorLine(spans, gradientColors, reverse) {
    const len = spans.length;
    const colorLen = gradientColors.length;

    for (let i = 0; i < len; i++) {
      const idx = reverse ? (len - 1 - i) : i;
      const colorIdx = Math.min(Math.floor(i * colorLen / len), colorLen - 1);
      const el = spans[idx];
      if (!el) continue;

      ensureOriginalColorCaptured(el);
      el.style.color = gradientColors[colorIdx];
    }
  }

  function processBatch(nodes, startIdx, colors, baseColor, gradientSize, lineno, resolve, myGen) {
    if (myGen !== generation) return resolve();

    const endIdx = Math.min(startIdx + BATCH_SIZE, nodes.length);
    const activeColors = colors.map(c => hex_to_rgb(c));

    for (let i = startIdx; i < endIdx; i++) {
      if (myGen !== generation) return resolve();

      const node = nodes[i];
      if (!node || !node.textContent || node.textContent.trim().length < 2) continue;
      if (node.closest && node.closest('pre, code')) continue;

      if (node.dataset.wasplineProcessed === '1') continue;
      node.dataset.wasplineProcessed = '1';

      try {
        const lines = lineWrapDetector.getLines(node);

        for (const line of lines) {
          if (!line || line.length === 0) continue;

          const colorIdx = Math.floor(lineno / 2) % activeColors.length;
          const isLeft = (lineno % 2 === 0);

          const gradientColors = computeGradientColors(
            baseColor,
            activeColors[colorIdx],
            Math.min(line.length, GRADIENT_STEPS),
            gradientSize
          );

          colorLine(line, gradientColors, isLeft);
          lineno++;
        }
      } catch (_) { /* ignore */ }
    }

    if (endIdx < nodes.length) {
      requestAnimationFrame(() =>
        processBatch(nodes, endIdx, colors, baseColor, gradientSize, lineno, resolve, myGen)
      );
    } else {
      resolve();
    }
  }

  function applyGradientFullMode(colors, colorText, gradientSize, nodeCoverage, myGen) {
    return new Promise(resolve => {
      if (myGen !== generation) return resolve();

      const nodes = getTargetNodes(nodeCoverage);
      if (nodes.length === 0) return resolve();

      const baseColor = hex_to_rgb(colorText);

      requestAnimationFrame(() =>
        processBatch(nodes, 0, colors, baseColor, gradientSize, 0, resolve, myGen)
      );
    });
  }

  function startObserverFullMode() {
    if (observer) return;

    observer = new MutationObserver(() => {
      if (!lastApply) return;

      clearTimeout(reapplyTimer);
      reapplyTimer = setTimeout(() => {
        document.querySelectorAll('[data-waspline-processed="1"]').forEach(n => delete n.dataset.wasplineProcessed);

        enqueueApplyFullMode({
          colors: lastApply.colors,
          color_text: lastApply.colorText,
          gradient_size: lastApply.gradientSize,
          node_coverage: lastApply.nodeCoverage,
          mode: 'spa_topup'
        });
      }, 250);
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopObserverFullMode() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
    clearTimeout(reapplyTimer);
    reapplyTimer = null;
  }

  function sameSettingsFullMode(last, msg) {
    if (!last || !msg) return false;
    const lc = Array.isArray(last.colors) ? last.colors.join(',') : '';
    const mc = Array.isArray(msg.colors) ? msg.colors.join(',') : '';
    return lc === mc &&
      String(last.colorText) === String(msg.color_text) &&
      Number(last.gradientSize) === Number(msg.gradient_size) &&
      Number(last.nodeCoverage) === Number(msg.node_coverage);
  }

  function enqueueApplyFullMode(msg) {
    if (!msg) return;
    pendingApply = msg;
    if (!isProcessing) void drainQueueFullMode();
  }

  async function drainQueueFullMode() {
    if (isProcessing) return;
    if (!pendingApply) return;

    const msg = pendingApply;
    pendingApply = null;

    isProcessing = true;
    const myGen = generation;

    try {
      const colors = Array.isArray(msg.colors) ? msg.colors : [];
      const colorText = String(msg.color_text || '#000000');
      const gradientSize = Number(msg.gradient_size);
      const nodeCoverage = Number(msg.node_coverage ?? 0);

      lastApply = { colors, colorText, gradientSize, nodeCoverage };
      startObserverFullMode();

      if (msg.mode !== 'spa_topup') {
        resetColorsFullMode();
      }

      await applyGradientFullMode(colors, colorText, gradientSize, nodeCoverage, myGen);
    } finally {
      isProcessing = false;
      if (pendingApply) void drainQueueFullMode();
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.command === "reset") {
      generation++;
      pendingApply = null;
      lastApply = null;
      stopObserverFullMode();
      resetColorsFullMode();
      safeResetAll();
      sendResponse({ status: "ok" });
      return true;
    }

    if (message.command === "apply_gradient") {
      const requestedMode = (message.mode === "full") ? "full" : "safe";

      if (requestedMode === "safe") {
        stopObserverFullMode();
        pendingApply = null;
        lastApply = null;
        resetColorsFullMode();

        applySafeMode(message);
        sendResponse({ status: "ok", mode: "safe" });
        return true;
      }

      safeResetAll();

      const msg = {
        colors: message.colors,
        color_text: message.color_text,
        gradient_size: message.gradient_size,
        node_coverage: message.node_coverage,
        mode: 'apply'
      };

      if (sameSettingsFullMode(lastApply, msg)) {
        sendResponse({ status: "ok", note: "no_change", mode: "full" });
        return true;
      }

      generation++;
      enqueueApplyFullMode(msg);
      sendResponse({ status: "queued", mode: "full" });
      return true;
    }

    return false;
  });

})();
