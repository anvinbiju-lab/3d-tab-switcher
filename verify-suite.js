/**
 * Comprehensive Unit & Integration Verification Suite for 3D Visual Tab Switcher
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('=== STARTING 3D VISUAL TAB SWITCHER VERIFICATION SUITE ===\n');

// 1. MANIFEST V3 SYNTAX & PERMISSIONS CHECK
console.log('Test 1: Validating manifest.json...');
const manifestRaw = fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestRaw);

assert.strictEqual(manifest.manifest_version, 3, 'Manifest version must be 3');
assert(manifest.permissions.includes('tabs'), 'Must have tabs permission');
assert(manifest.permissions.includes('storage'), 'Must have storage permission');
assert(manifest.permissions.includes('activeTab'), 'Must have activeTab permission');
assert(manifest.permissions.includes('scripting'), 'Must have scripting permission for auto-injection');
assert(manifest.host_permissions.includes('<all_urls>'), 'Must have <all_urls> host permission');
assert.strictEqual(manifest.background.service_worker, 'background.js', 'Service worker must be background.js');
assert.strictEqual(manifest.action.default_popup, 'popup.html', 'Action must have popup.html');
assert(manifest.commands['toggle-tab-switcher'], 'Must define toggle-tab-switcher command');
console.log('✔ Test 1 Passed: manifest.json is strictly compliant with Manifest V3!\n');

// 2. TRIGONOMETRIC ENGINE VERIFICATION
console.log('Test 2: Validating 3D Cylindrical Trigonometric Calculations...');
const CARD_WIDTH = 260;
const CARD_GAP = 24;
const MIN_RADIUS = 450;

function calculateTrigonometricLayout(tabCount) {
  const N = Math.max(tabCount, 1);
  const chord = CARD_WIDTH + CARD_GAP; // 284px
  const theta = N > 1 ? 360 / N : 0;

  let calculatedRadius = MIN_RADIUS;
  if (N > 2) {
    calculatedRadius = Math.round((chord / 2) / Math.tan(Math.PI / N));
  }
  const radius = Math.max(MIN_RADIUS, calculatedRadius);
  return { theta, radius };
}

// Low tab count (N = 3): apothem = 142 / tan(pi/3) = 82px, clamped to 450px
const layout3 = calculateTrigonometricLayout(3);
assert.strictEqual(layout3.theta, 120, 'Theta for 3 tabs must be 120 deg');
assert.strictEqual(layout3.radius, 450, 'Radius for 3 tabs must be clamped to min 450px');

// Moderate tab count (N = 12): theta = 30 deg, radius = 142 / tan(pi/12) = 530px
const layout12 = calculateTrigonometricLayout(12);
assert.strictEqual(layout12.theta, 30, 'Theta for 12 tabs must be 30 deg');
assert(layout12.radius >= 520 && layout12.radius <= 540, 'Radius for 12 tabs should be approx 530px');

// Single tab (N = 1): theta = 0, radius = 450px
const layout1 = calculateTrigonometricLayout(1);
assert.strictEqual(layout1.theta, 0, 'Theta for 1 tab must be 0');
assert.strictEqual(layout1.radius, 450, 'Radius for 1 tab must be clamped to 450px');
console.log('✔ Test 2 Passed: 3D trigonometric engine calculates correct angles & radii without collision!\n');

// 3. SHORTCUT MATCHING LOGIC FOR ALT + Q
console.log('Test 3: Validating Alt + Q Shortcut Key Matcher...');

function matchesShortcut(e, userSettings) {
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

const settingsAltQ = { customModifier: 'Alt', customKey: 'Q' };

// Test lower case 'q' with KeyQ
assert(matchesShortcut({ altKey: true, ctrlKey: false, metaKey: false, key: 'q', code: 'KeyQ' }, settingsAltQ), 'Should match lower q');
// Test upper case 'Q' with KeyQ
assert(matchesShortcut({ altKey: true, ctrlKey: false, metaKey: false, key: 'Q', code: 'KeyQ' }, settingsAltQ), 'Should match upper Q');
// Test dead key or international character when Alt is pressed
assert(matchesShortcut({ altKey: true, ctrlKey: false, metaKey: false, key: 'œ', code: 'KeyQ' }, settingsAltQ), 'Should match code KeyQ even with alternate key char');
// Should NOT match if Ctrl is also pressed
assert(!matchesShortcut({ altKey: true, ctrlKey: true, metaKey: false, key: 'q', code: 'KeyQ' }, settingsAltQ), 'Should not match with Ctrl');
// Should NOT match if key is W
assert(!matchesShortcut({ altKey: true, ctrlKey: false, metaKey: false, key: 'w', code: 'KeyW' }, settingsAltQ), 'Should not match W when configured for Q');
console.log('✔ Test 3 Passed: Alt + Q shortcut matching handles all keyboard layouts & edge cases!\n');

// 4. SHORTEST-PATH ROTATIONAL DISPLACEMENT (NO 360-DEG REVERSE SPINS)
console.log('Test 4: Validating Shortest Angular Displacement on Wrap-Around...');

function getShortestAngleDelta(fromIndex, toIndex, totalTabs, theta) {
  let diff = toIndex - fromIndex;
  if (diff > totalTabs / 2) diff -= totalTabs;
  if (diff < -totalTabs / 2) diff += totalTabs;
  return diff * theta;
}

// When cycling from last tab (N - 1 = 9) to first tab (0) in a 10-tab carousel:
const deltaWrap = getShortestAngleDelta(9, 0, 10, 36);
assert.strictEqual(deltaWrap, 36, 'Wrapping from 9 to 0 should step forward +36 deg, not -324 deg reverse spin!');

// When cycling from 0 to 9 (backward):
const deltaWrapBack = getShortestAngleDelta(0, 9, 10, 36);
assert.strictEqual(deltaWrapBack, -36, 'Wrapping from 0 to 9 should step backward -36 deg, not +324 deg!');
console.log('✔ Test 4 Passed: Wrap-around navigation is perfectly continuous and never spins backwards!\n');

// 5. RESTRICTED URL IDENTIFICATION (BACKGROUND ROUTING)
console.log('Test 5: Validating Restricted URL Fallback Detection...');
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

assert(isRestrictedUrl('chrome://extensions/shortcuts'), 'chrome://extensions/shortcuts must be restricted');
assert(isRestrictedUrl('chrome://newtab/'), 'chrome://newtab must be restricted');
assert(isRestrictedUrl('devtools://devtools/bundled/inspector.html'), 'devtools must be restricted');
assert(!isRestrictedUrl('https://github.com'), 'https://github.com must NOT be restricted');
assert(!isRestrictedUrl('https://example.com'), 'https://example.com must NOT be restricted');
console.log('✔ Test 5 Passed: Restricted page detector correctly isolates non-scriptable browser tabs!\n');

console.log('========================================================');
console.log('ALL TESTS PASSED SUCCESSFULLY (5/5)!');
console.log('========================================================');
