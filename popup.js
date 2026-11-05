/**
 * 3D Visual Tab Switcher - Settings & Customization Popup
 */

const DEFAULT_SETTINGS = {
  customModifier: 'Alt',
  customKey: 'Q',
  releaseToSwitch: true,
  autoAdvanceOnFirstPress: true
};

const modifierSelect = document.getElementById('modifierSelect');
const recordKeyBtn = document.getElementById('recordKeyBtn');
const currentKeyDisplay = document.getElementById('currentKeyDisplay');
const releaseToSwitchCheckbox = document.getElementById('releaseToSwitchCheckbox');
const autoAdvanceCheckbox = document.getElementById('autoAdvanceCheckbox');
const modNameDesc = document.getElementById('modNameDesc');
const hintMod = document.getElementById('hintMod');
const hintKey = document.getElementById('hintKey');
const openShortcutsBtn = document.getElementById('openShortcutsBtn');
const testLaunchBtn = document.getElementById('testLaunchBtn');
const statusToast = document.getElementById('statusToast');

let isRecordingKey = false;
let toastTimeout = null;

function showToast(message = 'Settings saved!') {
  if (statusToast) {
    statusToast.textContent = message;
    statusToast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      statusToast.classList.remove('show');
    }, 1500);
  }
}

function updateHintDisplay(modifier, key) {
  if (modNameDesc) modNameDesc.textContent = modifier;
  if (hintMod) hintMod.textContent = modifier;
  if (hintKey) hintKey.textContent = key.toUpperCase();
}

// Load configuration from local storage with fallback to sync
function loadStoredSettings() {
  const storage = chrome.storage.local || chrome.storage.sync;
  storage.get(DEFAULT_SETTINGS, (settings) => {
    if (chrome.runtime.lastError || !settings) {
      settings = DEFAULT_SETTINGS;
    }

    modifierSelect.value = settings.customModifier || 'Alt';
    currentKeyDisplay.textContent = (settings.customKey || 'W').toUpperCase();
    releaseToSwitchCheckbox.checked = settings.releaseToSwitch !== false;
    autoAdvanceCheckbox.checked = settings.autoAdvanceOnFirstPress !== false;

    updateHintDisplay(modifierSelect.value, currentKeyDisplay.textContent);
  });
}

loadStoredSettings();

// Save configuration updates to both local and sync storage
function saveSettings() {
  const settings = {
    customModifier: modifierSelect.value,
    customKey: currentKeyDisplay.textContent.toUpperCase(),
    releaseToSwitch: releaseToSwitchCheckbox.checked,
    autoAdvanceOnFirstPress: autoAdvanceCheckbox.checked
  };

  // Save to local storage first (always succeeds)
  if (chrome.storage?.local) {
    chrome.storage.local.set(settings);
  }
  // Also save to sync storage if available
  if (chrome.storage?.sync) {
    chrome.storage.sync.set(settings, () => {
      // Ignore sync errors if unauthenticated
      if (chrome.runtime.lastError) {
        console.debug('Sync storage error:', chrome.runtime.lastError.message);
      }
    });
  }

  updateHintDisplay(settings.customModifier, settings.customKey);
  showToast();
}

modifierSelect.addEventListener('change', () => {
  saveSettings();
});

releaseToSwitchCheckbox.addEventListener('change', () => {
  saveSettings();
});

autoAdvanceCheckbox.addEventListener('change', () => {
  saveSettings();
});

// Key recording functionality
recordKeyBtn.addEventListener('click', () => {
  isRecordingKey = true;
  recordKeyBtn.classList.add('recording');
  currentKeyDisplay.textContent = '...';

  const handleKeydown = (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Ignore solitary modifier presses
    if (['Alt', 'Control', 'Shift', 'Meta'].includes(e.key)) {
      return;
    }

    let detectedKey = e.key.toUpperCase();
    if (e.code.startsWith('Key')) {
      detectedKey = e.code.replace('Key', '').toUpperCase();
    } else if (e.code.startsWith('Digit')) {
      detectedKey = e.code.replace('Digit', '');
    } else if (e.key === 'Tab') {
      detectedKey = 'Tab';
    } else if (e.key === '`' || e.code === 'Backquote') {
      detectedKey = '`';
    }

    currentKeyDisplay.textContent = detectedKey;
    recordKeyBtn.classList.remove('recording');
    isRecordingKey = false;
    window.removeEventListener('keydown', handleKeydown, true);

    saveSettings();
  };

  window.addEventListener('keydown', handleKeydown, true);
});

// Open Chrome extensions shortcuts settings page
openShortcutsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// Launch switcher immediately via background worker
testLaunchBtn.addEventListener('click', async () => {
  chrome.runtime.sendMessage({ action: 'TRIGGER_ACTIVE_SWITCHER' }, () => {
    window.close();
  });
});
