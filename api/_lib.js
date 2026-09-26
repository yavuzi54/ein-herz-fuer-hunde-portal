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
    <div style="max-width:640px;margin:0 auto;background:#FBF8F2;border-radius:10px;padding:32px 28px;">
      <div style="font-size:1.3rem;font-weight:bold;color:${brand.ink};margin-bottom:4px;">Ein Herz <em>für Hunde</em></div>
      <div style="height:1px;background:#ddd6c4;margin:16px 0 24px;"></div>
      <h2 style="color:${brand.ink};font-size:1.2rem;margin:0 0 16px;">${title}</h2>
      <div style="color:${brand.soft};font-size:0.95rem;line-height:1.6;">${bodyHtml}</div>
      <div style="height:1px;background:#ddd6c4;margin:28px 0 16px;"></div>
      <p style="color:${brand.soft};font-size:0.78rem;margin:0;line-height:1.5;">Ein Herz für Hunde · Muttendorf 18d, 8143 Dobl-Zwaring, Österreich<br>
      Dies ist eine automatische Nachricht unseres Vermittlungsportals. Bei Fragen antworten Sie einfach auf diese E-Mail oder schreiben an vermittlung@einherzfuerhunde.com.<br>
      <a href="https://einherzfuerhunde.com" style="color:${brand.soft};">einherzfuerhunde.com</a></p>
    </div>
  </div>`;

const credBox = (email, password) => `
  <p style="background:#F1E0BE;padding:12px 16px;border-radius:6px;">
    <b>E-Mail:</b> ${esc(email)}<br>
    <b>Passwort:</b> <span style="font-family:monospace;font-size:1.05rem;">${esc(password)}</span>
  </p>`;

// ---------- Schutzvertrag ----------
export const SHELTER = {
  name: 'Ein Herz für Hunde', street: 'Muttendorf 18d', city: '8143 Dobl-Zwaring',
  web: 'www.einherzfuerhunde.com', email: 'vermittlung@einherzfuerhunde.com',
  bank: 'Volksbank Steiermark', iban: 'AT49 4477 0166 7220 0000', bic: 'VBOEATWWGRA', paypal: 'spende@einherzfuerhunde.com'
};
const MONTHS = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const fmtBirth = v => {
  const m = String(v || '').match(/^(\d{4})-(\d{1,2})/);
  if (m) return `${MONTHS[+m[2] - 1]} ${m[1]}`;
  return String(v || '');
};
const fmtDate = v => {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v || '');
};
const fmtSex = v => v === 'f' ? 'weiblich (Hündin)' : v === 'm' ? 'männlich (Rüde)' : '';
export const money = v => {
  const n = Number(v);
  return isFinite(n) ? '€ ' + n.toFixed(2).replace('.', ',') : '';
};
const bold = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

// The full signed contract as email-safe HTML
export function contractHTML(c) {
  const h = c.holder || {}, d = c.dog || {}, f = c.fees || {};
  const rest = (Number(f.total) || 0) - (Number(f.deposit) || 0);
  const row = (a, b) => `<tr><td style="font-size:13px;padding:4px 10px 4px 0;color:#6b7068;white-space:nowrap;vertical-align:top;">${a}</td><td style="font-size:13px;padding:4px 0;color:#24322B;"><b>${esc(b) || '-'}</b></td></tr>`;
  const signed = new Date(c.signedAt);
  const signedTxt = isNaN(signed) ? '' : signed.toLocaleString('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'long', timeStyle: 'short' });
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:#24322B;">
    <div style="font-size:11px;color:#6b7068;">${SHELTER.name} · ${SHELTER.street} · ${SHELTER.city} · ${SHELTER.web} · ${SHELTER.email}</div>
    <h2 style="text-align:center;letter-spacing:4px;margin:18px 0 2px;font-size:20px;">SCHUTZVERTRAG</h2>
    <div style="text-align:center;color:#6b7068;margin-bottom:18px;">Verbindliche Erklärung zur Übernahme eines Tieres · Fassung ${esc(c.version)}</div>
    <h3 style="font-size:14px;margin:14px 0 6px;">Angaben zum neuen Halter des Tieres</h3>
    <table style="border-collapse:collapse;">
      ${row('Zuname', h.lastName)}${row('Vorname', h.firstName)}${row('PLZ/Ort', h.zipCity)}${row('Straße/Nr.', h.street)}
      ${row('Telefonnummer', h.phone)}${row('E-Mail-Adresse', h.email)}${row('Geburtsdatum', fmtDate(h.birthdate))}
      ${row('Identitätsnachweis', [h.idType, h.idNumber].filter(Boolean).join(', '))}${row('Ausstellende Behörde', h.idAuthority)}${row('Ausgestellt am', fmtDate(h.idDate))}
    </table>
    <h3 style="font-size:14px;margin:18px 0 6px;">Folgendes Tier wird übergeben</h3>
    <table style="border-collapse:collapse;">
      ${row('Tierart', d.species)}${row('Name', d.name)}${row('Rasse', d.breed)}${row('Geburtsdatum', fmtBirth(d.birth))}
      ${row('Geschlecht', fmtSex(d.sex))}${row('Farbzeichnung', d.color)}${row('Kastriert', d.neutered)}${row('Chip-Nummer', d.chip)}
      ${row('Impfungen', d.vaccinations)}${row('Besondere Kennzeichen', d.marks)}
    </table>
    <p style="margin:18px 0 8px;"><b><u>Zwischen dem Verein „Ein Herz für Hunde“ und dem oben genannten neuen Tierhalter wird folgender, rechtsverbindlicher Vertrag zur Übernahme des angeführten Tieres geschlossen:</u></b></p>
    <ol style="padding-left:22px;margin:0;">
      ${(c.clauses || []).map(t => `<li style="margin-bottom:6px;">${bold(t)}</li>`).join('')}
      <li style="margin-bottom:6px;">Der Übernehmer entrichtet eine Schutzgebühr von insgesamt <b>${money(f.total)}</b>.<br>Anzahlung: <b>${money(f.deposit)}</b><br>Restbetrag bei Übergabe: <b>${money(rest)}</b></li>
    </ol>
    <p style="margin:14px 0;">Anzahlung auf das Vereinskonto: ${SHELTER.name}, ${SHELTER.bank}<br>IBAN: <b>${SHELTER.iban}</b> · BIC: ${SHELTER.bic}<br>PayPal: ${SHELTER.paypal}</p>
    <p style="font-size:12px;color:#6b7068;">Unsere Kooperation mit der Tierpension Schandl erlaubt uns nach §31a des österreichischen Tierschutzgesetzes Hunde anzubieten und zu vermitteln.</p>
    <div style="border-top:1px solid #ddd6c4;margin-top:14px;padding-top:10px;">
      Elektronisch unterschrieben von <b>${esc(c.signature)}</b>${c.place ? ` in ${esc(c.place)}` : ''} am ${esc(signedTxt)}
    </div>
  </div>`;
}

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
  contractSigned: ({ name, contract }, forShelter) => {
    const c = contract, d = c.dog || {}, h = c.holder || {};
    const ref = `Anzahlung ${d.name || ''}, ${[h.firstName, h.lastName].filter(Boolean).join(' ')}`;
    const intro = forShelter
      ? `<p><b>${esc(name)}</b> hat soeben den Schutzvertrag für <b>${esc(d.name)}</b> im Portal unterschrieben. Hier die vollständige Kopie für eure Unterlagen.</p>`
      : `<p>Hallo ${esc(name)},</p>
         <p>vielen Dank, Ihr Schutzvertrag für <b>${esc(d.name)}</b> ist bei uns eingegangen. Diese E-Mail ist Ihre Kopie, bitte bewahren Sie sie auf.</p>
         <p><b>Die nächsten Schritte:</b></p>
         <ol style="padding-left:20px;">
           <li>Bitte überweisen Sie die Anzahlung von <b>${money(c.fees && c.fees.deposit)}</b> an:<br>
             ${SHELTER.name}, ${SHELTER.bank}<br>IBAN: <b>${SHELTER.iban}</b> · BIC: ${SHELTER.bic}<br>
             Verwendungszweck: <b>${esc(ref)}</b><br>(oder per PayPal an ${SHELTER.paypal})</li>
           <li>Bitte senden Sie uns eine Kopie Ihres Ausweises: Antworten Sie einfach auf diese E-Mail und hängen Sie ein Foto oder einen Scan an.</li>
           <li>Sobald beides da ist, organisieren wir die Reise von ${esc(d.name)} und melden uns mit dem Abholtermin.</li>
         </ol>`;
    return {
      subject: forShelter ? `Schutzvertrag unterschrieben: ${d.name} / ${name}` : `Ihr Schutzvertrag für ${d.name}`,
      html: wrap(forShelter ? 'Neuer Schutzvertrag' : 'Schutzvertrag erhalten', `${intro}
        <div style="margin-top:22px;padding:18px;background:#fff;border:1px solid #ddd6c4;border-radius:8px;">${contractHTML(c)}</div>`)
    };
  },
  contract: ({ name, dogName }) => ({
    subject: `Schutzvertrag für ${dogName || 'Ihren Wunschhund'} freigeschaltet`,
    html: wrap('Ihr Schutzvertrag ist bereit', `
      <p>Hallo ${esc(name)},</p>
      <p>der Schutzvertrag für <b>${esc(dogName || 'Ihren Wunschhund')}</b> wurde für Sie freigeschaltet. Bitte melden Sie sich im Portal an und füllen Sie ihn dort aus, um die Vermittlung verbindlich abzuschließen.</p>`)
  })
};

// Plain-text copy of the HTML email. Spam filters trust emails that include both.
function toText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h2|div)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(l => l.trim()).join('\n')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export async function sendEmail(to, { subject, html, replyTo }) {
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
      html,
      text: toText(html),
      reply_to: replyTo || process.env.RESEND_REPLY_TO || 'vermittlung@einherzfuerhunde.com'
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
