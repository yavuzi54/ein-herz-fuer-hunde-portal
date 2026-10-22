import { rpc, onlyPost } from './_lib.js';

// Private documents (TRACES, Verträge …) in the private "admin-docs" bucket.
// The browser never gets the secret key: it asks this function for short-lived links.
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
const BUCKET = 'admin-docs';
const MAX_BYTES = 25 * 1024 * 1024;

async function storage(path, method, body) {
  const r = await fetch(`${URL_}/storage/v1${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!r.ok) throw new Error((data && (data.message || data.error)) || `Storage HTTP ${r.status}`);
  return data;
}

const safeName = n => String(n || 'datei')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/g, 'ss')
  .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) || 'datei';

export default async function handler(req, res) {
  if (!onlyPost(req, res)) return;
  const { adminPassword, action, fileName, size, id } = req.body || {};
  if (!adminPassword || !action) return res.status(400).json({ error: 'Missing fields' });
  try {
    const ok = await rpc('check_admin', { p_password: adminPassword });
    if (ok !== true) return res.status(401).json({ error: 'Falsches Passwort' });

    if (action === 'upload-url') {
      if (size && Number(size) > MAX_BYTES) return res.status(400).json({ error: 'Datei zu groß (max. 25 MB)' });
      const path = `docs/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName(fileName)}`;
      const r = await storage(`/object/upload/sign/${BUCKET}/${path}`, 'POST', {});
      const token = new URLSearchParams(String(r.url || '').split('?')[1] || '').get('token');
      if (!token) throw new Error('Kein Upload-Token');
      return res.status(200).json({ path, token });
    }
    if (action === 'download-url') {
      const path = await rpc('admin_document_path', { p_password: adminPassword, p_id: id });
      if (!path) return res.status(404).json({ error: 'Dokument nicht gefunden' });
      const r = await storage(`/object/sign/${BUCKET}/${path}`, 'POST', { expiresIn: 300 });
      return res.status(200).json({ url: `${URL_}/storage/v1${r.signedURL}` });
    }
    if (action === 'delete') {
      const path = await rpc('admin_delete_document', { p_password: adminPassword, p_id: id });
      if (path) { try { await storage(`/object/${BUCKET}`, 'DELETE', { prefixes: [path] }); } catch (_) {} }
      return res.status(200).json({ ok: true });
    }
    if (action === 'discard') { // upload finished but saving the entry failed: remove the file again
      const p = String(req.body.path || '');
      if (/^docs\/[A-Za-z0-9._-]+$/.test(p)) { try { await storage(`/object/${BUCKET}`, 'DELETE', { prefixes: [p] }); } catch (_) {} }
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    const wrongPw = /Falsches Passwort/.test(e.message);
    return res.status(wrongPw ? 401 : 500).json({ error: wrongPw ? 'Falsches Passwort' : e.message });
  }
}
