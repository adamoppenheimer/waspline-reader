// bg.js (MV3 service worker)

// ---------- helpers ----------
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

// Per-tab enabled state stored in session (clears when browser closes)
async function getEnabledTabs() {
  const result = await chrome.storage.session.get({ enabledTabs: {} });
  return result.enabledTabs || {};
}

async function setTabEnabled(tabId, enabled) {
  const enabledTabs = await getEnabledTabs();
  const key = String(tabId);

  if (enabled) enabledTabs[key] = true;
  else delete enabledTabs[key];

  await chrome.storage.session.set({ enabledTabs });
}

async function isTabEnabled(tabId) {
  const enabledTabs = await getEnabledTabs();
  return !!enabledTabs[String(tabId)];
}

async function getSettings() {
  return await chrome.storage.local.get({
    color1: "#0000FF",
    color2: "#FF0000",
    color_text: "#000000",
    gradient_size: 50
  });
}

// Inject content script into all frames (important for Gmail)
async function ensureInjectedAllFrames(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["contentScript.js"]
  });
}

// Send a message to all frames in the tab (important for Gmail)
async function sendToAllFrames(tabId, message) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  await Promise.all(
    frames.map(f =>
      chrome.tabs.sendMessage(tabId, message, { frameId: f.frameId }).catch(() => {})
    )
  );
}

async function applyToTab(tabId) {
  const settings = await getSettings();
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

// ---------- popup messaging ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "GET_TAB_ENABLED") {
        sendResponse({ enabled: await isTabEnabled(msg.tabId) });
        return;
      }

      if (msg?.type === "SET_TAB_ENABLED") {
        const tabId = msg.tabId;
        const desired = !!msg.enabled;

        const tab = await chrome.tabs.get(tabId);
        if (isRestrictedUrl(tab.url)) {
          // Can't run here; do not enable
          await setTabEnabled(tabId, false);
          sendResponse({ ok: false, reason: "restricted" });
          return;
        }

        // Persist per-tab state
        await setTabEnabled(tabId, desired);

        // Apply/reset immediately
        try {
          if (desired) await applyToTab(tabId);
          else await resetTab(tabId);

          sendResponse({ ok: true });
        } catch (e) {
          // If apply fails, revert enabled state
          if (desired) await setTabEnabled(tabId, false);
          sendResponse({ ok: false, reason: "inject_failed" });
        }
        return;
      }
    } catch (e) {
      sendResponse({ ok: false, reason: "internal_error" });
    }
  })();

  return true; // keep port open
});

// ---------- your preference: turn OFF on refresh/navigation ----------
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  // Any completed navigation/refresh turns it off for that tab
  await setTabEnabled(tabId, false);
});

// Cleanup on close
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await setTabEnabled(tabId, false);
});
