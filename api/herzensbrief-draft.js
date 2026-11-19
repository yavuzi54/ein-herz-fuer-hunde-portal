import Anthropic from '@anthropic-ai/sdk';
import { rpc, onlyPost } from './_lib.js';

// Claude writes a DRAFT of the monthly Herzensbrief (subject + intro in DE and EN, which posts to show).
// Material = only that month's published public posts and the real counter numbers (public_impact).
// Nothing is sent here: the team edits the draft in the admin tab and sends it themselves.
// Needs ANTHROPIC_API_KEY in the Vercel env.
export const config = { maxDuration: 60 };

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['subject_de', 'subject_en', 'intro_de', 'intro_en', 'post_ids'],
  properties: {
    subject_de: { type: 'string' }, subject_en: { type: 'string' },
    intro_de: { type: 'string' }, intro_en: { type: 'string' },
    post_ids: { type: 'array', items: { type: 'string' } }
  }
};

const SYSTEM = `You draft the monthly "Herzensbrief" of Ein Herz für Hunde, an Austrian association that rescues street dogs in Bihać (Bosnia) and places them in Austria and Germany. Readers are supporters: Teamer, Paten, adopters and friends.
Write a warm, personal intro (German, formal "Sie", 80 to 140 words) that sums up the month, and the same intro in natural English. Write a short subject line in both languages.
Strict rules:
- Use only facts that appear in the posts or the numbers you are given. Never invent dogs, events, quotes, amounts, dates or numbers.
- Numbers: only the ones in "impact"; leave out any that are 0. Do not mention money, donations amounts or tax.
- If the month has few posts, keep it short rather than filling with general text.
- No long dashes. No emojis in the subject.
- post_ids: pick the posts worth showing in the letter (max 6), most touching first, using the given ids exactly.`;

export default async function handler(req, res) {
  if (!onlyPost(req, res)) return;
  const { adminPassword, month } = req.body || {};
  if (!adminPassword || !month) return res.status(400).json({ error: 'Angaben fehlen' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY fehlt in Vercel', code: 'no_key' });

  let material;
  try { material = await rpc('server_newsletter_material', { p_password: adminPassword, p_month: month }); }
  catch (e) { return res.status(/Passwort/.test(e.message) ? 401 : 500).json({ error: e.message }); }
  if (!material.posts.length) return res.status(400).json({ error: 'Keine veröffentlichten Beiträge in diesem Monat', code: 'no_posts' });

  const input = {
    month: material.month,
    impact: material.impact,
    posts: material.posts.map(p => ({ id: p.id, date: String(p.published_at || '').slice(0, 10), title: p.title || '', text: String(p.body || '').slice(0, 2500), dogs: p.dogs || [] }))
  };
  try {
    const client = handler.client || new Anthropic();
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: `Material for the Herzensbrief (JSON):\n${JSON.stringify(input)}` }]
    });
    if (response.stop_reason === 'refusal') return res.status(502).json({ error: 'Claude hat abgelehnt', code: 'refusal' });
    if (response.stop_reason === 'max_tokens') return res.status(502).json({ error: 'Antwort abgeschnitten', code: 'truncated' });
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const draft = JSON.parse(text);
    const known = new Set(material.posts.map(p => p.id));
    draft.post_ids = (draft.post_ids || []).filter(id => known.has(id)).slice(0, 6);
    if (!draft.post_ids.length) draft.post_ids = material.posts.slice(-6).map(p => p.id);
    return res.status(200).json({ ok: true, draft, posts: material.posts.length, impact: material.impact });
  } catch (e) {
    console.error('herzensbrief-draft', e.status || '', e.message);
    return res.status(502).json({ error: 'Entwurf fehlgeschlagen: ' + e.message, code: 'api' });
  }
}
