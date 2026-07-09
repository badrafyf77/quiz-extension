// popup.js
const apiKeyInput = document.getElementById("apiKey");
const modelSelect = document.getElementById("model");
const autoModeCheckbox = document.getElementById("autoMode");
const saveBtn     = document.getElementById("saveBtn");
const statusEl    = document.getElementById("status");
const toggleKeyBtn = document.getElementById("toggleKey");

const solvePageBtn = document.getElementById("solvePageBtn");
const questionsBadge = document.getElementById("pageQuestionsCount");

const explanationCard = document.getElementById("explanationCard");
const expQuestion = document.getElementById("expQuestion");
const expAnswers = document.getElementById("expAnswers");
const expText = document.getElementById("expText");

// ── Load Settings ────────────────────────────────────────────────────────────
chrome.storage.sync.get(["groqApiKey", "groqModel", "autoMode"], (r) => {
  if (r.groqApiKey) apiKeyInput.value = r.groqApiKey;
  if (r.groqModel)  modelSelect.value = r.groqModel;
  if (r.autoMode)   autoModeCheckbox.checked = !!r.autoMode;
});

// Load Latest AI Explanation
function updateExplanationCard() {
  chrome.storage.local.get(["lastQuestion", "lastExplanation", "lastAnswers", "lastType"], (r) => {
    if (r.lastExplanation && r.lastQuestion) {
      expQuestion.textContent = r.lastQuestion;
      if (r.lastAnswers && r.lastAnswers.length) {
        expAnswers.textContent = r.lastAnswers.join(", ");
      } else {
        expAnswers.textContent = r.lastType === "essay" ? "Written Answer" : "None";
      }
      expText.textContent = r.lastExplanation;
      explanationCard.classList.remove("hidden");
    } else {
      explanationCard.classList.add("hidden");
    }
  });
}

updateExplanationCard();

// Listen for new explanations solved in content.js in real time
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "local" && (changes.lastExplanation || changes.lastQuestion)) {
    updateExplanationCard();
  }
});

// ── Toggle Password Visibility ───────────────────────────────────────────────
toggleKeyBtn.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});

// ── Save Settings ────────────────────────────────────────────────────────────
saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  const model = modelSelect.value;
  const autoMode = autoModeCheckbox.checked;

  if (!key) {
    showStatus("Enter your Groq API key", "error");
    return;
  }

  chrome.storage.sync.set({ groqApiKey: key, groqModel: model, autoMode: autoMode }, () => {
    showStatus("Saved settings ✓", "success");
    // Query active tab to trigger auto solve if newly checked
    if (autoMode) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: "SOLVE_PAGE" }, () => {});
        }
      });
    }
  });
});

// ── Active Page Communication ────────────────────────────────────────────────
function checkActivePageStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    if (!activeTab || !activeTab.id || activeTab.url.startsWith("chrome://")) {
      questionsBadge.textContent = "N/A";
      solvePageBtn.disabled = true;
      return;
    }

    chrome.tabs.sendMessage(activeTab.id, { type: "GET_PAGE_STATUS" }, (response) => {
      // Handle chrome extensions connection errors when script is not injected
      if (chrome.runtime.lastError || !response) {
        questionsBadge.textContent = "Unsupported Page";
        solvePageBtn.disabled = true;
        return;
      }

      const count = response.count || 0;
      if (count > 0) {
        questionsBadge.textContent = `${count} Detected`;
        questionsBadge.classList.add("detected");
        solvePageBtn.disabled = false;
      } else {
        questionsBadge.textContent = "0 Detected";
        questionsBadge.classList.remove("detected");
        solvePageBtn.disabled = false; // Let the user try scanning again anyway
      }
    });
  });
}

// Check page status on popup open
checkActivePageStatus();

// Solve page button click
solvePageBtn.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    if (!activeTab || !activeTab.id) return;

    solvePageBtn.disabled = true;
    solvePageBtn.textContent = "Solving Page...";

    chrome.tabs.sendMessage(activeTab.id, { type: "SOLVE_PAGE" }, (response) => {
      solvePageBtn.disabled = false;
      solvePageBtn.textContent = "Solve Entire Page";

      if (chrome.runtime.lastError || !response) {
        showStatus("Failed to communicate with page", "error");
        return;
      }

      if (response.success) {
        showStatus(`Solving ${response.count} questions!`, "success");
        setTimeout(checkActivePageStatus, 2000); // refresh badge after some solve delay
      }
    });
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
