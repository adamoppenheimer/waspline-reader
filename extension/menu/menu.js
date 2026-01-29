'use strict';
// Define references to DOM elements
const color1 = document.getElementById('color1');
const color2 = document.getElementById('color2');
const color_text = document.getElementById('color_text');
const gradient_size = document.getElementById('gradient_size');
const enabled = document.getElementById('enabled');

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

function setEnabledAllowed(allowed, reason) {
  enabled.disabled = !allowed;
  enabled.title = allowed ? '' : (reason || "This extension can't run on this page.");
}

// MV3 “real” check: can Chrome inject scripts into this tab?
function canInjectIntoTab(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      { target: { tabId }, func: () => true },
      () => resolve(!chrome.runtime.lastError)
    );
  });
}

// Try a real injection check (no-op injection) to see if Chrome allows scripting on this tab
function checkInjectable(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: () => true,
      },
      () => {
        // If injection is blocked, chrome.runtime.lastError will be set
        if (chrome.runtime.lastError) resolve(false);
        else resolve(true);
      }
    );
  });
}

function ensureContentScriptInjected(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId: tabId },
        files: ["contentScript.js"] // NOTE: no leading slash
      },
      () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      }
    );
  });
}

// Listen for clicks on the input elements, and send the appropriate message
// to the content script in the page.
function eventHandler(e) {
  // Always operate on the current active tab first
  chrome.tabs.query({ active: true, currentWindow: true }, async function(tabs) {
    try {
      if (!tabs || tabs.length === 0) return;
      const tab = tabs[0];
      const url = tab.url || "";

      // If this page can't be scripted, disable the checkbox for THIS page only
      if (isRestrictedUrl(url) || !(await canInjectIntoTab(tab.id))) {
        enabled.checked = false; // UI-only for this page
        setEnabledAllowed(false, "This extension can't run on this page.");

        // IMPORTANT: do NOT change stored "enabled" here,
        // because you said you don't want it disabled permanently.
        return;
      }

      // Page is allowed: make sure checkbox is enabled (clickable)
      setEnabledAllowed(true);

      // Save the user's preferences globally
      await chrome.storage.local.set({
        color1: color1.value,
        color2: color2.value,
        color_text: color_text.value,
        gradient_size: gradient_size.value,
        enabled: enabled.checked
      });

      // Helper: send apply message
      async function applyGradientToTab() {
         await ensureContentScriptInjected(tab.id);
         await chrome.tabs.sendMessage(tab.id, {
            command: "apply_gradient",
            colors: [color1.value, color2.value],
            color_text: color_text.value,
            gradient_size: gradient_size.value
         });
      }

      // Helper: send reset message
      async function resetTab() {
         await ensureContentScriptInjected(tab.id);
         await chrome.tabs.sendMessage(tab.id, {
            command: "reset",
            color_text: color_text.value
         });
      }

      // Apply or reset based on enabled state
      if (enabled.checked) {
        await applyGradientToTab();
      } else {
        await resetTab();
      }
    } catch (error) {
      // If something went wrong (e.g., message fails), revert UI for this page only
      console.error(error);
      // If injection is blocked, disable; otherwise just revert the checkmark
      enabled.checked = false;
      setEnabledAllowed(true);
    }
  });
}

// Load settings from local storage, or use these defaults
chrome.storage.local.get({
  color1: "#0000FF",
  color2: "#FF0000",
  color_text: "#000000",
  gradient_size: 50,
  enabled: false
}, function(result) {
  // Load saved settings
  color1.value = result.color1;
  color2.value = result.color2;
  color_text.value = result.color_text;
  gradient_size.value = result.gradient_size;

  // Start from global preference
  enabled.checked = result.enabled;
  setEnabledAllowed(true);

  // Now check current tab and disable for THIS SITE ONLY if needed
  chrome.tabs.query({ active: true, currentWindow: true }, async function(tabs) {
    const tab = tabs && tabs[0];
    const url = tab && tab.url;

    if (isRestrictedUrl(url)) {
      enabled.checked = false; // for this page only
      setEnabledAllowed(false, "This extension can't run on this type of page.");
      return;
    }

    const ok = await canInjectIntoTab(tab.id);
    if (!ok) {
      enabled.checked = false; // for this page only
      setEnabledAllowed(false, "Chrome blocked script injection on this site.");
      return;
    }

    // Allowed: leave checkbox as the global setting
    setEnabledAllowed(true);
  });
});

chrome.tabs.query({ active: true, currentWindow: true }, async function(tabs) {
  const tab = tabs && tabs[0];
  const url = tab && tab.url;

  // First: scheme-based restriction
  if (isRestrictedUrl(url)) {
    setEnabledAllowed(false, "Not allowed on this type of page.");
    enabled.checked = false;
    chrome.storage.local.set({ enabled: false });
    return;
  }

  // Second: real injection capability check
  const ok = await checkInjectable(tab.id);
  if (!ok) {
    setEnabledAllowed(false, "Chrome blocked script injection on this page.");
    enabled.checked = false;
    chrome.storage.local.set({ enabled: false });
    return;
  }

  // Allowed
  setEnabledAllowed(true);
});

// Register event listeners to update page when options change
document.getElementById("enabled").addEventListener("change", eventHandler);
document.getElementById("gradient_size").addEventListener("change", eventHandler);
document.getElementById("color1").addEventListener("change", eventHandler);
document.getElementById("color2").addEventListener("change", eventHandler);
document.getElementById("color_text").addEventListener("change", eventHandler);