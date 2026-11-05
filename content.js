/**
 * 3D Visual Tab Switcher - Content Script
 *
 * Maximally Lightweight & Rich Visual Preview Architecture:
 * - Real Page Visual Extraction: Extracts og:image and hero banners from the active page
 *   and registers them with background.js so background tabs display real pictures!
 * - Zero Idle Overhead: Fast-bail key checking (`if (!e.altKey ...) return;`) executes in < 0.001ms.
 * - Single-Pass Blur Compositing: Global backdrop filter on the overlay only. Eliminates nested
 *   per-card backdrop-filter passes for a locked 60/120 FPS.
 * - Backface Culling & Paint Containment: `backface-visibility: hidden` and `contain: layout paint`.
 * - Async Image Decoding: `decoding="async"` prevents main-thread stalls.
 * - Complete Memory Tear-down on unmount.
 */

(() => {
  // Prevent duplicate execution if script is reinjected dynamically
  if (window.__3D_TAB_SWITCHER_INITIALIZED__) return;
  window.__3D_TAB_SWITCHER_INITIALIZED__ = true;

  const ROOT_ID = 'tab-switcher-root';
  const CARD_WIDTH = 260; // w = 260px
  const CARD_HEIGHT = 170; // h = 170px
  const CARD_GAP = 24; // g = 24px
  const MIN_RADIUS = 450; // Minimum radius clamp for low tab counts

  // User configurable shortcut settings
  let userSettings = {
    customModifier: 'Alt',
    customKey: 'Q',
    releaseToSwitch: true,
    autoAdvanceOnFirstPress: true
  };

  let hostElement = null;
  let shadowRoot = null;
  let isMounted = false;
  let isMounting = false;
  let isHoldingModifier = false;
  let pendingReleaseOnMount = false;

  // Active state
  let currentTabs = [];
  let currentIndex = 0;
  let currentAngleDeg = 0;
  let thetaDeg = 0;
  let cylinderRadius = MIN_RADIUS;

  // DOM elements inside Shadow Root
  let cylinderEl = null;
  let counterCurrentEl = null;
  let counterTotalEl = null;
  let hintsFooterEl = null;
  let cardElements = [];

  // ---------------------------------------------------------------------------
  // VISUAL METADATA & LIVE MEDIA FRAME EXTRACTION
  // ---------------------------------------------------------------------------

  function captureVideoFrame() {
    try {
      const video = document.querySelector('video');
      if (video && video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2) {
        const targetW = 320;
        const targetH = Math.round((video.videoHeight * targetW) / video.videoWidth);
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, targetW, targetH);
        return canvas.toDataURL('image/jpeg', 0.55);
      }
    } catch {}
    return null;
  }

  function getYouTubeThumbnail() {
    try {
      if (location.hostname.includes('youtube.com')) {
        const v = new URLSearchParams(location.search).get('v');
        if (v) {
          return `https://i.ytimg.com/vi/${v}/hqdefault.jpg`;
        }
      }
    } catch {}
    return null;
  }

  function extractPageVisuals(checkVideo = false) {
    try {
      // 0. If video frame check is requested, try grabbing current video frame
      if (checkVideo) {
        const frame = captureVideoFrame();
        if (frame) return frame;
      }

      // 1. YouTube specific high-definition video thumbnail
      const ytThumb = getYouTubeThumbnail();
      if (ytThumb) return ytThumb;

      // 2. Open Graph / Twitter card image tags
      const metaSelectors = [
        'meta[property="og:image"]',
        'meta[property="og:image:secure_url"]',
        'meta[name="twitter:image"]',
        'meta[name="twitter:image:src"]',
        'meta[name="thumbnail"]'
      ];

      for (const sel of metaSelectors) {
        const el = document.querySelector(sel);
        const val = el ? el.content : null;
        if (val) {
          try {
            const resolved = new URL(val, window.location.href).href;
            if (/^https?:\/\//i.test(resolved)) {
              return resolved;
            }
          } catch {}
        }
      }

      // 3. High-res apple touch and web app icons (180x180, 192x192)
      const iconSelectors = [
        'link[rel="apple-touch-icon"]',
        'link[rel="apple-touch-icon-precomposed"]',
        'link[rel="icon"][sizes="192x192"]',
        'link[rel="icon"][sizes="180x180"]',
        'link[rel="icon"][sizes="128x128"]'
      ];
      for (const sel of iconSelectors) {
        const el = document.querySelector(sel);
        const val = el ? el.href : null;
        if (val) {
          try {
            const resolved = new URL(val, window.location.href).href;
            if (/^https?:\/\//i.test(resolved)) {
              return resolved;
            }
          } catch {}
        }
      }

      // 4. Prominent hero/article image on the page
      const hero = document.querySelector('article img[src], [role="main"] img[src], header img[src], main img[src]');
      if (hero && hero.src) {
        try {
          const resolved = new URL(hero.src, window.location.href).href;
          if (/^https?:\/\//i.test(resolved) && (hero.naturalWidth > 160 || !hero.complete)) {
            return resolved;
          }
        } catch {}
      }

      return null;
    } catch {
      return null;
    }
  }

  function reportPageVisual(forceOverwrite = false, checkVideo = false) {
    try {
      const visualUrl = extractPageVisuals(checkVideo);
      if (visualUrl) {
        chrome.runtime.sendMessage({
          action: 'REGISTER_PAGE_VISUAL',
          visualUrl,
          forceOverwrite
        }).catch(() => {});
      }
    } catch {}
  }

  // Report visual on initialization and after document ready
  reportPageVisual(false, true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => reportPageVisual(false, true), { once: true });
  }

  // When switching away from this tab (visibilityState: hidden), capture exact final frame
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      reportPageVisual(true, true);
    }
  }, { passive: true });

  // YouTube SPA navigation listener
  window.addEventListener('yt-navigate-finish', () => {
    reportPageVisual(true, true);
  }, { passive: true });

  // Lightweight video event listeners (throttled to avoid any CPU impact)
  let videoListenerAttached = false;
  function attachVideoListeners() {
    if (videoListenerAttached) return;
    const video = document.querySelector('video');
    if (!video) return;
    videoListenerAttached = true;

    video.addEventListener('pause', () => reportPageVisual(true, true), { passive: true });
    
    let lastSnap = 0;
    video.addEventListener('timeupdate', () => {
      const now = Date.now();
      if (now - lastSnap > 7000) { // Every 7s while playing
        lastSnap = now;
        reportPageVisual(true, true);
      }
    }, { passive: true });
  }

  // Check for video element after small delay for SPAs
  setTimeout(attachVideoListeners, 1500);

  /**
   * Load user shortcut configuration from local/sync storage
   */
  function loadSettings() {
    try {
      const storage = chrome?.storage?.local || chrome?.storage?.sync;
      if (storage) {
        storage.get(userSettings, (stored) => {
          if (!chrome.runtime.lastError && stored) {
            userSettings = { ...userSettings, ...stored };
            updateFooterHints();
          }
        });
      }
    } catch {
      // Keep defaults
    }
  }

  loadSettings();

  // Listen for real-time setting updates from popup
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' || area === 'sync') {
        loadSettings();
      }
    });
  }

  /**
   * Ultra-fast shortcut matcher. Bails out immediately for standard typing.
   */
  function matchesShortcut(e) {
    if (!e.altKey && !e.ctrlKey && !e.metaKey) return false;

    const mod = (userSettings.customModifier || 'Alt').toLowerCase();
    const targetKey = (userSettings.customKey || 'Q').toUpperCase();

    let modMatches = false;
    if (mod === 'alt') {
      modMatches = e.altKey && !e.ctrlKey && !e.metaKey;
    } else if (mod === 'ctrl' || mod === 'control') {
      modMatches = e.ctrlKey && !e.altKey && !e.metaKey;
    } else if (mod === 'meta' || mod === 'cmd') {
      modMatches = e.metaKey && !e.altKey && !e.ctrlKey;
    }

    if (!modMatches) return false;

    const k = (e.key || '').toUpperCase();
    const code = (e.code || '').toUpperCase();

    if (k === targetKey) return true;
    if (code === 'KEY' + targetKey) return true;
    if (code === targetKey) return true;
    if (targetKey === 'TAB' && (k === 'TAB' || code === 'TAB')) return true;
    if (targetKey === '`' && (k === '`' || code === 'BACKQUOTE')) return true;

    return false;
  }

  /**
   * 3D Cylindrical Geometry Engine
   */
  function calculateTrigonometricLayout(tabCount) {
    const N = Math.max(tabCount, 1);
    const chord = CARD_WIDTH + CARD_GAP; // 260 + 24 = 284px

    const theta = N > 1 ? 360 / N : 0;

    let calculatedRadius = MIN_RADIUS;
    if (N > 2) {
      calculatedRadius = Math.round((chord / 2) / Math.tan(Math.PI / N));
    }

    const radius = Math.max(MIN_RADIUS, calculatedRadius);
    return { theta, radius };
  }

  function updateCylinderTransform() {
    if (!cylinderEl) return;
    cylinderEl.style.transform = `translateZ(-${cylinderRadius}px) rotateY(${-currentAngleDeg}deg)`;
  }

  function updateCardHighlights() {
    const N = currentTabs.length;
    if (N === 0) return;

    cardElements.forEach((cardEl, i) => {
      let diff = Math.abs(i - currentIndex);
      if (diff > N / 2) {
        diff = N - diff;
      }
      const angularDistance = diff * thetaDeg;

      const inner = cardEl.querySelector('.tab-card-inner');
      if (!inner) return;

      if (i === currentIndex) {
        cardEl.classList.add('is-active');
        inner.style.transform = 'scale(1.08)';
        inner.style.opacity = '1';
        inner.style.borderColor = '#00e5ff';
        inner.style.boxShadow = '0 0 28px rgba(0, 229, 255, 0.45), 0 16px 36px rgba(0, 0, 0, 0.8)';
        cardEl.style.pointerEvents = 'auto';
        cardEl.setAttribute('aria-selected', 'true');
      } else {
        cardEl.classList.remove('is-active');
        cardEl.setAttribute('aria-selected', 'false');

        if (angularDistance <= 45) {
          inner.style.transform = 'scale(1.0)';
          inner.style.opacity = '0.85';
          inner.style.borderColor = 'rgba(255, 255, 255, 0.12)';
          inner.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.5)';
          cardEl.style.pointerEvents = 'auto';
        } else if (angularDistance <= 90) {
          inner.style.transform = 'scale(0.96)';
          inner.style.opacity = '0.55';
          inner.style.borderColor = 'rgba(255, 255, 255, 0.06)';
          inner.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.4)';
          cardEl.style.pointerEvents = 'auto';
        } else {
          inner.style.transform = 'scale(0.92)';
          inner.style.opacity = '0.15';
          inner.style.borderColor = 'transparent';
          inner.style.boxShadow = 'none';
          cardEl.style.pointerEvents = 'none';
        }
      }
    });
  }

  function updateHeaderInfo() {
    if (counterCurrentEl) {
      counterCurrentEl.textContent = (currentIndex + 1).toString();
    }
    if (counterTotalEl) {
      counterTotalEl.textContent = currentTabs.length.toString();
    }
  }

  function updateFooterHints() {
    if (!hintsFooterEl) return;
    const mod = userSettings.customModifier || 'Alt';
    const key = (userSettings.customKey || 'Q').toUpperCase();

    hintsFooterEl.innerHTML = `
      <div class="shortcut-hints">
        <span class="hint-item"><kbd>${mod}</kbd> + <kbd>${key}</kbd> Next Tab</span>
        <span class="hint-separator">•</span>
        <span class="hint-item"><kbd>Shift</kbd> + <kbd>${key}</kbd> Prev Tab</span>
        <span class="hint-separator">•</span>
        <span class="hint-item">Release <kbd>${mod}</kbd> or <kbd>Enter</kbd> Switch</span>
        <span class="hint-separator">•</span>
        <span class="hint-item"><kbd>Esc</kbd> Close</span>
      </div>
    `;
  }

  function rotateTo(targetIndex) {
    const N = currentTabs.length;
    if (N === 0) return;

    const normalizedTarget = ((targetIndex % N) + N) % N;

    let diff = normalizedTarget - currentIndex;
    if (diff > N / 2) diff -= N;
    if (diff < -N / 2) diff += N;

    currentIndex = normalizedTarget;
    currentAngleDeg += diff * thetaDeg;

    updateCylinderTransform();
    updateCardHighlights();
    updateHeaderInfo();
  }

  function switchTab(tabId) {
    if (!tabId) return;
    chrome.runtime.sendMessage({ action: 'SWITCH_TAB', tabId }, () => {
      unmountSwitcher();
    });
  }

  function closeTab(tabId, event) {
    if (event) event.stopPropagation();

    chrome.runtime.sendMessage({ action: 'CLOSE_TAB', tabId }, (res) => {
      if (res && res.success) {
        const removeIdx = currentTabs.findIndex((t) => t.id === tabId);
        if (removeIdx !== -1) {
          currentTabs.splice(removeIdx, 1);
        }

        if (currentTabs.length === 0) {
          unmountSwitcher();
          return;
        }

        if (currentIndex >= currentTabs.length) {
          currentIndex = currentTabs.length - 1;
        }

        renderCylinderCards();
      }
    });
  }

  function generateShadowStyles() {
    return `
      :host {
        all: initial;
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        z-index: 2147483647;
        pointer-events: auto;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      }

      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      /* Single Global Backdrop Filter */
      .switcher-backdrop {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        background: rgba(10, 12, 16, 0.82);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        align-items: center;
        padding: 28px 24px;
        overflow: hidden;
        user-select: none;
        opacity: 0;
        animation: overlayFadeIn 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }

      @keyframes overlayFadeIn {
        from { opacity: 0; transform: scale(1.02); }
        to { opacity: 1; transform: scale(1); }
      }

      .switcher-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        max-width: 820px;
        padding: 10px 20px;
        background: rgba(22, 26, 36, 0.94);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 40px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        z-index: 10;
      }

      .header-brand {
        display: flex;
        align-items: center;
        gap: 10px;
        color: #ffffff;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.3px;
      }

      .header-brand svg {
        width: 18px;
        height: 18px;
        color: #00e5ff;
        filter: drop-shadow(0 0 6px rgba(0, 229, 255, 0.6));
      }

      .tab-counter {
        font-size: 12px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.65);
        background: rgba(255, 255, 255, 0.06);
        padding: 4px 14px;
        border-radius: 20px;
        border: 1px solid rgba(255, 255, 255, 0.06);
      }

      .tab-counter .counter-current {
        color: #00e5ff;
        font-weight: 700;
      }

      .carousel-stage {
        position: relative;
        width: 100%;
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        perspective: 1200px;
        perspective-origin: center center;
        contain: layout paint;
        overflow: visible;
      }

      .carousel-cylinder {
        position: absolute;
        width: ${CARD_WIDTH}px;
        height: ${CARD_HEIGHT}px;
        transform-style: preserve-3d;
        transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1);
        will-change: transform;
      }

      .tab-card {
        position: absolute;
        top: 0;
        left: 0;
        width: ${CARD_WIDTH}px;
        height: ${CARD_HEIGHT}px;
        border-radius: 14px;
        transform-style: preserve-3d;
        backface-visibility: hidden;
        cursor: pointer;
      }

      .tab-card-inner {
        width: 100%;
        height: 100%;
        background: rgba(22, 26, 36, 0.94);
        border: 1px solid rgba(255, 255, 255, 0.09);
        border-radius: 14px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        backface-visibility: hidden;
        transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1),
                    border-color 0.25s ease,
                    box-shadow 0.25s ease,
                    opacity 0.25s ease;
      }

      /* Card Top Row */
      .card-header {
        height: 34px;
        min-height: 34px;
        padding: 0 10px;
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(255, 255, 255, 0.03);
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }

      .card-favicon {
        width: 16px;
        height: 16px;
        border-radius: 3px;
        object-fit: contain;
        flex-shrink: 0;
      }

      .card-favicon-fallback {
        width: 16px;
        height: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #00e5ff;
        flex-shrink: 0;
      }

      .card-domain {
        font-size: 11px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.65);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        letter-spacing: 0.2px;
      }

      .card-close-btn {
        width: 20px;
        height: 20px;
        border-radius: 4px;
        border: none;
        background: transparent;
        color: rgba(255, 255, 255, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        cursor: pointer;
        padding: 0;
        transition: background 0.15s ease, color 0.15s ease;
        flex-shrink: 0;
      }

      .card-close-btn:hover {
        background: rgba(255, 68, 68, 0.25);
        color: #ff5555;
      }

      /* Middle Preview Area */
      .card-preview {
        flex: 1;
        position: relative;
        background: #0d1017;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .card-preview-img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: top center;
        display: block;
      }

      /* High-Definition Branded Fallback Tile */
      .card-preview-fallback {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        background: radial-gradient(circle at 50% 40%, rgba(30, 38, 54, 0.75) 0%, rgba(13, 16, 23, 0.98) 100%);
      }

      .fallback-window-dots {
        position: absolute;
        top: 8px;
        left: 10px;
        display: flex;
        gap: 5px;
      }

      .fallback-window-dots span {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.2);
      }

      .fallback-orb {
        width: 50px;
        height: 50px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(0, 229, 255, 0.35);
        box-shadow: 0 0 20px rgba(0, 229, 255, 0.2);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .fallback-orb-icon {
        width: 30px;
        height: 30px;
        object-fit: contain;
        border-radius: 6px;
      }

      .fallback-orb svg {
        width: 24px;
        height: 24px;
        stroke: #00e5ff;
      }

      .fallback-domain-tag {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.6px;
        color: rgba(255, 255, 255, 0.6);
        text-transform: uppercase;
      }

      /* Bottom Row */
      .card-footer {
        height: 38px;
        min-height: 38px;
        padding: 0 12px;
        display: flex;
        align-items: center;
        background: rgba(18, 21, 28, 0.94);
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }

      .card-title {
        font-size: 12px;
        font-weight: 600;
        color: #f0f4fc;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.3;
        letter-spacing: 0.1px;
        width: 100%;
      }

      .switcher-footer {
        z-index: 10;
      }

      .shortcut-hints {
        display: flex;
        align-items: center;
        gap: 12px;
        background: rgba(22, 26, 36, 0.94);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 30px;
        padding: 8px 22px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        color: rgba(255, 255, 255, 0.75);
        font-size: 11px;
        font-weight: 500;
      }

      .hint-item {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .hint-separator {
        color: rgba(255, 255, 255, 0.2);
      }

      kbd {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 19px;
        height: 19px;
        padding: 0 5px;
        font-family: inherit;
        font-size: 10px;
        font-weight: 600;
        color: #00e5ff;
        background: rgba(0, 229, 255, 0.1);
        border: 1px solid rgba(0, 229, 255, 0.25);
        border-radius: 4px;
      }
    `;
  }

  function getFallbackFaviconSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="2" y1="12" x2="22" y2="12"></line>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
      </svg>
    `;
  }

  function getFallbackSnapshotSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
        <line x1="8" y1="21" x2="16" y2="21"></line>
        <line x1="12" y1="17" x2="12" y2="21"></line>
      </svg>
    `;
  }

  function showFallbackPreview(container, tab) {
    const fallback = document.createElement('div');
    fallback.className = 'card-preview-fallback';

    // 1. Subtle browser window header dots
    const dots = document.createElement('div');
    dots.className = 'fallback-window-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    fallback.appendChild(dots);

    // 2. High-resolution brand icon lookup (Google Favicon 128px CDN)
    const domain = (tab && tab.domain) ? tab.domain : 'web';
    const isStandardWeb = domain && !domain.startsWith('chrome') && !domain.startsWith('about') && !domain.startsWith('file');
    const hdFaviconUrl = isStandardWeb
      ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`
      : (tab && tab.favIconUrl ? tab.favIconUrl : '');

    const orb = document.createElement('div');
    orb.className = 'fallback-orb';

    if (hdFaviconUrl) {
      const orbImg = document.createElement('img');
      orbImg.className = 'fallback-orb-icon';
      orbImg.src = hdFaviconUrl;
      orbImg.decoding = 'async';
      orbImg.alt = '';
      orbImg.onerror = () => {
        if (tab && tab.favIconUrl && orbImg.src !== tab.favIconUrl) {
          orbImg.src = tab.favIconUrl;
        } else {
          orb.innerHTML = getFallbackSnapshotSvg();
        }
      };
      orb.appendChild(orbImg);
    } else {
      orb.innerHTML = getFallbackSnapshotSvg();
    }
    fallback.appendChild(orb);

    // 3. Domain chip
    const tag = document.createElement('div');
    tag.className = 'fallback-domain-tag';
    tag.textContent = domain;
    fallback.appendChild(tag);

    container.appendChild(fallback);
  }

  function renderCylinderCards() {
    if (!cylinderEl) return;
    cylinderEl.innerHTML = '';
    cardElements = [];

    const N = currentTabs.length;
    const layout = calculateTrigonometricLayout(N);
    thetaDeg = layout.theta;
    cylinderRadius = layout.radius;

    currentAngleDeg = currentIndex * thetaDeg;

    currentTabs.forEach((tab, i) => {
      const card = document.createElement('div');
      card.className = 'tab-card';
      card.dataset.index = i.toString();
      card.dataset.tabId = tab.id.toString();

      const cardRotationY = i * thetaDeg;
      card.style.transform = `rotateY(${cardRotationY}deg) translateZ(${cylinderRadius}px)`;

      const inner = document.createElement('div');
      inner.className = 'tab-card-inner';

      // 1. Header
      const header = document.createElement('div');
      header.className = 'card-header';

      if (tab.favIconUrl) {
        const faviconImg = document.createElement('img');
        faviconImg.className = 'card-favicon';
        faviconImg.src = tab.favIconUrl;
        faviconImg.decoding = 'async';
        faviconImg.alt = '';
        faviconImg.onerror = () => {
          faviconImg.remove();
          const fallback = document.createElement('span');
          fallback.className = 'card-favicon-fallback';
          fallback.innerHTML = getFallbackFaviconSvg();
          header.insertBefore(fallback, domainEl);
        };
        header.appendChild(faviconImg);
      } else {
        const fallback = document.createElement('span');
        fallback.className = 'card-favicon-fallback';
        fallback.innerHTML = getFallbackFaviconSvg();
        header.appendChild(fallback);
      }

      const domainEl = document.createElement('div');
      domainEl.className = 'card-domain';
      domainEl.textContent = tab.domain || 'web';
      header.appendChild(domainEl);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'card-close-btn';
      closeBtn.title = 'Close tab';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', (e) => closeTab(tab.id, e));
      header.appendChild(closeBtn);

      inner.appendChild(header);

      // 2. Preview Image or Branded Card
      const preview = document.createElement('div');
      preview.className = 'card-preview';

      if (tab.snapshot) {
        const snapImg = document.createElement('img');
        snapImg.className = 'card-preview-img';
        snapImg.src = tab.snapshot;
        snapImg.decoding = 'async';
        snapImg.loading = 'lazy';
        snapImg.alt = tab.title;
        snapImg.onerror = () => {
          snapImg.remove();
          showFallbackPreview(preview, tab);
        };
        preview.appendChild(snapImg);
      } else {
        showFallbackPreview(preview, tab);
      }

      inner.appendChild(preview);

      // 3. Footer Title
      const footer = document.createElement('div');
      footer.className = 'card-footer';

      const titleEl = document.createElement('div');
      titleEl.className = 'card-title';
      titleEl.textContent = tab.title || 'Untitled Tab';
      titleEl.title = tab.title || '';
      footer.appendChild(titleEl);

      inner.appendChild(footer);
      card.appendChild(inner);

      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-close-btn')) return;
        switchTab(tab.id);
      });

      cylinderEl.appendChild(card);
      cardElements.push(card);
    });

    updateCylinderTransform();
    updateCardHighlights();
    updateHeaderInfo();
  }

  function handleSwitcherKeyDown(e) {
    if (!isMounted) return;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      rotateTo(currentIndex + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      rotateTo(currentIndex - 1);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      rotateTo(e.shiftKey ? currentIndex - 1 : currentIndex + 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (currentTabs[currentIndex]) {
        switchTab(currentTabs[currentIndex].id);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      unmountSwitcher();
    }
  }

  /**
   * Mounts the isolated Shadow DOM overlay.
   */
  async function mountSwitcher(autoAdvanceToNext = false) {
    if (isMounted || isMounting) return;
    isMounting = true;
    pendingReleaseOnMount = false;

    chrome.runtime.sendMessage({ action: 'GET_TABS' }, (response) => {
      isMounting = false;

      if (!response || !response.success || !response.tabs || response.tabs.length === 0) {
        return;
      }

      currentTabs = response.tabs;

      const activeIdx = currentTabs.findIndex((t) => t.active);
      const baseIdx = activeIdx !== -1 ? activeIdx : 0;

      if (autoAdvanceToNext && currentTabs.length > 1) {
        currentIndex = (baseIdx + 1) % currentTabs.length;
      } else {
        currentIndex = baseIdx;
      }

      if (pendingReleaseOnMount && userSettings.releaseToSwitch) {
        pendingReleaseOnMount = false;
        switchTab(currentTabs[currentIndex].id);
        return;
      }

      const existing = document.getElementById(ROOT_ID);
      if (existing) existing.remove();

      hostElement = document.createElement('div');
      hostElement.id = ROOT_ID;

      shadowRoot = hostElement.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = generateShadowStyles();
      shadowRoot.appendChild(style);

      const backdrop = document.createElement('div');
      backdrop.className = 'switcher-backdrop';

      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop || e.target.classList.contains('carousel-stage')) {
          unmountSwitcher();
        }
      });

      // Header
      const header = document.createElement('div');
      header.className = 'switcher-header';
      header.innerHTML = `
        <div class="header-brand">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
            <polyline points="2 17 12 22 22 17"></polyline>
            <polyline points="2 12 12 17 22 12"></polyline>
          </svg>
          <span>3D Tab Switcher</span>
        </div>
        <div class="tab-counter">
          Tab <span class="counter-current">1</span> of <span class="counter-total">${currentTabs.length}</span>
        </div>
      `;
      backdrop.appendChild(header);

      counterCurrentEl = header.querySelector('.counter-current');
      counterTotalEl = header.querySelector('.counter-total');

      // Carousel Stage
      const stage = document.createElement('div');
      stage.className = 'carousel-stage';

      cylinderEl = document.createElement('div');
      cylinderEl.className = 'carousel-cylinder';
      stage.appendChild(cylinderEl);
      backdrop.appendChild(stage);

      // Hints Footer
      hintsFooterEl = document.createElement('div');
      hintsFooterEl.className = 'switcher-footer';
      backdrop.appendChild(hintsFooterEl);
      updateFooterHints();

      shadowRoot.appendChild(backdrop);
      document.documentElement.appendChild(hostElement);

      isMounted = true;

      renderCylinderCards();

      window.addEventListener('keydown', handleSwitcherKeyDown, true);
    });
  }

  function unmountSwitcher() {
    isMounted = false;
    isMounting = false;
    isHoldingModifier = false;
    pendingReleaseOnMount = false;

    window.removeEventListener('keydown', handleSwitcherKeyDown, true);

    if (hostElement && hostElement.parentNode) {
      hostElement.parentNode.removeChild(hostElement);
    }

    // Complete memory reclamation
    hostElement = null;
    shadowRoot = null;
    cylinderEl = null;
    counterCurrentEl = null;
    counterTotalEl = null;
    hintsFooterEl = null;
    cardElements.length = 0;
    currentTabs.length = 0;
  }

  function toggleSwitcher() {
    if (isMounted) {
      unmountSwitcher();
    } else {
      mountSwitcher(userSettings.autoAdvanceOnFirstPress);
    }
  }

  function handleShortcutTrigger(isShift = false) {
    isHoldingModifier = true;

    if (!isMounted) {
      mountSwitcher(userSettings.autoAdvanceOnFirstPress);
    } else {
      if (isShift) {
        rotateTo(currentIndex - 1);
      } else {
        rotateTo(currentIndex + 1);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // GLOBAL SHORTCUT & MODIFIER RELEASE LISTENERS
  // ---------------------------------------------------------------------------

  window.addEventListener(
    'keydown',
    (e) => {
      if (matchesShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        handleShortcutTrigger(e.shiftKey);
      }
    },
    true
  );

  window.addEventListener(
    'keyup',
    (e) => {
      const mod = (userSettings.customModifier || 'Alt').toLowerCase();
      let modReleased = false;

      if (mod === 'alt' && e.key === 'Alt') {
        modReleased = true;
      } else if ((mod === 'ctrl' || mod === 'control') && e.key === 'Control') {
        modReleased = true;
      } else if ((mod === 'meta' || mod === 'cmd') && e.key === 'Meta') {
        modReleased = true;
      }

      if (modReleased) {
        isHoldingModifier = false;

        if (isMounting) {
          pendingReleaseOnMount = true;
        } else if (isMounted && userSettings.releaseToSwitch) {
          if (currentTabs[currentIndex]) {
            switchTab(currentTabs[currentIndex].id);
          }
        }
      }
    },
    true
  );

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'CYCLE_OR_OPEN') {
      handleShortcutTrigger(false);
      sendResponse({ success: true });
    } else if (request.action === 'TOGGLE_SWITCHER') {
      toggleSwitcher();
      sendResponse({ success: true });
    }
  });
})();
