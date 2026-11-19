import { rpc, sendEmail, onlyPost, cors, page, supporterTemplates, isEmail, lang2, API_ORIGIN } from './_lib.js';

// Supporter sign-up ("Unterstützer werden"): name, email, own password, optional Herzensbrief.
//   POST JSON { name, email, password, lang, newsletter, website }  -> always { ok: true }
//   GET  ?confirm=TOKEN  -> page with a button (email scanners open links, a button they don't press)
//   POST form confirm=TOKEN -> account switched on
export default async function handler(req, res) {
  const q = req.query || {};
  if (req.method === 'GET' && q.confirm) {
    const en = q.lang === 'en';
    return page(res, 200, {
      lang: q.lang, title: en ? 'Confirm your email' : 'E-Mail bestätigen',
      text: en ? 'One last click and your account is ready.' : 'Noch ein Klick, dann ist Ihr Konto bereit.',
      form: { action: '/api/signup', fields: { confirm: String(q.confirm).slice(0, 100), lang: en ? 'en' : 'de' }, button: en ? 'Confirm' : 'Bestätigen' }
    });
  }
  const body = req.body || {};
  if (req.method === 'POST' && body.confirm) {
    const en = body.lang === 'en';
    let r = null;
    try { r = await rpc('server_confirm_email', { p_token: String(body.confirm) }); } catch (e) { console.error('confirm', e.message); }
    if (r && r.ok) {
      return page(res, 200, { lang: r.lang, title: r.lang === 'en' ? 'Thank you, you are in!' : 'Danke, Sie sind dabei!',
        text: r.lang === 'en' ? 'Your account is active. Log in with your email and password to follow dogs and read the news from Bihać.'
                              : 'Ihr Konto ist aktiv. Melden Sie sich mit E-Mail und Passwort an, um Hunden zu folgen und die Neuigkeiten aus Bihać zu lesen.' });
    }
    return page(res, 400, { lang: body.lang, title: en ? 'This link no longer works' : 'Dieser Link ist nicht mehr gültig',
      text: en ? 'It may have been used already or be older than 7 days. Just sign up again or log in.'
               : 'Er wurde vielleicht schon benutzt oder ist älter als 7 Tage. Melden Sie sich einfach neu an oder loggen Sie sich ein.' });
  }

  if (!onlyPost(req, res)) return;
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const lang = lang2(body.lang);
  if (String(body.website || '').trim()) return res.status(200).json({ ok: true });     // bot filled the hidden field
  if (name.length < 2 || !isEmail(email)) return res.status(400).json({ error: 'missing', code: 'missing' });
  if (password.length < 10) return res.status(400).json({ error: 'password', code: 'password' });

  try {
    const r = await rpc('server_supporter_signup', { p_name: name, p_email: email, p_password: password, p_lang: lang, p_newsletter: !!body.newsletter });
    if (r && (r.mode === 'new' || r.mode === 'pending')) {
      const link = `${API_ORIGIN()}/api/signup?confirm=${encodeURIComponent(r.token)}&lang=${r.lang}`;
      await sendEmail(r.email, supporterTemplates.signupConfirm({ name: r.name, lang: r.lang, link, newsletter: r.newsletter }));
    } else if (r && r.mode === 'exists') {
      await sendEmail(r.email, supporterTemplates.signupExists({ name: r.name, lang: r.lang }));
    }
  } catch (e) {
    console.error('signup', e.message);
    if (/später/.test(e.message)) return res.status(429).json({ error: 'busy', code: 'busy' });
  }
  // Same answer whether the email is new or known, so nobody can test which emails have an account
  return res.status(200).json({ ok: true });
}
