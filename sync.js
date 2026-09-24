import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import { TMDB_GENRES } from "./genres.js";

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
const LIMIT = args.limit ? Number(args.limit) : Infinity;
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

// ---------- Vix Vocal: elenco delle opere ----------

const WORK_RE = /^https?:\/\/(www\.)?vixvocal\.it\/opere\/[^/?#]+\/?$/i;

async function discoverFromSitemaps() {
  const queue = [`${VIX}/sitemap.xml`, `${VIX}/sitemap_index.xml`];

  const robots = await http(`${VIX}/robots.txt`).catch(() => null);
  if (robots) {
    for (const m of robots.matchAll(/^sitemap:\s*(\S+)/gim)) queue.push(m[1]);
  }

  const visited = new Set();
  const works = new Set();

  while (queue.length) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    const xml = await http(url).catch(() => null);
    if (!xml || !xml.includes("<loc>")) continue;

    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const loc = m[1].replace(/&amp;/g, "&");
      if (/\.xml(\.gz)?$/i.test(loc)) queue.push(loc);
      else if (WORK_RE.test(loc)) works.add(loc.replace(/\/$/, ""));
    }
  }
  return [...works];
}

async function discoverFromListing() {
  // Fallback: la pagina /opere mostra solo le prime 120 opere
  // (il resto viene caricato via JavaScript), quindi il risultato è parziale.
  const html = await http(`${VIX}/opere`);
  if (!html) return [];
  const $ = cheerio.load(html);
  const works = new Set();
  $("a[href]").each((_i, el) => {
    try {
      const abs = new URL($(el).attr("href"), VIX).href;
      if (WORK_RE.test(abs)) works.add(abs.replace(/\/$/, ""));
    } catch {}
  });
  return [...works];
}

async function discoverWorks() {
  console.log("Cerco l'elenco delle opere da sitemap.xml ...");
  let urls = await discoverFromSitemaps();

  if (urls.length > 0) {
    console.log(`Sitemap: ${urls.length} opere trovate.`);
    return urls;
  }

  console.log("");
  console.log("⚠️  Nessuna sitemap utilizzabile. Uso la pagina /opere (solo ~120 opere).");
  console.log("⚠️  Per il catalogo completo serve l'endpoint JSON usato dal pulsante");
  console.log("    'Mostra altre 120 opere' (vedi istruzioni nel README).");
  console.log("");
  urls = await discoverFromListing();
  console.log(`Pagina /opere: ${urls.length} opere trovate.`);
  return urls;
}

// ---------- Vix Vocal: singola scheda ----------

async function getVixWork(url) {
  const html = await http(url);
  if (!html) return null;

  const $ = cheerio.load(html);
  const title = $("h1").first().text().replace(/\s+/g, " ").trim();
  if (!title) return null;

  const text = $("body").text().replace(/\s+/g, " ");

  // Anno: cerca "(1999)" oppure "Anno: 1999", senza prendere anni a caso
  const yearMatch =
    text.match(/\(((?:19|20)\d{2})\)/) ||
    text.match(/\bAnno\D{0,15}((?:19|20)\d{2})\b/i);

  return {
    title,
    year: yearMatch ? Number(yearMatch[1]) : null,
    sourceUrl: url
  };
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
    i => i.media_type === "movie" || i.media_type === "tv"
  );
  if (!candidates.length) return null;

  const scored = candidates
    .map(c => ({ c, s: scoreCandidate(work, c) }))
    .sort((x, y) => y.s - x.s || (y.c.popularity || 0) - (x.c.popularity || 0));

  const { c: best, s } = scored[0];
  if (s < 90) return null; // match troppo incerto: meglio scartare

  const kind = best.media_type === "movie" ? "movie" : "tv";
  const d = await tmdb(`/${kind}/${best.id}`, { append_to_response: "external_ids" });
  if (!d) return null;

  const genreKeys = [
    ...new Set((d.genres || []).map(g => TMDB_GENRES[g.id]).filter(Boolean))
  ];

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

  for (const item of Object.values(cache)) {
    if (!item) continue;
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

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        if (Date.now() > DEADLINE) { stopped = true; return; }
        const index = next++;
        await fn(items[index], index);
      }
    })
  );
}

// ---------- Main ----------

async function main() {
  console.log("\n🇮🇹 NUVIO ITA CATALOG SYNC\n");

  let urls = await discoverWorks();
  if (!urls.length) {
    console.error("Nessuna opera trovata. Controlla la connessione o la struttura del sito.");
    process.exit(1);
  }
  if (urls.length > LIMIT) urls = urls.slice(0, LIMIT);

  const cache = await loadCache();
  const todo = urls.filter(u => !(u in cache));
  console.log(`Da elaborare: ${todo.length} (già in cache: ${urls.length - todo.length})\n`);

  let done = 0;
  await pool(todo, CONCURRENCY, async url => {
    try {
      const work = await getVixWork(url);
      cache[url] = work ? await resolveTMDB(work) : null;
      if (cache[url]) console.log(`✓ ${work.title} → ${cache[url].name}`);
    } catch (error) {
      // non salvo in cache: verrà ritentata alla prossima esecuzione
      console.log(`Errore ${url}: ${error.message}`);
    }

    await sleep(200);

    if (++done % 200 === 0) {
      await save(cache);
      console.log(`--- ${done}/${todo.length} (salvataggio intermedio) ---`);
    }
  });

  const count = await save(cache);
  if (stopped) console.log("\n⏱️  Tempo massimo raggiunto: rilancia il sync per continuare da dove si è fermato.");
  console.log("\n============================");
  console.log(`FILM:  ${count.movies}`);
  console.log(`SERIE: ${count.series}`);
  console.log("============================");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
