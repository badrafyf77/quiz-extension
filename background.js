// background.js — Service Worker
// Handles Groq / Lightning AI chat completions calls (avoids CORS issues from content scripts)

// ── Keyboard Shortcut Commands ────────────────────────────────────────────────
// Registered via manifest.json "commands":
//  - "solve-page" (Ctrl/Cmd+Shift+X): extracts the selection/page and runs the
//    batched solve flow.
//  - "copy-selection" (Ctrl/Cmd+Shift+K): copies the current page selection
//    to the clipboard.
//  - "paste-clipboard" (Ctrl/Cmd+Shift+L): pastes clipboard content into the
//    currently focused input/textarea/contenteditable field.
// All three simply relay a message to the active tab's content script, which
// does the actual work in the page context.
const COMMAND_MESSAGE_TYPES = {
  "solve-page": "TRIGGER_SOLVE",
  "copy-selection": "TRIGGER_COPY_SELECTION",
  "paste-clipboard": "TRIGGER_PASTE_CLIPBOARD"
};

chrome.commands.onCommand.addListener((command, tab) => {
  const messageType = COMMAND_MESSAGE_TYPES[command];
  if (!messageType) return;
  if (!tab?.id) return;
  console.log(`[QCM Solver] "${command}" command triggered — active tab id: ${tab.id}, url: ${tab.url}`);
  chrome.tabs.sendMessage(tab.id, { type: messageType }, () => {
    if (chrome.runtime.lastError) {
      console.warn(`[QCM Solver] could not reach content script on this tab: ${chrome.runtime.lastError.message}`);
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ASK_GROQ_BATCH") {
    handleGroqBatchRequest(message.payload)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }

  if (message.type === "ASK_GROQ_RAW_SEGMENT") {
    handleGroqRawSegmentRequest(message.payload)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "CAPTURE_SCREENSHOT") {
    handleCaptureScreenshot(sender.tab?.id)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "ASK_OPENAI_VISION") {
    handleOpenAIVisionRequest(message.payload)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ── Screenshot Capture ───────────────────────────────────────────────────────
// Must run in the background service worker — content scripts cannot call
// chrome.tabs.captureVisibleTab. Captures only the visible viewport (not the
// full scrollable page) of the tab that dispatched the request.
async function handleCaptureScreenshot(tabId) {
  const windowId = tabId
    ? (await chrome.tabs.get(tabId)).windowId
    : chrome.windows.WINDOW_ID_CURRENT;

  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  if (!dataUrl) {
    throw new Error("Screenshot capture returned no data.");
  }
  return { dataUrl };
}

// ── OpenAI Vision Transcription ──────────────────────────────────────────────
// Sends the screenshot to an OpenAI vision-capable chat completions model and
// asks it to transcribe exactly what quiz question(s) and choices are visible,
// in the same structured shape the batch-answer flow expects. This step only
// TRANSCRIBES — the actual answering still happens via Groq/Lightning.
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

const VISION_SYSTEM_PROMPT = `You are a precise vision transcription tool. You will be shown a screenshot of a webpage that contains one or more quiz/exam questions.

Your ONLY job is to transcribe exactly what is visible — do NOT answer or solve anything yourself.

For each question you can see, output it using this exact format, with no extra commentary before, between, or after:

For a multiple-choice question:
<question type="mcq">
<text>Full question text exactly as shown.</text>
<choice>Choice A text</choice>
<choice>Choice B text</choice>
...
</question>

For an open-ended / essay / short-answer question (no lettered choices):
<question type="essay">
<text>Full question text exactly as shown.</text>
</question>

For a code completion / programming question (e.g. "complete this function", a Python/code editor snippet, a partially written function to finish):
<question type="code">
<text>Full prompt/instructions plus the exact starter code shown, preserving original indentation and line breaks character-for-character.</text>
</question>

Include every distinct question visible in the screenshot, in the order they appear top to bottom. If NO question is visible in the screenshot, output exactly: NONE_FOUND
Do not guess, invent, or answer — transcribe only.`;

async function handleOpenAIVisionRequest({ dataUrl, apiKey, model }) {
  if (!dataUrl) throw new Error("No screenshot provided.");
  if (!apiKey) throw new Error("No OpenAI API key configured.");

  const resolvedModel = model || "gpt-4o-mini";

  const response = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: resolvedModel,
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe the quiz question(s) — including any code completion / programming questions — visible in this screenshot." },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } }
          ]
        }
      ],
      ...temperatureParamFor(resolvedModel, 0),
      ...tokenParamFor(resolvedModel, 2000)
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI Vision API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? "";

  const questions = parseVisionTranscription(raw);
  return { questions, raw };
}

// Parses <question type="mcq|essay|code">...</question> blocks from the vision
// model's transcription into the same { type, questionText, choices } shape
// used by the existing batch-answer flow.
function parseVisionTranscription(raw) {
  if (!raw || /^\s*NONE_FOUND\s*$/i.test(raw.trim())) return [];

  const questionBlocks = raw.match(/<question[^>]*>[\s\S]*?<\/question>/gi) || [];

  return questionBlocks.map(block => {
    const typeMatch = block.match(/<question\s+type="(mcq|essay|code)"/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : "essay";

    const textMatch = block.match(/<text>([\s\S]*?)<\/text>/i);
    const questionText = textMatch ? textMatch[1].trim() : "";

    if (!questionText) return null;

    if (type === "code") {
      return { type: "code", questionText };
    }

    if (type === "essay") {
      return { type: "essay", questionText };
    }

    const choiceMatches = [...block.matchAll(/<choice>([\s\S]*?)<\/choice>/gi)];
    const choices = choiceMatches.map(m => ({ text: m[1].trim() })).filter(c => c.text);

    if (choices.length < 2) {
      return { type: "essay", questionText };
    }

    return { type: "mcq", questionText, choices };
  }).filter(Boolean);
}

// ── Provider Endpoints ────────────────────────────────────────────────────────
const PROVIDER_ENDPOINTS = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  lightning: "https://lightning.ai/api/v1/chat/completions"
};

// Newer OpenAI-family models (GPT-5.x and reasoning models such as the o-series)
// have two beta restrictions confirmed against the live Lightning AI API:
//  1. They reject the legacy "max_tokens" param and require
//     "max_completion_tokens" instead (this produced the original Lightning
//     AI 500 "MaxTokens" error when GPT 5.5/5.6 were selected).
//  2. They reject a custom "temperature" (and top_p/n/presence_penalty/
//     frequency_penalty) — these are fixed at their default and sending a
//     custom value returns a 500 "beta-limitations" error. temperature must
//     simply be omitted from the request body for these models.
// Older models (GPT-4, GPT-4 Turbo, Claude, Llama/Groq, etc.) still expect
// "max_tokens" and accept a custom "temperature" normally. Detect by model ID
// rather than a provider-wide switch, since Lightning AI routes to multiple
// underlying model families.
function isBetaLimitedModel(model) {
  return /gpt-5|^o[1-9]/i.test(model || "");
}

function tokenParamFor(model, budget) {
  return isBetaLimitedModel(model)
    ? { max_completion_tokens: budget }
    : { max_tokens: budget };
}

function temperatureParamFor(model, value) {
  return isBetaLimitedModel(model) ? {} : { temperature: value };
}

// ── Batched Multi-Question Request ───────────────────────────────────────────
// Sends ALL detected questions (MCQ + essay/open-ended + code completion) in a
// single request to the selected provider (Groq or Lightning AI — both
// OpenAI-compatible chat completions APIs). Each question is numbered; the
// model is instructed to answer each one inside its own <qN>...</qN> wrapper
// so results can be parsed back to the original question order. `questions`
// is an array of:
//   { type: "mcq", questionText, choices: [{ text }, ...] }
//   { type: "essay", questionText }
//   { type: "code", questionText }
async function handleGroqBatchRequest({ questions, provider, apiKey, model, context }) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("No questions provided.");
  }

  const resolvedProvider = provider === "groq" ? "groq" : "lightning";
  const endpoint = PROVIDER_ENDPOINTS[resolvedProvider];
  const defaultModel = resolvedProvider === "groq" ? "llama-3.3-70b-versatile" : "openai/gpt-5.6-sol";
  const resolvedModel = model || defaultModel;

  const prompt = buildBatchPrompt(questions, context);

  const tokenBudget = 400 * questions.length + 600;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: resolvedModel,
      messages: [
        { role: "system", content: BATCH_SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ],
      ...temperatureParamFor(resolvedModel, 0.1),
      ...tokenParamFor(resolvedModel, tokenBudget)
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${resolvedProvider === "groq" ? "Groq" : "Lightning AI"} API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? "";

  const results = parseBatchResponse(raw, questions);

  // Save a lightweight snapshot of the latest batch for popup/debugging purposes.
  chrome.storage.local.set({
    lastBatchQuestionCount: questions.length,
    lastBatchRaw: raw
  });

  return { results, raw };
}

// ── Raw Selection Segmentation ────────────────────────────────────────────────
// Used when the user selects a block of text that may contain an unknown
// number of questions (client-side heuristics for splitting/counting proved
// unreliable against real-world copy-pasted platform text — blank lines from
// UI chrome like "Insérer" / "Shift+Enter pour exécuter" caused a 5-question
// selection to be split into ~17 fragments). Instead, the raw text is sent
// as-is and the model itself decides how many questions it contains, what
// type each is, and answers all of them — self-numbering its own <qN> blocks
// with an explicit type attribute so parsing doesn't require knowing the
// count or types ahead of time.
async function handleGroqRawSegmentRequest({ text, provider, apiKey, model, context }) {
  if (!text || !text.trim()) {
    throw new Error("No text provided.");
  }

  const resolvedProvider = provider === "groq" ? "groq" : "lightning";
  const endpoint = PROVIDER_ENDPOINTS[resolvedProvider];
  const defaultModel = resolvedProvider === "groq" ? "llama-3.3-70b-versatile" : "openai/gpt-5.6-sol";
  const resolvedModel = model || defaultModel;

  let contextStr = "";
  if (context && (context.title || context.domain)) {
    contextStr = `Context: This text was selected on the website "${context.domain || "unknown"}" titled "${context.title || "unknown"}".\n\n`;
  }
  const prompt = `${contextStr}${text.trim()}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: resolvedModel,
      messages: [
        { role: "system", content: RAW_SEGMENT_SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ],
      ...temperatureParamFor(resolvedModel, 0.1),
      ...tokenParamFor(resolvedModel, 6000)
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${resolvedProvider === "groq" ? "Groq" : "Lightning AI"} API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? "";

  const results = parseRawSegmentResponse(raw);

  chrome.storage.local.set({
    lastBatchQuestionCount: results.length,
    lastBatchRaw: raw
  });

  return { results, raw };
}

const RAW_SEGMENT_SYSTEM_PROMPT = `You are an elite academic assistant. You will be given a raw block of text selected from a webpage. It may contain ONE or SEVERAL distinct questions, possibly mixed with unrelated UI text (e.g. "Insert", "Shift+Enter to run", instructions, exercise titles) that you must ignore.

Your job, in one pass:
1. Identify every distinct question in the text (ignore stray UI chrome/navigation text that is not part of any question).
2. Classify each one as exactly one of:
   - "mcq": multiple-choice, with lettered choices (A, B, C, ...).
   - "essay": open-ended / short-answer / free response, no choices.
   - "code": a code completion / programming exercise (e.g. Python) asking you to write or complete code — including cases with instructions plus a starter code snippet to finish.
3. Answer every question you identified, fully and correctly.

Respond using ONLY numbered wrapper blocks, one per question you identified, in the order they appear in the text, with no extra commentary before, between, or after them. You decide how many <qN> blocks to output — do not force a fixed count.

For a multiple-choice question:
<qN type="mcq">
<text>Short restatement of the question (1 sentence, for display purposes).</text>
<choice>Choice A text</choice>
<choice>Choice B text</choice>
...
<answer>LETTER(S)</answer>
<explanation>Brief reasoning (1-3 sentences).</explanation>
</qN>
If multiple choices are correct, separate letters with commas, e.g. <answer>A,C</answer>. Under no circumstances put anything except capital letters and commas inside <answer> tags.

For an open-ended / essay question:
<qN type="essay">
<text>Short restatement of the question (1 sentence, for display purposes).</text>
<essay>Full written answer text, ready to read as-is, in the same language as the question.</essay>
</qN>

For a code completion / programming question:
<qN type="code">
<text>Short restatement of the question (1 sentence, for display purposes).</text>
<code>Complete, runnable code only — no prose, no explanation, no markdown code fences. Preserve correct indentation and syntax exactly as valid source code.</code>
</qN>

If the text contains NO identifiable question at all, respond with exactly: NONE_FOUND
Number the blocks q1, q2, q3, ... in order. Respond with ONLY the <qN>...</qN> blocks (or NONE_FOUND), nothing else.`;

// Parses an unknown number of <qN type="mcq|essay|code">...</qN> blocks from
// a raw-segmentation response. Unlike parseBatchResponse, this does not know
// the expected count or types ahead of time — both come from the model, which
// also restates each question's text (and MCQ choices) since the client never
// pre-extracted them from the raw selection.
function parseRawSegmentResponse(raw) {
  if (!raw || /^\s*NONE_FOUND\s*$/i.test(raw.trim())) return [];

  const blockPattern = /<q(\d+)\s+type="(mcq|essay|code)"\s*>([\s\S]*?)<\/q\d+>/gi;
  const results = [];
  let match;

  while ((match = blockPattern.exec(raw)) !== null) {
    const [, , typeRaw, inner] = match;
    const type = typeRaw.toLowerCase();

    const textMatch = inner.match(/<text>([\s\S]*?)<\/text>/i);
    const questionText = textMatch ? textMatch[1].trim() : "";

    if (type === "essay") {
      const essayMatch = inner.match(/<essay>([\s\S]*?)<\/essay>/i);
      const answer = essayMatch ? essayMatch[1].trim() : inner.replace(/<[^>]*>/g, "").trim();
      if (answer) results.push({ type: "essay", questionText, answer });
      continue;
    }

    if (type === "code") {
      const codeMatch = inner.match(/<code>([\s\S]*?)<\/code>/i);
      let answer = codeMatch ? codeMatch[1].trim() : inner.replace(/<[^>]*>/g, "").trim();
      answer = answer.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
      if (answer) results.push({ type: "code", questionText, answer });
      continue;
    }

    // mcq
    const choiceMatches = [...inner.matchAll(/<choice>([\s\S]*?)<\/choice>/gi)];
    const choices = choiceMatches.map(m => ({ text: m[1].trim() })).filter(c => c.text);

    const answerMatch = inner.match(/<answer>([\s\S]*?)<\/answer>/i);
    const explanationMatch = inner.match(/<explanation>([\s\S]*?)<\/explanation>/i);
    const letters = (answerMatch ? answerMatch[1] : inner)
      .toUpperCase()
      .split(/[^A-Z]+/)
      .map(l => l.trim())
      .filter(l => l.length === 1);

    if (letters.length > 0) {
      results.push({
        type: "mcq",
        questionText,
        choices,
        letters,
        explanation: explanationMatch ? explanationMatch[1].replace(/<[^>]*>/g, "").trim() : ""
      });
    }
  }

  return results;
}

const BATCH_SYSTEM_PROMPT = `You are an elite academic assistant that solves multiple quiz questions in a single pass with perfect accuracy.

You will be given a numbered list of questions. Each question is one of:
- A multiple-choice question with lettered choices (A, B, C, ...).
- An open-ended / essay / short-answer question with no choices (marked "[open-ended]").
- A code completion / programming question, usually Python, asking you to write or complete code (marked "[code]").

For EACH question, respond using this exact wrapper format, in the same order as given, with no extra text before, between, or after the wrappers:

For a multiple-choice question N:
<qN><answer>LETTER(S)</answer><explanation>Brief reasoning (1-3 sentences).</explanation></qN>

If multiple choices are correct, separate letters with commas, e.g. <answer>A,C</answer>.
Under no circumstances put anything except capital letters and commas inside <answer> tags.

For an open-ended / essay question N:
<qN><essay>Full written answer text, ready to read as-is, in the same language as the question.</essay></qN>

For a code completion / programming question N:
<qN><code>Complete, runnable code only — no prose, no explanation, no markdown code fences. Preserve correct indentation and syntax exactly as valid source code.</code></qN>

Respond with ONLY the <qN>...</qN> blocks, one per question, nothing else.`;

function buildBatchPrompt(questions, context) {
  let contextStr = "";
  if (context && (context.title || context.domain)) {
    contextStr = `Context: These questions are part of a quiz on the website "${context.domain || "unknown"}" titled "${context.title || "unknown"}".\n\n`;
  }

  const blocks = questions.map((q, i) => {
    const n = i + 1;
    if (q.type === "code") {
      return `Question ${n} [code]: ${q.questionText}`;
    }
    if (q.type === "essay" || !q.choices || q.choices.length === 0) {
      return `Question ${n} [open-ended]: ${q.questionText}`;
    }
    const choiceLines = q.choices
      .map((c, ci) => `${String.fromCharCode(65 + ci)}) ${c.text}`)
      .join("\n");
    return `Question ${n}: ${q.questionText}\nChoices:\n${choiceLines}`;
  });

  return `${contextStr}${blocks.join("\n\n")}`;
}

// Parses a raw response containing <q1>...</q1><q2>...</q2>... blocks back
// into an ordered array of result objects matching the input `questions` order.
// Tolerant of missing/malformed tags for individual questions — those entries
// come back with an `error` field rather than throwing for the whole batch.
function parseBatchResponse(raw, questions) {
  return questions.map((q, i) => {
    const n = i + 1;
    const blockMatch = raw.match(new RegExp(`<q${n}>([\\s\\S]*?)<\\/q${n}>`, "i"));

    if (!blockMatch) {
      return {
        questionText: q.questionText,
        type: q.type,
        error: "No answer returned for this question."
      };
    }

    const block = blockMatch[1];

    if (q.type === "code") {
      const codeMatch = block.match(/<code>([\s\S]*?)<\/code>/i);
      let answer = codeMatch ? codeMatch[1].trim() : block.replace(/<[^>]*>/g, "").trim();
      // Strip stray markdown fences if the model added them despite instructions.
      answer = answer.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
      if (!answer) {
        return { questionText: q.questionText, type: "code", error: "Empty answer returned." };
      }
      return { questionText: q.questionText, type: "code", answer };
    }

    if (q.type === "essay") {
      const essayMatch = block.match(/<essay>([\s\S]*?)<\/essay>/i);
      const answer = essayMatch ? essayMatch[1].trim() : block.replace(/<[^>]*>/g, "").trim();
      if (!answer) {
        return { questionText: q.questionText, type: "essay", error: "Empty answer returned." };
      }
      return { questionText: q.questionText, type: "essay", answer };
    }

    // MCQ
    const answerMatch = block.match(/<answer>([\s\S]*?)<\/answer>/i);
    const explanationMatch = block.match(/<explanation>([\s\S]*?)<\/explanation>/i);

    const letters = (answerMatch ? answerMatch[1] : block)
      .toUpperCase()
      .split(/[^A-Z]+/)
      .map(l => l.trim())
      .filter(l => l.length === 1);

    if (letters.length === 0) {
      return { questionText: q.questionText, type: "mcq", choices: q.choices, error: "No parseable answer letters returned." };
    }

    return {
      questionText: q.questionText,
      type: "mcq",
      choices: q.choices,
      letters,
      explanation: explanationMatch ? explanationMatch[1].replace(/<[^>]*>/g, "").trim() : ""
    };
  });
}

