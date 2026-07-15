# QCM AI Solver — Browser Extension

Answers QCM/MCQ, open-ended, and code-completion quiz questions using **Groq** or **Lightning AI**, on demand, with keyboard shortcuts. Can read questions from a text selection, scan the page's DOM, take a screenshot and read it with **OpenAI Vision**, or read an image straight from your clipboard. Answers are shown in an on-page panel and copied to your clipboard — nothing is ever auto-filled or clicked on the page for you (except when you explicitly use the Paste shortcut).

Works in Chrome, Brave, and any other Chromium-based browser (Manifest V3).

---

## Installation (Developer Mode)

1. Open your browser → go to `chrome://extensions/` (or `brave://extensions/` in Brave)
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder (`quiz-extension/`)
5. The extension icon appears in your toolbar

---

## Setup

### 1. Answer provider (required) — Groq or Lightning AI

1. Click the extension's toolbar icon to open the popup
2. Use the **Provider** switch to pick **Lightning AI** (default) or **Groq**
3. Get a key:
   - Groq (free tier): [console.groq.com/keys](https://console.groq.com/keys)
   - Lightning AI: [lightning.ai](https://lightning.ai/)
4. Paste your key into the API key field and pick a model
5. Click **Save Settings**

The popup shows a live status badge — green "✓ API key configured" once saved, amber "⚠️ No API key set" if missing.

### 2. Image provider (optional) — OpenAI Vision

Only needed if you want to use **screenshot-based** detection instead of scanning the page's DOM, or if you want to answer questions **pasted as an image** from your clipboard.

1. Get an OpenAI API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. In the popup's **Image Provider** card, flip the **Detection Method** switch to "OpenAI Vision screenshot" if you want it as your default no-selection mode
3. Paste your key, pick a model (`gpt-4o-mini` recommended — fast and cheap), click **Save Image Provider**

Clipboard-image detection (see below) always uses this OpenAI key regardless of the Detection Method switch, since it always needs Vision.

### 3. Enable / disable

The switch at the top of the popup turns the whole extension on or off. When off, all three shortcuts do nothing on any page — useful if you want to temporarily disable it (e.g. during a proctored exam) without uninstalling it.

---

## Usage & Shortcuts

There are three shortcuts. All are remappable any time in `chrome://extensions/shortcuts` (or `brave://extensions/shortcuts`).

### `Ctrl+Shift+X` / `⌘+Shift+X` — Solve

The main shortcut. What it does depends on what's available, checked in this order:

1. **Clipboard has an image** (e.g. you just took a manual OS screenshot — most OSes copy it straight to the clipboard): the image is sent to OpenAI Vision, which reads whatever question(s) are in it; the answer(s) then come from your Groq/Lightning provider. Takes priority over everything else below.
2. **You have text selected**: highlight a question (or several questions at once — a whole exercise block, for example) and press the shortcut. The AI reads the raw selection, figures out how many questions are in it on its own, classifies each one (multiple-choice, open-ended, or code completion), and answers all of them in one pass. You don't need to select cleanly — surrounding UI text/instructions are ignored automatically.
3. **Nothing selected, no clipboard image**: uses whichever **Detection Method** you picked in the popup:
   - **DOM scan** (default): scans the visible page for MCQ and open-ended/essay questions using common quiz-platform markup.
   - **OpenAI Vision screenshot**: takes a screenshot of the visible tab and reads it with OpenAI Vision instead of scanning the DOM — more accurate on unusual layouts, canvas-rendered questions, or code editors, but requires an OpenAI key and costs a Vision API call every time.

Every path recognizes three question types automatically — multiple-choice, open-ended/essay, and **code completion** (e.g. "complete this Python function") — and answers each appropriately (a lettered answer + explanation for MCQ, full prose for essay, runnable code for code completion).

### `Ctrl+Shift+K` / `⌘+Shift+K` — Copy selection

Copies whatever text is currently selected on the page to your clipboard. Plain utility shortcut, not AI-related.

### `Ctrl+Shift+L` / `⌘+Shift+L` — Paste

Pastes your clipboard's text content into whichever input, textarea, or contenteditable field is currently focused on the page. Does nothing if no such field is focused.

### Viewing answers

A thin **"ANSWERS"** tab is always pinned to the right edge of every page. Click it to open/close the results panel. When you press the Solve shortcut:

1. The panel opens automatically and shows a loading state
2. Once the AI responds, each question appears as its own card:
   - MCQ → the correct choice letter(s) + a short explanation
   - Open-ended → the full written answer
   - Code completion → the completed code in a monospace block
3. All results are copied to your clipboard as plain text automatically (with a "Copied to clipboard ✓" confirmation)

Nothing on the page itself is ever filled, clicked, or modified by the Solve/Copy shortcuts — this is a show-only tool. The Paste shortcut is the only one that writes into the page, and only into whatever field you deliberately focused first.

---

## How It Works

| Step | What happens |
|------|-------------|
| 1 | You press `Ctrl+Shift+X` / `⌘+Shift+X` |
| 2 | Content script checks, in order: clipboard image → text selection → page detection method (DOM scan or Vision screenshot) |
| 3 | For a selection, the whole raw text is sent once and the AI segments + classifies + answers it in one request; for clipboard images or page detection, questions are extracted first, then sent together in **one** batched request |
| 4 | Background worker calls the Groq/Lightning API (and OpenAI's Vision endpoint, when used) — this avoids CORS issues from content scripts |
| 5 | The AI returns answers for every question in a single structured response |
| 6 | Results are rendered in the side panel and copied to your clipboard |

---

## Supported Quiz Platforms (DOM scan mode)

- Moodle
- Google Forms
- Any site using `<fieldset>` + radio/checkbox
- Sites with `role="radiogroup"` patterns
- Custom quiz platforms with `.question`, `.qtext` classes
- Open-ended/essay/short-answer fields (`textarea`, `contenteditable`, plain text inputs)
- Code editor / notebook-style exercises (e.g. Jupyter-like cells) — best handled via text selection or OpenAI Vision, since code editors rarely expose clean DOM markup

---

## Panel States

| State | Meaning |
|-------|---------|
| Spinner | Solving — waiting on the AI |
| Green answer badge | MCQ correct choice letter(s) + explanation |
| Plain text card | Full written answer for an open-ended question |
| Monospace code block | Completed code for a code-completion question |
| ⚠️ (amber, in popup) | No API key set |
| ⚠️ (red, in panel) | No API key set, no questions found, or the AI request failed |

---

## Privacy

- Your API keys are stored locally in your browser's extension storage (`chrome.storage.sync`), never sent anywhere except the provider you configured
- Questions/screenshots are only sent to `api.groq.com`, `lightning.ai`, and/or `api.openai.com` (only if you configured OpenAI Vision), and only when you explicitly press a shortcut — nothing runs automatically in the background
- Clipboard access (`clipboardRead`/`clipboardWrite` permissions) is only used at the moment you press a shortcut — the extension never polls or monitors your clipboard passively
- No data is logged or stored externally

---

## Free Tiers

- Groq offers a generous free tier with fast inference: [console.groq.com/keys](https://console.groq.com/keys)
- OpenAI Vision (for screenshot/clipboard-image detection) is billed per your OpenAI account's usual API pricing — check [openai.com/pricing](https://openai.com/pricing) for current rates
