import { rpc, sendEmail, templates, onlyPost } from './_lib.js';

// Chat message from the team (adminPassword + applicantId) or from an applicant (token).
// Saves it in the database and sends a short "you have a new message" email
// (at most one every 15 minutes per conversation and direction).
export default async function handler(req, res) {
  if (!onlyPost(req, res)) return;
  const { adminPassword, applicantId, token, author, text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Leere Nachricht' });
  if (!token && !(adminPassword && applicantId)) return res.status(400).json({ error: 'Angaben fehlen' });

  let r;
  try {
    r = await rpc('server_add_message', {
      p_admin_password: adminPassword || null, p_applicant: applicantId || null,
      p_token: token || null, p_author: String(author || ''), p_body: String(text)
    });
  } catch (e) {
    const wrongPw = /Falsches Passwort/.test(e.message);
    return res.status(wrongPw ? 401 : 400).json({ error: e.message });
  }

  let emailed = false;
  if (r.notify) {
    try {
      if (r.sender === 'team') await sendEmail(r.email, templates.messageToApplicant(r));
      else await sendEmail(process.env.CONTRACT_COPY_TO || 'vermittlung@einherzfuerhunde.com', { ...templates.messageToTeam(r), replyTo: r.email });
      emailed = true;
    } catch (e) { console.error('message email', e.message); }
  }
  return res.status(200).json({ ok: true, message: r.message, emailed });
}
