// background.js — Service Worker
// Handles Groq API calls (avoids CORS issues from content scripts)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ASK_GROQ") {
    handleGroqRequest(message.payload)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }
});

async function handleGroqRequest({ question, choices, apiKey, model, context }) {
  const choiceLines = choices
    .map((c, i) => `${String.fromCharCode(65 + i)}) ${c.text}`)
    .join("\n");

  const systemPrompt = `You are an elite academic assistant designed to solve multiple-choice questions with perfect accuracy.
First, perform a detailed step-by-step analysis of the question, evaluate each answer choice, and eliminate incorrect options logically. Write out your reasoning fully and clearly.
Second, state the final correct choice(s) using capital letters inside <answer>...</answer> tags.
If there are multiple correct choices, list them separated by commas (e.g., <answer>A,C</answer>).
Under no circumstances should you put anything else inside the <answer> tags.`;

  let contextStr = "";
  if (context && (context.title || context.domain)) {
    contextStr = `Context: This question is part of a quiz on the website "${context.domain || 'unknown'}" titled "${context.title || 'unknown'}".\n\n`;
  }

  const userPrompt = `${contextStr}Question: ${question}

Choices:
${choiceLines}

Let's think step-by-step:`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.1,
      max_tokens: 1200
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? "";

  let explanation = "";
  let letters = [];

  // Extract DeepSeek R1 reasoning/think tags if present
  const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch) {
    explanation = thinkMatch[1].trim();
  }

  // Extract answer tags
  const answerMatch = raw.match(/<answer>([\s\S]*?)<\/answer>/i);
  let answerContent = "";
  if (answerMatch) {
    answerContent = answerMatch[1].trim();
    if (!explanation) {
      explanation = raw.split(/<answer>/i)[0].replace(/<think>[\s\S]*?<\/think>/i, "").replace(/Explanation:/i, "").trim();
    }
  } else {
    answerContent = raw;
    explanation = "Answer provided directly.";
  }

  // Clean HTML tags from explanation
  explanation = explanation.replace(/<[^>]*>/g, "").trim();

  // Parse letters (e.g. "A, C" or "A")
  letters = answerContent
    .toUpperCase()
    .split(/[^A-Z]+/)
    .map(l => l.trim())
    .filter(l => l.length === 1);

  // If parsing failed to find letters in tags, search raw output for letters
  if (letters.length === 0) {
    letters = raw
      .toUpperCase()
      .split(/[,\s]+/)
      .map(l => l.trim())
      .filter(l => /^[A-Z]$/.test(l));
  }

  // Save the latest solved question details to local storage
  chrome.storage.local.set({
    lastQuestion: question,
    lastExplanation: explanation || "No explanation provided.",
    lastAnswers: letters
  });

  return { letters, explanation, raw };
}
