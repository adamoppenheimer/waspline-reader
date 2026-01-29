// bg.js (MV3 service worker)

// ----- extension defaults -----
const EXT_DEFAULTS = {
  color1: "#0000FF",
  color2: "#FF0000",
  color_text: "#000000",
  gradient_size: 50,

  // New: percent-based coverage of candidate nodes (0..100)
  // 0 still means "minimum behavior" (we still enforce at least 400 nodes in content script)
  node_coverage: 0
};

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

/**
 * Per-tab state in session storage:
 * tabStates: {
 *   [tabId]: {
 *     enabled: boolean,
 *     settings: { ... },              // selected settings in UI for this tab
 *     appliedSettings: { ... } | null,// settings last applied to the page
 *     settingsIsExplicit: boolean
 *   }
 * }
 */
async function getTabStates() {
  const result = await chrome.storage.session.get({ tabStates: {} });
  return result.tabStates || {};
}
async function setTabStates(tabStates) {
  await chrome.storage.session.set({ tabStates });
}
async function getTabState(tabId) {
  const tabStates = await getTabStates();
  return tabStates[String(tabId)] || null;
}
async function setTabState(tabId, patch) {
  const tabStates = await getTabStates();
  const key = String(tabId);
  const prev = tabStates[key] || {
    enabled: false,
    settings: null,
    appliedSettings: null,
    settingsIsExplicit: false
  };

  tabStates[key] = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : prev.enabled,
    settings: patch.settings !== undefined ? patch.settings : prev.settings,
    appliedSettings: patch.appliedSettings !== undefined ? patch.appliedSettings : prev.appliedSettings,
    settingsIsExplicit: typeof patch.settingsIsExplicit === "boolean" ? patch.settingsIsExplicit : prev.settingsIsExplicit
  };

  await setTabStates(tabStates);
}
async function clearTabState(tabId) {
  const tabStates = await getTabStates();
  delete tabStates[String(tabId)];
  await setTabStates(tabStates);
}

// User defaults in local storage
async function getUserDefaults() {
  const result = await chrome.storage.local.get({ userDefaults: EXT_DEFAULTS });
  return result.userDefaults || EXT_DEFAULTS;
}
async function setUserDefaults(newDefaults) {
  await chrome.storage.local.set({ userDefaults: newDefaults });
  return newDefaults;
}

// Injection helpers
async function ensureInjectedAllFrames(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["contentScript.js"]
  });
}

async function sendToAllFrames(tabId, message) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  await Promise.all(
    frames.map(f =>
      chrome.tabs.sendMessage(tabId, message, { frameId: f.frameId }).catch(() => {})
    )
  );
}

async function applyToTab(tabId, settings) {
  await ensureInjectedAllFrames(tabId);
  await sendToAllFrames(tabId, {
    command: "apply_gradient",
    colors: [settings.color1, settings.color2],
    color_text: settings.color_text,
    gradient_size: settings.gradient_size,
    node_coverage: settings.node_coverage
  });
}

async function resetTab(tabId) {
  await ensureInjectedAllFrames(tabId);
  await sendToAllFrames(tabId, { command: "reset" });
}

async function getSelectedSettingsForTab(tabId) {
  const state = await getTabState(tabId);
  if (state && state.settings) return state.settings;
  return await getUserDefaults();
}

// ----- messaging API for popup -----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "GET_TAB_INFO") {
        const tabId = msg.tabId;
        const state = await getTabState(tabId);
        const userDefaults = await getUserDefaults();

        const selected = state?.settings || userDefaults;

        sendResponse({
          ok: true,
          enabled: !!state?.enabled,
          settings: selected,
          appliedSettings: state?.appliedSettings || null,
          userDefaults,
          extDefaults: EXT_DEFAULTS
        });
        return;
      }

      // Apply / Restore
      if (msg?.type === "SET_TAB_ENABLED") {
        const tabId = msg.tabId;
        const desired = !!msg.enabled;

        const tab = await chrome.tabs.get(tabId);
        if (isRestrictedUrl(tab.url)) {
          await setTabState(tabId, { enabled: false, appliedSettings: null });
          sendResponse({ ok: false, reason: "restricted" });
          return;
        }

        // Ensure selected settings exist
        const current = await getTabState(tabId);
        if (!current?.settings) {
          const userDefaults = await getUserDefaults();
          await setTabState(tabId, { settings: userDefaults, settingsIsExplicit: false });
        }

        if (desired) {
          const settings = await getSelectedSettingsForTab(tabId);

          await setTabState(tabId, { enabled: true });

          try {
            await applyToTab(tabId, settings);
            await setTabState(tabId, { appliedSettings: settings });
            sendResponse({ ok: true });
          } catch (_) {
            await setTabState(tabId, { enabled: false, appliedSettings: null });
            sendResponse({ ok: false, reason: "inject_failed" });
          }
          return;
        } else {
          await setTabState(tabId, { enabled: false });
          try { await resetTab(tabId); } catch (_) {}
          await setTabState(tabId, { appliedSettings: null });
          sendResponse({ ok: true });
          return;
        }
      }

      // Update per-tab selected settings (does NOT auto-apply)
      if (msg?.type === "SET_TAB_SETTINGS") {
        const tabId = msg.tabId;
        const newSettings = msg.settings;

        await setTabState(tabId, { settings: newSettings, settingsIsExplicit: true });
        sendResponse({ ok: true });
        return;
      }

      // Save user defaults (global). Does not auto-apply.
      if (msg?.type === "SET_USER_DEFAULTS") {
        const saved = await setUserDefaults(msg.userDefaults);

        const tabId = sender?.tab?.id;
        if (typeof tabId === "number") {
          const state = await getTabState(tabId);
          const isExplicit = !!state?.settingsIsExplicit;
          if (!isExplicit) {
            await setTabState(tabId, { settings: saved, settingsIsExplicit: false });
          }
        }

        sendResponse({ ok: true, userDefaults: saved });
        return;
      }

      // Reset selected controls to defaults; no auto-apply
      if (msg?.type === "RESET_TAB_TO_DEFAULTS") {
        const tabId = msg.tabId;
        const which = msg.which; // "user" | "ext"
        const defaults = which === "ext" ? EXT_DEFAULTS : await getUserDefaults();
        await setTabState(tabId, { settings: defaults, settingsIsExplicit: false });
        sendResponse({ ok: true, settings: defaults });
        return;
      }

      sendResponse({ ok: false, reason: "unknown_message" });
    } catch (_) {
      sendResponse({ ok: false, reason: "internal_error" });
    }
  })();

  return true;
});

// Disable on refresh/navigation
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  await setTabState(tabId, { enabled: false, appliedSettings: null });
});

// Cleanup on close
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearTabState(tabId);
});
