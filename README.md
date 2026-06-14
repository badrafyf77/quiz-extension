# QCM AI Solver — Chrome Extension

Silently solves QCM/MCQ quizzes using **Groq AI** and marks correct answers with a **black dot** — no clicking required.

---

## Installation (Developer Mode)

1. Open Chrome → go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder (`quiz-extension/`)
5. The extension icon appears in your toolbar

---

## Setup

1. Click the extension icon
2. Paste your **Groq API key** (free at [console.groq.com/keys](https://console.groq.com/keys))
3. Choose a model (LLaMA 3 70B recommended)
4. Click **Save Settings**

---

## Usage

### Manual Mode (default)
- Navigate to your quiz page
- Click the extension icon → **Solve This Page**
- Black dots appear next to the correct answers

### Auto Mode
- Enable **Auto Mode** in settings
- Every time you load a quiz page, it solves automatically

---

## How It Works

| Step | What happens |
|------|-------------|
| 1 | Content script scans the page for QCM patterns |
| 2 | Each question + choices is sent to the background worker |
| 3 | Background worker calls Groq API (no CORS issues) |
| 4 | AI returns the correct answer letter(s) |
| 5 | A black dot `●` appears next to the correct choice |

---

## Supported Quiz Platforms

- Moodle
- Google Forms
- Any site using `<fieldset>` + radio/checkbox
- Sites with `role="radiogroup"` patterns
- Custom quiz platforms with `.question`, `.qtext` classes

---

## Visual Indicators

| Indicator | Meaning |
|-----------|---------|
| `●` (black dot) | AI-selected correct answer |
| ⏳ | Processing in progress |
| ⚠️ | Error (hover for details) |

---

## Privacy

- Your API key is stored locally in Chrome storage (never sent anywhere except Groq)
- Questions are sent only to `api.groq.com`
- No data is logged or stored externally

---

## Groq Free Tier

Groq offers a generous free tier with fast inference. Get your key at:  
**https://console.groq.com/keys**
