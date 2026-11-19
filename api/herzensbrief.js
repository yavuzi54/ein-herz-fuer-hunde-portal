import { rpc, sendEmail, onlyPost, page, supporterTemplates, isEmail, lang2, API_ORIGIN } from './_lib.js';

// Herzensbrief (monthly newsletter), double opt-in.
//   POST JSON { email, lang, token? }       -> sign up (logged in with a confirmed account: on at once)
//   GET  ?confirm=T | ?unsubscribe=U        -> page with a button
//   POST form confirm=T | unsubscribe=U     -> done
//   POST ?unsubscribe=U (List-Unsubscribe=One-Click from the mail program) -> done
export default async function handler(req, res) {
  const q = req.query || {}, body = req.body || {};
  const en = (q.lang || body.lang) === 'en';
  if (req.method === 'GET' && (q.confirm || q.unsubscribe)) {
    const isConfirm = !!q.confirm;
    return page(res, 200, {
      lang: en ? 'en' : 'de',
      title: isConfirm ? (en ? 'Confirm the Herzensbrief' : 'Herzensbrief bestätigen') : (en ? 'Unsubscribe' : 'Herzensbrief abbestellen'),
      text: isConfirm ? (en ? 'Once a month, news from our dogs in Bihać.' : 'Einmal im Monat Neuigkeiten von unseren Hunden aus Bihać.')
                      : (en ? 'You will not get any more Herzensbriefe. Your email address is deleted from the list.' : 'Sie bekommen dann keinen Herzensbrief mehr. Ihre E-Mail-Adresse wird aus der Liste gelöscht.'),
      form: { action: '/api/herzensbrief', fields: isConfirm ? { confirm: String(q.confirm).slice(0, 100), lang: en ? 'en' : 'de' } : { unsubscribe: String(q.unsubscribe).slice(0, 100), lang: en ? 'en' : 'de' },
              button: isConfirm ? (en ? 'Yes, confirm' : 'Ja, bestätigen') : (en ? 'Unsubscribe' : 'Abbestellen') }
    });
  }
  if (req.method === 'POST' && (body.unsubscribe || q.unsubscribe)) {
    let r = null;
    try { r = await rpc('server_newsletter_unsubscribe', { p_token: String(body.unsubscribe || q.unsubscribe) }); } catch (e) { console.error('unsubscribe', e.message); }
    if (q.unsubscribe && !body.unsubscribe) return res.status(200).json({ ok: true });   // one-click from the mail program
    return page(res, 200, { lang: (r && r.lang) || (en ? 'en' : 'de'), title: en ? 'Unsubscribed' : 'Abbestellt',
      text: en ? 'You will not get any more Herzensbriefe. Thank you for your support!' : 'Sie bekommen keinen Herzensbrief mehr. Danke für Ihre Unterstützung!' });
  }
  if (req.method === 'POST' && body.confirm) {
    let r = null;
    try { r = await rpc('server_newsletter_confirm', { p_token: String(body.confirm) }); } catch (e) { console.error('nl confirm', e.message); }
    if (r && r.ok) return page(res, 200, { lang: r.lang, title: r.lang === 'en' ? 'Thank you!' : 'Danke!',
      text: r.lang === 'en' ? 'The next Herzensbrief comes to you.' : 'Der nächste Herzensbrief kommt zu Ihnen.' });
    return page(res, 400, { lang: en ? 'en' : 'de', title: en ? 'This link no longer works' : 'Dieser Link ist nicht mehr gültig',
      text: en ? 'It may have been used already or be older than 7 days.' : 'Er wurde vielleicht schon benutzt oder ist älter als 7 Tage.' });
  }

  if (!onlyPost(req, res)) return;
  const email = String(body.email || '').trim().toLowerCase();
  const token = String(body.token || '');
  if (String(body.website || '').trim()) return res.status(200).json({ ok: true, mode: 'confirm' });
  if (!token && !isEmail(email)) return res.status(400).json({ error: 'email', code: 'email' });
  try {
    const r = await rpc('server_newsletter_subscribe', { p_email: email, p_lang: lang2(body.lang), p_token: token });
    if (r && r.mode === 'confirm') {
      const link = `${API_ORIGIN()}/api/herzensbrief?confirm=${encodeURIComponent(r.token)}&lang=${r.lang}`;
      await sendEmail(r.email, supporterTemplates.newsletterConfirm({ lang: r.lang, link }));
    }
    // logged in: tell the page it is on; anonymous: always "check your inbox" (no hint whether the email is known)
    return res.status(200).json({ ok: true, mode: token ? (r && r.mode) : 'confirm' });
  } catch (e) {
    console.error('herzensbrief', e.message);
    if (/Sitzung/.test(e.message)) return res.status(401).json({ error: 'expired', code: 'expired' });
    return res.status(400).json({ error: 'failed', code: 'failed' });
  }
}
