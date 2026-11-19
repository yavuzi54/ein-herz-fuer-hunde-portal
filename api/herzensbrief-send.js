import { rpc, sendEmail, sendBatch, onlyPost, supporterTemplates, isEmail, API_ORIGIN } from './_lib.js';

// Team sends the Herzensbrief of a month (admin password, checked in the database).
//   { adminPassword, month: 'YYYY-MM-DD', letter: { subject_de, subject_en, intro_de, intro_en, post_ids }, testTo? }
// testTo = one preview email (DE + EN) to that address, nothing is marked as sent.
// Otherwise sends in batches of 100 for up to ~40 s and answers { sent, remaining }; the admin page
// calls again while remaining > 0. Who already got it is stored, so nobody gets it twice.
export const config = { maxDuration: 60 };

function mailFor(sub, letter, posts) {
  const lang = sub.lang === 'en' ? 'en' : 'de';
  const unsubscribeUrl = sub.unsubscribe_token ? `${API_ORIGIN()}/api/herzensbrief?unsubscribe=${sub.unsubscribe_token}&lang=${lang}` : null;
  const m = supporterTemplates.herzensbrief({
    lang, posts, unsubscribeUrl,
    subject: (lang === 'en' ? letter.subject_en : letter.subject_de) || letter.subject_de,
    intro: (lang === 'en' ? letter.intro_en : letter.intro_de) || letter.intro_de
  });
  return { to: sub.email, subject: m.subject, html: m.html,
    headers: unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined };
}

export default async function handler(req, res) {
  if (!onlyPost(req, res)) return;
  const { adminPassword, month, letter = {}, testTo } = req.body || {};
  if (!adminPassword || !month) return res.status(400).json({ error: 'Angaben fehlen' });
  if (!String(letter.subject_de || '').trim() || !String(letter.intro_de || '').trim())
    return res.status(400).json({ error: 'Betreff und Einleitung (Deutsch) fehlen', code: 'missing' });
  const saved = {
    subject_de: letter.subject_de, subject_en: letter.subject_en || '', intro_de: letter.intro_de, intro_en: letter.intro_en || '',
    post_ids: Array.isArray(letter.post_ids) ? letter.post_ids.slice(0, 30) : []
  };
  const started = Date.now();
  let sent = 0, remaining = 0;
  try {
    if (testTo) {
      if (!isEmail(String(testTo))) return res.status(400).json({ error: 'Test-Adresse ungültig' });
      const p = await rpc('server_newsletter_prepare', { p_password: adminPassword, p_month: month, p_letter: saved, p_limit: 0 });
      for (const lang of ['de', 'en']) {
        const m = mailFor({ email: testTo, lang }, saved, p.posts);
        await sendEmail(testTo, { subject: '[Test] ' + m.subject, html: m.html });
      }
      return res.status(200).json({ ok: true, test: true, remaining: p.remaining });
    }
    while (Date.now() - started < 40000) {
      const p = await rpc('server_newsletter_prepare', { p_password: adminPassword, p_month: month, p_letter: saved, p_limit: 100 });
      remaining = p.remaining;
      if (!p.recipients.length) break;
      await sendBatch(p.recipients.map(s => mailFor(s, saved, p.posts)));
      remaining = await rpc('server_newsletter_mark_sent', { p_password: adminPassword, p_newsletter: p.newsletter.id, p_subscribers: p.recipients.map(s => s.id) });
      sent += p.recipients.length;
      if (!remaining) break;
      await new Promise(r => setTimeout(r, 600));   // stay under Resend's rate limit
    }
  } catch (e) {
    console.error('herzensbrief-send', e.message);
    return res.status(/Passwort/.test(e.message) ? 401 : 500).json({ error: e.message, sent, remaining });
  }
  return res.status(200).json({ ok: true, sent, remaining });
}
