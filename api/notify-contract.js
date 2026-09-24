import { rpc, sendEmail, templates, onlyPost } from './_lib.js';

// Admin unlocked the contract: look up the applicant server-side and email them.
export default async function handler(req, res) {
  if (!onlyPost(req, res)) return;
  const { adminPassword, applicantId } = req.body || {};
  if (!adminPassword || !applicantId) return res.status(400).json({ error: 'Missing fields' });
  try {
    const r = await rpc('server_contract_info', { p_admin_password: adminPassword, p_id: applicantId });
    if (!r || !r.email) return res.status(404).json({ error: 'Kein freigeschalteter Vertrag' });
    await sendEmail(r.email, templates.contract(r));
    return res.status(200).json({ ok: true });
  } catch (e) {
    const wrongPw = /Falsches Passwort/.test(e.message);
    return res.status(wrongPw ? 401 : 500).json({ error: wrongPw ? 'Falsches Passwort' : 'E-Mail fehlgeschlagen' });
  }
}
