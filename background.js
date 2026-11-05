/**
 * 3D Visual Tab Switcher - Background Service Worker (Manifest V3)
 *
 * Maximally Lightweight & Rich Visual Preview Engine:
 * - Persistent Storage: Snapshots are preserved in chrome.storage.local across service worker
 *   idle/wake cycles, so all open tabs maintain real preview pictures!
 * - Micro-Thumbnail Downscaling: Downscales tab snapshots to 320x200 JPEGs via OffscreenCanvas,
 *   reducing RAM usage by ~95% (from ~800KB down to ~12KB per tab).
 * - Page Visual Ingestion: Content scripts extract and register rich page previews (og:image,
 *   hero banners) for background tabs that haven't been directly visited yet.
 * - Compact LRU Cache: Up to 30 recent tabs are stored (~350KB total storage).
 * - Automatic Garbage Collection: Prunes dead tab previews on tab close and browser startup.
 */

const STORAGE_KEY = 'tab_snapshots_v1';
const snapshotCache = new Map();
const MAX_SNAPSHOT_CACHE_SIZE = 30;

/**
 * Checks if a given URL is a restricted internal browser page
 * where content scripts cannot execute.
 */
function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('devtools://') ||
    url.startsWith('edge://') ||
    url.startsWith('view-source:') ||
    url.includes('chromewebstore.google.com')
  );
}

// -----------------------------------------------------------------------------
// PERSISTENT STORAGE MANAGEMENT (Survives Service Worker Restarts)
// -----------------------------------------------------------------------------

async function initSnapshotStorage() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data && data[STORAGE_KEY]) {
      const stored = data[STORAGE_KEY];
      for (const [id, url] of Object.entries(stored)) {
        snapshotCache.set(Number(id), url);
      }
    }
    pruneDeadTabSnapshots();
  } catch (err) {
    console.debug('[3D Tab Switcher] Error loading snapshot storage:', err);
  }
}

initSnapshotStorage();

let persistTimer = null;
function persistSnapshotCache() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const obj = {};
      for (const [id, url] of snapshotCache.entries()) {
        obj[id] = url;
      }
      chrome.storage.local.set({ [STORAGE_KEY]: obj }).catch(() => {});
    } catch {}
  }, 400);
}

async function pruneDeadTabSnapshots() {
  try {
    const allTabs = await chrome.tabs.query({});
    const activeTabIds = new Set(allTabs.map((t) => t.id));
    let changed = false;

    for (const tabId of snapshotCache.keys()) {
      if (!activeTabIds.has(tabId)) {
        snapshotCache.delete(tabId);
        changed = true;
      }
    }

    if (changed) {
      persistSnapshotCache();
    }
  } catch {}
}

/**
 * Downscales full-resolution viewport captures into ultra-lightweight thumbnails.
 */
async function downscaleToThumbnail(dataUrl, maxW = 320, maxH = 200) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);

    let w = bitmap.width;
    let h = bitmap.height;
    if (w > maxW) {
      h = Math.round((h * maxW) / w);
      w = maxW;
    }
    if (h > maxH) {
      w = Math.round((w * maxH) / h);
      h = maxH;
    }

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close(); // Free raw texture from VRAM immediately

    const resizedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.5 });
    const buffer = await resizedBlob.arrayBuffer();

    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return 'data:image/jpeg;base64,' + btoa(binary);
  } catch {
    return dataUrl;
  }
}

/**
 * Captures a visual snapshot of the currently active tab.
 */
function captureActiveTab(windowId) {
  return new Promise((resolve) => {
    try {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, 200);

      chrome.tabs.captureVisibleTab(
        windowId || null,
        { format: 'jpeg', quality: 45 },
        async (dataUrl) => {
          if (timedOut) return;
          clearTimeout(timer);
          if (chrome.runtime.lastError || !dataUrl) {
            resolve(null);
          } else {
            const thumbnail = await downscaleToThumbnail(dataUrl);
            resolve(thumbnail);
          }
        }
      );
    } catch {
      resolve(null);
    }
  });
}

function cacheSnapshot(tabId, dataUrl) {
  if (!tabId || !dataUrl) return;

  if (snapshotCache.size >= MAX_SNAPSHOT_CACHE_SIZE && !snapshotCache.has(tabId)) {
    const oldestKey = snapshotCache.keys().next().value;
    snapshotCache.delete(oldestKey);
  }

  snapshotCache.set(tabId, dataUrl);
  persistSnapshotCache();
}

let snapshotTimer = null;
function requestSnapshot(tabId, windowId, delayMs = 350) {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(async () => {
    const dataUrl = await captureActiveTab(windowId);
    if (dataUrl) {
      cacheSnapshot(tabId, dataUrl);
    }
  }, delayMs);
}

// -----------------------------------------------------------------------------
// EXTENSION LIFECYCLE: AUTO-INJECT ON INSTALL / UPDATE
// -----------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file://*/*'] });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
      } catch {}
    }
  } catch (err) {
    console.debug('[3D Tab Switcher] Setup injection error:', err);
  }
});

// -----------------------------------------------------------------------------
// TAB LIFECYCLE LISTENERS
// -----------------------------------------------------------------------------

chrome.tabs.onActivated.addListener((activeInfo) => {
  requestSnapshot(activeInfo.tabId, activeInfo.windowId, 250);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.status === 'complete') {
    requestSnapshot(tabId, tab.windowId, 350);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  snapshotCache.delete(tabId);
  persistSnapshotCache();
});

// -----------------------------------------------------------------------------
// ROBUST MESSAGE DISPATCH WITH AUTO-INJECTION FALLBACK
// -----------------------------------------------------------------------------

async function sendOrInject(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      await new Promise((r) => setTimeout(r, 60));
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (injectErr) {
      throw injectErr;
    }
  }
}

async function dispatchCycleOrOpenToActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    if (!tabs || tabs.length === 0) return;

    const activeTab = tabs.find((t) => t.active);

    if (activeTab && !isRestrictedUrl(activeTab.url)) {
      await sendOrInject(activeTab.id, { action: 'CYCLE_OR_OPEN' });
      return;
    }

    const accessibleTab = tabs.find((t) => !isRestrictedUrl(t.url));
    if (accessibleTab) {
      await chrome.tabs.update(accessibleTab.id, { active: true });
      await new Promise((r) => setTimeout(r, 100));
      await sendOrInject(accessibleTab.id, { action: 'CYCLE_OR_OPEN' });
    } else {
      const currentIdx = activeTab ? activeTab.index : 0;
      const nextIdx = (currentIdx + 1) % tabs.length;
      await chrome.tabs.update(tabs[nextIdx].id, { active: true });
    }
  } catch (err) {
    console.debug('[3D Tab Switcher] Error dispatching command:', err);
  }
}

async function dispatchToggleToActiveTab(explicitTab) {
  try {
    let target = explicitTab;
    if (!target) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      target = activeTab;
    }

    if (!target || !target.id) return;

    if (!isRestrictedUrl(target.url)) {
      await sendOrInject(target.id, { action: 'TOGGLE_SWITCHER' });
    } else {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const accessibleTab = tabs.find((t) => !isRestrictedUrl(t.url));
      if (accessibleTab) {
        await chrome.tabs.update(accessibleTab.id, { active: true });
        await new Promise((r) => setTimeout(r, 100));
        await sendOrInject(accessibleTab.id, { action: 'TOGGLE_SWITCHER' });
      }
    }
  } catch (err) {
    console.debug('[3D Tab Switcher] Error toggling switcher:', err);
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-tab-switcher') {
    dispatchCycleOrOpenToActiveTab();
  }
});

// -----------------------------------------------------------------------------
// MESSAGE DISPATCHER (CONTENT SCRIPT <-> BACKGROUND)
// -----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Register visual preview image found by content script (og:image / hero banner / live video frame)
  if (request.action === 'REGISTER_PAGE_VISUAL' && sender.tab?.id) {
    const tabId = sender.tab.id;
    if (request.visualUrl) {
      // Overwrite if requested (e.g. video frame update) or if no snapshot exists yet
      if (request.forceOverwrite || !snapshotCache.has(tabId)) {
        cacheSnapshot(tabId, request.visualUrl);
      }
    }
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'TRIGGER_ACTIVE_SWITCHER') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const target = tabs && tabs[0] ? tabs[0] : null;
        await dispatchToggleToActiveTab(target);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'GET_TABS') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const activeTab = tabs.find((t) => t.active);

        // Immediately refresh active tab's snapshot so current view is 100% live
        if (activeTab && !isRestrictedUrl(activeTab.url)) {
          const freshSnapshot = await captureActiveTab(activeTab.windowId);
          if (freshSnapshot) {
            cacheSnapshot(activeTab.id, freshSnapshot);
          }
        }

        const tabsPayload = tabs.map((tab) => {
          let domain = 'web';
          try {
            if (tab.url.startsWith('http://') || tab.url.startsWith('https://')) {
              domain = new URL(tab.url).hostname.replace(/^www\./, '');
            } else if (tab.url.startsWith('chrome://')) {
              domain = 'chrome://' + (tab.url.replace('chrome://', '').split('/')[0] || '');
            } else if (tab.url.startsWith('about:')) {
              domain = 'about:blank';
            } else if (tab.url) {
              domain = tab.url.split('/')[0];
            }
          } catch {
            domain = 'web';
          }

          return {
            id: tab.id,
            index: tab.index,
            title: tab.title || 'Untitled Tab',
            url: tab.url || '',
            domain,
            favIconUrl: tab.favIconUrl || '',
            active: tab.active,
            snapshot: snapshotCache.get(tab.id) || null
          };
        });

        sendResponse({ success: true, tabs: tabsPayload });
      } catch (error) {
        sendResponse({ success: false, error: error.message, tabs: [] });
      }
    })();
    return true;
  }

  if (request.action === 'SWITCH_TAB') {
    chrome.tabs.update(request.tabId, { active: true }, (tab) => {
      sendResponse({ success: !chrome.runtime.lastError, tab });
    });
    return true;
  }

  if (request.action === 'CLOSE_TAB') {
    chrome.tabs.remove(request.tabId, () => {
      snapshotCache.delete(request.tabId);
      persistSnapshotCache();
      sendResponse({ success: !chrome.runtime.lastError });
    });
    return true;
  }
});
