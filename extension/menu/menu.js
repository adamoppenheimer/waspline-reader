'use strict';

// ----- DOM refs -----
const color1 = document.getElementById('color1');
const color2 = document.getElementById('color2');
const color_text = document.getElementById('color_text');
const gradient_size = document.getElementById('gradient_size');
const enabled = document.getElementById('enabled');

const btnSaveMyDefault = document.getElementById('save-my-default');
const btnResetMyDefault = document.getElementById('reset-my-default');
const btnResetExtDefault = document.getElementById('reset-ext-default');

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

function readSettingsFromUI() {
  return {
    color1: color1.value,
    color2: color2.value,
    color_text: color_text.value,
    gradient_size: Number(gradient_size.value)
  };
}

function writeSettingsToUI(settings) {
  color1.value = settings.color1;
  color2.value = settings.color2;
  color_text.value = settings.color_text;
  gradient_size.value = settings.gradient_size;
}

// Pull current tab info from background
async function getTabInfo(tabId) {
  return await chrome.runtime.sendMessage({ type: "GET_TAB_INFO", tabId });
}

async function syncUIToCurrentTab() {
  const tab = await getActiveTab();
  if (!tab) return;

  // Restriction checks
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

  const info = await getTabInfo(tab.id);
  if (!info?.ok) return;

  enabled.checked = !!info.enabled;
  writeSettingsToUI(info.settings);
}

// ----- behavior: any setting change updates this tab immediately (if enabled) -----
async function onSettingChanged(e) {
  const tab = await getActiveTab();
  if (!tab) return;

  if (isRestrictedUrl(tab.url) || !(await canInjectIntoTab(tab.id))) {
    enabled.checked = false;
    setEnabledAllowed(false, "This extension can't run on this page.");
    return;
  }
  setEnabledAllowed(true);

  const settings = readSettingsFromUI();

  // Save settings to this tab (does not affect other tabs)
  await chrome.runtime.sendMessage({
    type: "SET_TAB_SETTINGS",
    tabId: tab.id,
    settings
  });

  // If enabled checkbox is ON, bg.js will apply immediately after SET_TAB_SETTINGS.
  // If OFF, it just stores the per-tab settings for next time you enable.
}

// ----- behavior: toggle enabled for this tab -----
async function onEnabledToggled(e) {
  const tab = await getActiveTab();
  if (!tab) return;

  if (isRestrictedUrl(tab.url) || !(await canInjectIntoTab(tab.id))) {
    enabled.checked = false;
    setEnabledAllowed(false, "This extension can't run on this page.");
    return;
  }
  setEnabledAllowed(true);

  // Ensure bg has latest settings for this tab before enabling
  const settings = readSettingsFromUI();
  await chrome.runtime.sendMessage({
    type: "SET_TAB_SETTINGS",
    tabId: tab.id,
    settings
  });

  const res = await chrome.runtime.sendMessage({
    type: "SET_TAB_ENABLED",
    tabId: tab.id,
    enabled: enabled.checked
  });

  if (enabled.checked && (!res || !res.ok)) {
    enabled.checked = false;
    const reason =
      res && res.reason === "restricted" ? "Not allowed on this type of page." :
      res && res.reason === "inject_failed" ? "Chrome blocked script injection on this site." :
      "Could not enable on this page.";
    setEnabledAllowed(false, reason);
  }
}

// ----- buttons -----
async function onSaveMyDefault() {
  const settings = readSettingsFromUI();

  // Save global user default (does not affect other tabs)
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
  }
}

// ----- init -----
(async function init() {
  await syncUIToCurrentTab();
})();

// ----- listeners -----
enabled.addEventListener("change", onEnabledToggled);

gradient_size.addEventListener("change", onSettingChanged);
color1.addEventListener("change", onSettingChanged);
color2.addEventListener("change", onSettingChanged);
color_text.addEventListener("change", onSettingChanged);

// Buttons
btnSaveMyDefault.addEventListener("click", onSaveMyDefault);
btnResetMyDefault.addEventListener("click", onResetMyDefault);
btnResetExtDefault.addEventListener("click", onResetExtDefault);
