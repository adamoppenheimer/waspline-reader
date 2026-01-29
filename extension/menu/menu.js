'use strict';
// Define references to DOM elements
const color1 = document.getElementById('color1');
const color2 = document.getElementById('color2');
const color_text = document.getElementById('color_text');
const gradient_size = document.getElementById('gradient_size');
const enabled = document.getElementById('enabled');
const popupContent = document.getElementById('popup-content');
const errorContent = document.getElementById('error-content');

// Domain blacklist elements
const currentDomainName = document.getElementById('current-domain-name');
const toggleDomainBtn = document.getElementById('toggle-domain-btn');
const newDomainInput = document.getElementById('new-domain-input');
const addDomainBtn = document.getElementById('add-domain-btn');
const blacklistContainer = document.getElementById('blacklist-container');
const domainDisabledNotice = document.getElementById('domain-disabled-notice');

// Current page domain
let currentDomain = null;

// Check if URL is restricted (cannot inject content scripts)
function isRestrictedUrl(url) {
	if (!url) return true;
	return url.startsWith('chrome://') ||
		url.startsWith('chrome-extension://') ||
		url.startsWith('edge://') ||
		url.startsWith('about:') ||
		url.startsWith('moz-extension://') ||
		url.startsWith('file://') ||
		url.startsWith('devtools://') ||
		url.startsWith('view-source:') ||
		url.startsWith('data:');
}

// Extract domain from URL
function getDomainFromUrl(url) {
	try {
		const urlObj = new URL(url);
		return urlObj.hostname;
	} catch (e) {
		return null;
	}
}

// Very simple domain validation (prevents weird characters)
function normalizeDomainInput(domain) {
	if (!domain) return null;
	domain = domain.toLowerCase().trim();

	// Allow letters, numbers, dots, and hyphens only
	if (!/^[a-z0-9.-]+$/.test(domain)) return null;

	// Basic sanity: must not start/end with dot or hyphen
	if (/^[.-]|[.-]$/.test(domain)) return null;

	return domain;
}

// Check if domain is in blacklist
async function isDomainBlacklisted(domain) {
	if (!domain) return false;
	const result = await chrome.storage.local.get({ domainBlacklist: [] });
	return result.domainBlacklist.includes(domain);
}

// Get blacklist from storage
async function getBlacklist() {
	const result = await chrome.storage.local.get({ domainBlacklist: [] });
	return result.domainBlacklist;
}

// Save blacklist to storage
async function saveBlacklist(blacklist) {
	await chrome.storage.local.set({ domainBlacklist: blacklist });
}

// Add domain to blacklist
async function addToBlacklist(domain) {
	domain = normalizeDomainInput(domain);
	if (!domain) return;

	const blacklist = await getBlacklist();
	if (!blacklist.includes(domain)) {
		blacklist.push(domain);
		await saveBlacklist(blacklist);
	}
	await updateBlacklistUI();
	await updateCurrentDomainUI();
}

// Remove domain from blacklist
async function removeFromBlacklist(domain) {
	const blacklist = await getBlacklist();
	const index = blacklist.indexOf(domain);
	if (index > -1) {
		blacklist.splice(index, 1);
		await saveBlacklist(blacklist);
	}
	await updateBlacklistUI();
	await updateCurrentDomainUI();
}

// Update the blacklist UI (safe: uses textContent instead of innerHTML)
async function updateBlacklistUI() {
	const blacklist = await getBlacklist();

	// Clear existing content
	blacklistContainer.textContent = '';

	if (blacklist.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty-list';
		empty.textContent = 'No disabled sites';
		blacklistContainer.appendChild(empty);
		return;
	}

	for (const domain of blacklist) {
		const item = document.createElement('div');
		item.className = 'blacklist-item';

		const spanDomain = document.createElement('span');
		spanDomain.className = 'blacklist-domain';
		spanDomain.title = domain;
		spanDomain.textContent = domain;

		const removeBtn = document.createElement('span');
		removeBtn.className = 'remove-btn';
		removeBtn.title = 'Remove';
		removeBtn.textContent = '×';
		removeBtn.addEventListener('click', async () => {
			await removeFromBlacklist(domain);
		});

		item.appendChild(spanDomain);
		item.appendChild(removeBtn);
		blacklistContainer.appendChild(item);
	}
}

// Update current domain UI
async function updateCurrentDomainUI() {
	if (!currentDomain) {
		currentDomainName.textContent = '-';
		toggleDomainBtn.classList.add('hidden');
		domainDisabledNotice.classList.add('hidden');
		return;
	}

	currentDomainName.textContent = currentDomain;
	toggleDomainBtn.classList.remove('hidden');

	const isBlacklisted = await isDomainBlacklisted(currentDomain);

	if (isBlacklisted) {
		toggleDomainBtn.textContent = 'Enable here';
		toggleDomainBtn.classList.remove('btn-danger');
		toggleDomainBtn.classList.add('btn-success');
		domainDisabledNotice.classList.remove('hidden');
	} else {
		toggleDomainBtn.textContent = 'Disable here';
		toggleDomainBtn.classList.remove('btn-success');
		toggleDomainBtn.classList.add('btn-danger');
		domainDisabledNotice.classList.add('hidden');
	}
}

// Show error message for restricted pages
function showRestrictedPageError() {
	if (popupContent) popupContent.classList.add('hidden');
	if (errorContent) errorContent.classList.remove('hidden');
}

// Show normal popup content
function showNormalContent() {
	if (popupContent) popupContent.classList.remove('hidden');
	if (errorContent) errorContent.classList.add('hidden');
}

// Inject content script if not already injected
async function ensureContentScriptInjected(tabId) {
	try {
		// Try to send a ping message to check if content script is already injected
		await chrome.tabs.sendMessage(tabId, { command: "ping" });
	} catch (error) {
		// Content script not injected, inject it now
		await chrome.scripting.executeScript({
			target: { tabId: tabId },
			files: ["/contentScript.js"]
		});
		// Small delay to ensure script is ready
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

// Listen for clicks on the input elements, and send the appropriate message
// to the content script in the page.
async function eventHandler(e) {
	// Determine if this domain is blacklisted (but still allow saving settings)
	const domainIsBlacklisted = currentDomain && await isDomainBlacklisted(currentDomain);

	// Send message to content script to color lines
	async function apply_gradient(tabs) {
		if (!tabs || tabs.length === 0) return;
		const tab = tabs[0];

		// Check if this is a restricted URL
		if (isRestrictedUrl(tab.url)) {
			showRestrictedPageError();
			return;
		}

		// Check if domain is blacklisted
		const domain = getDomainFromUrl(tab.url);
		if (domain && await isDomainBlacklisted(domain)) {
			return;
		}

		try {
			// Ensure content script is injected before sending message
			await ensureContentScriptInjected(tab.id);
			await chrome.tabs.sendMessage(tab.id, {
				command: "apply_gradient",
				colors: [color1.value, color2.value],
				color_text: color_text.value,
				gradient_size: gradient_size.value
			});
		} catch (error) {
			console.error('Error applying gradient:', error);
			showRestrictedPageError();
		}
	}

	// Send message to content script to reset lines
	async function reset(tabs) {
		if (!tabs || tabs.length === 0) return;
		const tab = tabs[0];

		// Check if this is a restricted URL
		if (isRestrictedUrl(tab.url)) {
			showRestrictedPageError();
			return;
		}

		try {
			// Ensure content script is injected before sending message
			await ensureContentScriptInjected(tab.id);
			await chrome.tabs.sendMessage(tab.id, {
				command: "reset",
				color_text: color_text.value
			});
		} catch (error) {
			console.error('Error resetting:', error);
		}
	}

	// Store attributes into local storage
	await chrome.storage.local.set({
		color1: color1.value,
		color2: color2.value,
		color_text: color_text.value,
		gradient_size: gradient_size.value,
		enabled: enabled.checked,
	});

	// Dispatch depending on checkbox enabled state
	try {
		const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

		// If blacklisted, don't apply/reset — but we DID save settings above
		if (domainIsBlacklisted) return;

		if (enabled.checked) {
			await apply_gradient(tabs);
		} else {
			await reset(tabs);
		}
	} catch (error) {
		console.error('Error handling event:', error);
	}
}

// Check current page on popup open
async function checkCurrentPage() {
	try {
		const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
		if (tabs && tabs.length > 0) {
			const tab = tabs[0];

			if (isRestrictedUrl(tab.url)) {
				showRestrictedPageError();
				return;
			}

			showNormalContent();

			// Get current domain
			currentDomain = getDomainFromUrl(tab.url);
			await updateCurrentDomainUI();
			await updateBlacklistUI();
		}
	} catch (error) {
		console.error('Error checking current page:', error);
	}
}

// Toggle current domain in blacklist
async function toggleCurrentDomain() {
	if (!currentDomain) return;

	const isBlacklisted = await isDomainBlacklisted(currentDomain);
	if (isBlacklisted) {
		await removeFromBlacklist(currentDomain);
	} else {
		await addToBlacklist(currentDomain);
	}
}

// Add new domain from input
async function addNewDomain() {
	const domain = normalizeDomainInput(newDomainInput.value);
	if (domain) {
		await addToBlacklist(domain);
		newDomainInput.value = '';
	}
}

// Run check when popup opens
checkCurrentPage();

// Load settings from local storage, or use these defaults
chrome.storage.local.get({
	color1: "#0000FF",
	color2: "#FF0000",
	color_text: "#000000",
	gradient_size: 50,
	enabled: false
}).then(function(result) {
	color1.value = result.color1;
	color2.value = result.color2;
	color_text.value = result.color_text;
	gradient_size.value = result.gradient_size;
	enabled.checked = result.enabled;
});

// Register event listeners to update page when options change
document.getElementById("enabled").addEventListener("change", eventHandler);
document.getElementById("gradient_size").addEventListener("change", eventHandler);
document.getElementById("color1").addEventListener("change", eventHandler);
document.getElementById("color2").addEventListener("change", eventHandler);
document.getElementById("color_text").addEventListener("change", eventHandler);

// Domain blacklist event listeners
toggleDomainBtn.addEventListener('click', toggleCurrentDomain);
addDomainBtn.addEventListener('click', addNewDomain);
newDomainInput.addEventListener('keypress', (e) => {
	if (e.key === 'Enter') {
		addNewDomain();
	}
});