// content.js — QCM Solver
// Passive until the user presses Ctrl+Shift+X (Cmd+Shift+X on Mac). Extracts the
// current text selection (if any) or scans the page for questions, sends them all
// in a single batched request, and displays results in an injected side panel.
// Never fills or marks form fields — answers are shown only, plus copied to clipboard.

(function () {
  "use strict";

  let apiKey = "";
  let model = "llama-3.3-70b-versatile";
  let provider = "lightning";
  let openaiApiKey = "";
  let openaiModel = "gpt-4o-mini";
  let detectionMethod = "dom"; // "dom" or "vision" — explicit user choice from popup
  let extensionEnabled = true; // toggled from the popup; all shortcuts no-op when false

  const LOG = "[QCM Solver]";
  console.log(`${LOG} content script loaded — frame: ${window === window.top ? "top" : "iframe"} — url: ${location.href}`);

  // ── Injected Panel: Edge Handle + Results Panel Shell ────────────────────────
  // Always injected on load (top frame only), independent of solving state.
  // Shows a persistent tab on the right edge; clicking toggles the panel open/closed.
  const PANEL_STYLE_ID = "qcm-solver-panel-style";
  const PANEL_ROOT_ID = "qcm-solver-panel-root";

  function injectPanelStyles() {
    if (document.getElementById(PANEL_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PANEL_STYLE_ID;
    style.textContent = `
      #qcm-solver-panel-root, #qcm-solver-panel-root * {
        box-sizing: border-box;
        font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #qcm-solver-panel-root {
        position: fixed;
        top: 50%;
        right: 0;
        transform: translateY(-50%);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        pointer-events: none;
      }
      #qcm-solver-handle {
        pointer-events: auto;
        background: linear-gradient(135deg, #4f46e5, #7c3aed);
        color: #fff;
        border: none;
        border-radius: 10px 0 0 10px;
        padding: 14px 6px;
        cursor: pointer;
        box-shadow: -2px 2px 16px rgba(0,0,0,0.35);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        opacity: 0.85;
        transition: opacity 0.2s, padding 0.2s;
      }
      #qcm-solver-handle:hover {
        opacity: 1;
      }
      #qcm-solver-handle .qcm-handle-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #fff;
        opacity: 0.9;
      }
      #qcm-solver-handle .qcm-handle-label {
        writing-mode: vertical-rl;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }
      #qcm-solver-panel {
        pointer-events: auto;
        width: 320px;
        max-height: 70vh;
        overflow-y: auto;
        background: radial-gradient(circle at top right, #1a153b, #090a0f 60%);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 12px 0 0 12px;
        box-shadow: -4px 4px 32px rgba(0,0,0,0.45);
        color: #f3f4f6;
        font-size: 13px;
        padding: 0;
        margin-right: -340px;
        transition: margin-right 0.25s ease;
      }
      #qcm-solver-panel-root.qcm-open #qcm-solver-panel {
        margin-right: 0;
      }
      #qcm-solver-panel::-webkit-scrollbar {
        width: 5px;
      }
      #qcm-solver-panel::-webkit-scrollbar-thumb {
        background: #3f3f46;
        border-radius: 10px;
      }
      #qcm-solver-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      #qcm-solver-panel-header .qcm-title {
        font-size: 13px;
        font-weight: 700;
        background: linear-gradient(135deg, #fff, #a78bfa);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      #qcm-solver-panel-header .qcm-close {
        cursor: pointer;
        color: #9ca3af;
        font-size: 16px;
        line-height: 1;
        background: none;
        border: none;
        padding: 2px 6px;
      }
      #qcm-solver-panel-header .qcm-close:hover {
        color: #f3f4f6;
      }
      #qcm-solver-panel-body {
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .qcm-empty-state, .qcm-error-state {
        font-size: 12px;
        color: #9ca3af;
        line-height: 1.5;
        text-align: center;
        padding: 12px 4px;
      }
      .qcm-error-state {
        color: #f87171;
      }
      .qcm-loading-state {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        font-size: 12px;
        color: #c7d2fe;
        padding: 20px 4px;
      }
      .qcm-spinner {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        border: 2px solid rgba(139, 92, 246, 0.25);
        border-top-color: #a78bfa;
        animation: qcm-spin 0.7s linear infinite;
        flex-shrink: 0;
      }
      @keyframes qcm-spin {
        to { transform: rotate(360deg); }
      }
      .qcm-copied-banner {
        font-size: 11px;
        font-weight: 600;
        color: #34d399;
        background: rgba(16, 185, 129, 0.12);
        border: 1px solid rgba(16, 185, 129, 0.25);
        border-radius: 8px;
        padding: 6px 10px;
        text-align: center;
        max-height: 0;
        opacity: 0;
        overflow: hidden;
        padding-top: 0;
        padding-bottom: 0;
        margin-bottom: 0;
        transition: opacity 0.2s, max-height 0.2s, padding 0.2s, margin 0.2s;
      }
      .qcm-copied-banner.qcm-visible {
        opacity: 1;
        max-height: 40px;
        padding-top: 6px;
        padding-bottom: 6px;
        margin-bottom: 4px;
      }
      .qcm-copied-banner.qcm-banner-warn {
        color: #fbbf24;
        background: rgba(245, 158, 11, 0.12);
        border-color: rgba(245, 158, 11, 0.25);
      }
      .qcm-result-card {
        background: rgba(22, 24, 33, 0.7);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 10px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .qcm-result-card.qcm-result-error {
        border-color: rgba(239, 68, 68, 0.25);
      }
      .qcm-result-q {
        font-size: 11px;
        color: #9ca3af;
        line-height: 1.4;
      }
      .qcm-result-answer-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .qcm-answer-badge {
        background: rgba(16, 185, 129, 0.15);
        border: 1px solid rgba(16, 185, 129, 0.3);
        color: #a7f3d0;
        font-size: 11px;
        font-weight: 700;
        padding: 2px 8px;
        border-radius: 20px;
        flex-shrink: 0;
      }
      .qcm-answer-text {
        font-size: 12px;
        color: #f3f4f6;
        font-weight: 600;
        line-height: 1.4;
      }
      .qcm-result-explanation {
        font-size: 11px;
        color: #d1d5db;
        line-height: 1.5;
      }
      .qcm-result-essay {
        font-size: 12px;
        color: #f3f4f6;
        line-height: 1.5;
        white-space: pre-wrap;
      }
      .qcm-result-error-text {
        font-size: 11px;
        color: #f87171;
      }
      .qcm-math {
        font-family: "Cambria Math", Cambria, "STIX Two Math", serif;
        font-style: italic;
        color: #c4b5fd;
        white-space: nowrap;
      }
      .qcm-code-block {
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 6px;
        padding: 8px 10px;
        font-family: "SF Mono", "Fira Code", Menlo, Consolas, monospace;
        font-size: 11px;
        color: #e4e4e7;
        white-space: pre-wrap;
        overflow-x: auto;
        margin: 4px 0;
      }
    `;
    document.head.appendChild(style);
  }

  function injectPanelShell() {
    if (document.getElementById(PANEL_ROOT_ID)) return;
    if (window !== window.top) return; // only inject once, in the top frame

    injectPanelStyles();

    const root = document.createElement("div");
    root.id = PANEL_ROOT_ID;

    const handle = document.createElement("button");
    handle.id = "qcm-solver-handle";
    handle.title = "Toggle QCM Solver answers";
    handle.innerHTML = `
      <span class="qcm-handle-dot"></span>
      <span class="qcm-handle-label">ANSWERS</span>
    `;
    handle.addEventListener("click", () => {
      root.classList.toggle("qcm-open");
    });

    const panel = document.createElement("div");
    panel.id = "qcm-solver-panel";
    panel.innerHTML = `
      <div id="qcm-solver-panel-header">
        <span class="qcm-title">QCM Solver</span>
        <button class="qcm-close" title="Close">×</button>
      </div>
      <div id="qcm-solver-panel-body">
        <div class="qcm-empty-state">No results yet — press Ctrl+Shift+X (⌘+Shift+X on Mac) to solve.</div>
      </div>
    `;
    panel.querySelector(".qcm-close").addEventListener("click", () => {
      root.classList.remove("qcm-open");
    });

    root.appendChild(handle);
    root.appendChild(panel);
    (document.body || document.documentElement).appendChild(root);

    console.log(`${LOG} panel shell injected`);
  }

  injectPanelShell();

  // ── Load settings ────────────────────────────────────────────────────────────
  function applySettings(r) {
    provider = r.provider === "groq" ? "groq" : "lightning"; // default: lightning
    if (provider === "groq") {
      apiKey = r.groqApiKey || "";
      model = r.groqModel || "llama-3.3-70b-versatile";
    } else {
      apiKey = r.lightningApiKey || "";
      model = r.lightningModel || "openai/gpt-5.6-sol";
    }
    openaiApiKey = r.openaiApiKey || "";
    openaiModel = r.openaiModel || "gpt-4o-mini";
    detectionMethod = r.detectionMethod === "vision" ? "vision" : "dom"; // default: dom scan
    extensionEnabled = r.extensionEnabled !== false; // default: true
    console.log(`${LOG} settings loaded — provider: ${provider}, apiKey set: ${!!apiKey}, model: ${model}, detectionMethod: ${detectionMethod}, openaiApiKey set: ${!!openaiApiKey}, extensionEnabled: ${extensionEnabled}`);
  }

  function loadSettings(callback) {
    chrome.storage.sync.get(
      ["provider", "groqApiKey", "groqModel", "lightningApiKey", "lightningModel", "openaiApiKey", "openaiModel", "detectionMethod", "extensionEnabled"],
      (r) => {
        applySettings(r);
        if (callback) callback();
      }
    );
  }

  loadSettings();

  chrome.storage.onChanged.addListener(() => {
    // Any relevant key changed (provider switch, either API key, either model) —
    // simplest correct approach is to just reload the full settings snapshot.
    loadSettings();
  });


  // ── Helper: Is Element Visible ───────────────────────────────────────────────
  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  // Helper: Find Nearest Common Ancestor
  function findCommonParent(elements) {
    if (elements.length === 0) return null;
    let parent = elements[0].parentElement;
    while (parent) {
      const allContained = elements.every(el => parent.contains(el));
      if (allContained) {
        return parent;
      }
      parent = parent.parentElement;
    }
    return null;
  }

  // ── Helper: Extract Rich Text (Math, Tables, Images, Code Blocks) ────────────
  function extractRichText(element) {
    if (!element) return "";
    
    // Clone node so we don't modify the visible page DOM
    const clone = element.cloneNode(true);
    
    // 1. Process MathJax formulas (standard in Moodle and custom pages)
    clone.querySelectorAll('.MathJax, [id^="MathJax-Element"]').forEach(math => {
      const script = math.querySelector('script[type^="math/tex"]');
      if (script) {
        const replacement = document.createTextNode(` $${script.textContent.trim()}$ `);
        math.parentNode.replaceChild(replacement, math);
      }
    });

    // 2. Process KaTeX math formulas (common in Canvas and modern quiz platforms)
    clone.querySelectorAll('.katex').forEach(math => {
      const annotation = math.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation) {
        const replacement = document.createTextNode(` $${annotation.textContent.trim()}$ `);
        math.parentNode.replaceChild(replacement, math);
      }
    });

    // 3. Process tables to structured Markdown text
    clone.querySelectorAll('table').forEach(table => {
      const rows = Array.from(table.querySelectorAll('tr'));
      let mdTable = "\n";
      rows.forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('th, td')).map(cell => cell.innerText.trim());
        if (cells.length > 0) {
          mdTable += "| " + cells.join(" | ") + " |\n";
        }
      });
      const replacement = document.createTextNode(mdTable);
      table.parentNode.replaceChild(replacement, table);
    });

    // 4. Process code blocks to keep their formatting
    clone.querySelectorAll('pre, code').forEach(code => {
      // Avoid nesting if a code block is inside a pre
      if (code.tagName === "CODE" && code.parentElement.tagName === "PRE") return;
      const text = code.innerText.trim();
      if (text) {
        const replacement = document.createTextNode(`\n\`\`\`\n${text}\n\`\`\`\n`);
        code.parentNode.replaceChild(replacement, code);
      }
    });

    // 5. Process images to extract their alt text
    clone.querySelectorAll('img').forEach(img => {
      const alt = img.alt ? img.alt.trim() : "";
      const src = img.src ? img.src.split('/').pop() : "";
      const replacement = document.createTextNode(` [Image: ${alt || src || 'unnamed'}] `);
      img.parentNode.replaceChild(replacement, img);
    });

    return clone.innerText.trim();
  }

  // ── DOM QCM Scanner ──────────────────────────────────────────────────────────
  function scanQuestions() {
    const containers = [];
    
    // 1. Selector-based matching (LMS specific containers)
    const selectors = [
      ".geS5ne", // Google Forms
      ".que.multichoice, .que.truefalse, .que.match, .que.multianswer", // Moodle
      ".question.display_question, .quiz-question", // Canvas
      "fieldset", // Generic HTML fieldsets
      "[role=\"radiogroup\"]", // ARIA
      ".question-container, .quiz-container, .q-card" // Custom platforms
    ];

    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        if (!containers.includes(el) && isVisible(el)) {
          containers.push(el);
        }
      });
    });

    // 2. Generic inputs-based matching (for custom/undetected sites)
    const inputGroups = {};
    document.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(input => {
      if (!isVisible(input)) return;
      const groupKey = input.name || input.parentElement.className || input.parentElement.parentElement.className;
      if (groupKey) {
        if (!inputGroups[groupKey]) inputGroups[groupKey] = [];
        inputGroups[groupKey].push(input);
      }
    });

    for (const key in inputGroups) {
      const inputs = inputGroups[key];
      if (inputs.length >= 2) {
        const commonContainer = findCommonParent(inputs);
        if (commonContainer && !containers.includes(commonContainer) && isVisible(commonContainer)) {
          if (commonContainer.tagName !== "BODY" && commonContainer.tagName !== "HTML" && commonContainer.tagName !== "FORM") {
            containers.push(commonContainer);
          }
        }
      }
    }

    // 3. Fallback: no native <input> elements at all — many custom quiz UIs render
    // choices as plain clickable <li>/<div> elements styled via JS/CSS instead of
    // real radio/checkbox inputs. Detect groups of ≥3 same-tag siblings under a
    // common parent that each carry short, choice-like text (e.g. "A) Paris").
    const CHOICE_LIKE_SELECTOR = ".option, .choice, .answer-item, .answer, [class*=\"option\"], [class*=\"choice\"], [class*=\"answer\"], li";
    const siblingGroups = new Map();
    document.querySelectorAll(CHOICE_LIKE_SELECTOR).forEach(el => {
      if (!isVisible(el)) return;
      const text = el.innerText?.trim();
      if (!text || text.length < 1 || text.length > 300) return;
      const parent = el.parentElement;
      if (!parent) return;
      if (!siblingGroups.has(parent)) siblingGroups.set(parent, []);
      siblingGroups.get(parent).push(el);
    });

    siblingGroups.forEach((els, parent) => {
      if (els.length < 2 || els.length > 12) return; // quiz choices rarely exceed ~10 options
      if (parent.closest("nav, header, footer")) return;
      // Skip if this parent (or an ancestor) is already covered by an existing container
      const alreadyCovered = containers.some(c => c === parent || c.contains(parent) || parent.contains(c));
      if (alreadyCovered) return;
      if (parent.tagName === "BODY" || parent.tagName === "HTML") return;
      // Walk up one level to try to capture a question-text sibling above the option list
      // (many layouts put the question text in a sibling element just before the list).
      const candidateContainer = parent.parentElement && isVisible(parent.parentElement)
        ? parent.parentElement
        : parent;
      if (!containers.includes(candidateContainer)) {
        containers.push(candidateContainer);
      }
    });

    const parsedQuestions = [];
    containers.forEach(container => {
      // Skip if already solved/solving
      if (container.hasAttribute("data-qcm-solved") || container.hasAttribute("data-qcm-solving")) {
        return;
      }

      // Find Question Text (Rich Parsing)
      let questionText = "";
      const qTextEl = container.querySelector(".qtext, .question_text, .M7yDu, legend, .question-title, .question-header, h2, h3, h4, h5");
      if (qTextEl) {
        questionText = extractRichText(qTextEl);
      } else {
        // Fallback: extract rich contents of the container's top-level text nodes
        questionText = extractRichText(container).split('\n')[0] || "Question";
      }

      if (!questionText || questionText.length < 5) return;

      // Find Choices
      const optionEls = container.querySelectorAll(
        ".answer > div, .answers .answer, .answer_label, div[role=\"radio\"], div[role=\"checkbox\"], label, .option, .choice, .answer-item, li"
      );

      const candidates = Array.from(optionEls).filter(el => {
        if (!isVisible(el)) return false;
        const text = el.innerText?.trim();
        if (!text) return false;
        if (qTextEl && (qTextEl === el || qTextEl.contains(el))) return false;
        return true;
      });

      // De-duplicate: Keep outer containers, discard nested children
      const filteredCandidates = [];
      candidates.forEach(el => {
        const isContainedByOther = candidates.some(other => other !== el && other.contains(el));
        if (!isContainedByOther) {
          if (el !== container && el.innerText.trim().length < 500) {
            filteredCandidates.push(el);
          }
        }
      });

      const choices = [];
      filteredCandidates.forEach((el, index) => {
        let text = extractRichText(el);
        const labelPattern = /^([A-Za-z][\.\)]\s*|[0-9]+[\.\)]\s*|[-•–]\s+|\[[ xX]?\]\s*|\([ xX*]?\)\s*)/;
        text = text.replace(labelPattern, "").trim();

        choices.push({
          text: text,
          element: el,
          index: index
        });
      });

      if (choices.length >= 2) {
        parsedQuestions.push({
          container,
          questionText,
          choices
        });
      }
    });

    return parsedQuestions;
  }

  // ── Guard: filter out fields that clearly aren't quiz answer fields ──────────
  // Prevents the generic scanner from grabbing site search boxes, login/email
  // fields, newsletter signups, etc. and stuffing an AI answer into them.
  const NON_ANSWER_FIELD_PATTERN = /search|login|log-in|signin|sign-in|email|e-mail|password|passwd|pwd|user(-?name)?|subscribe|newsletter|comment|captcha|^q$|query|promo|coupon/i;
  function isLikelyAnswerField(field) {
    const probe = [field.name, field.id, field.placeholder, field.getAttribute("autocomplete")]
      .filter(Boolean)
      .join(" ");
    return !NON_ANSWER_FIELD_PATTERN.test(probe);
  }

  // ── DOM Essay/"Rédaction" Scanner (open-ended, no fixed choices) ─────────────
  function scanEssayQuestions() {
    const containers = [];

    const selectors = [
      ".que.essay", // Moodle essay question
      ".question.display_question.essay_question, .question.display_question.short_answer_question", // Canvas
      ".essay-question, .open-question, .short-answer, .free-text-question" // Custom platforms
    ];

    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        if (!containers.includes(el) && isVisible(el)) {
          containers.push(el);
        }
      });
    });

    // Generic detection: any visible writable text field, grouped by its nearest question-like ancestor.
    // Deliberately excludes "form" as a fallback container — on many sites the whole page is one
    // <form>, which would sweep in unrelated fields (search boxes, logins, etc.) as "questions".
    document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"], input:not([type])').forEach(field => {
      if (!isVisible(field)) return;
      if (!isLikelyAnswerField(field)) return;
      const container = field.closest(
        '.que, .question, .question-container, .quiz-container, .q-card, fieldset'
      ) || field.parentElement;
      if (container && !containers.includes(container)) {
        containers.push(container);
      }
    });

    const parsedQuestions = [];
    containers.forEach(container => {
      if (container.hasAttribute("data-qcm-solved") || container.hasAttribute("data-qcm-solving")) {
        return;
      }

      const field = container.querySelector('textarea, [contenteditable="true"], input[type="text"], input:not([type])');
      if (!field || !isVisible(field) || !isLikelyAnswerField(field)) return;

      // Skip fields that already contain an answer
      const existing = (field.tagName === "TEXTAREA" || field.tagName === "INPUT" ? field.value : field.innerText || "").trim();
      if (existing.length > 3) return;

      // Skip containers that already have MCQ-style choices (handled elsewhere)
      const hasChoiceInputs = container.querySelectorAll('input[type="radio"], input[type="checkbox"]').length >= 2;
      if (hasChoiceInputs) return;

      // Require real extracted question text — never fall back to a placeholder string,
      // since that would defeat the length check below and send junk to the AI.
      let questionText = "";
      const qTextEl = container.querySelector(".qtext, .question_text, .M7yDu, legend, .question-title, .question-header, h2, h3, h4, h5");
      if (qTextEl) {
        questionText = extractRichText(qTextEl);
      } else {
        questionText = (extractRichText(container).split('\n')[0] || "").trim();
      }

      if (!questionText || questionText.length < 5) return;

      parsedQuestions.push({ container, questionText, field });
    });

    return parsedQuestions;
  }

  // ── Debug Helper (run window.__qcmDebugScan() in the DevTools console) ───────
  window.__qcmDebugScan = function () {
    const mcq = scanQuestions();
    const essay = scanEssayQuestions();
    console.log(`${LOG} debug scan — ${mcq.length} MCQ container(s), ${essay.length} essay container(s)`);
    mcq.forEach((q, i) => {
      console.log(`  MCQ #${i + 1}:`, q.questionText.slice(0, 80), "| choices:", q.choices.map(c => c.text));
    });
    essay.forEach((q, i) => {
      console.log(`  Essay #${i + 1}:`, q.questionText.slice(0, 80));
    });
    if (mcq.length === 0 && essay.length === 0) {
      console.log(`${LOG} debug — no containers matched. Common causes: choices are plain text with no distinguishing wrapper, or the question/choice text is inside a shadow DOM / iframe the scanner can't see.`);
    }
    return { mcq, essay };
  };

  // ── Panel Rendering Helpers ───────────────────────────────────────────────────
  function getPanelBody() {
    return document.getElementById("qcm-solver-panel-body");
  }

  function openPanel() {
    const root = document.getElementById(PANEL_ROOT_ID);
    if (root) root.classList.add("qcm-open");
  }

  function renderPanelMessage(html, kind) {
    const body = getPanelBody();
    if (!body) return;
    const cls = kind === "error" ? "qcm-error-state" : "qcm-empty-state";
    body.innerHTML = `<div class="${cls}">${html}</div>`;
  }

  function renderPanelLoading(count, label) {
    const body = getPanelBody();
    if (!body) return;
    const text = label || `Solving ${count} question${count === 1 ? "" : "s"}…`;
    body.innerHTML = `
      <div class="qcm-loading-state">
        <span class="qcm-spinner"></span>
        <span>${text}</span>
      </div>
    `;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ── Readable Math/Code Formatting for Display ────────────────────────────────
  // extractRichText() encodes MathJax/KaTeX formulas as "$...$" and code blocks as
  // fenced "```...```" text so the raw text sent to the AI stays unambiguous. That
  // raw markup isn't meant for humans to read as-is, so before displaying question
  // text (or AI answer/explanation text that echoes the same style) in the panel,
  // clean it up into something legible: convert common LaTeX to plain symbols and
  // render code fences as an actual <pre> block instead of literal backticks.
  const LATEX_REPLACEMENTS = [
    [/\\times/g, "×"],
    [/\\div/g, "÷"],
    [/\\pm/g, "±"],
    [/\\leq/g, "≤"],
    [/\\geq/g, "≥"],
    [/\\neq/g, "≠"],
    [/\\approx/g, "≈"],
    [/\\infty/g, "∞"],
    [/\\cdot/g, "·"],
    [/\\rightarrow|\\to/g, "→"],
    [/\\sqrt\{([^}]*)\}/g, "√($1)"],
    [/\\frac\{([^}]*)\}\{([^}]*)\}/g, "($1/$2)"],
    [/\\alpha/g, "α"], [/\\beta/g, "β"], [/\\gamma/g, "γ"], [/\\delta/g, "δ"],
    [/\\pi/g, "π"], [/\\theta/g, "θ"], [/\\lambda/g, "λ"], [/\\mu/g, "μ"], [/\\sigma/g, "σ"],
    [/\^\{([^}]*)\}/g, (_, exp) => toSuperscript(exp)],
    [/\^([0-9a-zA-Z])/g, (_, exp) => toSuperscript(exp)],
    [/_\{([^}]*)\}/g, (_, sub) => toSubscript(sub)],
    [/_([0-9a-zA-Z])/g, (_, sub) => toSubscript(sub)],
    [/\\[a-zA-Z]+/g, ""], // strip any remaining unrecognized LaTeX commands
    [/[{}]/g, ""] // strip leftover braces
  ];

  const SUPERSCRIPT_MAP = { "0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹","+":"⁺","-":"⁻","n":"ⁿ","i":"ⁱ" };
  const SUBSCRIPT_MAP   = { "0":"₀","1":"₁","2":"₂","3":"₃","4":"₄","5":"₅","6":"₆","7":"₇","8":"₈","9":"₉","+":"₊","-":"₋" };

  function toSuperscript(str) {
    return String(str).split("").map(ch => SUPERSCRIPT_MAP[ch] || ch).join("");
  }
  function toSubscript(str) {
    return String(str).split("").map(ch => SUBSCRIPT_MAP[ch] || ch).join("");
  }

  function formatMathInline(text) {
    let result = text;
    for (const [pattern, replacement] of LATEX_REPLACEMENTS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  // Converts extractRichText()'s "$...$" math spans and "```...```" code fences
  // into readable plain text, returning HTML-safe markup (escaping happens here,
  // per-segment, so math symbols and code aren't double-escaped or left raw).
  function formatDisplayText(text) {
    if (!text) return "";
    const segments = [];
    let lastIndex = 0;

    // Code fences first (```...```), since their contents shouldn't be touched by math formatting.
    const codeFencePattern = /```([\s\S]*?)```/g;
    let match;
    const withCodePlaceholders = [];
    while ((match = codeFencePattern.exec(text)) !== null) {
      withCodePlaceholders.push({ start: match.index, end: match.index + match[0].length, code: match[1] });
    }

    function renderPlainSegment(segment) {
      // Inline math: $...$
      const mathPattern = /\$([^$]+)\$/g;
      let out = "";
      let idx = 0;
      let m;
      while ((m = mathPattern.exec(segment)) !== null) {
        out += escapeHtml(segment.slice(idx, m.index));
        out += `<span class="qcm-math">${escapeHtml(formatMathInline(m[1].trim()))}</span>`;
        idx = m.index + m[0].length;
      }
      out += escapeHtml(segment.slice(idx));
      return out;
    }

    if (withCodePlaceholders.length === 0) {
      return renderPlainSegment(text);
    }

    withCodePlaceholders.forEach(block => {
      segments.push(renderPlainSegment(text.slice(lastIndex, block.start)));
      segments.push(`<pre class="qcm-code-block">${escapeHtml(block.code.trim())}</pre>`);
      lastIndex = block.end;
    });
    segments.push(renderPlainSegment(text.slice(lastIndex)));

    return segments.join("");
  }

  // Renders the parsed batch results as cards. Does NOT touch the clipboard
  // banner — that's shown separately once the clipboard write actually succeeds.
  function renderPanelResults(results) {
    const body = getPanelBody();
    if (!body) return;

    const cardsHtml = results.map((r, i) => {
      const n = i + 1;
      if (r.error) {
        return `
          <div class="qcm-result-card qcm-result-error">
            <div class="qcm-result-q">Q${n}. ${formatDisplayText(truncate(r.questionText, 140))}</div>
            <div class="qcm-result-error-text">⚠️ ${escapeHtml(r.error)}</div>
          </div>
        `;
      }

      if (r.type === "essay") {
        return `
          <div class="qcm-result-card">
            <div class="qcm-result-q">Q${n}. ${formatDisplayText(truncate(r.questionText, 140))}</div>
            <div class="qcm-result-essay">${formatDisplayText(r.answer)}</div>
          </div>
        `;
      }

      if (r.type === "code") {
        return `
          <div class="qcm-result-card">
            <div class="qcm-result-q">Q${n}. ${formatDisplayText(truncate(r.questionText, 140))}</div>
            <pre class="qcm-code-block">${escapeHtml(r.answer)}</pre>
          </div>
        `;
      }

      const letterText = r.letters
        .map(letter => {
          const idx = letter.charCodeAt(0) - 65;
          const choice = r.choices?.[idx];
          return choice ? `${letter}) ${choice.text}` : letter;
        })
        .join(", ");

      return `
        <div class="qcm-result-card">
          <div class="qcm-result-q">Q${n}. ${formatDisplayText(truncate(r.questionText, 140))}</div>
          <div class="qcm-result-answer-row">
            <span class="qcm-answer-badge">${escapeHtml(r.letters.join(", "))}</span>
            <span class="qcm-answer-text">${formatDisplayText(letterText)}</span>
          </div>
          ${r.explanation ? `<div class="qcm-result-explanation">${formatDisplayText(r.explanation)}</div>` : ""}
        </div>
      `;
    }).join("");

    body.innerHTML = `
      <div class="qcm-copied-banner" id="qcm-copied-banner">Copied to clipboard ✓</div>
      ${cardsHtml}
    `;
  }

  // Shows the transient clipboard confirmation banner. Called only after a
  // confirmed successful navigator.clipboard.writeText() — never assumed.
  function showCopiedBanner(text) {
    const banner = document.getElementById("qcm-copied-banner");
    if (!banner) return;
    banner.textContent = text;
    banner.classList.remove("qcm-banner-warn");
    requestAnimationFrame(() => banner.classList.add("qcm-visible"));
    clearTimeout(banner._hideTimer);
    banner._hideTimer = setTimeout(() => banner.classList.remove("qcm-visible"), 2200);
  }

  // Shows the banner in a muted "warning" state when the clipboard write fails —
  // results are still visible in the panel, just not on the clipboard.
  function showCopyFailedBanner() {
    const banner = document.getElementById("qcm-copied-banner");
    if (!banner) return;
    banner.textContent = "Couldn't copy to clipboard — results shown below";
    banner.classList.add("qcm-banner-warn");
    requestAnimationFrame(() => banner.classList.add("qcm-visible"));
    clearTimeout(banner._hideTimer);
    banner._hideTimer = setTimeout(() => banner.classList.remove("qcm-visible"), 3200);
  }

  function truncate(text, max) {
    if (!text) return "";
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }

  // Builds the full plain-text block copied to the clipboard, one section per question.
  function buildClipboardText(results) {
    return results.map((r, i) => {
      const n = i + 1;
      if (r.error) return `Q${n}: [error] ${r.error}`;
      if (r.type === "essay") return `Q${n} (essay): ${r.answer}`;
      if (r.type === "code") return `Q${n} (code):\n\`\`\`\n${r.answer}\n\`\`\``;

      const letterText = r.letters
        .map(letter => {
          const idx = letter.charCodeAt(0) - 65;
          const choice = r.choices?.[idx];
          return choice ? `${letter}) ${choice.text}` : letter;
        })
        .join(", ");
      return `Q${n}: ${letterText}`;
    }).join("\n");
  }

  // ── Screenshot/Clipboard + OpenAI Vision Transcription ───────────────────────
  // Sends an image to OpenAI's vision endpoint for transcription. If no
  // `dataUrl` is passed, asks the background worker to capture the visible
  // tab first (page-screenshot detection method); if one is passed (e.g. an
  // image read from the clipboard), it's used as-is. Returns an array of
  // { type, questionText, choices } matching the shape used elsewhere.
  // Throws on any failure so the caller can fall back to DOM scanning.
  async function getQuestionsFromVision(dataUrl) {
    let resolvedDataUrl = dataUrl;

    if (!resolvedDataUrl) {
      const captureResponse = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" });
      if (!captureResponse || !captureResponse.success) {
        throw new Error(captureResponse?.error || "Screenshot capture failed.");
      }
      resolvedDataUrl = captureResponse.data.dataUrl;
    }

    const visionResponse = await chrome.runtime.sendMessage({
      type: "ASK_OPENAI_VISION",
      payload: { dataUrl: resolvedDataUrl, apiKey: openaiApiKey, model: openaiModel }
    });
    if (!visionResponse || !visionResponse.success) {
      throw new Error(visionResponse?.error || "OpenAI Vision request failed.");
    }

    return visionResponse.data.questions || [];
  }

  // ── Clipboard Image Detection ────────────────────────────────────────────────
  // Checks the OS clipboard for an image (e.g. the user just took a manual
  // screenshot, which most OSes copy straight to the clipboard) and converts
  // it to a base64 data URL for the Vision pipeline. Always returns null on
  // any failure — no permission granted yet, document not focused, clipboard
  // empty, or clipboard contains only text — so callers can silently continue
  // with their normal selection/page-detection flow instead of erroring out.
  async function getImageFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.read) return null;

    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith("image/"));
        if (!imageType) continue;

        const blob = await item.getType(imageType);
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        return dataUrl;
      }
    } catch (err) {
      console.log(`${LOG} clipboard image read skipped (${err.message || err}) — continuing with normal detection.`);
    }
    return null;
  }

  // ── Trigger Solve (Ctrl+Shift+X / Cmd+Shift+X) ───────────────────────────────
  // Selection-first: if the user has text selected, try to parse it as a single
  // question. Otherwise, fall back to scanning the whole visible page for
  // MCQ + essay/write-in questions. Sends everything in ONE batched Groq request.
  // Never fills or marks form fields — the panel is the only answer surface.
  async function handleTriggerSolve() {
    if (!extensionEnabled) {
      console.log(`${LOG} solve shortcut ignored — extension is disabled from the popup.`);
      return;
    }

    openPanel();

    if (!apiKey) {
      const providerLabel = provider === "groq" ? "Groq" : "Lightning AI";
      renderPanelMessage(`⚠️ No ${providerLabel} API key set — open the extension popup to add one.`, "error");
      return;
    }

    // ── Clipboard image path: highest priority ──────────────────────────────────
    // If the user just took a manual OS screenshot (most OSes copy it straight
    // to the clipboard) and then pressed the shortcut, answer that image —
    // takes priority over text selection and page detection, since pasting an
    // image is a deliberate, high-signal action. Silently falls through to the
    // normal selection/page flow if there's no image on the clipboard.
    const clipboardImage = await getImageFromClipboard();
    if (clipboardImage) {
      if (!openaiApiKey) {
        renderPanelMessage(`⚠️ Found an image on your clipboard, but no OpenAI API key is configured for Vision — open the extension popup to add one.`, "error");
        return;
      }
      renderPanelLoading(0, "Reading the image from your clipboard…");
      try {
        const questions = await getQuestionsFromVision(clipboardImage);
        console.log(`${LOG} clipboard image — OpenAI Vision found ${questions.length} question(s)`);

        if (questions.length === 0) {
          renderPanelMessage("The AI couldn't find any question in the clipboard image.", "empty");
          return;
        }

        renderPanelLoading(questions.length);

        const response = await chrome.runtime.sendMessage({
          type: "ASK_GROQ_BATCH",
          payload: {
            questions,
            provider,
            apiKey,
            model,
            context: {
              title: document.title || "",
              domain: window.location.hostname || ""
            }
          }
        });

        if (!response || !response.success) {
          const errMsg = response?.error || "Unknown error";
          console.error(`${LOG} clipboard image batch request failed:`, errMsg);
          renderPanelMessage(`⚠️ AI request failed: ${escapeHtml(errMsg)}`, "error");
          return;
        }

        await renderResultsAndCopy(response.data.results);
      } catch (err) {
        console.error(`${LOG} clipboard image flow failed:`, err);
        renderPanelMessage(`⚠️ Clipboard image request failed: ${escapeHtml(err.message || String(err))}`, "error");
      }
      return;
    }

    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();

    // ── Selection path: let the AI segment + answer in one pass ────────────────
    // Client-side heuristics for splitting a raw selection into N questions
    // proved unreliable against real-world copy-pasted platform text (blank
    // lines from UI chrome like "Insert" / "Shift+Enter to run" caused a
    // 5-question selection to fragment into ~17 pieces). Instead, the whole
    // selection is sent as-is and the model decides how many questions it
    // contains, classifies each, and answers all of them in one request.
    if (selectedText && selectedText.length >= 10) {
      renderPanelLoading(0, "Reading your selection…");
      try {
        const response = await chrome.runtime.sendMessage({
          type: "ASK_GROQ_RAW_SEGMENT",
          payload: {
            text: selectedText,
            provider,
            apiKey,
            model,
            context: {
              title: document.title || "",
              domain: window.location.hostname || ""
            }
          }
        });

        if (!response || !response.success) {
          const errMsg = response?.error || "Unknown error";
          console.error(`${LOG} raw segment request failed:`, errMsg);
          renderPanelMessage(`⚠️ AI request failed: ${escapeHtml(errMsg)}`, "error");
          return;
        }

        const { results } = response.data;
        console.log(`${LOG} raw segment results — AI found ${results.length} question(s):`, results);

        if (results.length === 0) {
          renderPanelMessage("The AI couldn't find any question in your selection. Try selecting a bit more context.", "empty");
          return;
        }

        await renderResultsAndCopy(results);
      } catch (err) {
        console.error(`${LOG} raw segment request threw:`, err);
        renderPanelMessage(`⚠️ AI request failed: ${escapeHtml(err.message || String(err))}`, "error");
      }
      return;
    }

    // ── No-selection path: DOM scan or OpenAI Vision, then batched answer ──────
    // Build a unified list of question payloads to send to the AI.
    let questions = [];

    // No selection: use whichever detection method the user explicitly chose
    // in the popup (DOM scan or OpenAI Vision screenshot). No silent fallback
    // between the two — if Vision is selected but misconfigured, surface it.
    if (detectionMethod === "vision") {
      if (!openaiApiKey) {
        renderPanelMessage(`⚠️ Detection method is set to OpenAI Vision but no OpenAI API key is configured — open the extension popup to add one, or switch to DOM scan.`, "error");
        return;
      }
      renderPanelLoading(0, "Reading the page via OpenAI Vision…");
      try {
        questions = await getQuestionsFromVision();
        console.log(`${LOG} trigger solve — OpenAI Vision found ${questions.length} question(s)`);
      } catch (err) {
        console.error(`${LOG} OpenAI Vision transcription failed:`, err);
        renderPanelMessage(`⚠️ OpenAI Vision request failed: ${escapeHtml(err.message || String(err))}`, "error");
        return;
      }
    } else {
      const mcqQuestions = scanQuestions();
      const essayQuestions = scanEssayQuestions();
      if (mcqQuestions.length === 0 && essayQuestions.length === 0) {
        console.log(`${LOG} debug — no questions detected by page scan. Run window.__qcmDebugScan() in the console for details.`);
      }
      questions = [
        ...mcqQuestions.map(q => ({
          type: "mcq",
          questionText: q.questionText,
          choices: q.choices.map(c => ({ text: c.text }))
        })),
        ...essayQuestions.map(q => ({
          type: "essay",
          questionText: q.questionText
        }))
      ];
      console.log(`${LOG} trigger solve — page scan found ${mcqQuestions.length} MCQ + ${essayQuestions.length} essay/write-in question(s)`);
    }

    if (questions.length === 0) {
      renderPanelMessage("No questions found on this page. Try selecting a question and its choices first.", "empty");
      return;
    }

    renderPanelLoading(questions.length);

    try {
      const response = await chrome.runtime.sendMessage({
        type: "ASK_GROQ_BATCH",
        payload: {
          questions,
          provider,
          apiKey,
          model,
          context: {
            title: document.title || "",
            domain: window.location.hostname || ""
          }
        }
      });

      if (!response || !response.success) {
        const errMsg = response?.error || "Unknown error";
        console.error(`${LOG} batch request failed:`, errMsg);
        renderPanelMessage(`⚠️ AI request failed: ${escapeHtml(errMsg)}`, "error");
        return;
      }

      const { results } = response.data;
      console.log(`${LOG} batch results:`, results);

      await renderResultsAndCopy(results);
    } catch (err) {
      console.error(`${LOG} batch request threw:`, err);
      renderPanelMessage(`⚠️ AI request failed: ${escapeHtml(err.message || String(err))}`, "error");
    }
  }

  // Renders results in the panel and copies them to the clipboard — shared by
  // both the raw-selection-segmentation path and the DOM-scan/Vision batch path.
  async function renderResultsAndCopy(results) {
    renderPanelResults(results);

    const clipboardText = buildClipboardText(results);
    try {
      await navigator.clipboard.writeText(clipboardText);
      console.log(`${LOG} copied results to clipboard`);
      showCopiedBanner("Copied to clipboard ✓");
    } catch (clipErr) {
      console.warn(`${LOG} clipboard write failed:`, clipErr);
      showCopyFailedBanner();
    }
  }

  // ── Lightweight Toast (independent of the results panel) ────────────────────
  // Used for the copy-selection / paste-clipboard shortcuts, which should give
  // instant feedback without opening or touching the results side panel.
  const TOAST_ID = "qcm-solver-toast";

  function showToast(text, kind) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%) translateY(12px);
        z-index: 2147483647;
        background: rgba(20, 20, 28, 0.95);
        color: #f3f4f6;
        font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        font-weight: 500;
        padding: 10px 18px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.1);
        box-shadow: 0 8px 28px rgba(0,0,0,0.35);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.18s ease, transform 0.18s ease;
      `;
      (document.body || document.documentElement).appendChild(toast);
    }

    toast.textContent = text;
    toast.style.borderColor = kind === "error" ? "rgba(239, 68, 68, 0.4)" : "rgba(255,255,255,0.1)";
    toast.style.color = kind === "error" ? "#fca5a5" : "#f3f4f6";

    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateX(-50%) translateY(0)";
    });

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(-50%) translateY(12px)";
    }, 2200);
  }

  // ── Copy Selection (Ctrl/Cmd+Shift+K) ────────────────────────────────────────
  // Copies whatever text is currently selected on the page to the clipboard.
  // Independent of the AI — a plain convenience shortcut.
  async function handleCopySelection() {
    if (!extensionEnabled) {
      console.log(`${LOG} copy-selection shortcut ignored — extension is disabled from the popup.`);
      return;
    }

    const selectedText = window.getSelection()?.toString();

    if (!selectedText || !selectedText.trim()) {
      showToast("Nothing selected to copy", "error");
      return;
    }

    try {
      await navigator.clipboard.writeText(selectedText);
      console.log(`${LOG} copy-selection — copied ${selectedText.length} character(s) to clipboard`);
      showToast("Copied to clipboard ✓");
    } catch (err) {
      console.warn(`${LOG} copy-selection failed:`, err);
      showToast("Couldn't copy — clipboard write failed", "error");
    }
  }

  // ── Paste Clipboard (Ctrl/Cmd+Shift+L) ───────────────────────────────────────
  // Pastes clipboard text content into the currently focused input, textarea,
  // or contenteditable field. Does nothing (with a toast explaining why) if no
  // such field is focused — never guesses a target field on its own.
  async function handlePasteClipboard() {
    if (!extensionEnabled) {
      console.log(`${LOG} paste-clipboard shortcut ignored — extension is disabled from the popup.`);
      return;
    }

    const el = document.activeElement;
    const isTextField = el && (
      el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && /^(text|search|email|url|tel|number|password)$/i.test(el.type || "text")) ||
      el.isContentEditable
    );

    if (!isTextField) {
      showToast("Click into a text field first, then paste", "error");
      return;
    }

    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      console.warn(`${LOG} paste-clipboard — clipboard read failed:`, err);
      showToast("Couldn't read clipboard", "error");
      return;
    }

    if (!text) {
      showToast("Clipboard is empty", "error");
      return;
    }

    if (el.isContentEditable) {
      // execCommand is deprecated but remains the most reliable cross-site way
      // to insert text into contenteditable while preserving native undo/redo
      // and firing the input events sites listen for. Falls back to a direct
      // textContent insert (and a manual "input" event) if unsupported.
      const inserted = document.execCommand && document.execCommand("insertText", false, text);
      if (!inserted) {
        el.textContent += text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      // Native input/textarea: insert at the caret position (replacing any
      // current selection within the field), then fire "input" so frameworks
      // bound to the field (React, Vue, etc.) pick up the change.
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + text.length;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    console.log(`${LOG} paste-clipboard — pasted ${text.length} character(s) into focused field`);
    showToast("Pasted ✓");
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "TRIGGER_SOLVE") {
      handleTriggerSolve();
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "TRIGGER_COPY_SELECTION") {
      handleCopySelection();
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "TRIGGER_PASTE_CLIPBOARD") {
      handlePasteClipboard();
      sendResponse({ received: true });
      return true;
    }
  });

  // Note: selection text is no longer classified/split on the client — the
  // model itself segments an arbitrary selection into questions, classifies
  // each (mcq/essay/code), and answers them via the ASK_GROQ_RAW_SEGMENT
  // request (see handleTriggerSolve above). Client-side heuristics for this
  // were removed after proving unreliable on real-world copy-pasted text.

})();
