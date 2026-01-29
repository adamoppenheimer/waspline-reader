(function () {
  'use strict';

  // Minimum number of nodes to process regardless of slider setting
  const MIN_NODES = 400;

  // When processing more than MIN_NODES, ensure we process at least this fraction of total candidates
  const MIN_FRACTION_IF_OVER_MIN = 0.95;

  // Batch/gradient settings
  const BATCH_SIZE = 30;
  const GRADIENT_STEPS = 10;

  const colorCache = new Map();

  // SPA support
  let lastApply = null;      // { colors, colorText, gradientSize, nodeCoverage }
  let observer = null;
  let reapplyTimer = null;

  // Processing / queuing
  let isProcessing = false;
  let pendingApply = null;

  // Cancellation token
  let generation = 0;

  // -------------------------
  // Color helpers
  // -------------------------
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
      const t = 1 - (i / denom);
      const r = (baseColor[0] * (1 - t) + activeColor[0] * t) | 0;
      const g = (baseColor[1] * (1 - t) + activeColor[1] * t) | 0;
      const b = (baseColor[2] * (1 - t) + activeColor[2] * t) | 0;
      colors[i] = `rgb(${r},${g},${b})`;
    }
    return colors;
  }

  // -------------------------
  // Candidate selection
  // -------------------------
  function isLikelyChatGPT() {
    const host = location.host || '';
    return host.includes('chatgpt.com') || host.includes('chat.openai.com');
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

  function getCandidateNodes() {
    const genericSelector = [
      'article p', 'main p', '.content p', '.post p', '.article p',
      'p', 'li', 'blockquote',

      // Gmail body container
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

      // Filter out obvious huge containers so line detection doesn't go nuclear
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

  function clampInt(n, min, max) {
    n = Number(n);
    if (!Number.isFinite(n)) n = min;
    n = Math.round(n);
    return Math.max(min, Math.min(max, n));
  }

  function computeMaxNodes(totalCandidates, nodeCoveragePercent) {
    const total = Math.max(0, totalCandidates | 0);
    const pct = clampInt(nodeCoveragePercent, 0, 100);

    // Base: percent of total, but always at least MIN_NODES
    let maxNodes = Math.max(MIN_NODES, Math.round(total * (pct / 100)));

    // If user chose enough that we're beyond MIN_NODES, avoid patchiness:
    // ensure at least 95% coverage, capped to total.
    if (maxNodes > MIN_NODES) {
      maxNodes = Math.max(maxNodes, Math.ceil(total * MIN_FRACTION_IF_OVER_MIN));
    }

    return Math.min(maxNodes, total);
  }

  function findViewportAnchorIndex(nodes) {
    // Choose the node whose vertical center is closest to the viewport center.
    const viewportCenterY = window.innerHeight / 2;

    let bestIdx = 0;
    let bestDist = Infinity;

    // Prefer nodes near/within viewport first
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!el || !el.getBoundingClientRect) continue;

      const r = el.getBoundingClientRect();

      // Skip totally offscreen far above/below unless we have no better candidates.
      // We still compute distance so we get something reasonable.
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
    const candidates = getCandidateNodes();
    const total = candidates.length;
    if (total === 0) return [];

    const maxNodes = computeMaxNodes(total, nodeCoveragePercent);
    if (maxNodes >= total) return candidates;

    const anchor = findViewportAnchorIndex(candidates);

    const halfBefore = Math.floor(maxNodes / 2);
    const halfAfter = maxNodes - halfBefore;

    let start = anchor - halfBefore;
    let end = anchor + halfAfter;

    // Clamp window into bounds, preserving size
    if (start < 0) {
      end += -start;
      start = 0;
    }
    if (end > total) {
      const over = end - total;
      start = Math.max(0, start - over);
      end = total;
    }

    return candidates.slice(start, end);
  }

  // -------------------------
  // Original color capture / restore
  // -------------------------
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

  function resetColors() {
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

    const nodes = document.querySelectorAll('[data-waspline-processed="1"]');
    for (const n of nodes) delete n.dataset.wasplineProcessed;
  }

  // -------------------------
  // Coloring logic
  // -------------------------
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
    if (myGen !== generation) {
      resolve();
      return;
    }

    const endIdx = Math.min(startIdx + BATCH_SIZE, nodes.length);
    const activeColors = colors.map(c => hex_to_rgb(c));

    for (let i = startIdx; i < endIdx; i++) {
      if (myGen !== generation) {
        resolve();
        return;
      }

      const node = nodes[i];
      if (!node || !node.textContent || node.textContent.trim().length < 2) continue;
      if (node.closest && node.closest('pre, code')) continue;

      if (node.dataset.wasplineProcessed === '1') continue;
      node.dataset.wasplineProcessed = '1';

      try {
        const lines = lineWrapDetector.getLines(node);

        for (const line of lines) {
          if (myGen !== generation) {
            resolve();
            return;
          }
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
      } catch (_) {
        // ignore
      }
    }

    if (endIdx < nodes.length) {
      requestAnimationFrame(() => {
        processBatch(nodes, endIdx, colors, baseColor, gradientSize, lineno, resolve, myGen);
      });
    } else {
      resolve();
    }
  }

  function applyGradient(colors, colorText, gradientSize, nodeCoverage, myGen) {
    return new Promise((resolve) => {
      if (myGen !== generation) {
        resolve();
        return;
      }

      const nodes = getTargetNodes(nodeCoverage);
      if (nodes.length === 0) {
        resolve();
        return;
      }

      const baseColor = hex_to_rgb(colorText);

      requestAnimationFrame(() => {
        processBatch(nodes, 0, colors, baseColor, gradientSize, 0, resolve, myGen);
      });
    });
  }

  // -------------------------
  // SPA observer
  // -------------------------
  function startObserver() {
    if (observer) return;

    observer = new MutationObserver(() => {
      if (!lastApply) return;

      clearTimeout(reapplyTimer);
      reapplyTimer = setTimeout(() => {
        const nodes = document.querySelectorAll('[data-waspline-processed="1"]');
        for (const n of nodes) delete n.dataset.wasplineProcessed;

        enqueueApply({
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

  function stopObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
    clearTimeout(reapplyTimer);
    reapplyTimer = null;
  }

  // -------------------------
  // Apply queuing
  // -------------------------
  function sameSettings(last, msg) {
    if (!last || !msg) return false;
    const lc = Array.isArray(last.colors) ? last.colors.join(',') : '';
    const mc = Array.isArray(msg.colors) ? msg.colors.join(',') : '';
    return lc === mc &&
      String(last.colorText) === String(msg.color_text) &&
      Number(last.gradientSize) === Number(msg.gradient_size) &&
      Number(last.nodeCoverage) === Number(msg.node_coverage);
  }

  function enqueueApply(msg) {
    if (!msg) return;
    pendingApply = msg;
    if (!isProcessing) void drainQueue();
  }

  async function drainQueue() {
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
      startObserver();

      if (msg.mode !== 'spa_topup') {
        resetColors();
      }

      await applyGradient(colors, colorText, gradientSize, nodeCoverage, myGen);
    } finally {
      isProcessing = false;
      if (pendingApply) void drainQueue();
    }
  }

  // -------------------------
  // Message listener
  // -------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.command === "ping") {
      sendResponse({ status: "ok" });
      return true;
    }

    if (message.command === "reset") {
      generation++;
      pendingApply = null;
      lastApply = null;
      stopObserver();
      resetColors();
      sendResponse({ status: "ok" });
      return true;
    }

    if (message.command === "apply_gradient") {
      const msg = {
        colors: message.colors,
        color_text: message.color_text,
        gradient_size: message.gradient_size,
        node_coverage: message.node_coverage,
        mode: 'apply'
      };

      if (sameSettings(lastApply, msg)) {
        sendResponse({ status: "ok", note: "no_change" });
        return true;
      }

      generation++;
      enqueueApply(msg);
      sendResponse({ status: "queued" });
      return true;
    }

    return false;
  });

})();
