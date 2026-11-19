import { rpc, sendEmail, templates, onlyPost } from './_lib.js';

// "Konto löschen" in the applicant area (required by the App Store and Google Play).
// The person confirms with their password. Without a signed contract everything is
// deleted; with one, the login is removed and the contract is kept (retention period).
export default async function handler(req, res) {
  if (!onlyPost(req, res)) return;
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Angaben fehlen' });

  let r;
  try {
    r = await rpc('server_delete_account', { p_token: String(token), p_password: String(password) });
  } catch (e) {
    const wrongPw = /Passwort ist falsch/.test(e.message);
    const expired = /Sitzung abgelaufen/.test(e.message);
    return res.status(wrongPw || expired ? 401 : 400).json({ error: e.message, code: wrongPw ? 'wrong_password' : expired ? 'expired' : 'error' });
  }

  // Emails are a courtesy: the deletion already happened, so failures only get logged
  try { await sendEmail(r.email, templates.accountDeleted(r)); } catch (e) { console.error('delete mail', e.message); }
  try {
    await sendEmail(process.env.CONTRACT_COPY_TO || 'vermittlung@einherzfuerhunde.com', templates.accountDeletedTeam(r));
  } catch (e) { console.error('delete team mail', e.message); }

  return res.status(200).json({ ok: true, mode: r.mode });
}
