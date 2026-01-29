// bg.js (MV3 service worker)

// ----- extension defaults -----
const EXT_DEFAULTS = {
  color1: "#0000FF",
  color2: "#FF0000",
  color_text: "#000000",
  gradient_size: 50
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

// Per-tab state in session storage:
// tabStates: { [tabId]: { enabled: boolean, settings: {color1,color2,color_text,gradient_size} } }
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
  const prev = tabStates[key] || { enabled: false, settings: null };
  tabStates[key] = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : prev.enabled,
    settings: patch.settings !== undefined ? patch.settings : prev.settings
  };
  await setTabStates(tabStates);
}
async function clearTabState(tabId) {
  const tabStates = await getTabStates();
  delete tabStates[String(tabId)];
  await setTabStates(tabStates);
}

// User defaults in local storage (synced across tabs)
async function getUserDefaults() {
  const result = await chrome.storage.local.get({ userDefaults: EXT_DEFAULTS });
  return result.userDefaults || EXT_DEFAULTS;
}
async function setUserDefaults(newDefaults) {
  await chrome.storage.local.set({ userDefaults: newDefaults });
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
    gradient_size: settings.gradient_size
  });
}

async function resetTab(tabId) {
  await ensureInjectedAllFrames(tabId);
  await sendToAllFrames(tabId, { command: "reset" });
}

// Effective settings for a tab: tab.settings if present else userDefaults
async function getEffectiveSettingsForTab(tabId) {
  const state = await getTabState(tabId);
  if (state && state.settings) return state.settings;
  return await getUserDefaults();
}

// ----- messaging API for popup -----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // Return current tab enabled + effective settings + user defaults + ext defaults
      if (msg?.type === "GET_TAB_INFO") {
        const tabId = msg.tabId;
        const state = await getTabState(tabId);
        const userDefaults = await getUserDefaults();
        const effective = state?.settings || userDefaults;

        sendResponse({
          ok: true,
          enabled: !!state?.enabled,
          settings: effective,
          userDefaults,
          extDefaults: EXT_DEFAULTS
        });
        return;
      }

      // Toggle enabled for this tab (per-tab)
      if (msg?.type === "SET_TAB_ENABLED") {
        const tabId = msg.tabId;
        const desired = !!msg.enabled;

        const tab = await chrome.tabs.get(tabId);
        if (isRestrictedUrl(tab.url)) {
          await setTabState(tabId, { enabled: false });
          sendResponse({ ok: false, reason: "restricted" });
          return;
        }

        // Ensure tab has settings; default to user defaults if missing
        const current = await getTabState(tabId);
        if (!current?.settings) {
          const userDefaults = await getUserDefaults();
          await setTabState(tabId, { settings: userDefaults });
        }

        await setTabState(tabId, { enabled: desired });

        try {
          if (desired) {
            const settings = await getEffectiveSettingsForTab(tabId);
            await applyToTab(tabId, settings);
          } else {
            await resetTab(tabId);
          }
          sendResponse({ ok: true });
        } catch (e) {
          // If enabling failed, revert to disabled
          if (desired) await setTabState(tabId, { enabled: false });
          sendResponse({ ok: false, reason: "inject_failed" });
        }
        return;
      }

      // Update per-tab settings (does not affect other tabs)
      // If enabled, apply immediately
      if (msg?.type === "SET_TAB_SETTINGS") {
        const tabId = msg.tabId;
        const newSettings = msg.settings;

        await setTabState(tabId, { settings: newSettings });

        const state = await getTabState(tabId);
        if (state?.enabled) {
          const tab = await chrome.tabs.get(tabId);
          if (!isRestrictedUrl(tab.url)) {
            try {
              await applyToTab(tabId, newSettings);
            } catch (_) {
              // If apply fails, silently keep settings but do not crash
            }
          }
        }

        sendResponse({ ok: true });
        return;
      }

      // Save user defaults (global)
      if (msg?.type === "SET_USER_DEFAULTS") {
        await setUserDefaults(msg.userDefaults);
        sendResponse({ ok: true });
        return;
      }

      // Reset current tab settings to "user" or "ext" defaults (and apply if enabled)
      if (msg?.type === "RESET_TAB_TO_DEFAULTS") {
        const tabId = msg.tabId;
        const which = msg.which; // "user" | "ext"

        const defaults = which === "ext" ? EXT_DEFAULTS : await getUserDefaults();
        await setTabState(tabId, { settings: defaults });

        const state = await getTabState(tabId);
        if (state?.enabled) {
          try { await applyToTab(tabId, defaults); } catch (_) {}
        }

        sendResponse({ ok: true, settings: defaults });
        return;
      }

      sendResponse({ ok: false, reason: "unknown_message" });
    } catch (e) {
      sendResponse({ ok: false, reason: "internal_error" });
    }
  })();

  return true;
});

// ----- your preference: disable on refresh/navigation -----
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  // Always turn off on navigation/refresh
  await setTabState(tabId, { enabled: false });
});

// Cleanup on close
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearTabState(tabId);
});
