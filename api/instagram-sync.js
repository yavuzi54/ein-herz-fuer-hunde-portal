import Anthropic from '@anthropic-ai/sdk';
import { rpc, cors, requireAdmin, storageUpload } from './_lib.js';

// Hourly import from the Verein's own Instagram (Business or Creator account, "Instagram API
// with Instagram Login"). Every new post, reel and story becomes a DRAFT in "Aus Bihać"
// (published at once only if the team switched auto-publish on). Stories disappear after
// 24 hours, so their photo/video is copied to Supabase Storage right away; Instagram's own
// media links expire too, so everything is copied.
//
// Called by: Supabase pg_cron every hour (Authorization: Bearer CRON_SECRET), or the
// "Jetzt abrufen" button in the admin tab ({ adminPassword }).
// Env: IG_ACCESS_TOKEN, CRON_SECRET. Two kinds of token work:
//  - "Instagram login" token (starts with IG..., apps made before ~Oct 2026): graph.instagram.com,
//    lasts 60 days, the job refreshes it weekly and keeps the new one in integration_state.
//  - "Unified login" system-user token (starts with EAA..., new Meta apps): graph.facebook.com,
//    never expires, no refresh. The Instagram account id is looked up once (or set IG_USER_ID).
// Optional: IG_API = 'instagram' | 'facebook' to force the kind, IG_GRAPH_VERSION (default v26.0).
//
// News stories (needs ANTHROPIC_API_KEY, off with IG_STORIES=off): every imported draft gets a short
// German news text written by Claude from the caption + photos (+ video cover). Each run handles up
// to STORY_PER_RUN drafts that have no title yet, so older imports are filled in over the next runs.
// op=story (admin button "Mit Claude neu schreiben"): the browser sends frames cut from the video,
// Claude rewrites the story; the result goes back into the editor only (the team saves it).
export const config = { maxDuration: 60 };

const isUnified = token => {
  const forced = (process.env.IG_API || '').toLowerCase();
  if (forced) return forced === 'facebook' || forced === 'unified';
  return !String(token).startsWith('IG');
};
let GRAPH_BASE = 'https://graph.instagram.com';
const GRAPH = () => process.env.IG_GRAPH_BASE || GRAPH_BASE;
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

async function viaFacebook(token, state) {
  let id = process.env.IG_USER_ID || (state.api === 'facebook' && state.user_id) || null;
  let lookupError = null;
  if (!id) {
    const a = await ig('/me/assigned_instagram_accounts', token, { fields: 'id,username' }).catch(e => { lookupError = e.message; return null; });
    id = a && a.data && a.data[0] && a.data[0].id;
  }
  if (!id) {
    const p = await ig('/me/accounts', token, { fields: 'instagram_business_account{id,username}' }).catch(() => null);
    const hit = p && (p.data || []).find(x => x.instagram_business_account);
    id = hit && hit.instagram_business_account.id;
  }
  if (!id) throw new Error(lookupError || 'Kein Instagram-Konto für diesen Token gefunden (Konto in der Konfiguration zuweisen oder IG_USER_ID setzen)');
  const u = await ig(`/${id}`, token, { fields: 'id,username' });
  return { user_id: String(u.id || id), username: u.username };
}


// ---------- news stories with Claude ----------
const STORY_MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const STORY_PER_RUN = 4;
const storiesOn = () => !!process.env.ANTHROPIC_API_KEY && (process.env.IG_STORIES || '').toLowerCase() !== 'off';

const STORY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'body', 'dog_ids'],
  properties: { title: { type: 'string' }, body: { type: 'string' }, dog_ids: { type: 'array', items: { type: 'string' } } }
};
const STORY_SYSTEM = `You write short news posts for the website and app of "Ein Herz für Hunde", an Austrian association that rescues street dogs in Bihać (Bosnia) and places them in homes in Austria and Germany. Each post is based on one of the association's own Instagram posts, reels or stories.
You get the original caption (may be empty) and pictures (photos, the video cover, or frames cut from the video in time order). Write in German, in the association's own voice ("wir", talking to supporters with "ihr"), like a short update from the team on the ground:
- title: short, warm and concrete, max 70 characters, no emojis, no hashtags. It says what happened, e.g. "Futter für die Welpen an der Deponie".
- body: tell what happened and why it matters, as a short news update. With a real caption: 40 to 120 words. With an empty or very short caption: only 2 or 3 sentences (20 to 50 words).
Style rules:
- Never describe the picture as a picture. Do not write "Auf dem Bild", "im Video", "zu sehen", "am Bildrand", "in dieser Story/diesem Reel/Beitrag" or similar. Tell it as an event: "Heute haben wir die Welpen an der Deponie gefüttert." not "Auf dem Bild sind Welpen zu sehen."
- No mention of Instagram, stories, reels or posts.
- Do not list visual details (colours, bowls, sacks, boards). Keep only what matters to a supporter.
Strict rules:
- Only facts from the caption or clearly visible in the pictures. Never invent names, ages, diagnoses, numbers, places, dates, amounts or quotes. If unsure, leave it out.
- If the caption asks for help (donations, adoption, sponsors), you may repeat that request, but no bank data and no amounts that are not in the caption.
- No hashtags, no @mentions, no emojis in the title, at most one emoji in the body, no long dashes.
- dog_ids: ids from the given dog list whose name clearly appears in the caption (exact name, any case). Empty if none.`;

async function rest(path, opt = {}) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...opt, headers: {
    apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    'Content-Type': 'application/json', Prefer: 'return=minimal', ...(opt.headers || {}) } });
  if (!r.ok) throw new Error(`db ${path.split('?')[0]}: ${r.status}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

export async function writeStory({ caption, kind, imageUrls = [], frames = [], dogs = [] }) {
  const content = [];
  frames.slice(0, 8).forEach(d => content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(d).replace(/^data:image\/\w+;base64,/, '') } }));
  if (!frames.length) imageUrls.slice(0, 4).forEach(u => content.push({ type: 'image', source: { type: 'url', url: u } }));
  content.push({ type: 'text', text: JSON.stringify({
    kind: kind || 'post', pictures: frames.length ? 'frames from the video, in time order' : 'photos / video cover',
    caption: String(caption || '').slice(0, 2200), dogs: dogs.map(d => ({ id: d.id, name: d.name })) }) });
  const client = writeStory.client || new Anthropic({ timeout: 25000, maxRetries: 0 });
  const response = await client.beta.messages.create({
    model: STORY_MODEL(), max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    system: STORY_SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: STORY_SCHEMA } },
    messages: [{ role: 'user', content }]
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude hat abgelehnt');
  if (response.stop_reason === 'max_tokens') throw new Error('Antwort abgeschnitten');
  const out = JSON.parse(response.content.filter(b => b.type === 'text').map(b => b.text).join(''));
  const known = new Set(dogs.map(d => String(d.id)));
  return {
    title: String(out.title || '').replace(/[\u2013\u2014]/g, '-').slice(0, 200),
    body: String(out.body || '').replace(/[\u2013\u2014]/g, '-').slice(0, 8000),
    dog_ids: [...new Set((out.dog_ids || []).map(String))].filter(id => known.has(id))
  };
}

const loadDogs = () => rest('dogs?select=id,name&order=name.asc', { headers: { Prefer: '' } }).catch(() => []);

// fills drafts that have no title yet (newest first); runs in parallel, never fails the import
async function fillStories(deadline) {
  if (!storiesOn()) return { stories: 0 };
  const todo = await rest(`posts?select=id,event,body,photos&source=eq.instagram&published_at=is.null&title=is.null&order=created_at.desc&limit=${STORY_PER_RUN}`, { headers: { Prefer: '' } }).catch(() => []);
  if (!todo || !todo.length || Date.now() > deadline) return { stories: 0 };
  const dogs = await loadDogs();
  let done = 0; const errors = [];
  await Promise.all(todo.map(async p => {
    try {
      const s = await writeStory({ caption: p.body, kind: p.event, imageUrls: (p.photos || []).filter(u => /^https:\/\//.test(u)), dogs });
      if (!s.title || !s.body) return;
      // keep the original Instagram caption under the story, so the team can compare before publishing
      const body = p.body ? `${s.body}\n\n[Instagram-Text]\n${p.body}`.slice(0, 8000) : s.body;
      await rest(`posts?id=eq.${encodeURIComponent(p.id)}&title=is.null`, { method: 'PATCH', body: JSON.stringify({ title: s.title, body, dog_ids: s.dog_ids }) });
      done++;
    } catch (e) { errors.push(e.message); }
  }));
  return { stories: done, story_error: errors[0] || null };
}

// op=story: admin button, returns a new story for one post (nothing saved here)
async function storyForPost(req, res) {
  const { adminPassword, post_id, frames } = req.body || {};
  await requireAdmin(adminPassword);
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY fehlt in Vercel', code: 'no_key' });
  const rows = await rest(`posts?select=id,event,body,photos&id=eq.${encodeURIComponent(String(post_id || ''))}`, { headers: { Prefer: '' } });
  const p = rows && rows[0];
  if (!p) return res.status(404).json({ error: 'Beitrag nicht gefunden' });
  const caption = String(p.body || '').includes('[Instagram-Text]') ? String(p.body).split('[Instagram-Text]').pop().trim() : p.body;
  const s = await writeStory({ caption, kind: p.event, frames: Array.isArray(frames) ? frames : [],
    imageUrls: (p.photos || []).filter(u => /^https:\/\//.test(u)), dogs: await loadDogs() });
  const body = caption ? `${s.body}\n\n[Instagram-Text]\n${caption}`.slice(0, 8000) : s.body;
  return res.status(200).json({ ok: true, title: s.title, body, dog_ids: s.dog_ids });
}

export async function runSync() {
  const started = Date.now();
  const state = (await rpc('server_integration_get', { p_key: 'instagram' })) || {};
  // tolerate copy/paste leftovers (spaces, line breaks, quotes) around the token
  const envToken = (process.env.IG_ACCESS_TOKEN || '').replace(/\s+/g, '').replace(/^["']|["']$/g, '') || null;
  let unified = envToken ? isUnified(envToken) : false;
  // unified tokens never expire and are never stored; Instagram-login tokens are refreshed and kept
  let token = unified ? envToken : (state.token || envToken);
  if (!token) return { skipped: 'not_connected' };
  GRAPH_BASE = unified ? `https://graph.facebook.com/${process.env.IG_GRAPH_VERSION || 'v26.0'}` : 'https://graph.instagram.com';
  const now = Date.now();
  const patch = {};
  let me;

  // unified (EAA) token: try graph.facebook.com first; if Meta rejects it there, the same token
  // may be an Instagram-login token, so try graph.instagram.com/me before giving up
  let fbError = null;
  if (unified) {
    try { me = await viaFacebook(token, state); patch.api = 'facebook'; patch.token = null; patch.token_expires = null; }
    catch (e) {
      fbError = e.message;
      if (process.env.IG_API) throw e;
      GRAPH_BASE = 'https://graph.instagram.com';
      try { me = await ig('/me', token, { fields: 'user_id,username' }); unified = false; patch.api = 'instagram'; patch.token = null; }
      catch (e2) { throw new Error(`${fbError} | graph.instagram.com: ${e2.message}`); }
    }
  } else {
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
    me = await ig('/me', token, { fields: 'user_id,username' });
    patch.api = 'instagram';
  }
  patch.username = me.username; patch.user_id = me.user_id;
  // first run: only the last 30 days, so old posts do not flood the drafts
  const since = (state.since && Date.parse(state.since)) || (now - 30 * 864e5);
  if (!state.since) patch.since = new Date(since).toISOString();

  const items = [];
  const media = await ig(unified ? `/${me.user_id}/media` : '/me/media', token, { fields: MEDIA_FIELDS, limit: '25' });
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
  // news stories for drafts without a title (this run's imports and older ones), within the time limit
  const st = await fillStories(started + 28000).catch(e => ({ stories: 0, story_error: e.message }));
  patch.last_sync = new Date().toISOString();
  patch.last_error = storiesError ? `Stories: ${storiesError}` : (st.story_error ? `Claude: ${st.story_error}`.slice(0, 300) : null);
  await rpc('server_integration_set', { p_key: 'instagram', p_value: patch });
  return { imported, waiting: Math.max(0, fresh.length - known.size - todo.length), stories: !storiesError, news_written: st.stories };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const auth = (req.headers && req.headers.authorization) || '';
  const secret = process.env.CRON_SECRET;
  try {
    if ((req.query && req.query.op) === 'story' || (req.body && req.body.op) === 'story') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      return await storyForPost(req, res);
    }
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
