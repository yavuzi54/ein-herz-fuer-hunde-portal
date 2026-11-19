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
  messageToApplicant: ({ name }) => ({
    subject: 'Neue Nachricht vom Vermittlungsteam',
    html: wrap('Sie haben eine neue Nachricht', `
      <p>Hallo ${esc(name)},</p>
      <p>unser Vermittlungsteam hat Ihnen im Vermittlungsportal eine Nachricht geschrieben.</p>
      <p><a href="https://einherzfuerhunde.com/vermittlung/?view=nachrichten" style="display:inline-block;background:${brand.clay};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold;">Nachricht lesen</a></p>
      <p style="font-size:0.85rem;">Bitte melden Sie sich unter „Ich habe Zugang“ an und antworten Sie dort, damit alles an einem Ort bleibt.</p>`)
  }),
  messageToTeam: ({ name, email }) => ({
    subject: `Neue Nachricht von ${name || email}`,
    html: wrap('Neue Nachricht im Portal', `
      <p><b>${esc(name)}</b> (${esc(email)}) hat im Vermittlungsportal eine Nachricht geschrieben.</p>
      <p>Zum Lesen und Antworten: Interner Zugang → Interessenten → ${esc(name)} → Nachrichten.</p>`)
  }),
  accountDeleted: ({ name, mode }) => ({
    subject: 'Ihr Konto wurde gelöscht',
    html: wrap('Ihr Konto wurde gelöscht', `
      <p>Hallo ${esc(name)},</p>
      <p>wie gewünscht haben wir Ihr Konto im Vermittlungsportal gelöscht. Sie können sich nicht mehr anmelden.</p>
      ${mode === 'retained'
        ? '<p>Ihr unterschriebener Schutzvertrag und die dazugehörige Selbstauskunft müssen wir aus rechtlichen Gründen noch aufbewahren. Sie werden nach Ablauf der Aufbewahrungsfrist gelöscht.</p>'
        : '<p>Ihre Selbstauskunft und Ihre Nachrichten wurden gelöscht.</p>'}
      <p>Falls Sie das nicht selbst veranlasst haben, melden Sie sich bitte sofort bei uns.</p>`)
  }),
  accountDeletedTeam: ({ name, email, mode }) => ({
    subject: `Konto gelöscht: ${name || email}`,
    html: wrap('Eine Person hat ihr Konto gelöscht', `
      <p><b>${esc(name)}</b> (${esc(email)}) hat das Konto im Portal (App oder Website) selbst gelöscht.</p>
      <p>${mode === 'retained'
        ? 'Es gibt einen unterschriebenen Schutzvertrag, darum bleiben Vertrag und Selbstauskunft gespeichert (Anmeldung ist gesperrt).'
        : 'Selbstauskunft, Nachrichten und Notizen sind vollständig gelöscht.'}</p>`)
  }),
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

// The store app runs the portal from inside the phone (origin capacitor://localhost on iOS,
// https://localhost on Android) and calls these functions with absolute URLs.
// Only these origins get CORS headers; the website itself is same-origin and needs none.
const APP_ORIGINS = ['capacitor://localhost', 'https://localhost', 'http://localhost'];

export function cors(req, res) {
  const origin = req.headers && req.headers.origin;
  if (origin && APP_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

export function onlyPost(req, res) {
  if (cors(req, res)) return false;   // preflight answered
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return false;
  }
  return true;
}

// ======================================================================
// Supporter area (SQL 16): sign-up, Herzensbrief, Instagram import, feed
// ======================================================================

// Where the confirm/unsubscribe links point (this Vercel project) and where people log in
export const API_ORIGIN = () => process.env.PUBLIC_API_ORIGIN || 'https://ein-herz-fuer-hunde-portal.vercel.app';
export const PORTAL_PAGE = 'https://einherzfuerhunde.com/vermittlung/';

export const isEmail = e => typeof e === 'string' && e.length <= 200 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
export const lang2 = l => (l === 'en' ? 'en' : 'de');
const btn = (href, text) => `<p><a href="${esc(href)}" style="display:inline-block;background:${brand.clay};color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:bold;">${esc(text)}</a></p>`;

// Small photo version made by uploadPhoto() ("…/opt/x.jpg" -> "…/opt/x-t.jpg")
export const thumbOf = u => (/\/opt\/[^/?]+\.jpg$/.test(String(u || '')) ? String(u).replace(/\.jpg$/, '-t.jpg') : u);

// Footer for supporter emails (the portal footer talks about applications)
const wrapSupporter = (title, bodyHtml, lang, unsubscribeUrl) => wrap(title, bodyHtml).replace(
  /Dies ist eine automatische Nachricht unseres Vermittlungsportals\.[^<]*<br>/,
  lang === 'en'
    ? `You get this email because you signed up at Ein Herz für Hunde.${unsubscribeUrl ? ` <a href="${esc(unsubscribeUrl)}" style="color:${brand.soft};">Unsubscribe from the Herzensbrief</a>.` : ''}<br>`
    : `Sie erhalten diese E-Mail, weil Sie sich bei Ein Herz für Hunde angemeldet haben.${unsubscribeUrl ? ` <a href="${esc(unsubscribeUrl)}" style="color:${brand.soft};">Herzensbrief abbestellen</a>.` : ''}<br>`);

export const supporterTemplates = {
  signupConfirm: ({ name, lang, link, newsletter }) => lang === 'en' ? {
    subject: 'Please confirm your email',
    html: wrapSupporter('Welcome to Ein Herz für Hunde!', `
      <p>Hello ${esc(name)},</p>
      <p>thank you for supporting our dogs from Bihać. Please confirm your email address so your account is switched on${newsletter ? ' and the monthly Herzensbrief can reach you' : ''}:</p>
      ${btn(link, 'Confirm email')}
      <p style="font-size:0.85rem;">The link is valid for 7 days. If you did not sign up, simply ignore this email.</p>`, 'en')
  } : {
    subject: 'Bitte bestätigen Sie Ihre E-Mail-Adresse',
    html: wrapSupporter('Willkommen bei Ein Herz für Hunde!', `
      <p>Hallo ${esc(name)},</p>
      <p>danke, dass Sie unsere Hunde aus Bihać unterstützen. Bitte bestätigen Sie Ihre E-Mail-Adresse, damit Ihr Konto aktiv wird${newsletter ? ' und der monatliche Herzensbrief Sie erreicht' : ''}:</p>
      ${btn(link, 'E-Mail bestätigen')}
      <p style="font-size:0.85rem;">Der Link gilt 7 Tage. Falls Sie sich nicht angemeldet haben, ignorieren Sie diese E-Mail einfach.</p>`, 'de')
  },
  signupExists: ({ name, lang }) => lang === 'en' ? {
    subject: 'You already have an account',
    html: wrapSupporter('You already have an account', `
      <p>Hello ${esc(name)},</p>
      <p>someone (probably you) tried to sign up again with this email address. You already have an account, so you can simply log in:</p>
      ${btn(PORTAL_PAGE + '?view=zugang', 'Log in')}
      <p style="font-size:0.85rem;">Forgot your password? Use "Forgot password" on the login page.</p>`, 'en')
  } : {
    subject: 'Sie haben schon ein Konto',
    html: wrapSupporter('Sie haben schon ein Konto', `
      <p>Hallo ${esc(name)},</p>
      <p>mit dieser E-Mail-Adresse wurde gerade erneut eine Anmeldung versucht (wahrscheinlich von Ihnen). Sie haben bereits ein Konto und können sich einfach anmelden:</p>
      ${btn(PORTAL_PAGE + '?view=zugang', 'Anmelden')}
      <p style="font-size:0.85rem;">Passwort vergessen? Auf der Anmeldeseite unter „Passwort vergessen“.</p>`, 'de')
  },
  newsletterConfirm: ({ lang, link }) => lang === 'en' ? {
    subject: 'Please confirm: Herzensbrief',
    html: wrapSupporter('One click and you are in', `
      <p>Hello,</p>
      <p>please confirm that you would like to receive the Herzensbrief: once a month, news from our dogs in Bihać.</p>
      ${btn(link, 'Yes, send me the Herzensbrief')}
      <p style="font-size:0.85rem;">If you did not ask for this, ignore this email and nothing will be sent.</p>`, 'en')
  } : {
    subject: 'Bitte bestätigen: Herzensbrief',
    html: wrapSupporter('Ein Klick, und Sie sind dabei', `
      <p>Hallo,</p>
      <p>bitte bestätigen Sie, dass Sie den Herzensbrief erhalten möchten: einmal im Monat Neuigkeiten von unseren Hunden aus Bihać.</p>
      ${btn(link, 'Ja, Herzensbrief erhalten')}
      <p style="font-size:0.85rem;">Falls Sie das nicht angefordert haben, ignorieren Sie diese E-Mail. Es wird dann nichts verschickt.</p>`, 'de')
  },
  // The monthly letter. Posts are written by the team (German); intro/subject come in both languages.
  herzensbrief: ({ lang, subject, intro, posts, unsubscribeUrl }) => {
    const en = lang === 'en';
    const more = PORTAL_PAGE + '?view=aus-bihac';
    const postHtml = (posts || []).map(p => {
      const photo = (p.photos || [])[0];
      const text = String(p.body || '').length > 600 ? String(p.body).slice(0, 600).replace(/\s+\S*$/, '') + ' …' : String(p.body || '');
      return `<div style="margin:0 0 22px;padding:0 0 18px;border-bottom:1px solid #e6dfd0;">
        ${photo ? `<img src="${esc(thumbOf(photo))}" alt="" width="560" style="width:100%;max-width:560px;border-radius:120px 120px 8px 8px;display:block;margin:0 0 12px;">` : ''}
        ${p.title ? `<div style="font-weight:bold;color:${brand.ink};font-size:1.05rem;margin:0 0 6px;">${esc(p.title)}</div>` : ''}
        <div style="white-space:pre-line;">${esc(text)}</div></div>`;
    }).join('');
    return {
      subject: subject || (en ? 'Herzensbrief from Bihać' : 'Herzensbrief aus Bihać'),
      html: wrapSupporter(esc(subject || 'Herzensbrief'), `
        <p style="white-space:pre-line;">${esc(intro || '')}</p>
        ${postHtml}
        ${btn(more, en ? 'More news from Bihać' : 'Mehr aus Bihać')}`, lang, unsubscribeUrl)
    };
  }
};

// Several emails in one Resend call (max 100). Each item: { to, subject, html, headers }
export async function sendBatch(items) {
  const r = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(items.map(it => ({
      from: process.env.RESEND_NEWSLETTER_FROM || process.env.RESEND_FROM || 'onboarding@resend.dev',
      to: it.to, subject: it.subject, html: it.html, text: toText(it.html),
      reply_to: process.env.RESEND_REPLY_TO || 'info@einherzfuerhunde.com',
      headers: it.headers
    })))
  });
  if (!r.ok) throw new Error(`Resend batch: ${await r.text()}`);
  return true;
}

// A small branded page for links opened from emails (confirm, unsubscribe)
export function page(res, status, { title, text, form, lang }) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.status(status).send(`<!doctype html><html lang="${lang === 'en' ? 'en' : 'de'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;background:${brand.paper};font-family:Georgia,serif;color:${brand.ink};}
.c{max-width:520px;margin:60px auto;background:#FBF8F2;border-radius:12px;padding:32px 26px;}
h1{font-size:1.4rem;margin:0 0 12px;}p{color:${brand.soft};line-height:1.6;}
button,a.b{display:inline-block;background:${brand.clay};color:#fff;border:0;border-radius:6px;padding:12px 20px;font:bold 1rem Georgia,serif;text-decoration:none;cursor:pointer;}</style></head>
<body><div class="c"><div style="font-weight:bold;margin-bottom:18px;">Ein Herz <em>für Hunde</em></div><h1>${esc(title)}</h1><p>${esc(text)}</p>
${form ? `<form method="post" action="${esc(form.action)}">${Object.entries(form.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<button type="submit">${esc(form.button)}</button></form>`
       : `<p><a class="b" href="${PORTAL_PAGE}">${lang === 'en' ? 'To the portal' : 'Zum Portal'}</a></p>`}
</div></body></html>`);
}

// Uploads a file to Supabase Storage with the secret key (server only). Returns the public URL.
export async function storageUpload(bucket, path, body, contentType) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': contentType,
               'Cache-Control': 'max-age=31536000', 'x-upsert': 'true' },
    body
  });
  if (!r.ok) throw new Error(`Storage ${r.status}: ${await r.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
}

// The admin password is checked in the database (check_admin). Throws if wrong.
export async function requireAdmin(password) {
  if (!password) { const e = new Error('Falsches Passwort'); e.status = 401; throw e; }
  try { return await rpc('admin_instagram_status', { p_password: String(password), p_auto_publish: null }); }
  catch (e) { if (/Passwort/.test(e.message)) e.status = 401; throw e; }
}
