(function() {
'use strict';

// Configuration
const MAX_PARAGRAPHS = 300;
const BATCH_SIZE = 20;
const GRADIENT_STEPS = 10; // Pre-compute gradient colors in steps

// Cache for parsed colors
const colorCache = new Map();

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
		spans[idx].style.color = gradientColors[colorIdx];
	}
}

// Process paragraphs in batches using requestAnimationFrame
function processBatch(paragraphs, startIdx, colors, baseColor, gradientSize, lineno, resolve, mode) {
	const endIdx = Math.min(startIdx + BATCH_SIZE, paragraphs.length);
	const activeColors = colors.map(c => hex_to_rgb(c));

	for (let i = startIdx; i < endIdx; i++) {
		const paragraph = paragraphs[i];
		// Skip code blocks / preformatted text
		if (paragraph.closest('pre, code')) continue;

		// When applying, avoid reprocessing the same elements
		if (mode === "apply") {
			if (paragraph.dataset.wasplineProcessed === '1') continue;
			paragraph.dataset.wasplineProcessed = '1';
		}

		// When resetting, allow everything and clear marker
		if (mode === "reset") {
			delete paragraph.dataset.wasplineProcessed;
		}

		if (!paragraph.textContent || paragraph.textContent.trim().length < 2) continue;

		try {
			const lines = lineWrapDetector.getLines(paragraph);

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
			// Skip failed paragraphs
		}
	}

	if (endIdx < paragraphs.length) {
		// Continue with next batch on next frame
		requestAnimationFrame(() => {
			processBatch(paragraphs, endIdx, colors, baseColor, gradientSize, lineno, resolve);
		});
	} else {
		resolve();
	}
}

// Main gradient application function
function applyGradient(colors, colorText, gradientSize, mode) {
	return new Promise((resolve) => {
		const allParagraphs = document.querySelectorAll([
			// General articles / pages
			'article p', 'main p', '.content p', '.post p', '.article p', 'p',
			// Lists and quotes (often used instead of <p>)
			'li', 'blockquote',
			// ChatGPT (message content is usually rendered under .markdown)
			'.markdown p', '.markdown li', '.markdown blockquote',
			// Gmail (email body container)
			'div.a3s p', 'div.a3s li', 'div.a3s blockquote'
		].join(','));
		const paragraphs = Array.from(allParagraphs).slice(0, MAX_PARAGRAPHS);

		if (paragraphs.length === 0) {
			resolve();
			return;
		}

		const baseColor = hex_to_rgb(colorText);

		// Start processing on next animation frame for smooth rendering
		requestAnimationFrame(() => {
			processBatch(paragraphs, 0, colors, baseColor, gradientSize, 0, resolve, mode);
		});
	});
}

// Track processing state
let isProcessing = false;

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.command === "ping") {
		sendResponse({ status: "ok" });
		return true;
	}

	if (message.command === "apply_gradient" || message.command === "reset") {
		if (isProcessing) {
			sendResponse({ status: "busy" });
			return true;
		}

		isProcessing = true;
		const colors = message.command === "reset"
			? [message.color_text]
			: message.colors;
		const gradientSize = message.command === "reset"
			? 0
			: message.gradient_size;

		applyGradient(colors, message.color_text, gradientSize, message.command === "reset" ? "reset" : "apply")
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