'use strict';

// ----- DOM refs -----
const color1 = document.getElementById('color1');
const color2 = document.getElementById('color2');
const color_text = document.getElementById('color_text');
const gradient_size = document.getElementById('gradient_size');

const btnApply = document.getElementById('apply');
const btnRestore = document.getElementById('restore');

const btnSaveMyDefault = document.getElementById('save-my-default');
const btnResetMyDefault = document.getElementById('reset-my-default');
const btnResetExtDefault = document.getElementById('reset-ext-default');

const popupContent = document.getElementById('popup-content');
const errorContent = document.getElementById('error-content');

// Defensive binder
function bind(el, eventName, handler) {
  if (!el) return;
  el.addEventListener(eventName, handler);
}

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

// MV3 injection check on active tab
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

function readSettingsFromUI() {
  return {
    color1: color1?.value ?? "#0000FF",
    color2: color2?.value ?? "#FF0000",
    color_text: color_text?.value ?? "#000000",
    gradient_size: Number(gradient_size?.value ?? 50)
  };
}

function writeSettingsToUI(settings) {
  if (!settings) return;
  if (color1) color1.value = settings.color1 ?? "#0000FF";
  if (color2) color2.value = settings.color2 ?? "#FF0000";
  if (color_text) color_text.value = settings.color_text ?? "#000000";
  if (gradient_size) gradient_size.value = String(settings.gradient_size ?? 50);
}

function settingsEqual(a, b) {
  if (!a || !b) return false;
  return String(a.color1) === String(b.color1) &&
    String(a.color2) === String(b.color2) &&
    String(a.color_text) === String(b.color_text) &&
    Number(a.gradient_size) === Number(b.gradient_size);
}

async function getTabInfo(tabId) {
  return await chrome.runtime.sendMessage({ type: "GET_TAB_INFO", tabId });
}

// ----- state -----
let lastInfo = null;   // { enabled, settings, appliedSettings, ... }
let lastTabId = null;
let lastAllowed = false;

// ----- UI state -----
function refreshButtons() {
  const notAllowedReason = "Chrome blocked script injection on this site.";
  setButtonAllowed(btnApply, lastAllowed, notAllowedReason);
  setButtonAllowed(btnRestore, lastAllowed, notAllowedReason);

  if (!lastAllowed) return;

  const ui = readSettingsFromUI();
  const applied = !!lastInfo?.enabled;
  const appliedSettings = lastInfo?.appliedSettings; // IMPORTANT: separate from selected

  // Restore only if something is applied
  setButtonAllowed(btnRestore, applied, applied ? "" : "Nothing to restore.");

  // Apply if not applied yet, or UI differs from what is currently applied
  const canApply = !applied || !settingsEqual(ui, appliedSettings);
  setButtonAllowed(btnApply, canApply, canApply ? "" : "These settings are already applied.");
}

// ----- init / sync -----
async function syncUIToCurrentTab() {
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
  if (lastInfo?.ok) {
    // Fill UI with selected settings for this tab (not necessarily applied)
    writeSettingsToUI(lastInfo.settings);
  }

  refreshButtons();
}

// ----- settings changes: store selected settings only -----
async function onSettingsChanged() {
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

  // Update local cache: selected settings changed, appliedSettings unchanged
  if (lastInfo?.ok) lastInfo.settings = settings;

  refreshButtons();
}

// ----- Apply / Restore -----
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

  // Persist selected settings first
  await chrome.runtime.sendMessage({
    type: "SET_TAB_SETTINGS",
    tabId: tab.id,
    settings
  });

  // Apply to page
  const res = await chrome.runtime.sendMessage({
    type: "SET_TAB_ENABLED",
    tabId: tab.id,
    enabled: true
  });

  // Refresh info for appliedSettings + enabled state
  lastInfo = await getTabInfo(tab.id);
  refreshButtons();

  if (!res || !res.ok) {
    if (lastInfo?.ok) {
      lastInfo.enabled = false;
      lastInfo.appliedSettings = null;
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

// ----- defaults buttons -----
async function onSaveMyDefault() {
  const settings = readSettingsFromUI();
  await chrome.runtime.sendMessage({
    type: "SET_USER_DEFAULTS",
    userDefaults: settings
  });
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

// ----- init -----
(async function init() {
  await syncUIToCurrentTab();
})();

// Controls changes do not auto-apply
bind(gradient_size, "input", onSettingsChanged);
bind(color1, "input", onSettingsChanged);
bind(color2, "input", onSettingsChanged);
bind(color_text, "input", onSettingsChanged);

// Apply / Restore
bind(btnApply, "click", onApply);
bind(btnRestore, "click", onRestore);

// Defaults
bind(btnSaveMyDefault, "click", onSaveMyDefault);
bind(btnResetMyDefault, "click", onResetMyDefault);
bind(btnResetExtDefault, "click", onResetExtDefault);
