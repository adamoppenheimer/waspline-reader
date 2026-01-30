// bg.js (MV3 service worker)

// ----- extension defaults -----
const EXT_DEFAULTS = {
  color1: "#0000FF",
  color2: "#FF0000",
  color_text: "#000000",
  gradient_size: 50,
  node_coverage: 0,

  // NEW: Safe mode control — how many "lines" per color sweep (smaller = faster change)
  safe_cycle_lines: 6
};

// Mode prefs (stored separately from userDefaults to avoid breaking your existing defaults UX)
const MODE_DEFAULTS = {
  defaultMode: "safe", // safe-by-default everywhere
  siteModes: {}        // { "host": "full" } overrides only
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

function getHostFromUrl(url) {
  try {
    return new URL(url).host || "";
  } catch (_) {
    return "";
  }
}

/**
 * Per-tab state in session storage:
 * tabStates: {
 *   [tabId]: {
 *     enabled: boolean,
 *     settings: { ... },
 *     appliedSettings: { ... } | null,
 *     appliedMode: "safe" | "full" | null,
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
    appliedMode: null,
    settingsIsExplicit: false
  };

  tabStates[key] = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : prev.enabled,
    settings: patch.settings !== undefined ? patch.settings : prev.settings,
    appliedSettings: patch.appliedSettings !== undefined ? patch.appliedSettings : prev.appliedSettings,
    appliedMode: patch.appliedMode !== undefined ? patch.appliedMode : prev.appliedMode,
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
  // Ensure new key exists even for old installs
  const u = result.userDefaults || EXT_DEFAULTS;
  if (u.safe_cycle_lines === undefined) u.safe_cycle_lines = EXT_DEFAULTS.safe_cycle_lines;
  return u;
}
async function setUserDefaults(newDefaults) {
  await chrome.storage.local.set({ userDefaults: newDefaults });
  return newDefaults;
}

// Mode prefs in local storage
async function getModePrefs() {
  const result = await chrome.storage.local.get({ modePrefs: MODE_DEFAULTS });
  const prefs = result.modePrefs || MODE_DEFAULTS;
  const defaultMode = prefs.defaultMode === "full" ? "full" : "safe";
  const siteModes = (prefs.siteModes && typeof prefs.siteModes === "object") ? prefs.siteModes : {};
  return { defaultMode, siteModes };
}
async function setModePrefs(prefs) {
  await chrome.storage.local.set({ modePrefs: prefs });
  return prefs;
}
async function resolveModeForTabUrl(url) {
  const host = getHostFromUrl(url);
  const prefs = await getModePrefs();
  const override = prefs.siteModes?.[host];
  const mode = (override === "full") ? "full" : prefs.defaultMode; // safe default
  return { host, mode, prefs };
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

async function applyToTab(tabId, tabUrl, settings) {
  await ensureInjectedAllFrames(tabId);

  const { mode } = await resolveModeForTabUrl(tabUrl);

  await sendToAllFrames(tabId, {
    command: "apply_gradient",
    colors: [settings.color1, settings.color2],
    color_text: settings.color_text,
    gradient_size: settings.gradient_size,
    node_coverage: settings.node_coverage,

    // NEW: safe mode line-cycle control
    safe_cycle_lines: settings.safe_cycle_lines,

    mode
  });

  return mode;
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
          appliedMode: state?.appliedMode || null,
          userDefaults,
          extDefaults: EXT_DEFAULTS
        });
        return;
      }

      if (msg?.type === "GET_SITE_MODE") {
        const tabId = msg.tabId;
        const tab = await chrome.tabs.get(tabId);
        const { host, mode, prefs } = await resolveModeForTabUrl(tab.url);

        sendResponse({
          ok: true,
          host,
          mode,
          isOverridden: prefs.siteModes?.[host] === "full"
        });
        return;
      }

      if (msg?.type === "SET_SITE_MODE") {
        const tabId = msg.tabId;
        const tab = await chrome.tabs.get(tabId);
        const host = getHostFromUrl(tab.url);

        const prefs = await getModePrefs();
        const next = (msg.siteMode === "full") ? "full" : "safe";

        const siteModes = { ...(prefs.siteModes || {}) };
        if (next === "full") siteModes[host] = "full";
        else delete siteModes[host];

        await setModePrefs({ defaultMode: "safe", siteModes });
        sendResponse({ ok: true, host, siteMode: next });
        return;
      }

      if (msg?.type === "SET_TAB_ENABLED") {
        const tabId = msg.tabId;
        const desired = !!msg.enabled;

        const tab = await chrome.tabs.get(tabId);
        if (isRestrictedUrl(tab.url)) {
          await setTabState(tabId, { enabled: false, appliedSettings: null, appliedMode: null });
          sendResponse({ ok: false, reason: "restricted" });
          return;
        }

        const current = await getTabState(tabId);
        if (!current?.settings) {
          const userDefaults = await getUserDefaults();
          await setTabState(tabId, { settings: userDefaults, settingsIsExplicit: false });
        }

        if (desired) {
          const settings = await getSelectedSettingsForTab(tabId);
          await setTabState(tabId, { enabled: true });

          try {
            const modeUsed = await applyToTab(tabId, tab.url, settings);
            await setTabState(tabId, { appliedSettings: settings, appliedMode: modeUsed });
            sendResponse({ ok: true });
          } catch (_) {
            await setTabState(tabId, { enabled: false, appliedSettings: null, appliedMode: null });
            sendResponse({ ok: false, reason: "inject_failed" });
          }
          return;
        } else {
          await setTabState(tabId, { enabled: false });
          try { await resetTab(tabId); } catch (_) {}
          await setTabState(tabId, { appliedSettings: null, appliedMode: null });
          sendResponse({ ok: true });
          return;
        }
      }

      if (msg?.type === "SET_TAB_SETTINGS") {
        const tabId = msg.tabId;
        await setTabState(tabId, { settings: msg.settings, settingsIsExplicit: true });
        sendResponse({ ok: true });
        return;
      }

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

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  await setTabState(tabId, { enabled: false, appliedSettings: null, appliedMode: null });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearTabState(tabId);
});
