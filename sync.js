import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import { TMDB_GENRES, EXTRA_SERIES_KEYWORDS } from "./genres.js";

// ---------- Configurazione ----------

// Legge .env senza dipendenze esterne
try {
  const raw = await fs.readFile(".env", "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {}

const API_KEY = process.env.TMDB_API_KEY;
if (!API_KEY) {
  console.error("ERRORE: manca TMDB_API_KEY (crea il file .env)");
  process.exit(1);
}

// Uso: npm run sync -- --limit=50   (per un test veloce)
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter(a => a.startsWith("--"))
    .map(a => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v];
    })
);
const LIMIT = args.limit ? Number(args.limit) : Infinity; // max pagine per esecuzione
const DEADLINE = args.maxMinutes ? Date.now() + Number(args.maxMinutes) * 60000 : Infinity;
let stopped = false;

const TMDB_API = "https://api.themoviedb.org/3";
const VIX = "https://vixvocal.it";
const UA = "Mozilla/5.0 (compatible; nuvio-ita-catalog/1.0)";
const CONCURRENCY = 4;
const CACHE_FILE = "cache.json";
const CATALOG_FILE = "catalog.json";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- HTTP ----------

async function http(url, { json = false, retries = 3 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "it-IT,it;q=0.9" },
        signal: AbortSignal.timeout(25000)
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (error) {
      if (i === retries) throw error;
      await sleep(1000 * (i + 1) ** 2);
    }
  }
}

function tmdb(endpoint, params = {}) {
  const url = new URL(`${TMDB_API}${endpoint}`);
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("language", "it-IT");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  return http(url.href, { json: true });
}

// ---------- Vix Vocal: crawler ----------
// Il sito non offre sitemap né un elenco completo (il pulsante "Mostra altre"
// usa JavaScript). Partiamo da alcune pagine e seguiamo i collegamenti:
// opera -> doppiatori -> altre opere -> ... finché non troviamo nulla di nuovo.

const PAGE_RE = /^https?:\/\/(www\.)?vixvocal\.it\/(opere|professionisti|aziende)\/([^/?#]+)\/?$/i;

function canon(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = "";
    u.search = "";
    u.hostname = u.hostname.replace(/^www\./, "");
    return u.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

const isWork = url => /^https?:\/\/vixvocal\.it\/opere\/[^/]+$/i.test(url);

// Prova alcuni schemi di paginazione comuni su /opere
async function probePagination(seed) {
  const base = await http(`${VIX}/opere`).catch(() => null);
  if (!base) return;
  const $b = cheerio.load(base);
  const known = new Set();
  $b("a[href]").each((_i, el) => {
    const c = canon($b(el).attr("href"), VIX);
    if (c && isWork(c)) known.add(c);
  });

  const patterns = [
    n => `?page=${n}`,
    n => `?p=${n}`,
    n => `?pagina=${n}`,
    n => `?offset=${(n - 1) * 120}`,
    n => `?skip=${(n - 1) * 120}`
  ];

  for (const make of patterns) {
    const html = await http(`${VIX}/opere${make(2)}`).catch(() => null);
    if (!html) continue;
    const $ = cheerio.load(html);
    const found = [];
    $("a[href]").each((_i, el) => {
      const c = canon($(el).attr("href"), VIX);
      if (c && isWork(c) && !known.has(c)) found.push(c);
    });
    if (!found.length) continue;

    console.log(`Paginazione trovata: /opere${make(2)}`);
    found.forEach(u => seed(u));
    for (let n = 3; n < 400; n++) {
      const h = await http(`${VIX}/opere${make(n)}`).catch(() => null);
      if (!h) break;
      const $$ = cheerio.load(h);
      let added = 0;
      $$("a[href]").each((_i, el) => {
        const c = canon($$(el).attr("href"), VIX);
        if (c && isWork(c) && seed(c)) added++;
      });
      if (!added) break;
      await sleep(300);
    }
    return;
  }
  console.log("Nessuna paginazione semplice su /opere (uso solo i collegamenti).");
}

// ---------- Vix Vocal: singola scheda ----------

function parseWork($) {
  const title = $("h1").first().text().replace(/\s+/g, " ").trim();
  if (!title) return null;

  const text = $("body").text().replace(/\s+/g, " ");

  // Tipo dall'intestazione "Catalogo opere · Film · Titolo · 2026"
  let hint = null;
  const ci = text.search(/Catalogo opere/i);
  if (ci >= 0) {
    const seg = text.slice(ci + 14, ci + 100).replace(/^\W+/, "");
    if (/^(videogioc|multimedia|pubblicit|audiolibr|radiosceneggiat|trailer)/i.test(seg)) {
      return { skip: true };
    }
    if (/^(serie|miniserie|soap|documentari seriali|reality|programmi)/i.test(seg)) hint = "tv";
    else if (/^(film|cortometraggi|documentari)/i.test(seg)) hint = "movie";
  }
  if (/\(videogioco\)/i.test(title)) return { skip: true };

  // Anno: subito dopo il titolo, altrimenti "(1999)"
  let year = null;
  const ti = text.indexOf(title);
  if (ti >= 0) {
    const m = text.slice(ti + title.length, ti + title.length + 60).match(/((?:19|20)\d{2})(?!\d)/);
    if (m) year = Number(m[1]);
  }
  if (!year) {
    const m = text.match(/\(((?:19|20)\d{2})\)/);
    if (m) year = Number(m[1]);
  }

  return { title, year, hint };
}

// ---------- Collegamento a TMDB ----------

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreCandidate(work, c) {
  const a = normalize(work.title);
  const b = normalize(c.title || c.name);
  const o = normalize(c.original_title || c.original_name);

  let score = 0;
  if (a && a === b) score += 100;
  else if (a && a === o) score += 95;
  else if (a && b && (b.includes(a) || a.includes(b))) score += 20;

  const date = c.release_date || c.first_air_date || "";
  const year = Number(date.slice(0, 4));
  if (work.year && year) {
    const diff = Math.abs(year - work.year);
    if (diff === 0) score += 40;
    else if (diff === 1) score += 20;
    else if (diff > 3) score -= 30;
  }
  return score;
}

async function resolveTMDB(work) {
  const result = await tmdb("/search/multi", {
    query: work.title,
    page: 1,
    include_adult: false
  });

  const candidates = (result?.results || []).filter(
    i =>
      (i.media_type === "movie" || i.media_type === "tv") &&
      (!work.hint || i.media_type === work.hint)
  );
  if (!candidates.length) return null;

  const scored = candidates
    .map(c => ({ c, s: scoreCandidate(work, c) }))
    .sort((x, y) => y.s - x.s || (y.c.popularity || 0) - (x.c.popularity || 0));

  const { c: best, s } = scored[0];
  if (s < 90) return null; // match troppo incerto: meglio scartare

  const kind = best.media_type === "movie" ? "movie" : "tv";
  const d = await tmdb(`/${kind}/${best.id}`, { append_to_response: "external_ids,keywords" });
  if (!d) return null;

  const genreKeys = [
    ...new Set((d.genres || []).map(g => TMDB_GENRES[g.id]).filter(Boolean))
  ];

  let extraGenreKeys = [];
  if (kind === "tv") {
    const rawKeywords = d.keywords?.results || d.keywords?.keywords || [];
    const names = rawKeywords.map(k => (k.name || "").toLowerCase());
    extraGenreKeys = Object.entries(EXTRA_SERIES_KEYWORDS)
      .filter(([, terms]) => terms.some(term => names.some(n => n.includes(term))))
      .map(([key]) => key);
  }

  const date = d.release_date || d.first_air_date || "";

  return {
    tmdbId: d.id,
    imdbId: d.imdb_id || d.external_ids?.imdb_id || null,
    type: kind === "movie" ? "movie" : "series",
    name: d.title || d.name || work.title,
    overview: d.overview || "",
    poster: d.poster_path || null,
    year: date ? Number(date.slice(0, 4)) : null,
    rating: d.vote_average || null,
    popularity: d.popularity || 0,
    genreKeys,
    sourceUrl: work.sourceUrl
  };
}

// ---------- Salvataggio ----------

async function loadCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function save(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache), "utf8");

  const movies = [];
  const series = [];
  const seen = new Set();

  for (const [key0, item] of Object.entries(cache)) {
    if (key0 === "__crawl" || !item || !item.tmdbId) continue;
    const key = `${item.type}:${item.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (item.type === "movie" ? movies : series).push(item);
  }

  await fs.writeFile(
    CATALOG_FILE,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        source: "Vix Vocal + TMDB",
        movies,
        series
      },
      null,
      2
    ),
    "utf8"
  );
  return { movies: movies.length, series: series.length };
}

// ---------- Main ----------

async function main() {
  console.log("\n🇮🇹 NUVIO ITA CATALOG SYNC\n");

  const cache = await loadCache();

  // Migrazione una tantum: le serie salvate prima dell'introduzione dei
  // generi extra non hanno "extraGenreKeys". Le rimuoviamo dalla cache
  // così vengono ricollegate a TMDB e questa volta calcoliamo anche quelli.
  // I film non vengono toccati: non usano le parole chiave.
  let migrated = 0;
  for (const [url, item] of Object.entries(cache)) {
    if (url === "__crawl") continue;
    if (item && item.type === "series" && item.extraGenreKeys === undefined) {
      delete cache[url];
      migrated++;
    }
  }
  if (migrated > 0) {
    console.log(`Migrazione: ${migrated} serie da ricollegare per i generi extra.\n`);
  }

  const state = cache.__crawl || { seen: [], queue: [] };
  const seen = new Set(state.seen);
  const queue = [...state.queue];
  const fails = new Map();

  const seed = url => {
    if (!url || seen.has(url) || !PAGE_RE.test(url)) return false;
    seen.add(url);
    queue.push(url);
    return true;
  };

  if (queue.length === 0) {
    // nuova scansione: riparto da zero (la cache TMDB resta)
    seen.clear();
    for (const p of ["", "/opere", "/professionisti", "/aziende"]) {
      const u = canon(VIX + p, VIX);
      if (!seen.has(u)) { seen.add(u); queue.push(u); }
    }
    await probePagination(seed);
    console.log(`Coda iniziale: ${queue.length} pagine\n`);
  } else {
    console.log(`Riprendo la scansione: ${queue.length} pagine in coda, ${seen.size} viste\n`);
  }

  let processed = 0;
  let active = 0;
  let lastLogged = 0;

  const persist = async () => {
    cache.__crawl = { seen: [...seen], queue };
    return save(cache);
  };

  async function handle(url) {
    const html = await http(url);
    if (!html) return;
    const $ = cheerio.load(html);

    $("a[href]").each((_i, el) => {
      const c = canon($(el).attr("href"), url);
      if (c) seed(c);
    });

    if (isWork(url) && !(url in cache)) {
      const work = parseWork($);
      if (work && !work.skip) {
        work.sourceUrl = url;
        cache[url] = await resolveTMDB(work);
        if (cache[url]) console.log(`✓ ${work.title} → ${cache[url].name}`);
      } else {
        cache[url] = null;
      }
    }
  }

  async function worker() {
    while (true) {
      if (Date.now() > DEADLINE) { stopped = true; return; }
      if (processed >= LIMIT) return;

      const url = queue.shift();
      if (!url) {
        if (active === 0) return;
        await sleep(200);
        continue;
      }

      active++;
      processed++;
      try {
        await handle(url);
      } catch (error) {
        const n = (fails.get(url) || 0) + 1;
        fails.set(url, n);
        console.log(`Errore ${url}: ${error.message} (tentativo ${n})`);
        if (n < 3) queue.push(url);
      } finally {
        active--;
      }

      await sleep(150);

      if (processed - lastLogged >= 200) {
        lastLogged = processed;
        await persist();
        const works = [...seen].filter(isWork).length;
        console.log(`--- pagine: ${processed}, in coda: ${queue.length}, opere trovate: ${works} ---`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const count = await persist();
  const works = [...seen].filter(isWork).length;

  if (stopped || queue.length) {
    console.log(`\n⏱️  Scansione non finita: ${queue.length} pagine in coda. Rilancia il sync per continuare.`);
  } else {
    console.log("\n✅ Scansione completata.");
  }

  console.log("\n============================");
  console.log(`OPERE TROVATE: ${works}`);
  console.log(`FILM:  ${count.movies}`);
  console.log(`SERIE: ${count.series}`);
  console.log("============================");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
