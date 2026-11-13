// Monthly hackathon crawler. Node 18+, no deps.
// Env: TAVILY_API_KEY, FIRECRAWL_API_KEY, GROQ_API_KEY (all optional; missing = source skipped).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const { TAVILY_API_KEY, FIRECRAWL_API_KEY, GROQ_API_KEY } = process.env;
const TODAY = new Date().toISOString().slice(0, 10);
const UA = { 'User-Agent': 'Mozilla/5.0 (hackathon-finder)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[fetch]', ...a);

const SCRAPE_PAGES = [
  'https://ethglobal.com/events',
  'https://mlh.io/seasons/2027/events',
  'https://lablab.ai/event',
  'https://dorahacks.io/hackathon',
  'https://devfolio.co/hackathons/open',
  'https://unstop.com/hackathons',
  'https://www.hackerearth.com/challenges/hackathon/',
  'https://taikai.network/en/hackathons',
];
const SEARCHES = [
  'online AI hackathon open for registration prize',
  'web3 blockchain hackathon upcoming worldwide',
  'food tech agritech hackathon upcoming',
  'virtual hackathon open to Africa participants',
  'climate sustainability virtual hackathon prize',
  'fintech online hackathon registration open',
  'health tech virtual hackathon upcoming',
  'remote global online hackathon open worldwide',
];

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
};
const categorize = (text) => Object.keys(CATS).filter((k) => CATS[k].test(text));

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// "Oct 30 - Dec 04, 2026" | "Nov 01 - 20, 2026" | "Dec 05, 2026" | "Dec 28, 2026 - Jan 05, 2027"
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
      const r = await fetch(`https://devpost.com/api/hackathons?status[]=${status}&page=${page}`, { headers: UA });
      if (!r.ok) break;
      const j = await r.json();
      if (!j.hackathons?.length) break;
      for (const h of j.hackathons) {
        if (h.invite_only) continue;
        const loc = h.displayed_location?.location || '';
        const { start, end } = devpostDates(h.submission_period_dates);
        out.push({
          title: h.title,
          url: h.url,
          start, end,
          mode: /online/i.test(loc) ? 'online' : 'in-person',
          location: loc,
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
  log('devpost', out.length);
  return out;
}

async function groqJSON(system, user) {
  for (const model of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, temperature: 0, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      if (r.status === 429) { await sleep(15000 * (attempt + 1)); continue; }
      if (!r.ok) { log('groq', model, r.status); break; }
      try { return JSON.parse((await r.json()).choices[0].message.content); } catch { break; }
    }
  }
  return { events: [] };
}

const EXTRACT_SYS = `You extract hackathon listings from web text. Today is ${TODAY}.
Return JSON {"events":[{"title":str,"url":str,"start":"YYYY-MM-DD"|null,"end":"YYYY-MM-DD"|null,"mode":"online"|"in-person"|"hybrid","location":str|null,"prize":str|null,"themes":[str],"organizer":str|null}]}.
Rules: only hackathons/buildathons explicitly present in the text; never invent events, dates or prizes (use null if unknown).
"url" must be a link that appears in the text (prefer the event's own page). Skip events that ended before today. Max 40 events.`;

async function extract(text, source) {
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < 3; i += 9000) chunks.push(text.slice(i, i + 9000));
  const out = [];
  for (const c of chunks) {
    const j = await groqJSON(EXTRACT_SYS, c);
    for (const e of j.events || []) if (e?.title && e?.url?.startsWith('http')) out.push({ ...e, source });
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
        method: 'POST',
        headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, waitFor: 3000 }),
      });
      const j = await r.json();
      const md = j?.data?.markdown || '';
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
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: TAVILY_API_KEY, query: `${q} ${TODAY.slice(0, 4)}`, max_results: 10, search_depth: 'advanced' }),
      });
      const j = await r.json();
      const text = (j.results || []).map((x) => `### ${x.title}\nURL: ${x.url}\n${x.content}`).join('\n\n');
      const ev = text ? await extract(text, 'Web search') : [];
      log('tavily', q, '->', ev.length);
      out.push(...ev);
    } catch (e) { log('tavily fail', q, e.message); }
  }
  return out;
}

const norm = (s) => String(s).toLowerCase().replace(/\b(20\d\d|hackathon|hack)\b/g, '').replace(/[^a-z0-9]/g, '');
const validDate = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);

const all = [...(await devpost()), ...(await firecrawl()), ...(await tavily())];
const seen = new Map();
for (const e of all) {
  e.start = validDate(e.start); e.end = validDate(e.end);
  if (e.end && e.end < TODAY) continue;
  if (!e.end && e.start && e.start < TODAY) continue;
  e.mode = ['online', 'in-person', 'hybrid'].includes(e.mode) ? e.mode : 'in-person';
  if (e.mode === 'in-person') continue; // Hackathonia = virtual only (online + hybrid)
  e.themes = Array.isArray(e.themes) ? e.themes : [];
  e.categories = categorize([e.title, ...e.themes, e.organizer || ''].join(' '));
  const k = norm(e.title);
  if (!k) continue;
  const prev = seen.get(k);
  if (!prev || (prev.source !== 'Devpost' && e.source === 'Devpost')) seen.set(k, e);
}
const events = [...seen.values()].sort((a, b) => (a.end || '9999').localeCompare(b.end || '9999'));

// Guard: if a run collapses (API down), keep last good data.
const file = new URL('../data/hackathons.json', import.meta.url);
const prevCount = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).events.length : 0;
if (events.length < Math.min(20, prevCount / 2)) { log('too few events', events.length, 'keeping previous', prevCount); process.exit(0); }
writeFileSync(file, JSON.stringify({ updated: TODAY, count: events.length, events }, null, 1));
log('wrote', events.length, 'from', all.length, 'raw');
