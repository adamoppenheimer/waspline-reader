(function () {
  'use strict';

  // Configuration
  const MAX_NODES = 400;
  const BATCH_SIZE = 20;
  const GRADIENT_STEPS = 10;

  // Cache for parsed colors
  const colorCache = new Map();

  // SPA support
  let lastApply = null;      // { colors, colorText, gradientSize }
  let observer = null;
  let reapplyTimer = null;

  // Processing / queuing
  let isProcessing = false;
  let pendingApply = null;

  // Cancellation token: increment to cancel in-flight work
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
  // DOM targeting
  // -------------------------
  function getTargetNodes() {
    const selector = [
      'article p', 'main p', '.content p', '.post p', '.article p', 'p',
      'li', 'blockquote',

      // ChatGPT-ish
      '.markdown p', '.markdown li', '.markdown blockquote',
      '.prose p', '.prose li', '.prose blockquote',
      '[data-message-author-role] p', '[data-message-author-role] li', '[data-message-author-role] blockquote',

      // Gmail body
      'div.a3s p', 'div.a3s li', 'div.a3s blockquote'
    ].join(',');

    const all = document.querySelectorAll(selector);
    return Array.from(all).slice(0, MAX_NODES);
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
    // Cancel if generation changed
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
      } catch (_) { /* ignore */ }
    }

    if (endIdx < nodes.length) {
      requestAnimationFrame(() => {
        processBatch(nodes, endIdx, colors, baseColor, gradientSize, lineno, resolve, myGen);
      });
    } else {
      resolve();
    }
  }

  function applyGradient(colors, colorText, gradientSize, myGen) {
    return new Promise((resolve) => {
      if (myGen !== generation) {
        resolve();
        return;
      }

      const nodes = getTargetNodes();
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
        // Top-up only; do not reset
        const nodes = document.querySelectorAll('[data-waspline-processed="1"]');
        for (const n of nodes) delete n.dataset.wasplineProcessed;

        enqueueApply({
          colors: lastApply.colors,
          color_text: lastApply.colorText,
          gradient_size: lastApply.gradientSize,
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
      Number(last.gradientSize) === Number(msg.gradient_size);
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

    // Snapshot generation for this run
    const myGen = generation;

    try {
      const colors = Array.isArray(msg.colors) ? msg.colors : [];
      const colorText = String(msg.color_text || '#000000');
      const gradientSize = Number(msg.gradient_size);

      lastApply = { colors, colorText, gradientSize };
      startObserver();

      if (msg.mode !== 'spa_topup') {
        // Clean recolor for explicit Apply
        resetColors();
      }

      await applyGradient(colors, colorText, gradientSize, myGen);
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
      // Cancel any in-flight apply immediately
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
        mode: 'apply'
      };

      if (sameSettings(lastApply, msg)) {
        sendResponse({ status: "ok", note: "no_change" });
        return true;
      }

      // New apply supersedes old: cancel in-flight work then queue
      generation++;
      enqueueApply(msg);
      sendResponse({ status: "queued" });
      return true;
    }

    return false;
  });

})();
