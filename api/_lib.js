// Shared helpers for the server functions. Files starting with "_" are not public endpoints on Vercel.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY; // secret/service_role key, NEVER in index.html

// Calls a Supabase database function with the secret key (server only)
export async function rpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SECRET,
      Authorization: `Bearer ${SUPABASE_SECRET}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!r.ok) {
    const msg = (data && data.message) || text || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return data;
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const brand = { ink: '#24322B', clay: '#A6512E', paper: '#EFE7D8', soft: '#4C5A50' };

const wrap = (title, bodyHtml) => `
  <div style="background:${brand.paper};padding:32px 16px;font-family:Georgia,serif;">
    <div style="max-width:480px;margin:0 auto;background:#FBF8F2;border-radius:10px;padding:32px 28px;">
      <div style="font-size:1.3rem;font-weight:bold;color:${brand.ink};margin-bottom:4px;">Ein Herz <em>für Hunde</em></div>
      <div style="height:1px;background:#ddd6c4;margin:16px 0 24px;"></div>
      <h2 style="color:${brand.ink};font-size:1.2rem;margin:0 0 16px;">${title}</h2>
      <div style="color:${brand.soft};font-size:0.95rem;line-height:1.6;">${bodyHtml}</div>
      <div style="height:1px;background:#ddd6c4;margin:28px 0 16px;"></div>
      <p style="color:${brand.soft};font-size:0.78rem;margin:0;">Ein Herz für Hunde · Dies ist eine automatische Nachricht unseres Vermittlungsportals. Bei Fragen: vermittlung@einherzfuerhunde.com</p>
    </div>
  </div>`;

const credBox = (email, password) => `
  <p style="background:#F1E0BE;padding:12px 16px;border-radius:6px;">
    <b>E-Mail:</b> ${esc(email)}<br>
    <b>Passwort:</b> <span style="font-family:monospace;font-size:1.05rem;">${esc(password)}</span>
  </p>`;

export const templates = {
  approved: ({ name, email, password }) => ({
    subject: 'Ihre Zugangsdaten zum Vermittlungsportal',
    html: wrap('Ihre Selbstauskunft wurde freigegeben!', `
      <p>Hallo ${esc(name)},</p>
      <p>gute Nachrichten: Ihre Selbstauskunft wurde geprüft und freigegeben. Sie können sich jetzt auf unserer Vermittlungsseite unter „Ich habe Zugang“ anmelden:</p>
      ${credBox(email, password)}
      <p>Nach der Anmeldung sehen Sie die Hunde, die zu Ihrer Situation passen.</p>`)
  }),
  reset: ({ name, email, password }) => ({
    subject: 'Ihre neuen Zugangsdaten',
    html: wrap('Neues Passwort angefordert', `
      <p>Hallo ${esc(name)},</p>
      <p>für Ihr Konto wurde ein neues Passwort angefordert. Ihre neuen Zugangsdaten:</p>
      ${credBox(email, password)}
      <p>Falls Sie diese Anfrage nicht gestellt haben, melden Sie sich bitte bei uns.</p>`)
  }),
  contract: ({ name, dogName }) => ({
    subject: `Schutzvertrag für ${dogName || 'Ihren Wunschhund'} freigeschaltet`,
    html: wrap('Ihr Schutzvertrag ist bereit', `
      <p>Hallo ${esc(name)},</p>
      <p>der Schutzvertrag für <b>${esc(dogName || 'Ihren Wunschhund')}</b> wurde für Sie freigeschaltet. Bitte melden Sie sich im Portal an und füllen Sie ihn dort aus, um die Vermittlung verbindlich abzuschließen.</p>`)
  })
};

export async function sendEmail(to, { subject, html }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'onboarding@resend.dev',
      to,
      subject,
      html
    })
  });
  if (!r.ok) throw new Error(`Resend: ${await r.text()}`);
  return true;
}

export function onlyPost(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return false;
  }
  return true;
}
