// content.js — QCM Solver
// Scans/solves quizzes automatically or manually, and supports a standalone Ctrl tap for selection solving.
// MCQ answers are marked with a silent dot; write-in/essay answers are typed directly into the
// field when possible, or shown as an on-page floating toast when the field can't be filled.

(function () {
  "use strict";

  let apiKey = "";
  let model = "llama-3.3-70b-versatile";
  let autoMode = false;
  let isScanningAndSolving = false;

  const LOG = "[QCM Solver]";
  console.log(`${LOG} content script loaded — frame: ${window === window.top ? "top" : "iframe"} — url: ${location.href}`);

  // ── Load settings ────────────────────────────────────────────────────────────
  function loadSettings(callback) {
    chrome.storage.sync.get(["groqApiKey", "groqModel", "autoMode"], (r) => {
      apiKey = r.groqApiKey || "";
      model  = r.groqModel  || "llama-3.3-70b-versatile";
      autoMode = !!r.autoMode;
      console.log(`${LOG} settings loaded — apiKey set: ${!!apiKey}, model: ${model}, autoMode: ${autoMode}`);
      if (callback) callback();
    });
  }

  loadSettings(() => {
    if (autoMode) {
      triggerAutoSolve();
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.groqApiKey) apiKey = changes.groqApiKey.newValue || "";
    if (changes.groqModel)  model  = changes.groqModel.newValue  || "llama-3.3-70b-versatile";
    if (changes.autoMode) {
      autoMode = !!changes.autoMode.newValue;
      if (autoMode) triggerAutoSolve();
    }
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

  // ── Fill a text field/editor with the AI answer ──────────────────────────────
  function fillField(field, text) {
    // Disabled/readonly fields aren't meant for direct typing — they're usually
    // driven by drag-and-drop or a JS framework that will just reset the value.
    // Disabled fields are also excluded from form submission entirely, so a
    // "successful" write there wouldn't count anyway. Treat as unfillable.
    if (field.disabled || field.readOnly) {
      console.log(`${LOG} field is disabled/readonly, skipping direct fill:`, field);
      return false;
    }

    try {
      if (field.tagName === "TEXTAREA" || field.tagName === "INPUT") {
        const proto = field.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (nativeSetter) {
          nativeSetter.call(field, text);
        } else {
          field.value = text;
        }
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        return field.value.trim().length > 0;
      }

      if (field.isContentEditable) {
        field.focus();
        field.innerText = text;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        return field.innerText.trim().length > 0;
      }

      return false;
    } catch (err) {
      return false;
    }
  }

  // ── Find nearest writable field for an open-ended selection ─────────────────
  function findNearestAnswerField(selection) {
    const fieldSelector = 'textarea, [contenteditable="true"], input[type="text"], input:not([type])';
    try {
      const range = selection.getRangeAt(0);
      let root = range.commonAncestorContainer;
      if (root.nodeType === Node.TEXT_NODE) root = root.parentElement;

      // Prefer a field inside the same question-like container as the selection
      // (deliberately excludes "form" — too broad on single-form quiz pages)
      const container = root.closest('.que, .question, .question-container, .quiz-container, .q-card, fieldset');
      if (container) {
        const field = container.querySelector(fieldSelector);
        if (field && isVisible(field) && isLikelyAnswerField(field)) return field;
      }

      // Otherwise, look for the nearest field following the selection in the DOM
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      let foundRangeEnd = false;
      while ((node = walker.nextNode())) {
        if (!foundRangeEnd) {
          if (node === range.endContainer || (range.endContainer.nodeType === Node.TEXT_NODE && node.contains(range.endContainer))) {
            foundRangeEnd = true;
          }
          continue;
        }
        if (node.matches?.(fieldSelector) && isVisible(node) && isLikelyAnswerField(node)) return node;
      }

      // Last resort: if there's exactly one candidate field on the page, use it
      const all = Array.from(document.querySelectorAll(fieldSelector)).filter(f => isVisible(f) && isLikelyAnswerField(f));
      if (all.length === 1) return all[0];

      return null;
    } catch (_) {
      return null;
    }
  }

  // ── Solve an Open-Ended Selection (Ctrl-tap on a write-in question) ──────────
  async function solveOpenEndedSelection(selection, selectedText) {
    if (selectedText.length < 5) return;

    const field = findNearestAnswerField(selection);
    console.log(`${LOG} open-ended mode — nearest answer field:`, field);

    try {
      const result = await chrome.runtime.sendMessage({
        type: "ASK_GROQ_ESSAY",
        payload: {
          question: selectedText,
          apiKey,
          model,
          context: {
            title: document.title || "",
            domain: window.location.hostname || ""
          }
        }
      });

      console.log(`${LOG} ASK_GROQ_ESSAY result:`, result);

      if (!result.success || !result.data.answer) {
        showFloatingAnswer(selectedText.slice(0, 150), `AI request failed: ${result.error || "no answer returned"}`);
        return;
      }

      const filled = field ? fillField(field, result.data.answer) : false;
      console.log(`${LOG} filled open-ended field: ${filled}`);
      if (!filled) {
        showFloatingAnswer(selectedText.slice(0, 150), result.data.answer);
      }
    } catch (err) {
      console.error(`${LOG} open-ended solve failed:`, err);
    }
  }

  // ── Solve Essay/"Rédaction" Questions Sequentially ───────────────────────────
  async function solveEssayQuestionsSequentially(qObjects) {
    if (!apiKey || qObjects.length === 0) return;

    console.log(`${LOG} solving ${qObjects.length} essay/write-in question(s)`);

    for (const qObj of qObjects) {
      qObj.container.setAttribute("data-qcm-solving", "true");

      try {
        const result = await chrome.runtime.sendMessage({
          type: "ASK_GROQ_ESSAY",
          payload: {
            question: qObj.questionText,
            apiKey,
            model,
            context: {
              title: document.title || "",
              domain: window.location.hostname || ""
            }
          }
        });

        console.log(`${LOG} essay answer for "${qObj.questionText}":`, result);

        if (result.success && result.data.answer) {
          const filled = fillField(qObj.field, result.data.answer);
          console.log(`${LOG} filled field: ${filled}`, qObj.field);
          if (filled) {
            qObj.container.setAttribute("data-qcm-solved", "true");
          } else {
            qObj.container.removeAttribute("data-qcm-solving");
            showFloatingAnswer(qObj.questionText, result.data.answer);
          }
        } else {
          qObj.container.removeAttribute("data-qcm-solving");
        }
      } catch (err) {
        console.error(`${LOG} essay solve failed:`, err);
        qObj.container.removeAttribute("data-qcm-solving");
      }

      await new Promise(r => setTimeout(r, 400));
    }
  }

  // ── Solve Questions Sequentially ─────────────────────────────────────────────
  async function solveQuestionsSequentially(qObjects, isAuto = false) {
    if (isScanningAndSolving) return;
    isScanningAndSolving = true;

    if (!apiKey) {
      console.error("QCM AI Solver: API key not set.");
      isScanningAndSolving = false;
      return;
    }

    for (const qObj of qObjects) {
      qObj.container.setAttribute("data-qcm-solving", "true");

      try {
        const result = await chrome.runtime.sendMessage({
          type: "ASK_GROQ",
          payload: { 
            question: qObj.questionText, 
            choices: qObj.choices, 
            apiKey, 
            model,
            context: {
              title: document.title || "",
              domain: window.location.hostname || ""
            }
          }
        });

        if (result.success) {
          const { letters } = result.data;
          let marked = 0;

          letters.forEach(letter => {
            const idx = letter.charCodeAt(0) - 65;
            const choice = qObj.choices[idx];
            if (choice && choice.element) {
              markElement(choice.element);
              marked++;
            }
          });

          if (marked > 0) {
            qObj.container.setAttribute("data-qcm-solved", "true");
          } else {
            qObj.container.removeAttribute("data-qcm-solving");
          }
        } else {
          qObj.container.removeAttribute("data-qcm-solving");
        }
      } catch (err) {
        qObj.container.removeAttribute("data-qcm-solving");
      }

      await new Promise(r => setTimeout(r, 400));
    }

    isScanningAndSolving = false;
  }

  // ── Auto Mode Trigger ────────────────────────────────────────────────────────
  let autoSolveTimeout;
  function triggerAutoSolve() {
    if (!autoMode) return;
    clearTimeout(autoSolveTimeout);
    autoSolveTimeout = setTimeout(() => {
      const questions = scanQuestions();
      const essayQuestions = scanEssayQuestions();
      console.log(`${LOG} auto-scan found ${questions.length} MCQ + ${essayQuestions.length} essay/write-in question(s)`);
      if (questions.length > 0) {
        solveQuestionsSequentially(questions, true);
      }
      if (essayQuestions.length > 0) {
        solveEssayQuestionsSequentially(essayQuestions);
      }
    }, 1500);
  }

  // Monitor dynamic DOM changes
  const observer = new MutationObserver((mutations) => {
    if (!autoMode) return;
    let addedElements = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        addedElements = true;
        break;
      }
    }
    if (addedElements) {
      triggerAutoSolve();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ── Keyboard Selection Solve Listener ────────────────────────────────────────
  // Triggers on a standalone tap of Ctrl (pressed and released with no other key
  // held in between), so it doesn't hijack normal combos like Ctrl+C/Ctrl+F/Ctrl+T.
  let ctrlUsedInCombo = false;

  document.addEventListener("keydown", (e) => {
    if (e.key === "Control") {
      ctrlUsedInCombo = false;
    } else if (e.ctrlKey) {
      ctrlUsedInCombo = true;
    }
  }, true);

  document.addEventListener("keyup", async (e) => {
    if (e.key !== "Control" || ctrlUsedInCombo) return;

    console.log(`${LOG} Ctrl tap detected`);

    if (!apiKey) {
      console.error(`${LOG} API key is missing — set it in the extension popup first.`);
      return;
    }

    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    console.log(`${LOG} selection length: ${selectedText ? selectedText.length : 0}`, selectedText);

    if (!selectedText || selectedText.length < 10) {
      console.warn(`${LOG} selection too short (<10 chars) — select the question + choices first, then tap Ctrl.`);
      return;
    }

    const parsed = parseSelection(selectedText);
    if (!parsed) {
      console.warn(`${LOG} parseSelection() failed — no >=2 choices detected, trying open-ended/essay mode instead.`);
      await solveOpenEndedSelection(selection, selectedText);
      return;
    }

    console.log(`${LOG} parsed question:`, parsed.question, "choices:", parsed.choices.map(c => c.text));

    try {
      const result = await chrome.runtime.sendMessage({
        type: "ASK_GROQ",
        payload: {
          question: parsed.question,
          choices: parsed.choices,
          apiKey,
          model,
          context: {
            title: document.title || "",
            domain: window.location.hostname || ""
          }
        }
      });

      console.log(`${LOG} ASK_GROQ result:`, result);

      if (!result.success) {
        console.error(`${LOG} API error:`, result.error);
        showFloatingAnswer(parsed.question, `AI request failed: ${result.error}`);
        return;
      }

      const { letters } = result.data;
      if (!letters.length) {
        console.warn(`${LOG} AI response had no parseable answer letters.`, result.data);
        return;
      }

      const markedCount = markAnswersInDOM(selection, parsed, letters);
      console.log(`${LOG} letters: ${letters.join(",")} — marked ${markedCount} element(s) in the DOM`);
      if (!markedCount) {
        const answerText = letters
          .map(letter => {
            const idx = letter.charCodeAt(0) - 65;
            const choice = parsed.choices[idx];
            return choice ? `${letter}) ${choice.text}` : letter;
          })
          .join(", ");
        showFloatingAnswer(parsed.question, answerText);
      }
    } catch (err) {
      console.error(`${LOG} request failed:`, err);
    }
  }, true);

  // ── Floating On-Page Answer Toast (fallback when we can't fill a field) ──────
  function showFloatingAnswer(question, answer) {
    let container = document.getElementById("qcm-solver-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "qcm-solver-toast-container";
      Object.assign(container.style, {
        position: "fixed",
        bottom: "16px",
        right: "16px",
        zIndex: "2147483647",
        display: "flex",
        flexDirection: "column-reverse",
        gap: "8px",
        maxWidth: "340px",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
      });
      (document.body || document.documentElement).appendChild(container);
    }

    const isDarkMode = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const bg = isDarkMode ? "#18181b" : "#ffffff";
    const fg = isDarkMode ? "#e4e4e7" : "#18181b";
    const sub = isDarkMode ? "#a1a1aa" : "#52525b";
    const border = isDarkMode ? "#3f3f46" : "#e4e4e7";

    const toast = document.createElement("div");
    Object.assign(toast.style, {
      background: bg,
      color: fg,
      border: `1px solid ${border}`,
      borderRadius: "10px",
      padding: "10px 24px 10px 12px",
      boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
      fontSize: "13px",
      lineHeight: "1.45",
      position: "relative",
      pointerEvents: "auto"
    });

    const closeBtn = document.createElement("span");
    closeBtn.textContent = "×";
    Object.assign(closeBtn.style, {
      position: "absolute",
      top: "4px",
      right: "8px",
      cursor: "pointer",
      fontSize: "16px",
      lineHeight: "1",
      opacity: "0.6"
    });
    closeBtn.addEventListener("click", () => toast.remove());

    const qEl = document.createElement("div");
    qEl.textContent = question;
    Object.assign(qEl.style, { color: sub, fontSize: "12px", marginBottom: "4px" });

    const aEl = document.createElement("div");
    aEl.textContent = answer;
    Object.assign(aEl.style, { fontWeight: "600" });

    toast.appendChild(closeBtn);
    toast.appendChild(qEl);
    toast.appendChild(aEl);
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = "opacity 0.4s ease";
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 400);
    }, 25000);
  }

  // ── Parse Selection Text ─────────────────────────────────────────────────────
  function parseSelection(text) {
    let lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);

    const labelPattern = /^([A-Za-z][\.\)]\s*|[0-9]+[\.\)]\s*|[-•–]\s+|\[[ xX]?\]\s*|\([ xX*]?\)\s*)/;

    // Some quiz layouts (inline/flex option lists) copy as a single line with no
    // breaks between the question and each choice. Reconstruct line breaks by
    // splitting right before each detected choice label (e.g. "... B) Berlin").
    if (lines.length < 3) {
      const inlineLabelPattern = /(?:^|\s)([A-Za-z][\.\)]\s+|[0-9]+[\.\)]\s+)/g;
      const withBreaks = text.replace(inlineLabelPattern, (_, label) => `\n${label}`);
      const altLines = withBreaks.split(/\n+/).map(l => l.trim()).filter(Boolean);
      if (altLines.length > lines.length) lines = altLines;
    }

    if (lines.length < 3) return null;

    const labeledLines = lines.filter(l => labelPattern.test(l));

    let question, choices;

    if (labeledLines.length >= 2) {
      const firstChoiceIdx = lines.findIndex(l => labelPattern.test(l));
      question = lines.slice(0, firstChoiceIdx).join(" ").trim() || lines[0];
      choices = lines.slice(firstChoiceIdx).map((l, i) => ({
        text: l.replace(labelPattern, "").trim(),
        originalLine: l
      }));
    } else {
      question = lines[0];
      choices = lines.slice(1).map(l => ({ text: l, originalLine: l }));
    }

    if (choices.length < 2) return null;
    return { question, choices };
  }

  // ── Mark Answers In DOM ──────────────────────────────────────────────────────
  function markAnswersInDOM(selection, parsed, letters) {
    document.querySelectorAll("[data-qcm-dot]").forEach(el => el.remove());
    document.querySelectorAll("[data-qcm-highlight]").forEach(el => {
      el.removeAttribute("data-qcm-highlight");
    });

    let markedCount = 0;
    try {
      const range = selection.getRangeAt(0);

      letters.forEach(letter => {
        const idx = letter.charCodeAt(0) - 65;
        const choice = parsed.choices[idx];
        if (!choice) return;

        const el = findElementByText(range, choice.text);
        if (el) {
          markElement(el);
          markedCount++;
        }
      });
    } catch (_) {}

    return markedCount;
  }

  function findElementByText(range, targetText) {
    const target = targetText.toLowerCase().trim();
    const candidates = [];

    let root = range.commonAncestorContainer;
    if (root.nodeType === Node.TEXT_NODE) root = root.parentElement;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      try {
        if (!range.intersectsNode(node)) continue;
      } catch (err) {
        continue;
      }

      if (!isVisible(node)) continue;

      const text = node.innerText?.trim().toLowerCase();
      if (!text || text.length < 2) continue;

      if (text === target || text.includes(target) || target.includes(text)) {
        candidates.push({ el: node, score: scoreMatch(text, target, node) });
      }
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].el;
  }

  function scoreMatch(elText, target, el) {
    let score = 0;
    if (elText === target) score += 100;
    else if (elText.includes(target)) score += 50 + (target.length / elText.length) * 50;
    else score += (elText.length / target.length) * 30;

    score -= elText.length * 0.1;

    if (el.querySelector('input[type="radio"], input[type="checkbox"]')) score += 20;
    if (el.tagName === "LABEL") score += 15;
    if (el.tagName === "LI") score += 10;
    return score;
  }

  function markElement(el) {
    const dot = document.createElement("span");
    dot.setAttribute("data-qcm-dot", "true");
    dot.title = "AI answer";

    const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dotColor = isDarkMode ? "#e4e4e7" : "#18181b";

    Object.assign(dot.style, {
      display: "inline-block",
      width: "5px",
      height: "5px",
      borderRadius: "50%",
      backgroundColor: dotColor,
      marginLeft: "5px",
      verticalAlign: "middle",
      flexShrink: "0",
      position: "relative",
      zIndex: "9999",
      opacity: "0.75"
    });

    el.appendChild(dot);
  }

  // ── Popup Message Communication ──────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "GET_PAGE_STATUS") {
      const questions = scanQuestions();
      const essayQuestions = scanEssayQuestions();
      sendResponse({ count: questions.length + essayQuestions.length });
      return true;
    }
    if (message.type === "SOLVE_PAGE") {
      const questions = scanQuestions();
      solveQuestionsSequentially(questions, false);
      const essayQuestions = scanEssayQuestions();
      solveEssayQuestionsSequentially(essayQuestions);
      sendResponse({ success: true, count: questions.length + essayQuestions.length });
      return true;
    }
  });

})();
