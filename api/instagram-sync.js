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
// Speech (optional): Claude cannot hear, so the audio of each video is first turned into text by Whisper,
// then Claude writes the news post from what is said. GROQ_API_KEY = Groq (free plan, whisper-large-v3-turbo),
// or OPENAI_API_KEY = OpenAI (gpt-4o-mini-transcribe). TRANSCRIBE_MODEL overrides the model. The transcript is kept in the draft under [Transkript] (cut off on publish).
// op=story (admin button "Video ansehen und neu schreiben"): the browser sends frames cut from the video,
// the server transcribes the audio, Claude rewrites the story; the result goes back into the editor only.
export const config = { maxDuration: 60 };

const isUnified = token => {
  const forced = (process.env.IG_API || '').toLowerCase();
  if (forced) return forced === 'facebook' || forced === 'unified';
  return !String(token).startsWith('IG');
};
let GRAPH_BASE = 'https://graph.instagram.com';
const GRAPH = () => process.env.IG_GRAPH_BASE || GRAPH_BASE;
const BUCKET = 'dog-photos', VIDEO_BUCKETS = ['instagram-videos', 'dog-photos'];   // instagram-videos: SQL 17, MP4 up to 50 MB
const MAX_VIDEO_BYTES = 45 * 1024 * 1024;  // bigger reels: poster photo + link to Instagram. Videos play only on tap (preload=none)
const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;  // Groq free plan / OpenAI upload limit
const VIDEO_BACKFILL_PER_RUN = 2;
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

// problems with videos in this run, shown in the admin box (a video that silently becomes a picture is hard to debug)
let videoProblems = [];
const videoProblem = msg => { if (videoProblems.length < 3) videoProblems.push(msg); };

async function copy(url, path, maxBytes) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const len = Number(r.headers.get('content-length') || 0);
  const isVideo = path.endsWith('.mp4');
  if (maxBytes && len > maxBytes) { if (isVideo) videoProblem(`zu groß (${Math.round(len / 1048576)} MB)`); return null; }
  const buf = Buffer.from(await r.arrayBuffer());
  if (maxBytes && buf.length > maxBytes) { if (isVideo) videoProblem(`zu groß (${Math.round(buf.length / 1048576)} MB)`); return null; }
  const type = isVideo ? 'video/mp4' : (r.headers.get('content-type') || 'image/jpeg');
  if (!isVideo) return storageUpload(BUCKET, path, buf, type);
  // videos: own bucket (SQL 17); if it does not exist yet, the photo bucket (takes only small videos)
  let err;
  for (const b of VIDEO_BUCKETS) {
    try { return await storageUpload(b, path, buf, type); } catch (e) { err = err || e; }
  }
  const m = String(err.message);
  videoProblem(/Bucket not found/i.test(m) ? 'Video-Speicher fehlt (SQL 17 in Supabase ausführen)'
    : /too large|maximum allowed size/i.test(m) ? `Video zu groß für den Speicher (${Math.round(buf.length / 1048576)} MB)` : `Speichern: ${m.slice(0, 120)}`);
  throw err;
}

// one Instagram item -> { photos, video_url }
async function copyMedia(item) {
  const photos = []; let video_url = null;
  const parts = item.media_type === 'CAROUSEL_ALBUM' ? ((item.children && item.children.data) || []).slice(0, 8) : [item];
  let n = 0;
  for (const p of parts) {
    n++;
    if (p.media_type === 'VIDEO') {
      if (!p.media_url) videoProblem('Instagram liefert keinen Video-Link (oft bei Reels mit Musik)');
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
You get the original caption (may be empty), pictures (photos, the video cover, or frames cut from the video in time order) and, for videos, a transcript of what is said (may be empty, may be German, Bosnian or English, may contain small speech-recognition errors).
When there is a transcript, it is the main source: the post must tell what the speaker says (what happened, what is needed, what is planned), summarised in your own words. You may quote one short sentence word for word from the transcript. Pictures only add context. Write in German, in the association's own voice ("wir", talking to supporters with "ihr"), like a short update from the team on the ground:
- title: short, warm and concrete, max 70 characters, no emojis, no hashtags. It says what happened, e.g. "Futter für die Welpen an der Deponie".
- body: tell what happened and why it matters, as a short news update. With a transcript or a real caption: 50 to 150 words. With neither (only pictures): only 2 or 3 sentences (20 to 50 words).
Style rules:
- Never describe the picture as a picture. Do not write "Auf dem Bild", "im Video", "zu sehen", "am Bildrand", "in dieser Story/diesem Reel/Beitrag" or similar. Tell it as an event: "Heute haben wir die Welpen an der Deponie gefüttert." not "Auf dem Bild sind Welpen zu sehen."
- No mention of Instagram, stories, reels or posts.
- Do not list visual details (colours, bowls, sacks, boards). Keep only what matters to a supporter.
Strict rules:
- Only facts from the transcript, the caption or clearly visible in the pictures. Never invent names, ages, diagnoses, numbers, places, dates, amounts or quotes. If unsure, leave it out.
- If the caption asks for help (donations, adoption, sponsors), you may repeat that request, but no bank data and no amounts that are not in the caption.
- No hashtags, no @mentions, no emojis in the title, at most one emoji in the body, no long dashes.
- dog_ids: ids from the given dog list whose name clearly appears in the caption or transcript (exact name, any case). Empty if none.`;

async function rest(path, opt = {}) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...opt, headers: {
    apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    'Content-Type': 'application/json', Prefer: 'return=minimal', ...(opt.headers || {}) } });
  if (!r.ok) throw new Error(`db ${path.split('?')[0]}: ${r.status}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

export async function writeStory({ caption, kind, imageUrls = [], frames = [], dogs = [], transcript = '' }) {
  const content = [];
  frames.slice(0, 8).forEach(d => content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(d).replace(/^data:image\/\w+;base64,/, '') } }));
  if (!frames.length) imageUrls.slice(0, 4).forEach(u => content.push({ type: 'image', source: { type: 'url', url: u } }));
  content.push({ type: 'text', text: JSON.stringify({
    kind: kind || 'post', pictures: frames.length ? 'frames from the video, in time order' : 'photos / video cover',
    caption: String(caption || '').slice(0, 2200), transcript: String(transcript || '').slice(0, 6000), dogs: dogs.map(d => ({ id: d.id, name: d.name })) }) });
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

// ---------- speech to text (Whisper via Groq or OpenAI, same API shape) ----------
function speechApi() {
  if (process.env.GROQ_API_KEY) return { url: 'https://api.groq.com/openai/v1/audio/transcriptions', key: process.env.GROQ_API_KEY, model: 'whisper-large-v3-turbo' };
  if (process.env.OPENAI_API_KEY) return { url: 'https://api.openai.com/v1/audio/transcriptions', key: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini-transcribe' };
  return null;
}
const speechOn = () => !!speechApi();
export async function transcribe(videoUrl) {
  if (!speechOn() || !videoUrl) return null;
  const r = await fetch(videoUrl);
  if (!r.ok) throw new Error(`Video laden ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_TRANSCRIBE_BYTES) return null;
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'video/mp4' }), 'video.mp4');
  const api = speechApi();
  form.append('model', process.env.TRANSCRIBE_MODEL || api.model);
  form.append('response_format', 'json');
  const t = await (transcribe.fetch || fetch)(api.url, {
    method: 'POST', headers: { Authorization: `Bearer ${api.key}` }, body: form,
    signal: AbortSignal.timeout(15000) });
  const j = await t.json().catch(() => ({}));
  if (!t.ok) throw new Error(`Transkript: ${(j.error && j.error.message) || t.status}`);
  return String(j.text || '').trim();
}

// draft body = news text + original caption + transcript. Everything from [Instagram-Text] on is cut off
// when the team publishes (index.html), so the marker is always written, even for an empty caption.
const NO_SPEECH = '(keine Sprache erkannt)', TOO_BIG = '(Video zu groß für ein Transkript)';
export function splitBody(body) {
  const b = String(body || '');
  if (!b.includes('[Instagram-Text]')) return { caption: b.trim(), transcript: null };
  const rest = b.split('[Instagram-Text]').slice(1).join('[Instagram-Text]');
  const [cap, tr] = rest.split('[Transkript]');
  return { caption: cap.trim(), transcript: tr === undefined ? null : tr.trim().replace(NO_SPEECH, '').replace(TOO_BIG, '') };
}
const draftBody = (story, caption, transcript) =>
  (`${story}\n\n[Instagram-Text]\n${caption || ''}` + (transcript === null ? '' : `\n\n[Transkript]\n${transcript || NO_SPEECH}`)).slice(0, 12000);

const loadDogs = () => rest('dogs?select=id,name&order=name.asc', { headers: { Prefer: '' } }).catch(() => []);

// fills drafts that have no title yet (newest first), and, once speech is on, video drafts that have no
// transcript yet (so videos imported before get a news text about what is said). Never fails the import.
async function fillStories(deadline) {
  if (!storiesOn() || Date.now() > deadline) return { stories: 0 };
  const sel = 'select=id,event,body,photos,video_url&source=eq.instagram&published_at=is.null';
  const filter = speechOn() ? `&or=(title.is.null,and(video_url.not.is.null,body.not.ilike.*Transkript*))` : '&title=is.null';
  const todo = await rest(`posts?${sel}${filter}&order=created_at.desc&limit=${STORY_PER_RUN}`, { headers: { Prefer: '' } }).catch(() => []);
  if (!todo || !todo.length) return { stories: 0 };
  const dogs = await loadDogs();
  let done = 0; const errors = [];
  await Promise.all(todo.map(async p => {
    try {
      const { caption, transcript: had } = splitBody(p.body);
      let transcript = had;
      let mark = null;
      if (transcript === null && p.video_url && speechOn()) {
        transcript = await transcribe(p.video_url);
        if (transcript === null) { transcript = ''; mark = TOO_BIG; }   // marked, so it is not tried again every hour
      }
      const s = await writeStory({ caption, transcript, kind: p.event, imageUrls: (p.photos || []).filter(u => /^https:\/\//.test(u)), dogs });
      if (!s.title || !s.body) return;
      await rest(`posts?id=eq.${encodeURIComponent(p.id)}&published_at=is.null`, { method: 'PATCH',
        body: JSON.stringify({ title: s.title, body: draftBody(s.body, caption, p.video_url && speechOn() ? (mark || transcript) : null), dog_ids: s.dog_ids }) });
      done++;
    } catch (e) { errors.push(e.message); }
  }));
  return { stories: done, story_error: errors[0] || null };
}

// videos that were too big for the old 8 MB limit: copy them now if Instagram still lists them
export async function backfillVideos(items) {
  const vids = items.filter(i => i.media_type === 'VIDEO' && i.media_url);
  if (items.some(i => i.media_type === 'VIDEO' && !i.media_url)) videoProblem('Instagram liefert keinen Video-Link (oft bei Reels mit Musik)');
  if (!vids.length) return 0;
  const ids = vids.map(i => String(i.id));
  const rows = await rest(`posts?select=id,external_id&source=eq.instagram&video_url=is.null&external_id=in.(${ids.map(encodeURIComponent).join(',')})`, { headers: { Prefer: '' } }).catch(() => []);
  let n = 0;
  for (const row of (rows || []).slice(0, VIDEO_BACKFILL_PER_RUN)) {
    const item = vids.find(i => String(i.id) === String(row.external_id));
    const url = await copy(item.media_url, `ig/${item.id}-1.mp4`, MAX_VIDEO_BYTES).catch(() => null);
    if (!url) continue;
    await rest(`posts?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', body: JSON.stringify({ video_url: url }) }).catch(() => null);
    n++;
  }
  return n;
}

// op=story: admin button, returns a new story for one post (nothing saved here)
async function storyForPost(req, res) {
  const { adminPassword, post_id, frames } = req.body || {};
  await requireAdmin(adminPassword);
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY fehlt in Vercel', code: 'no_key' });
  const rows = await rest(`posts?select=id,event,body,photos,video_url&id=eq.${encodeURIComponent(String(post_id || ''))}`, { headers: { Prefer: '' } });
  const p = rows && rows[0];
  if (!p) return res.status(404).json({ error: 'Beitrag nicht gefunden' });
  const { caption, transcript: had } = splitBody(p.body);
  let transcript = had;
  if (!transcript && p.video_url && speechOn()) transcript = await transcribe(p.video_url);
  const s = await writeStory({ caption, transcript, kind: p.event, frames: Array.isArray(frames) ? frames : [],
    imageUrls: (p.photos || []).filter(u => /^https:\/\//.test(u)), dogs: await loadDogs() });
  const body = draftBody(s.body, caption, p.video_url && transcript !== null ? transcript : null);
  return res.status(200).json({ ok: true, title: s.title, body, dog_ids: s.dog_ids, transcript: transcript || null });
}

export async function runSync() {
  const started = Date.now();
  videoProblems = [];
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
  const videos_added = await backfillVideos(items).catch(() => 0);
  // news stories for drafts without a title (this run's imports and older ones), within the time limit
  // (Vercel stops at 60 s: speech 15 s + Claude 25 s must still fit, otherwise the next run does it)
  const st = await fillStories(started + (speechOn() ? 15000 : 25000)).catch(e => ({ stories: 0, story_error: e.message }));
  patch.last_sync = new Date().toISOString();
  const errs = [storiesError && `Stories: ${storiesError}`, st.story_error && `Claude: ${st.story_error}`, videoProblems.length && `Video: ${[...new Set(videoProblems)].join(' · ')}`].filter(Boolean);
  patch.last_error = errs.length ? errs.join(' | ').slice(0, 300) : null;
  await rpc('server_integration_set', { p_key: 'instagram', p_value: patch });
  return { imported, waiting: Math.max(0, fresh.length - known.size - todo.length), stories: !storiesError, news_written: st.stories, videos_added, video_problems: [...new Set(videoProblems)] };
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
