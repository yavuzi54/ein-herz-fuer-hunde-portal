import { rpc, cors, requireAdmin, storageUpload } from './_lib.js';

// Hourly import from the Verein's own Instagram (Business or Creator account, "Instagram API
// with Instagram Login"). Every new post, reel and story becomes a DRAFT in "Aus Bihać"
// (published at once only if the team switched auto-publish on). Stories disappear after
// 24 hours, so their photo/video is copied to Supabase Storage right away; Instagram's own
// media links expire too, so everything is copied.
//
// Called by: Supabase pg_cron every hour (Authorization: Bearer CRON_SECRET), or the
// "Jetzt abrufen" button in the admin tab ({ adminPassword }).
// Env: IG_ACCESS_TOKEN (first long-lived token, only needed once; afterwards the job keeps a
// refreshed token in the locked integration_state table), CRON_SECRET.
export const config = { maxDuration: 60 };

const GRAPH = () => process.env.IG_GRAPH_BASE || 'https://graph.instagram.com';
const BUCKET = 'dog-photos';
const MAX_VIDEO_BYTES = 8 * 1024 * 1024;   // bigger reels: poster photo + link to Instagram (keeps Supabase traffic low)
const MAX_PER_RUN = 10;
const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,children{id,media_type,media_url,thumbnail_url}';

async function ig(path, token, params = {}) {
  const u = new URL(GRAPH() + path);
  Object.entries({ ...params, access_token: token }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Instagram ${path}: ${(j.error && j.error.message) || r.status}`);
  return j;
}

async function copy(url, path, maxBytes) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const len = Number(r.headers.get('content-length') || 0);
  if (maxBytes && len > maxBytes) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (maxBytes && buf.length > maxBytes) return null;
  const type = r.headers.get('content-type') || (path.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg');
  return storageUpload(BUCKET, path, buf, type);
}

// one Instagram item -> { photos, video_url }
async function copyMedia(item) {
  const photos = []; let video_url = null;
  const parts = item.media_type === 'CAROUSEL_ALBUM' ? ((item.children && item.children.data) || []).slice(0, 8) : [item];
  let n = 0;
  for (const p of parts) {
    n++;
    if (p.media_type === 'VIDEO') {
      if (!video_url && p.media_url) video_url = await copy(p.media_url, `ig/${item.id}-${n}.mp4`, MAX_VIDEO_BYTES).catch(() => null);
      if (p.thumbnail_url) { const u = await copy(p.thumbnail_url, `ig/${item.id}-${n}.jpg`).catch(() => null); if (u) photos.push(u); }
    } else if (p.media_url) {
      const u = await copy(p.media_url, `ig/${item.id}-${n}.jpg`).catch(() => null);
      if (u) photos.push(u);
    }
  }
  return { photos, video_url };
}

export async function runSync() {
  const state = (await rpc('server_integration_get', { p_key: 'instagram' })) || {};
  let token = state.token || process.env.IG_ACCESS_TOKEN;
  if (!token) return { skipped: 'not_connected' };
  const now = Date.now();
  const patch = {};

  // long-lived tokens last 60 days; refresh once a week (only allowed when the token is > 24 h old)
  const refreshedAt = state.token_refreshed_at ? Date.parse(state.token_refreshed_at) || 0 : 0;
  if (now - refreshedAt > 7 * 864e5) {
    try {
      const t = await ig('/refresh_access_token', token, { grant_type: 'ig_refresh_token' });
      token = t.access_token;
      patch.token = token; patch.token_refreshed_at = new Date(now).toISOString();
      patch.token_expires = new Date(now + (t.expires_in || 5184000) * 1000).toISOString();
    } catch (e) {
      if (!state.token) patch.token = token;   // first run: keep the env token, try refreshing next time
      console.warn('ig refresh', e.message);
    }
  }
  const me = await ig('/me', token, { fields: 'user_id,username' });
  patch.username = me.username; patch.user_id = me.user_id;
  // first run: only the last 30 days, so old posts do not flood the drafts
  const since = (state.since && Date.parse(state.since)) || (now - 30 * 864e5);
  if (!state.since) patch.since = new Date(since).toISOString();

  const items = [];
  const media = await ig('/me/media', token, { fields: MEDIA_FIELDS, limit: '25' });
  (media.data || []).forEach(m => items.push({ ...m, kind: m.media_product_type === 'REELS' ? 'reel' : 'post' }));
  let storiesError = null;
  try {
    const st = await ig(`/${me.user_id}/stories`, token, { fields: 'id,media_type,media_url,thumbnail_url,permalink,timestamp' });
    (st.data || []).forEach(s => items.push({ ...s, kind: 'story' }));
  } catch (e) { storiesError = e.message; }

  const fresh = items.filter(i => i.kind === 'story' || (Date.parse(i.timestamp) || now) >= since);
  const known = new Set(((await rpc('server_ig_known', { p_ids: fresh.map(i => String(i.id)) })) || []).map(String));
  // stories first (they vanish), then oldest posts first
  const todo = fresh.filter(i => !known.has(String(i.id)))
    .sort((a, b) => (a.kind === 'story' ? 0 : 1) - (b.kind === 'story' ? 0 : 1) || Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .slice(0, MAX_PER_RUN);

  let imported = 0;
  for (const item of todo) {
    const { photos, video_url } = await copyMedia(item);
    if (!photos.length && !video_url && !item.caption) continue;
    const id = await rpc('server_ig_save_post', { p_row: {
      external_id: String(item.id), event: item.kind, body: item.caption || '', photos, video_url,
      permalink: item.kind === 'story' ? '' : (item.permalink || ''), taken_at: item.timestamp } });
    if (id) imported++;
  }
  patch.last_sync = new Date().toISOString();
  patch.last_error = storiesError ? `Stories: ${storiesError}` : null;
  await rpc('server_integration_set', { p_key: 'instagram', p_value: patch });
  return { imported, waiting: Math.max(0, fresh.length - known.size - todo.length), stories: !storiesError };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const auth = (req.headers && req.headers.authorization) || '';
  const secret = process.env.CRON_SECRET;
  try {
    if (!(secret && auth === `Bearer ${secret}`)) {
      if (req.method !== 'POST') return res.status(401).json({ error: 'unauthorized' });
      await requireAdmin((req.body || {}).adminPassword);
    }
    const result = await runSync();
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('instagram-sync', e.message);
    if (e.status === 401) return res.status(401).json({ error: 'Falsches Passwort' });
    try { await rpc('server_integration_set', { p_key: 'instagram', p_value: { last_error: e.message.slice(0, 300), last_sync: new Date().toISOString() } }); } catch (_) {}
    return res.status(502).json({ error: e.message });
  }
}
