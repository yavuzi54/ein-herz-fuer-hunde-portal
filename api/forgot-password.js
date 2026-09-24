import { rpc, sendEmail, templates, onlyPost } from './_lib.js';

// The browser only sends an email address. The new password is created in the
// database and emailed from here; the browser never sees it.
export default async function handler(req, res) {
  if (!onlyPost(req, res)) return;
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (email && email.length < 200 && email.includes('@')) {
    try {
      const r = await rpc('server_reset_password', { p_email: email });
      if (r && r.password) await sendEmail(r.email, templates.reset(r));
    } catch (e) {
      console.error('forgot-password', e.message);
    }
  }
  // Always the same answer, so nobody can find out which emails have an account
  return res.status(200).json({ ok: true });
}
