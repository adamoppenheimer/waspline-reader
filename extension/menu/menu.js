'use strict';

// ----- DOM refs -----
const color1 = document.getElementById('color1');
const color2 = document.getElementById('color2');
const color_text = document.getElementById('color_text');
const gradient_size = document.getElementById('gradient_size');
const enabled = document.getElementById('enabled');

// ----- helpers -----
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

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function loadGlobalSettingsIntoUI() {
  const result = await chrome.storage.local.get({
    color1: "#0000FF",
    color2: "#FF0000",
    color_text: "#000000",
    gradient_size: 50
  });

  color1.value = result.color1;
  color2.value = result.color2;
  color_text.value = result.color_text;
  gradient_size.value = result.gradient_size;
}

async function saveGlobalSettingsFromUI() {
  await chrome.storage.local.set({
    color1: color1.value,
    color2: color2.value,
    color_text: color_text.value,
    gradient_size: gradient_size.value
  });
}

// Sync checkbox state + disabled state for the current tab
async function syncUIToCurrentTab() {
  const tab = await getActiveTab();
  if (!tab) return;

  if (isRestrictedUrl(tab.url)) {
    enabled.checked = false;
    setEnabledAllowed(false, "Not allowed on this type of page.");
    return;
  }

  const ok = await canInjectIntoTab(tab.id);
  if (!ok) {
    enabled.checked = false;
    setEnabledAllowed(false, "Chrome blocked script injection on this site.");
    return;
  }

  setEnabledAllowed(true);

  const res = await chrome.runtime.sendMessage({
    type: "GET_TAB_ENABLED",
    tabId: tab.id
  });

  enabled.checked = !!(res && res.enabled);
}

// ----- main event handler -----
async function eventHandler(e) {
  const tab = await getActiveTab();
  if (!tab) return;

  // Always save global settings (colors/size) when user changes any control
  await saveGlobalSettingsFromUI();

  // If current page can't run scripts, force UI off for this tab
  if (isRestrictedUrl(tab.url) || !(await canInjectIntoTab(tab.id))) {
    enabled.checked = false;
    setEnabledAllowed(false, "This extension can't run on this page.");
    return;
  }

  setEnabledAllowed(true);

  // If Enabled checkbox toggled: set per-tab enabled state via background
  if (e && e.target === enabled) {
    const desired = enabled.checked;

    const res = await chrome.runtime.sendMessage({
      type: "SET_TAB_ENABLED",
      tabId: tab.id,
      enabled: desired
    });

    if (desired && (!res || !res.ok)) {
      enabled.checked = false;

      const reason =
        res && res.reason === "restricted" ? "Not allowed on this type of page." :
        res && res.reason === "inject_failed" ? "Chrome blocked script injection on this site." :
        "Could not enable on this page.";

      setEnabledAllowed(false, reason);
      return;
    }

    setEnabledAllowed(true);
    return;
  }

  // If user changed colors/size and this tab is enabled, re-apply by “setting enabled true” again
  const resEnabled = await chrome.runtime.sendMessage({
    type: "GET_TAB_ENABLED",
    tabId: tab.id
  });

  if (resEnabled && resEnabled.enabled) {
    await chrome.runtime.sendMessage({
      type: "SET_TAB_ENABLED",
      tabId: tab.id,
      enabled: true
    });
  }
}

// ----- init -----
(async function init() {
  await loadGlobalSettingsIntoUI();
  await syncUIToCurrentTab();
})();

// ----- listeners -----
document.getElementById("enabled").addEventListener("change", eventHandler);
document.getElementById("gradient_size").addEventListener("change", eventHandler);
document.getElementById("color1").addEventListener("change", eventHandler);
document.getElementById("color2").addEventListener("change", eventHandler);
document.getElementById("color_text").addEventListener("change", eventHandler);
