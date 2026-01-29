(function () {
'use strict';

// Configuration
const MAX_NODES = 400;     // was MAX_PARAGRAPHS; now we target more than <p>
const BATCH_SIZE = 20;
const GRADIENT_STEPS = 10;

// Cache for parsed colors
const colorCache = new Map();

// State for SPA pages (ChatGPT, Gmail)
let lastApply = null;      // { colors, colorText, gradientSize }
let observer = null;
let reapplyTimer = null;

// Parse hex to RGB with caching
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

// Pre-compute gradient colors for a line
function computeGradientColors(baseColor, activeColor, steps, gradientSize) {
  const colors = new Array(steps);
  const factor = gradientSize / 50;

  for (let i = 0; i < steps; i++) {
    const t = 1 - (i / ((steps - 1) * factor || 1));
    const r = (baseColor[0] * (1 - t) + activeColor[0] * t) | 0;
    const g = (baseColor[1] * (1 - t) + activeColor[1] * t) | 0;
    const b = (baseColor[2] * (1 - t) + activeColor[2] * t) | 0;
    colors[i] = `rgb(${r},${g},${b})`;
  }
  return colors;
}

// Apply colors to a line of spans
function colorLine(spans, gradientColors, reverse) {
  const len = spans.length;
  const colorLen = gradientColors.length;

  for (let i = 0; i < len; i++) {
    const idx = reverse ? len - 1 - i : i;
    const colorIdx = Math.min(Math.floor(i * colorLen / len), colorLen - 1);

    const el = spans[idx];

    // Save original inline color once (empty string means "none")
    if (el.dataset.wasplineOrigColor === undefined) {
      el.dataset.wasplineOrigColor = el.style.color || "";
    }

    el.style.color = gradientColors[colorIdx];
  }
}

// Reset: restore original inline colors or remove our override
function resetColors() {
  const spans = document.querySelectorAll('span[data-waspline-orig-color]');
  for (const s of spans) {
    const orig = s.dataset.wasplineOrigColor;

    if (orig === "") {
      s.style.removeProperty('color');
    } else {
      s.style.color = orig;
    }
    delete s.dataset.wasplineOrigColor;
  }

  // Clear processed markers so apply can work cleanly next time
  const nodes = document.querySelectorAll('[data-waspline-processed="1"]');
  for (const n of nodes) {
    delete n.dataset.wasplineProcessed;
  }
}

// Process nodes in batches using requestAnimationFrame
function processBatch(nodes, startIdx, colors, baseColor, gradientSize, lineno, resolve) {
  const endIdx = Math.min(startIdx + BATCH_SIZE, nodes.length);
  const activeColors = colors.map(c => hex_to_rgb(c));

  for (let i = startIdx; i < endIdx; i++) {
    const node = nodes[i];

    // Skip empty/small
    if (!node.textContent || node.textContent.trim().length < 2) continue;

    // Skip code blocks (ChatGPT)
    if (node.closest && node.closest('pre, code')) continue;

    // Avoid reprocessing the same node repeatedly (important on SPA pages)
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
    } catch (e) {
      // Skip failed nodes
    }
  }

  if (endIdx < nodes.length) {
    requestAnimationFrame(() => {
      processBatch(nodes, endIdx, colors, baseColor, gradientSize, lineno, resolve);
    });
  } else {
    resolve();
  }
}

// Build a good list of text nodes to process across sites
function getTargetNodes() {
  const selector = [
    // General pages
    'article p', 'main p', '.content p', '.post p', '.article p', 'p',
    'li', 'blockquote',

    // ChatGPT (varies across UI versions)
    '.markdown p', '.markdown li', '.markdown blockquote',
    '.prose p', '.prose li', '.prose blockquote',
    '[data-message-author-role] p', '[data-message-author-role] li', '[data-message-author-role] blockquote',

    // Gmail email body container
    'div.a3s p', 'div.a3s li', 'div.a3s blockquote'
  ].join(',');

  const all = document.querySelectorAll(selector);
  return Array.from(all).slice(0, MAX_NODES);
}

// Main gradient application function
function applyGradient(colors, colorText, gradientSize) {
  return new Promise((resolve) => {
    const nodes = getTargetNodes();

    if (nodes.length === 0) {
      resolve();
      return;
    }

    const baseColor = hex_to_rgb(colorText);

    requestAnimationFrame(() => {
      processBatch(nodes, 0, colors, baseColor, gradientSize, 0, resolve);
    });
  });
}

// SPA observer: re-apply while enabled to handle ChatGPT/Gmail re-renders
function startObserver() {
  if (observer) return;

  observer = new MutationObserver(() => {
    if (!lastApply) return;

    clearTimeout(reapplyTimer);
    reapplyTimer = setTimeout(() => {
      // Clear processed markers before reapplying (because DOM may have changed)
      const nodes = document.querySelectorAll('[data-waspline-processed="1"]');
      for (const n of nodes) delete n.dataset.wasplineProcessed;

      applyGradient(lastApply.colors, lastApply.colorText, lastApply.gradientSize);
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

// Track processing state to avoid piling up work
let isProcessing = false;

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.command === "ping") {
    sendResponse({ status: "ok" });
    return true;
  }

  if (message.command === "reset") {
    // Stop SPA behavior and restore original colors
    lastApply = null;
    stopObserver();
    resetColors();
    sendResponse({ status: "ok" });
    return true;
  }

  if (message.command === "apply_gradient") {
    if (isProcessing) {
      sendResponse({ status: "busy" });
      return true;
    }

    isProcessing = true;

    // Save for SPA re-apply (ChatGPT/Gmail)
    lastApply = {
      colors: message.colors,
      colorText: message.color_text,
      gradientSize: message.gradient_size
    };
    startObserver();

    applyGradient(message.colors, message.color_text, message.gradient_size)
      .then(() => {
        isProcessing = false;
        sendResponse({ status: "ok" });
      })
      .catch((error) => {
        isProcessing = false;
        sendResponse({ status: "error", message: error.message });
      });

    return true;
  }

  return false;
});

})();
