import { rpc, sendEmail, templates, onlyPost } from './_lib.js';

// Applicant signs the Schutzvertrag. The database checks the login, builds the
// contract from its own data and saves it; then both sides get a copy by email.
export default async function handler(req, res) {
  if (!onlyPost(req, res)) return;
  const { token, holder, signature, place } = req.body || {};
  if (!token || !holder || !signature) return res.status(400).json({ error: 'Angaben fehlen' });

  let r;
  try {
    r = await rpc('applicant_submit_contract', {
      p_token: String(token), p_holder: holder, p_signature: String(signature), p_place: String(place || '')
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const shelterCopy = process.env.CONTRACT_COPY_TO || 'vermittlung@einherzfuerhunde.com';
  const results = await Promise.allSettled([
    sendEmail(r.email, templates.contractSigned(r, false)),
    sendEmail(shelterCopy, { ...templates.contractSigned(r, true), replyTo: r.email })
  ]);
  results.forEach(x => { if (x.status === 'rejected') console.error('contract email', x.reason && x.reason.message); });

  return res.status(200).json({ ok: true, contract: r.contract, emailed: results[0].status === 'fulfilled' });
}
