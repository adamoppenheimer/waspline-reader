'use strict';

const color1 = document.getElementById('color1');
const color2 = document.getElementById('color2');
const color_text = document.getElementById('color_text');
const gradient_size = document.getElementById('gradient_size');

const node_coverage = document.getElementById('node_coverage');
const node_coverage_value = document.getElementById('node_coverage_value');
const gradient_size_value = document.getElementById('gradient_size_value');

const btnApply = document.getElementById('apply');
const btnRestore = document.getElementById('restore');

const btnSaveMyDefault = document.getElementById('save-my-default');
const btnResetMyDefault = document.getElementById('reset-my-default');
const btnResetExtDefault = document.getElementById('reset-ext-default');

const popupContent = document.getElementById('popup-content');
const errorContent = document.getElementById('error-content');

const toast = document.getElementById('toast');
let toastTimer = null;

// Mode UI
const site_mode = document.getElementById('site_mode');
const site_host = document.getElementById('site_host');

// NEW safe speed UI
const safe_cycle_lines = document.getElementById('safe_cycle_lines');
const safe_cycle_lines_value = document.getElementById('safe_cycle_lines_value');

function bind(el, eventName, handler) {
  if (!el) return;
  el.addEventListener(eventName, handler);
}

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

function setButtonAllowed(btn, allowed, reason) {
  if (!btn) return;
  btn.disabled = !allowed;
  btn.title = allowed ? '' : (reason || "This extension can't run on this page.");
}

function showPopup(ok) {
  if (!popupContent || !errorContent) return;
  if (ok) {
    popupContent.classList.remove('hidden');
    errorContent.classList.add('hidden');
  } else {
    popupContent.classList.add('hidden');
    errorContent.classList.remove('hidden');
  }
}

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
  return tabs?.[0] || null;
}

function clampInt(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) n = min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function refreshSliderLabels() {
  if (node_coverage && node_coverage_value) {
    node_coverage_value.textContent = `${clampInt(node_coverage.value, 0, 100)}%`;
  }
  if (gradient_size && gradient_size_value) {
    gradient_size_value.textContent = `${clampInt(gradient_size.value, 0, 100)}%`;
  }
  if (safe_cycle_lines && safe_cycle_lines_value) {
    safe_cycle_lines_value.textContent = `${clampInt(safe_cycle_lines.value, 2, 30)}`;
  }
}

function readSettingsFromUI() {
  return {
    color1: color1?.value ?? "#0000FF",
    color2: color2?.value ?? "#FF0000",
    color_text: color_text?.value ?? "#000000",
    gradient_size: clampInt(gradient_size?.value ?? 50, 0, 100),
    node_coverage: clampInt(node_coverage?.value ?? 0, 0, 100),

    // NEW
    safe_cycle_lines: clampInt(safe_cycle_lines?.value ?? 6, 2, 30)
  };
}

function writeSettingsToUI(settings) {
  if (!settings) return;

  if (color1) color1.value = settings.color1 ?? "#0000FF";
  if (color2) color2.value = settings.color2 ?? "#FF0000";
  if (color_text) color_text.value = settings.color_text ?? "#000000";

  if (gradient_size) gradient_size.value = String(settings.gradient_size ?? 50);
  if (node_coverage) node_coverage.value = String(settings.node_coverage ?? 0);

  if (safe_cycle_lines) safe_cycle_lines.value = String(settings.safe_cycle_lines ?? 6);

  refreshSliderLabels();
}

function settingsEqual(a, b) {
  if (!a || !b) return false;
  return String(a.color1) === String(b.color1) &&
    String(a.color2) === String(b.color2) &&
    String(a.color_text) === String(b.color_text) &&
    Number(a.gradient_size) === Number(b.gradient_size) &&
    Number(a.node_coverage) === Number(b.node_coverage) &&
    Number(a.safe_cycle_lines) === Number(b.safe_cycle_lines);
}

async function getTabInfo(tabId) {
  return await chrome.runtime.sendMessage({ type: "GET_TAB_INFO", tabId });
}

async function getSiteMode(tabId) {
  return await chrome.runtime.sendMessage({ type: "GET_SITE_MODE", tabId });
}
async function setSiteMode(tabId, siteMode) {
  return await chrome.runtime.sendMessage({ type: "SET_SITE_MODE", tabId, siteMode });
}

function hideToast() {
  if (!toast) return;
  toast.classList.remove('visible');
  toast.classList.add('hidden');
}
function showToast(message, duration = 1500) {
  if (!toast) return;

  toast.textContent = message;
  toast.classList.remove('hidden');
  toast.classList.remove('visible');
  requestAnimationFrame(() => toast.classList.add('visible'));

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.classList.add('hidden'), 200);
  }, duration);
}

// ----- state -----
let lastInfo = null;
let lastTabId = null;
let lastAllowed = false;

function getUiMode() {
  return (site_mode?.value === "full") ? "full" : "safe";
}

function refreshButtons() {
  const notAllowedReason = "Chrome blocked script injection on this site.";
  setButtonAllowed(btnApply, lastAllowed, notAllowedReason);
  setButtonAllowed(btnRestore, lastAllowed, notAllowedReason);

  if (!lastAllowed) return;

  const ui = readSettingsFromUI();
  const applied = !!lastInfo?.enabled;
  const appliedSettings = lastInfo?.appliedSettings;

  const appliedMode = (lastInfo?.appliedMode === "full") ? "full" : "safe";
  const uiMode = getUiMode();

  setButtonAllowed(btnRestore, applied, applied ? "" : "Nothing to restore.");

  const canApply = !applied ||
    !settingsEqual(ui, appliedSettings) ||
    (uiMode !== appliedMode);

  setButtonAllowed(btnApply, canApply, canApply ? "" : "These settings + mode are already applied.");
}

async function syncModeUI(tabId) {
  if (!site_mode) return;

  const res = await getSiteMode(tabId);
  if (!res?.ok) return;

  if (site_host) site_host.textContent = res.host || "";
  site_mode.value = res.mode === "full" ? "full" : "safe";
  refreshButtons();
}

async function syncUIToCurrentTab() {
  hideToast();
  refreshSliderLabels();

  const tab = await getActiveTab();
  if (!tab) {
    showPopup(false);
    lastAllowed = false;
    refreshButtons();
    return;
  }

  lastTabId = tab.id;

  if (isRestrictedUrl(tab.url)) {
    showPopup(false);
    lastAllowed = false;
    refreshButtons();
    return;
  }

  const ok = await canInjectIntoTab(tab.id);
  if (!ok) {
    showPopup(false);
    lastAllowed = false;
    refreshButtons();
    return;
  }

  showPopup(true);
  lastAllowed = true;

  lastInfo = await getTabInfo(tab.id);
  if (lastInfo?.ok) writeSettingsToUI(lastInfo.settings);

  await syncModeUI(tab.id);
  refreshButtons();
}

async function onSettingsChanged() {
  refreshSliderLabels();

  if (!lastAllowed || typeof lastTabId !== "number") {
    refreshButtons();
    return;
  }

  const settings = readSettingsFromUI();

  await chrome.runtime.sendMessage({
    type: "SET_TAB_SETTINGS",
    tabId: lastTabId,
    settings
  });

  if (lastInfo?.ok) lastInfo.settings = settings;

  refreshButtons();
}

async function onModeChanged() {
  if (!lastAllowed || typeof lastTabId !== "number") return;

  const v = getUiMode();
  const res = await setSiteMode(lastTabId, v);
  if (res?.ok) showToast(v === "full" ? "Full mode enabled" : "Safe mode enabled", 1300);

  refreshButtons();
}

async function onApply() {
  const tab = await getActiveTab();
  if (!tab) return;

  if (isRestrictedUrl(tab.url) || !(await canInjectIntoTab(tab.id))) {
    lastAllowed = false;
    showPopup(false);
    refreshButtons();
    return;
  }

  lastAllowed = true;
  showPopup(true);

  const settings = readSettingsFromUI();

  await chrome.runtime.sendMessage({
    type: "SET_TAB_SETTINGS",
    tabId: tab.id,
    settings
  });

  const res = await chrome.runtime.sendMessage({
    type: "SET_TAB_ENABLED",
    tabId: tab.id,
    enabled: true
  });

  lastInfo = await getTabInfo(tab.id);
  refreshButtons();

  if (!res || !res.ok) {
    if (lastInfo?.ok) {
      lastInfo.enabled = false;
      lastInfo.appliedSettings = null;
      lastInfo.appliedMode = null;
    }
    refreshButtons();
  }
}

async function onRestore() {
  const tab = await getActiveTab();
  if (!tab) return;

  if (isRestrictedUrl(tab.url) || !(await canInjectIntoTab(tab.id))) {
    lastAllowed = false;
    showPopup(false);
    refreshButtons();
    return;
  }

  lastAllowed = true;
  showPopup(true);

  await chrome.runtime.sendMessage({
    type: "SET_TAB_ENABLED",
    tabId: tab.id,
    enabled: false
  });

  lastInfo = await getTabInfo(tab.id);
  refreshButtons();
}

async function onSaveMyDefault() {
  const settings = readSettingsFromUI();
  const res = await chrome.runtime.sendMessage({
    type: "SET_USER_DEFAULTS",
    userDefaults: settings
  });

  if (res?.ok) showToast("Saved!", 1500);
  else showToast("Save failed", 1600);
}

async function onResetMyDefault() {
  const tab = await getActiveTab();
  if (!tab) return;

  const res = await chrome.runtime.sendMessage({
    type: "RESET_TAB_TO_DEFAULTS",
    tabId: tab.id,
    which: "user"
  });

  if (res?.ok && res.settings) {
    writeSettingsToUI(res.settings);
    await onSettingsChanged();
  }
}

async function onResetExtDefault() {
  const tab = await getActiveTab();
  if (!tab) return;

  const res = await chrome.runtime.sendMessage({
    type: "RESET_TAB_TO_DEFAULTS",
    tabId: tab.id,
    which: "ext"
  });

  if (res?.ok && res.settings) {
    writeSettingsToUI(res.settings);
    await onSettingsChanged();
  }
}

(async function init() {
  await syncUIToCurrentTab();
})();

bind(node_coverage, "input", onSettingsChanged);
bind(gradient_size, "input", onSettingsChanged);
bind(color1, "input", onSettingsChanged);
bind(color2, "input", onSettingsChanged);
bind(color_text, "input", onSettingsChanged);
bind(safe_cycle_lines, "input", onSettingsChanged);

bind(site_mode, "change", onModeChanged);

bind(btnApply, "click", onApply);
bind(btnRestore, "click", onRestore);

bind(btnSaveMyDefault, "click", onSaveMyDefault);
bind(btnResetMyDefault, "click", onResetMyDefault);
bind(btnResetExtDefault, "click", onResetExtDefault);
