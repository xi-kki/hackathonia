// Hackathonia crawler. Node 18+, no deps.
// Free no-key APIs: Devpost, Hack Club, Devfolio, Unstop.
// Keyed (optional, skipped if missing): FIRECRAWL_API_KEY (scrape), TAVILY_API_KEY (web search), GROQ_API_KEY (LLM extract).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const { TAVILY_API_KEY, FIRECRAWL_API_KEY, GROQ_API_KEY } = process.env;
const TODAY = new Date().toISOString().slice(0, 10);
const UA = { 'User-Agent': 'Mozilla/5.0 (Hackathonia; +https://xi-kki.github.io/hackathonia/)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[fetch]', ...a);
const day = (s) => (s ? String(s).slice(0, 10) : null);
const getJSON = async (url, opt = {}) => { const r = await fetch(url, { ...opt, headers: { ...UA, ...(opt.headers || {}) } }); if (!r.ok) throw new Error(r.status); return r.json(); };

// Sites without a free API -> Firecrawl + LLM extract.
const SCRAPE_PAGES = [
  'https://ethglobal.com/events',
  'https://www.mlh.com/seasons/2027/events',
  'https://lablab.ai/event',
  'https://dorahacks.io/hackathon',
  'https://www.hackerearth.com/challenges/hackathon/',
  'https://taikai.network/en/hackathons',
];
const SEARCHES = [
  'online AI hackathon open for registration prize',
  'web3 blockchain hackathon upcoming worldwide',
  'food tech agritech hackathon upcoming',
  'hackathon Africa Nigeria Kenya Ghana upcoming',
  'climate sustainability hackathon upcoming prize',
  'fintech hackathon registration open',
  'health tech hackathon upcoming',
  'hackathon Europe upcoming registration',
  'hackathon Latin America upcoming',
  'hackathon Middle East Asia upcoming',
];

// ---------- location ----------
const REGIONS = {
  Africa: 'nigeria kenya ghana south africa egypt morocco ethiopia rwanda uganda tanzania senegal cameroon tunisia algeria zambia zimbabwe ivory coast cote d\'ivoire botswana namibia malawi mozambique benin togo angola sudan mauritius',
  Europe: 'uk united kingdom england scotland wales ireland germany france spain portugal italy netherlands belgium switzerland austria poland sweden norway denmark finland estonia latvia lithuania czech czechia slovakia hungary romania bulgaria greece croatia serbia slovenia ukraine luxembourg iceland malta cyprus',
  'North America': 'usa us united states america canada',
  'Latin America': 'mexico brazil argentina chile colombia peru uruguay ecuador venezuela bolivia paraguay costa rica panama guatemala dominican republic puerto rico',
  'Middle East': 'uae united arab emirates saudi arabia qatar bahrain kuwait oman israel jordan lebanon turkey türkiye iran iraq',
  Asia: 'india china japan south korea korea singapore malaysia indonesia philippines thailand vietnam hong kong taiwan pakistan bangladesh sri lanka nepal kazakhstan',
  Oceania: 'australia new zealand fiji',
};
const COUNTRY_REGION = {};
for (const [r, list] of Object.entries(REGIONS)) {
  for (const c of list.split(' ')) COUNTRY_REGION[c] = r;
}
// multi-word names
for (const [r, names] of Object.entries({ Africa: ['south africa', 'ivory coast', "cote d'ivoire"], Europe: ['united kingdom'], 'North America': ['united states'], 'Latin America': ['costa rica', 'dominican republic', 'puerto rico'], 'Middle East': ['united arab emirates', 'saudi arabia'], Asia: ['south korea', 'hong kong', 'sri lanka'], Oceania: ['new zealand'] })) for (const n of names) COUNTRY_REGION[n] = r;
const US_STATES = /^(A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])$/;
function regionOf(country) {
  const c = (country || '').toLowerCase().trim();
  return COUNTRY_REGION[c] || null;
}
function parseLocation(loc) {
  if (!loc || /online|virtual|remote/i.test(loc)) return { city: null, country: null };
  const parts = loc.split(',').map((s) => s.trim()).filter(Boolean);
  let country = parts.at(-1) || null;
  if (country && (US_STATES.test(country) || /^usa?$/i.test(country))) country = 'United States';
  return { city: parts.length > 1 ? parts[0] : null, country };
}

// ---------- categories ----------
const CATS = {
  AI: /\b(ai|machine learning|ml|llm|gpt|genai|agents?|artificial intelligence|deep learning|data science)\b/i,
  Web3: /\b(web3|blockchain|crypto|defi|ethereum|eth|solana|sui|bitcoin|nft|dao|onchain|polkadot|near|starknet)\b/i,
  'Food & Agri': /\b(food|agri\w*|farm\w*|nutrition|agtech)\b/i,
  Health: /\b(health\w*|medical|medtech|biotech|wellness)\b/i,
  Climate: /\b(climate|sustainab\w*|green|energy|environment\w*|carbon)\b/i,
  Fintech: /\b(fintech|finance|payments?|banking|financial)\b/i,
  Education: /\b(education|edtech|learning|students?)\b/i,
  'Social Good': /\b(social good|impact|nonprofit|civic|community)\b/i,
  Gaming: /\b(game|games|gaming|xr|vr)\b/i,
  Beginner: /\b(beginner|first[- ]time|newbie|high school|students?)\b/i,
};
const categorize = (text) => Object.keys(CATS).filter((k) => CATS[k].test(text));

// ---------- free APIs ----------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function devpostDates(s) {
  const m = s?.match(/^([A-Za-z]{3}) (\d{1,2})(?:, (\d{4}))?(?: - (?:([A-Za-z]{3}) )?(\d{1,2}), (\d{4}))?$/);
  if (!m) return {};
  const [, m1, d1, y1, m2, d2, y2] = m;
  const iso = (y, mo, d) => new Date(Date.UTC(+y, MONTHS[mo.toLowerCase()], +d)).toISOString().slice(0, 10);
  if (!d2) return { start: iso(y1, m1, d1), end: iso(y1, m1, d1) };
  return { start: iso(y1 || y2, m1, d1), end: iso(y2, m2 || m1, d2) };
}

async function devpost() {
  const out = [];
  for (const status of ['open', 'upcoming']) {
    for (let page = 1; page <= 30; page++) {
      const j = await getJSON(`https://devpost.com/api/hackathons?status[]=${status}&page=${page}`);
      if (!j.hackathons?.length) break;
      for (const h of j.hackathons) {
        if (h.invite_only) continue;
        const loc = (h.displayed_location?.location || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
        out.push({
          title: h.title, url: h.url, ...devpostDates(h.submission_period_dates),
          mode: /online/i.test(loc) ? 'online' : 'in-person',
          location: loc, ...parseLocation(loc),
          prize: (h.prize_amount || '').replace(/<[^>]+>/g, '').trim() || null,
          themes: (h.themes || []).map((t) => t.name),
          organizer: h.organization_name || null,
          registrations: h.registrations_count ?? null,
          source: 'Devpost',
        });
      }
      if (page * j.meta.per_page >= j.meta.total_count) break;
      await sleep(300);
    }
  }
  return out;
}

async function hackclub() {
  const a = await getJSON('https://hackathons.hackclub.com/api/events/upcoming');
  return a.map((h) => ({
    title: h.name, url: h.website, start: day(h.start), end: day(h.end),
    mode: h.virtual ? 'online' : h.hybrid ? 'hybrid' : 'in-person',
    location: [h.city, h.state, h.country].filter(Boolean).join(', ') || null,
    city: h.city || null, country: h.country || null,
    prize: null, themes: ['Beginner friendly', 'High school'], organizer: h.mlhAssociated ? 'MLH member event' : null,
    source: 'Hack Club',
  }));
}

async function devfolio() {
  const out = [];
  for (const type of ['application_open', 'upcoming']) {
    for (let from = 0; from < 300; from += 50) {
      const j = await getJSON('https://api.devfolio.co/api/search/hackathons', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, from, size: 50 }),
      });
      const hits = j?.hits?.hits || [];
      for (const { _source: h } of hits) {
        out.push({
          title: h.name, url: `https://${h.slug}.devfolio.co/`, start: day(h.starts_at), end: day(h.ends_at),
          mode: h.is_online ? 'online' : 'in-person',
          location: h.is_online ? 'Online' : [h.city, h.country].filter(Boolean).join(', '),
          city: h.is_online ? null : h.city || null, country: h.is_online ? null : h.country || null,
          prize: null, themes: (h.themes || []).map((t) => t?.name || t).filter(Boolean),
          organizer: h.hosted_by || null, source: 'Devfolio',
        });
      }
      if (hits.length < 50) break;
    }
  }
  return out;
}

async function unstop() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await getJSON(`https://unstop.com/api/public/opportunity/search-result?opportunity=hackathons&page=${page}&per_page=30&oppstatus=open`);
    const rows = j?.data?.data || [];
    for (const h of rows) {
      const a = h.address_with_country_logo || {};
      const online = h.region === 'online';
      const cash = (h.prizes || []).map((p) => p.cash).filter(Boolean).reduce((s, x) => s + +x, 0);
      out.push({
        title: h.title, url: `https://unstop.com/${h.public_url}`,
        start: day(h.regnRequirements?.start_regn_dt), end: day(h.end_date),
        mode: online ? 'online' : 'in-person',
        location: online ? 'Online' : [a.city, a.state, a.country?.name || a.country].filter((x) => typeof x === 'string').join(', '),
        city: online ? null : a.city || null, country: online ? null : (a.country?.name || (typeof a.country === 'string' ? a.country : null)),
        prize: cash ? `₹${cash.toLocaleString('en-IN')}` : null,
        themes: (h.workfunction || []).map((w) => w.name),
        organizer: h.organisation?.name || null, source: 'Unstop',
      });
    }
    if (rows.length < 30) break;
    await sleep(500);
  }
  return out;
}

// ---------- LLM-backed sources ----------
async function groqJSON(system, user) {
  for (const model of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (r.status === 429) { await sleep(15000 * (attempt + 1)); continue; }
      if (!r.ok) { log('groq', model, r.status); break; }
      try { return JSON.parse((await r.json()).choices[0].message.content); } catch { break; }
    }
  }
  return { events: [] };
}

const EXTRACT_SYS = `You extract hackathon listings from web text. Today is ${TODAY}.
Return JSON {"events":[{"title":str,"url":str,"start":"YYYY-MM-DD"|null,"end":"YYYY-MM-DD"|null,"mode":"online"|"in-person"|"hybrid","city":str|null,"country":str|null,"prize":str|null,"themes":[str],"organizer":str|null}]}.
Rules: only hackathons/buildathons explicitly present in the text; never invent events, dates, places or prizes (use null if unknown).
"country" is the full English country name. "url" must be a link that appears in the text (prefer the event's own page). Skip events that ended before today. Max 40 events.`;

async function extract(text, source) {
  const out = [];
  for (let i = 0; i < Math.min(text.length, 27000); i += 9000) {
    const j = await groqJSON(EXTRACT_SYS, text.slice(i, i + 9000));
    for (const e of j.events || []) if (e?.title && e?.url?.startsWith('http')) out.push({ ...e, location: e.mode === 'online' ? 'Online' : [e.city, e.country].filter(Boolean).join(', ') || null, source });
    await sleep(4000);
  }
  return out;
}

async function firecrawl() {
  if (!FIRECRAWL_API_KEY || !GROQ_API_KEY) return [];
  const out = [];
  for (const url of SCRAPE_PAGES) {
    try {
      const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST', headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, waitFor: 3000 }),
      });
      const md = (await r.json())?.data?.markdown || '';
      const host = new URL(url).hostname.replace(/^www\./, '');
      const ev = md ? await extract(md, host) : [];
      log('firecrawl', host, md.length, '->', ev.length);
      out.push(...ev);
    } catch (e) { log('firecrawl fail', url, e.message); }
  }
  return out;
}

async function tavily() {
  if (!TAVILY_API_KEY || !GROQ_API_KEY) return [];
  const out = [];
  for (const q of SEARCHES) {
    try {
      const j = await getJSON('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: TAVILY_API_KEY, query: `${q} ${TODAY.slice(0, 4)}`, max_results: 10, search_depth: 'advanced' }),
      });
      const text = (j.results || []).map((x) => `### ${x.title}\nURL: ${x.url}\n${x.content}`).join('\n\n');
      const ev = text ? await extract(text, 'Web search') : [];
      log('tavily', q, '->', ev.length);
      out.push(...ev);
    } catch (e) { log('tavily fail', q, e.message); }
  }
  return out;
}

// ---------- run ----------
async function safe(name, fn) {
  try { const r = await fn(); log(name, r.length); return r; } catch (e) { log(name, 'FAILED', e.message); return []; }
}
const only = process.argv[2]; // e.g. "free" = skip keyed sources
const all = [
  ...(await safe('devpost', devpost)),
  ...(await safe('hackclub', hackclub)),
  ...(await safe('devfolio', devfolio)),
  ...(await safe('unstop', unstop)),
  ...(only === 'free' ? [] : await safe('firecrawl', firecrawl)),
  ...(only === 'free' ? [] : await safe('tavily', tavily)),
];

const norm = (s) => String(s).toLowerCase().replace(/\b(20\d\d|hackathon|hack)\b/g, '').replace(/[^a-z0-9]/g, '');
const validDate = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
const API_SOURCES = new Set(['Devpost', 'Hack Club', 'Devfolio', 'Unstop']);
const seen = new Map();
for (const e of all) {
  if (!e.title || !e.url) continue;
  e.start = validDate(e.start); e.end = validDate(e.end);
  if (e.end && e.end < TODAY) continue;
  if (!e.end && e.start && e.start < TODAY) continue;
  e.mode = ['online', 'in-person', 'hybrid'].includes(e.mode) ? e.mode : 'in-person';
  e.themes = Array.isArray(e.themes) ? e.themes.filter((t) => typeof t === 'string') : [];
  e.region = e.mode === 'online' ? null : regionOf(e.country);
  e.categories = categorize([e.title, ...e.themes, e.organizer || ''].join(' '));
  const k = norm(e.title);
  if (!k) continue;
  const prev = seen.get(k);
  if (!prev || (!API_SOURCES.has(prev.source) && API_SOURCES.has(e.source))) seen.set(k, e);
}
// Geocode in-person events lacking a known region (OpenStreetMap Nominatim: free, 1 req/s, cached).
const cacheFile = new URL('../data/geocache.json', import.meta.url);
const geo = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
let lookups = 0;
for (const e of seen.values()) {
  if (e.mode === 'online' || e.region || !e.location) continue;
  const q = e.location.trim();
  if (!(q in geo) && lookups < 250) {
    lookups++;
    try {
      const [hit] = await getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&accept-language=en&q=${encodeURIComponent(q)}`);
      const a = hit?.address || {};
      geo[q] = hit ? { city: a.city || a.town || a.village || a.county || null, country: a.country || null } : null;
    } catch { geo[q] = null; }
    await sleep(1100);
  }
  const g = geo[q];
  if (g?.country) { e.country = g.country; e.city = e.city && e.city !== q ? e.city : g.city; e.region = regionOf(g.country); }
}
// Venue names Nominatim can't place (e.g. "Drexel University CCI Building"): one LLM batch, cached.
const unplaced = [...seen.values()].filter((e) => e.mode !== 'online' && !e.region && e.location && geo['llm:' + e.location] === undefined);
if (GROQ_API_KEY && unplaced.length) {
  const list = unplaced.slice(0, 120).map((e, i) => `${i}. venue="${e.location}" event="${e.title}" organizer="${e.organizer || ''}"`).join('\n');
  const j = await groqJSON('For each hackathon venue, give the country it is in, only if you are confident from the names (well-known university/city/company). Otherwise null. Return JSON {"r":[{"i":int,"country":str|null,"city":str|null}]}. Full English country names.', list);
  for (const x of j.r || []) { const e = unplaced[x.i]; if (e) geo['llm:' + e.location] = x.country ? { country: x.country, city: x.city || null } : null; }
}
for (const e of seen.values()) {
  const g = e.region || e.mode === 'online' ? null : geo['llm:' + e.location];
  if (g?.country) { e.country = g.country; e.city = e.city || g.city; e.region = regionOf(g.country); }
}
writeFileSync(cacheFile, JSON.stringify(geo));
log('geocoded', lookups, 'unplaced', [...seen.values()].filter((e) => e.mode !== 'online' && !e.region).length);

const events = [...seen.values()].sort((a, b) => (a.end || '9999').localeCompare(b.end || '9999'));

const file = new URL('../data/hackathons.json', import.meta.url);
const prevCount = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).events.length : 0;
if (events.length < Math.min(20, prevCount / 2)) { log('too few events', events.length, 'keeping previous', prevCount); process.exit(0); }
const sources = {}; events.forEach((e) => (sources[e.source] = (sources[e.source] || 0) + 1));
writeFileSync(file, JSON.stringify({ updated: TODAY, count: events.length, sources, events }, null, 1));
log('wrote', events.length, 'from', all.length, 'raw', JSON.stringify(sources));
