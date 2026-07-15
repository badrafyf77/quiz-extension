# QCM AI Solver — Browser Extension

Shows the answers to QCM/MCQ and open-ended quiz questions using **Groq AI**, on demand, with a single keyboard shortcut. Answers are displayed in an on-page panel and copied to your clipboard — nothing is ever auto-filled or clicked for you.

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

1. Get a free Groq API key at [console.groq.com/keys](https://console.groq.com/keys)
2. Click the extension's toolbar icon to open the popup
3. Paste your key into the **Groq API Key** field (starts with `gsk_...`)
4. Choose a model (LLaMA 3.3 70B recommended for best quality)
5. Click **Save Settings**

The popup shows a live status badge — green "✓ API key configured" once saved, amber "⚠️ No API key set" if missing.

---

## Usage

The extension is passive until you press the shortcut:

**`Ctrl+Shift+X`** (Windows/Linux) or **`⌘+Shift+X`** (Mac)

- **With text selected**: highlight a question and its choices with your mouse first, then press the shortcut — only that selection is sent to the AI.
- **With nothing selected**: press the shortcut anywhere on the page — it scans the whole visible page for MCQ and open-ended/essay questions and sends everything it finds in a single request.

You can remap the shortcut any time in `chrome://extensions/shortcuts` (or `brave://extensions/shortcuts`).

### Viewing answers

A thin **"ANSWERS"** tab is always pinned to the right edge of every page. Click it to open/close the results panel. When you press the shortcut:

1. The panel opens automatically and shows a loading spinner
2. Once the AI responds, each question appears as its own card — the correct choice letter(s) and a short explanation for MCQs, or the full written answer for open-ended questions
3. All results are copied to your clipboard as plain text automatically (with a "Copied to clipboard ✓" confirmation in the panel)

Nothing on the page itself is ever filled, clicked, or modified — this is a show-only tool.

---

## How It Works

| Step | What happens |
|------|-------------|
| 1 | You press `Ctrl+Shift+X` / `⌘+Shift+X` |
| 2 | Content script uses your text selection, or scans the page for MCQ + essay/write-in questions |
| 3 | All detected questions are sent together in **one** request to the background worker |
| 4 | Background worker calls the Groq API once (no CORS issues) |
| 5 | The AI returns answers for every question in a single structured response |
| 6 | Results are rendered in the side panel and copied to your clipboard |

---

## Supported Quiz Platforms

- Moodle
- Google Forms
- Any site using `<fieldset>` + radio/checkbox
- Sites with `role="radiogroup"` patterns
- Custom quiz platforms with `.question`, `.qtext` classes
- Open-ended/essay/short-answer fields (`textarea`, `contenteditable`, plain text inputs)

---

## Panel States

| State | Meaning |
|-------|---------|
| Spinner | Solving — waiting on the Groq API |
| Green answer badge | MCQ correct choice letter(s) + explanation |
| Plain text card | Full written answer for an open-ended question |
| ⚠️ (amber, in popup) | No API key set |
| ⚠️ (red, in panel) | No API key set, no questions found, or the AI request failed |

---

## Privacy

- Your API key is stored locally in your browser's extension storage (never sent anywhere except Groq)
- Questions are only sent to `api.groq.com`, and only when you explicitly press the shortcut — nothing runs automatically in the background
- No data is logged or stored externally

---

## Groq Free Tier

Groq offers a generous free tier with fast inference. Get your key at:
**https://console.groq.com/keys**
