// Ask Floop conversational brain — server-side Gemini proxy.
// Why server-side: the API key must never ship in the app. The key comes
// from the GEMINI_API_KEY env var (Railway), never hardcoded, never logged.
//
// POST /api/ai/ask  { message, history? } -> { reply }
// - Requires auth (ah middleware) so only logged-in customers can use it.
// - Tiny per-user rate limit to protect the free-tier quota.
// - Short timeout; on any failure the app falls back to its local brain.
const express = require('express');
const { ah } = require('../middleware/auth');

const router = express.Router();

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';

// Per-user rate limit: 20 AI questions per hour (free-tier protection).
const LIMIT_WINDOW_MS = 60 * 60 * 1000;
const LIMIT_MAX = 20;
const usage = new Map(); // userId -> [timestamps]

function rateOk(userId) {
  const now = Date.now();
  const arr = (usage.get(userId) || []).filter(t => now - t < LIMIT_WINDOW_MS);
  if (arr.length >= LIMIT_MAX) return false;
  arr.push(now);
  usage.set(userId, arr);
  return true;
}

const SYSTEM_PROMPT = [
  'You are Ask Floop, the friendly in-app assistant for Mana Nellore, a food delivery app in Nellore, India.',
  'Reply like a warm, concise human chat assistant. Keep replies short (1-3 sentences) unless the user asks for detail.',
  'You can speak English, Telugu, and Tanglish — mirror the user\'s language.',
  'You help with food cravings, orders, delivery, and the app itself.',
  'Never invent dish names, prices, restaurant names, or order details — if asked for specifics you don\'t know, say you\'ll check or suggest asking about the menu.',
  'Never mention you are an AI model; you are Ask Floop.',
].join('\n');

router.post('/ask', ah, async (req, res) => {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(503).json({ error: 'ai_unavailable' });

    const userId = String((req.user && (req.user.id || req.user.phone)) || 'anon');
    if (!rateOk(userId)) return res.status(429).json({ error: 'rate_limited' });

    const message = String(req.body && req.body.message || '').slice(0, 500).trim();
    if (!message) return res.status(400).json({ error: 'empty_message' });

    const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];
    const contents = history
      .filter(h => h && (h.q || h.a))
      .flatMap(h => ([
        ...(h.q ? [{ role: 'user', parts: [{ text: String(h.q).slice(0, 500) }] }] : []),
        ...(h.a ? [{ role: 'model', parts: [{ text: String(h.a).slice(0, 500) }] }] : []),
      ]));
    contents.push({ role: 'user', parts: [{ text: message }] });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let resp;
    try {
      resp = await fetch(GEMINI_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const code = resp.status;
      return res.status(502).json({ error: code === 429 ? 'rate_limited' : 'ai_error' });
    }
    const data = await resp.json();
    const text = data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts.map(p => p.text || '').join('').trim();
    if (!text) return res.status(502).json({ error: 'ai_empty' });
    res.json({ reply: text.slice(0, 1200) });
  } catch (e) {
    res.status(502).json({ error: 'ai_error' });
  }
});

module.exports = router;
