export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { type, to, name, email, password, dogName } = req.body || {};

  if (!to || !type) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const brand = {
    ink: '#24322B',
    clay: '#A6512E',
    paper: '#EFE7D8',
    soft: '#4C5A50'
  };

  const wrap = (title, bodyHtml) => `
    <div style="background:${brand.paper};padding:32px 16px;font-family:Georgia,serif;">
      <div style="max-width:480px;margin:0 auto;background:#FBF8F2;border-radius:10px;padding:32px 28px;">
        <div style="font-size:1.3rem;font-weight:bold;color:${brand.ink};margin-bottom:4px;">Ein Herz <em>für Hunde</em></div>
        <div style="height:1px;background:#ddd6c4;margin:16px 0 24px;"></div>
        <h2 style="color:${brand.ink};font-size:1.2rem;margin:0 0 16px;">${title}</h2>
        <div style="color:${brand.soft};font-size:0.95rem;line-height:1.6;">${bodyHtml}</div>
        <div style="height:1px;background:#ddd6c4;margin:28px 0 16px;"></div>
        <p style="color:${brand.soft};font-size:0.78rem;margin:0;">Ein Herz für Hunde e.V. — dies ist eine automatische Nachricht unseres Vermittlungsportals.</p>
      </div>
    </div>`;

  let subject, html;

  if (type === 'approved') {
    subject = 'Ihre Zugangsdaten zum Vermittlungsportal';
    html = wrap('Ihre Selbstauskunft wurde freigegeben!', `
      <p>Hallo ${name || ''},</p>
      <p>gute Nachrichten — Ihre Selbstauskunft wurde geprüft und freigegeben. Sie können sich jetzt auf unserer Vermittlungsseite unter „Ich habe Zugang" mit folgenden Daten anmelden:</p>
      <p style="background:#F1E0BE;padding:12px 16px;border-radius:6px;">
        <b>E-Mail:</b> ${email || to}<br>
        <b>Passwort:</b> ${password || ''}
      </p>
      <p>Nach der Anmeldung sehen Sie die Hunde, die zu Ihrer Situation passen.</p>
    `);
  } else if (type === 'contract') {
    subject = `Schutzvertrag für ${dogName || 'Ihren Wunschhund'} freigeschaltet`;
    html = wrap('Ihr Schutzvertrag ist bereit', `
      <p>Hallo ${name || ''},</p>
      <p>der Schutzvertrag für <b>${dogName || 'Ihren Wunschhund'}</b> wurde für Sie freigeschaltet. Bitte loggen Sie sich im Portal ein und füllen Sie ihn dort aus, um die Vermittlung verbindlich abzuschließen.</p>
    `);
  } else if (type === 'password-reset') {
    subject = 'Ihre neuen Zugangsdaten';
    html = wrap('Neues Passwort angefordert', `
      <p>Hallo,</p>
      <p>für Ihr Konto wurde ein neues Passwort angefordert. Ihre neuen Zugangsdaten:</p>
      <p style="background:#F1E0BE;padding:12px 16px;border-radius:6px;">
        <b>E-Mail:</b> ${email || to}<br>
        <b>Passwort:</b> ${password || ''}
      </p>
      <p>Falls Sie diese Anfrage nicht gestellt haben, ignorieren Sie diese E-Mail einfach.</p>
    `);
  } else {
    return res.status(400).json({ error: 'Unknown email type' });
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'onboarding@resend.dev',
        to,
        subject,
        html
      })
    });
    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ error: errText });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
