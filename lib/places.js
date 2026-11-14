// Place search for the 5k Runs form: as Fred types a place name or a UK postcode,
// return matching real places with their map position.
//   - UK postcodes: postcodes.io (free, no key)
//   - Place names:  Photon, an OpenStreetMap search built for search-as-you-type (free, no key)
// Requests go through this server so results can be cached and the browser only
// talks to our own site.

const PHOTON_URL = process.env.PHOTON_URL || 'https://photon.komoot.io';
const POSTCODES_URL = process.env.POSTCODES_URL || 'https://api.postcodes.io';
const USER_AGENT = 'fred-rehab-tracker (personal rehab tracker)';
const BIAS = { lat: 53.0027, lon: -2.1794 }; // Stoke-on-Trent: nearby places rank first
const MAX_RESULTS = 6;
const TIMEOUT_MS = 6000;

const FULL_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const PARTIAL_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]?)?$/i;

// Small in-memory cache so repeated searches (and typing back and forth) are instant.
const cache = new Map();
const CACHE_MAX = 500;
function remember(key, value) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, value);
}

async function getJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(options.headers || {}) },
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Place search returned ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

function postcodeResult(p) {
    return {
        name: p.postcode,
        town: p.admin_district || null,
        detail: [p.admin_ward, p.admin_district].filter(Boolean).join(', '),
        lat: p.latitude,
        lng: p.longitude,
    };
}

async function searchPostcodes(q) {
    const compact = q.replace(/\s+/g, '').toUpperCase();
    if (FULL_POSTCODE.test(q)) {
        const data = await getJson(`${POSTCODES_URL}/postcodes/${encodeURIComponent(compact)}`);
        return data && data.result && data.result.latitude != null ? [postcodeResult(data.result)] : [];
    }
    const auto = await getJson(`${POSTCODES_URL}/postcodes/${encodeURIComponent(q.trim())}/autocomplete?limit=${MAX_RESULTS}`);
    const codes = (auto && auto.result) || [];
    if (!codes.length) return [];
    const bulk = await getJson(`${POSTCODES_URL}/postcodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postcodes: codes }),
    });
    return ((bulk && bulk.result) || [])
        .map(r => r.result)
        .filter(r => r && r.latitude != null)
        .map(postcodeResult);
}

function photonResults(data) {
    const seen = new Set();
    const results = [];
    for (const f of (data && data.features) || []) {
        const p = f.properties || {};
        const [lng, lat] = (f.geometry && f.geometry.coordinates) || [];
        if (lat == null || lng == null) continue;
        const town = p.city || p.town || p.village || p.district || p.locality;
        const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || town;
        if (!name) continue;
        const detail = [p.street && p.street !== name ? p.street : null, town !== name ? town : null, p.county, p.postcode]
            .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
        const key = `${name}|${town || ''}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ name, town: town && town !== name ? town : null, detail, lat, lng, country: p.countrycode });
        if (results.length >= MAX_RESULTS) break;
    }
    // UK places first; Photon already ranks places near Stoke higher.
    return results.sort((a, b) => (b.country === 'GB') - (a.country === 'GB')).map(({ country, ...r }) => r);
}

async function searchNames(q) {
    const params = new URLSearchParams({ q, limit: String(MAX_RESULTS + 4), lang: 'en', lat: String(BIAS.lat), lon: String(BIAS.lon) });
    return photonResults(await getJson(`${PHOTON_URL}/api/?${params}`));
}

// Name of the place at a map position (used after "Use my location").
async function reversePlace(lat, lon) {
    lat = Number(lat); lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const key = `rev:${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (cache.has(key)) return cache.get(key);
    const params = new URLSearchParams({ lat: String(lat), lon: String(lon), lang: 'en', limit: '1' });
    const [place] = photonResults(await getJson(`${PHOTON_URL}/reverse?${params}`));
    remember(key, place || null);
    return place || null;
}

async function searchPlaces(query) {
    const q = String(query || '').trim().replace(/\s+/g, ' ');
    if (q.length < 3 || q.length > 100) return [];
    const key = q.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    let results = [];
    if (FULL_POSTCODE.test(q) || PARTIAL_POSTCODE.test(q)) results = await searchPostcodes(q);
    if (!results.length) results = await searchNames(q);
    remember(key, results);
    return results;
}

function registerPlaceRoutes(app, { requireLogin }) {
    app.get('/api/places', requireLogin, async (req, res) => {
        try {
            res.json(await searchPlaces(req.query.q));
        } catch (err) {
            console.error('Place search error:', err.message);
            res.status(502).json({ error: 'Place search is not available just now.' });
        }
    });

    app.get('/api/places/reverse', requireLogin, async (req, res) => {
        try {
            res.json(await reversePlace(req.query.lat, req.query.lon));
        } catch (err) {
            console.error('Reverse place error:', err.message);
            res.status(502).json({ error: 'Place search is not available just now.' });
        }
    });
}

module.exports = { registerPlaceRoutes, searchPlaces, reversePlace };
