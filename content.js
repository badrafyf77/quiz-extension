// content.js — QCM Solver
// Scans/solves quizzes automatically or manually, and supports Ctrl/Ctrl+W selection solving.
// Runs completely silently in the background — no toasts or highlight colors.

(function () {
  "use strict";

  let apiKey = "";
  let model = "llama-3.3-70b-versatile";
  let autoMode = false;
  let isScanningAndSolving = false;

  // ── Load settings ────────────────────────────────────────────────────────────
  function loadSettings(callback) {
    chrome.storage.sync.get(["groqApiKey", "groqModel", "autoMode"], (r) => {
      apiKey = r.groqApiKey || "";
      model  = r.groqModel  || "llama-3.3-70b-versatile";
      autoMode = !!r.autoMode;
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
      if (questions.length > 0) {
        solveQuestionsSequentially(questions, true);
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
  document.addEventListener("keydown", async (e) => {
    if (e.key !== "Control" && !(e.ctrlKey && e.key.toLowerCase() === "w")) return;

    e.preventDefault();
    e.stopPropagation();

    if (!apiKey) {
      console.error("QCM AI Solver: API Key is missing.");
      return;
    }

    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();

    if (!selectedText || selectedText.length < 10) {
      return;
    }

    const parsed = parseSelection(selectedText);
    if (!parsed) {
      return;
    }

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

      if (!result.success) {
        console.error("QCM AI Solver: API error", result.error);
        return;
      }

      const { letters } = result.data;
      if (!letters.length) {
        return;
      }

      markAnswersInDOM(selection, parsed, letters);
    } catch (err) {
      console.error("QCM AI Solver: request failed", err);
    }
  }, true);

  // ── Parse Selection Text ─────────────────────────────────────────────────────
  function parseSelection(text) {
    const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 3) return null;

    const labelPattern = /^([A-Za-z][\.\)]\s*|[0-9]+[\.\)]\s*|[-•–]\s+|\[[ xX]?\]\s*|\([ xX*]?\)\s*)/;
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
      sendResponse({ count: questions.length });
      return true;
    }
    if (message.type === "SOLVE_PAGE") {
      const questions = scanQuestions();
      solveQuestionsSequentially(questions, false);
      sendResponse({ success: true, count: questions.length });
      return true;
    }
  });

})();
