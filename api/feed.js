import { rpc, thumbOf, PORTAL_PAGE } from './_lib.js';

// Public read endpoint for the website strip "Neu aus Bihać": the latest published public posts.
// GET /api/feed?limit=3 -> { posts: [{ id, title, text, photo, date, url, instagram }] }
// Cached at Vercel's edge for 10 minutes, so visitors do not hit Supabase.
// The website's CSP only allows images from the Supabase host, so other links (old dog photos) are left out.
function storagePhoto(u) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  return u && base.startsWith('https://') && String(u).startsWith(base + '/storage/') ? thumbOf(u) : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET'); return res.status(204).end(); }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const limit = Math.min(Math.max(parseInt((req.query || {}).limit, 10) || 3, 1), 12);
  try {
    const rows = (await rpc('feed_list', { p_token: '', p_before: null, p_limit: limit, p_dog: null, p_mine: false })) || [];
    const posts = rows.map(p => {
      const text = String(p.body || '');
      return {
        id: p.id, title: p.title || '',
        text: text.length > 220 ? text.slice(0, 220).replace(/\s+\S*$/, '') + ' …' : text,
        photo: storagePhoto(p.photos && p.photos[0]),
        date: p.published_at, url: `${PORTAL_PAGE}?view=aus-bihac&beitrag=${p.id}`, instagram: p.permalink || null
      };
    });
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ posts });
  } catch (e) {
    console.error('feed', e.message);
    return res.status(500).json({ posts: [] });
  }
}
