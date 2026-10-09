const express = require('express');
const router = express.Router();
const { ah } = require('../middleware/auth');

/* POST /api/ai/ask — Ask Mana AI via Groq/Llama
   Body: { message, context? }
   Returns: { reply }
   Requires GROQ_API_KEY env var on Railway.
*/
router.post(
  '/ask',
  ah(async (req, res) => {
    const { message, context } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message required' });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'AI not configured' });
    }

    const systemPrompt = `You are Mana, a friendly food ordering assistant for Mana Nellore, a food delivery app in Nellore, India. Help users find dishes, place orders, track orders, and answer questions about restaurants. Be concise, warm, and helpful. Understand Telugu, Tanglish, and English. Today's date is ${new Date().toISOString().split('T')[0]}.`;

    const messages = [
      { role: 'system', content: systemPrompt },
    ];
    if (context && Array.isArray(context)) {
      messages.push(...context.slice(-6)); // last 6 messages for context
    }
    messages.push({ role: 'user', content: message.slice(0, 500) });

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages,
        max_tokens: 300,
        temperature: 0.7,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('Groq API error:', resp.status, err.slice(0, 200));
      return res.status(502).json({ error: 'AI temporarily unavailable' });
    }

    const data = await resp.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      return res.status(502).json({ error: 'Empty AI response' });
    }

    res.json({ reply });
  })
);

module.exports = router;
