// popup.js — Settings-only popup: provider switch (Lightning AI default / Groq),
// per-provider API key + model, and a live config status indicator.
const apiKeyInput = document.getElementById("apiKey");
const apiKeyLabel = document.getElementById("apiKeyLabel");
const apiKeyHint = document.getElementById("apiKeyHint");
const modelSelect = document.getElementById("model");
const lightningModelSelect = document.getElementById("lightningModel");
const lightningModelCustom = document.getElementById("lightningModelCustom");
const groqModelField = document.getElementById("groqModelField");
const lightningModelField = document.getElementById("lightningModelField");
const providerToggle = document.getElementById("providerToggle");
const providerHint = document.getElementById("providerHint");
const providerSubtitle = document.getElementById("providerSubtitle");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");
const toggleKeyBtn = document.getElementById("toggleKey");
const keyStatusBadge = document.getElementById("keyStatusBadge");

// Image Provider (Vision) — OpenAI, independent of the answer provider above
const openaiApiKeyInput = document.getElementById("openaiApiKey");
const openaiModelSelect = document.getElementById("openaiModel");
const toggleOpenaiKeyBtn = document.getElementById("toggleOpenaiKey");
const openaiStatusBadge = document.getElementById("openaiStatusBadge");
const saveOpenaiBtn = document.getElementById("saveOpenaiBtn");
const openaiStatusEl = document.getElementById("openaiStatus");
const detectionToggle = document.getElementById("detectionToggle");
const detectionHint = document.getElementById("detectionHint");
const openaiKeyField = document.getElementById("openaiKeyField");
const openaiModelField = document.getElementById("openaiModelField");

const PROVIDER_CONFIG = {
  lightning: {
    label: "Lightning AI (default)",
    subtitle: "Lightning AI Engine",
    keyLabel: "Lightning AI API Key",
    keyPlaceholder: "lgt_...",
    keyLink: { href: "https://lightning.ai/", text: "Get your Lightning AI key →" }
  },
  groq: {
    label: "Groq",
    subtitle: "Groq AI Engine",
    keyLabel: "Groq API Key",
    keyPlaceholder: "gsk_...",
    keyLink: { href: "https://console.groq.com/keys", text: "Get free key →" }
  }
};

function currentProvider() {
  return providerToggle.checked ? "groq" : "lightning";
}

function keyStorageField(provider) {
  return provider === "groq" ? "groqApiKey" : "lightningApiKey";
}

function currentDetectionMethod() {
  return detectionToggle.checked ? "vision" : "dom";
}

const DETECTION_HINTS = {
  dom: "DOM scan (no selection)",
  vision: "OpenAI Vision screenshot (no selection)"
};

function applyDetectionUI(method) {
  detectionHint.textContent = DETECTION_HINTS[method];
  const usesVision = method === "vision";
  openaiKeyField.classList.toggle("hidden", !usesVision);
  openaiModelField.classList.toggle("hidden", !usesVision);
}

// ── Load Settings ────────────────────────────────────────────────────────────
chrome.storage.sync.get(
  ["provider", "groqApiKey", "groqModel", "lightningApiKey", "lightningModel"],
  (r) => {
    const provider = r.provider === "groq" ? "groq" : "lightning"; // default: lightning
    providerToggle.checked = provider === "groq";

    if (r.groqModel) modelSelect.value = r.groqModel;

    if (r.lightningModel) {
      const matchesPreset = Array.from(lightningModelSelect.options).some(o => o.value === r.lightningModel);
      if (matchesPreset) {
        lightningModelSelect.value = r.lightningModel;
      } else {
        lightningModelCustom.value = r.lightningModel;
      }
    }

    applyProviderUI(provider);

    const key = provider === "groq" ? r.groqApiKey : r.lightningApiKey;
    if (key) apiKeyInput.value = key;
    updateKeyStatus(!!key);
  }
);

// ── Load Image Provider (OpenAI Vision) + Detection Method Settings ─────────
chrome.storage.sync.get(["openaiApiKey", "openaiModel", "detectionMethod"], (r) => {
  if (r.openaiApiKey) openaiApiKeyInput.value = r.openaiApiKey;
  if (r.openaiModel) openaiModelSelect.value = r.openaiModel;

  const method = r.detectionMethod === "vision" ? "vision" : "dom"; // default: dom scan
  detectionToggle.checked = method === "vision";
  applyDetectionUI(method);

  updateOpenaiKeyStatus(!!r.openaiApiKey, method);
});

// ── Detection Method Toggle ───────────────────────────────────────────────────
detectionToggle.addEventListener("change", () => {
  const method = currentDetectionMethod();
  applyDetectionUI(method);
  chrome.storage.sync.set({ detectionMethod: method }, () => {
    chrome.storage.sync.get(["openaiApiKey"], (r) => {
      updateOpenaiKeyStatus(!!r.openaiApiKey, method);
    });
  });
});

// ── Provider Toggle ───────────────────────────────────────────────────────────
providerToggle.addEventListener("change", () => {
  const provider = currentProvider();
  applyProviderUI(provider);

  // Load the key already saved for the newly-selected provider (if any), so
  // switching providers doesn't show the other provider's key in the field.
  chrome.storage.sync.get([keyStorageField(provider)], (r) => {
    apiKeyInput.value = r[keyStorageField(provider)] || "";
    updateKeyStatus(!!r[keyStorageField(provider)]);
  });
});

function applyProviderUI(provider) {
  const cfg = PROVIDER_CONFIG[provider];
  providerHint.textContent = cfg.label;
  providerSubtitle.textContent = cfg.subtitle;
  apiKeyLabel.textContent = cfg.keyLabel;
  apiKeyInput.placeholder = cfg.keyPlaceholder;
  apiKeyHint.innerHTML = `<a href="${cfg.keyLink.href}" target="_blank">${cfg.keyLink.text}</a>`;

  groqModelField.classList.toggle("hidden", provider !== "groq");
  lightningModelField.classList.toggle("hidden", provider !== "lightning");
}

// Reflect key status live if it changes in storage (e.g. saved from another popup instance)
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== "sync") return;
  const field = keyStorageField(currentProvider());
  if (changes[field]) {
    updateKeyStatus(!!changes[field].newValue);
  }
  if (changes.openaiApiKey || changes.detectionMethod) {
    chrome.storage.sync.get(["openaiApiKey"], (r) => {
      updateOpenaiKeyStatus(!!r.openaiApiKey, currentDetectionMethod());
    });
  }
});

function updateKeyStatus(hasKey) {
  if (hasKey) {
    keyStatusBadge.textContent = "✓ API key configured";
    keyStatusBadge.classList.add("detected");
    keyStatusBadge.classList.remove("warn");
  } else {
    keyStatusBadge.textContent = "⚠️ No API key set";
    keyStatusBadge.classList.remove("detected");
    keyStatusBadge.classList.add("warn");
  }
}

// ── Toggle Password Visibility ───────────────────────────────────────────────
toggleKeyBtn.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});

toggleOpenaiKeyBtn.addEventListener("click", () => {
  openaiApiKeyInput.type = openaiApiKeyInput.type === "password" ? "text" : "password";
});

// ── Save Settings ────────────────────────────────────────────────────────────
saveBtn.addEventListener("click", () => {
  const provider = currentProvider();
  const key = apiKeyInput.value.trim();

  if (!key) {
    showStatus(`Enter your ${PROVIDER_CONFIG[provider].keyLabel}`, "error");
    return;
  }

  const toSave = { provider, groqModel: modelSelect.value };

  if (provider === "groq") {
    toSave.groqApiKey = key;
  } else {
    const customModel = lightningModelCustom.value.trim();
    toSave.lightningApiKey = key;
    toSave.lightningModel = customModel || lightningModelSelect.value;
  }

  chrome.storage.sync.set(toSave, () => {
    showStatus("Saved settings ✓", "success");
    updateKeyStatus(true);
  });
});

// Helper for UI status message
function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status-msg ${type}`;
  statusEl.classList.remove("hidden");
  clearTimeout(statusEl._timer);
  statusEl._timer = setTimeout(() => {
    statusEl.classList.add("hidden");
  }, 3000);
}

// ── Image Provider (Vision) — OpenAI Save ────────────────────────────────────
saveOpenaiBtn.addEventListener("click", () => {
  const method = currentDetectionMethod();
  const key = openaiApiKeyInput.value.trim();

  if (method === "vision" && !key) {
    showOpenaiStatus("Enter your OpenAI API Key", "error");
    return;
  }

  const toSave = { detectionMethod: method };
  if (key) {
    toSave.openaiApiKey = key;
    toSave.openaiModel = openaiModelSelect.value;
  }

  chrome.storage.sync.set(toSave, () => {
    showOpenaiStatus("Saved image provider ✓", "success");
    updateOpenaiKeyStatus(!!key || !!openaiApiKeyInput.value.trim(), method);
  });
});

function updateOpenaiKeyStatus(hasKey, method) {
  if (method === "dom") {
    openaiStatusBadge.textContent = "DOM scan active";
    openaiStatusBadge.classList.remove("detected", "warn");
    return;
  }
  // method === "vision"
  if (hasKey) {
    openaiStatusBadge.textContent = "✓ Vision enabled";
    openaiStatusBadge.classList.add("detected");
    openaiStatusBadge.classList.remove("warn");
  } else {
    openaiStatusBadge.textContent = "⚠️ No OpenAI key set";
    openaiStatusBadge.classList.remove("detected");
    openaiStatusBadge.classList.add("warn");
  }
}

function showOpenaiStatus(msg, type) {
  openaiStatusEl.textContent = msg;
  openaiStatusEl.className = `status-msg ${type}`;
  openaiStatusEl.classList.remove("hidden");
  clearTimeout(openaiStatusEl._timer);
  openaiStatusEl._timer = setTimeout(() => {
    openaiStatusEl.classList.add("hidden");
  }, 3000);
}
