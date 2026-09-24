import { rpc, sendEmail, templates, onlyPost } from './_lib.js';

// Admin approves an application: status + password are set in the database,
// the login details are emailed from here.
export default async function handler(req, res) {
  if (!onlyPost(req, res)) return;
  const { adminPassword, applicantId } = req.body || {};
  if (!adminPassword || !applicantId) return res.status(400).json({ error: 'Missing fields' });

  let r;
  try {
    r = await rpc('server_approve_applicant', { p_admin_password: adminPassword, p_id: applicantId });
  } catch (e) {
    const wrongPw = /Falsches Passwort/.test(e.message);
    return res.status(wrongPw ? 401 : 400).json({ error: wrongPw ? 'Falsches Passwort' : e.message });
  }
  if (!r || r.already) return res.status(200).json({ ok: true, emailed: null });

  try {
    await sendEmail(r.email, templates.approved(r));
    return res.status(200).json({ ok: true, emailed: true });
  } catch (e) {
    console.error('approve email', e.message);
    return res.status(200).json({ ok: true, emailed: false });
  }
}
