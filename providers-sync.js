// Catalogo "per piattaforma streaming", indipendente da Vix Vocal.
// Usa solo TMDB: nessuno scraping di siti esterni, solo chiamate API.
// Per ogni piattaforma disponibile in Italia, scarica i titoli più
// popolari disponibili oggi in quel catalogo (film e serie separati).

import fs from "node:fs/promises";
import { TMDB_GENRES, EXTRA_SERIES_KEYWORDS } from "./genres.js";

// ---------- Configurazione ----------

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

const TMDB_API = "https://api.themoviedb.org/3";
const OUTPUT_FILE = "providers-catalog.json";

// Quante pagine di risultati scaricare per piattaforma/tipo.
// TMDB restituisce 20 titoli a pagina: 10 pagine = 200 titoli, i più popolari.
// TMDB non permette comunque di andare oltre 500 pagine (10.000 titoli):
// non è un tetto nostro, è il massimo assoluto dell'API. Non lo alziamo di
// più perché non avrebbe effetto.
const TMDB_MAX_PAGES = 500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tmdb(endpoint, params = {}) {
  const url = new URL(`${TMDB_API}${endpoint}`);
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("language", "it-IT");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url.href, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`TMDB ${res.status}`);
      return await res.json();
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(1000 * (attempt + 1) ** 2);
    }
  }
}

// ---------- Elenco piattaforme disponibili in Italia ----------

async function getProviders(kind) {
  const data = await tmdb(`/watch/providers/${kind}`, { watch_region: "IT" });
  return (data?.results || []).map(p => ({
    id: p.provider_id,
    name: p.provider_name,
    logo: p.logo_path
  }));
}

// Solo queste piattaforme, in questo ordine esatto. Gli ID sono quelli
// veri di TMDB (presi dal tuo manifest reale), non nomi da indovinare:
// non c'è ambiguità possibile, ogni ID identifica una piattaforma precisa.
const PLATFORM_WHITELIST = [
  { id: 119, name: "Amazon Prime Video" },
  { id: 8, name: "Netflix" },
  { id: 350, name: "Apple TV" },
  { id: 2, name: "Apple TV Store" },
  { id: 2149, name: "CG TV STREAMING" },
  { id: 40, name: "CHILI" },
  { id: 524, name: "Discovery+" },
  { id: 337, name: "Disney Plus" },
  { id: 3, name: "Google Play Movies" },
  { id: 1899, name: "HBO Max" },
  { id: 110, name: "Infinity+" },
  { id: 359, name: "Mediaset Infinity" },
  { id: 11, name: "Mubi" },
  { id: 2483, name: "MYmovies One" },
  { id: 39, name: "NOW TV" },
  { id: 531, name: "Paramount Plus" },
  { id: 538, name: "Plex" },
  { id: 222, name: "Rai Play" },
  { id: 35, name: "Rakuten TV" },
  { id: 29, name: "Sky Go" },
  { id: 109, name: "Timvision" },
  { id: 2680, name: "Anni Duemila Amazon Channel" },
  { id: 1727, name: "CG Collection Amazon channel" },
  { id: 1730, name: "Cine Comico Amazon Channel" },
  { id: 2717, name: "CINE Dark Amazon Channel" },
  { id: 2389, name: "Eagle Magic Amazon Channel" },
  { id: 2388, name: "Eagle No Limits Amazon Channel" },
  { id: 1729, name: "Full Action Amazon Channel" },
  { id: 1728, name: "iWonder Full Amazon channel" },
  { id: 2358, name: "Lionsgate+ Amazon Channels" },
  { id: 2141, name: "MGM Plus Amazon Channel" },
  { id: 1897, name: "MIDNIGHT FACTORY Amazon Channel" },
  { id: 2747, name: "The Film Club Amazon Channel" }
];

async function discoverAllProviders() {
  // Scarichiamo l'elenco solo per recuperare i loghi; la selezione delle
  // piattaforme non dipende più da questo elenco, solo dagli ID fissi sopra.
  const [moviesProviders, seriesProviders] = await Promise.all([
    getProviders("movie"),
    getProviders("tv")
  ]);
  const byId = new Map();
  for (const p of [...moviesProviders, ...seriesProviders]) {
    if (!byId.has(p.id)) byId.set(p.id, p);
  }

  const result = [];
  const missing = [];

  for (const entry of PLATFORM_WHITELIST) {
    const raw = byId.get(entry.id);
    if (!raw) {
      // La piattaforma potrebbe essere sparita da TMDB nel frattempo: lo
      // segnaliamo, ma continuiamo comunque a provare a interrogarla per id.
      missing.push(entry.name);
    }
    result.push({ id: entry.id, name: entry.name, logo: raw?.logo || null });
  }

  console.log(`Piattaforme richieste: ${PLATFORM_WHITELIST.length}`);
  if (missing.length) {
    console.log(`⚠️  Non presenti nell'elenco attuale di TMDB (verranno comunque provate):`);
    for (const name of missing) console.log(`   - ${name}`);
  }
  console.log("");

  return result;
}

// ---------- Titoli per piattaforma ----------

function toItem(raw, kind) {
  const date = raw.release_date || raw.first_air_date || "";
  const genreKeys = [
    ...new Set((raw.genre_ids || []).map(id => TMDB_GENRES[id]).filter(Boolean))
  ];

  return {
    tmdbId: raw.id,
    type: kind === "movie" ? "movie" : "series",
    name: raw.title || raw.name || "",
    overview: raw.overview || "",
    poster: raw.poster_path || null,
    year: date ? Number(date.slice(0, 4)) : null,
    releaseDate: date || null,
    rating: raw.vote_average || null,
    popularity: raw.popularity || 0,
    genreKeys
  };
}

// Cache condivisa tra tutte le piattaforme: se la stessa serie è su
// Netflix e Disney+, le parole chiave si scaricano una sola volta.
const seriesKeywordsCache = new Map();

async function getExtraGenreKeys(tmdbId) {
  if (seriesKeywordsCache.has(tmdbId)) return seriesKeywordsCache.get(tmdbId);

  let extraGenreKeys = [];
  try {
    const data = await tmdb(`/tv/${tmdbId}/keywords`);
    const names = (data?.results || []).map(k => (k.name || "").toLowerCase());
    extraGenreKeys = Object.entries(EXTRA_SERIES_KEYWORDS)
      .filter(([, terms]) => terms.some(term => names.some(n => n.includes(term))))
      .map(([key]) => key);
  } catch {
    // Se la richiesta fallisce per una serie, la lasciamo semplicemente
    // senza generi extra invece di far fallire tutto il sync.
  }

  seriesKeywordsCache.set(tmdbId, extraGenreKeys);
  return extraGenreKeys;
}

// Lingue originali da escludere sempre dai cataloghi per piattaforma:
// tolgono i titoli cinesi che TMDB segna disponibili in Italia ma che
// non hanno nulla a che fare con un doppiaggio italiano documentato.
const EXCLUDED_ORIGINAL_LANGUAGES = new Set(["zh", "cn"]);

async function discoverCatalog(kind, providerId) {
  const items = [];
  let totalPages = TMDB_MAX_PAGES;
  let skippedForLanguage = 0;

  for (let page = 1; page <= Math.min(TMDB_MAX_PAGES, totalPages); page++) {
    const data = await tmdb(`/discover/${kind}`, {
      watch_region: "IT",
      with_watch_providers: providerId,
      sort_by: "popularity.desc",
      include_adult: false,
      page
    });
    if (!data?.results?.length) break;

    totalPages = data.total_pages || 1;

    for (const raw of data.results) {
      if (EXCLUDED_ORIGINAL_LANGUAGES.has(raw.original_language)) {
        skippedForLanguage++;
        continue;
      }

      const item = toItem(raw, kind);
      if (kind === "tv") {
        item.extraGenreKeys = await getExtraGenreKeys(raw.id);
        await sleep(120);
      }
      items.push(item);
    }

    await sleep(200);
  }

  if (skippedForLanguage > 0) {
    console.log(`  (${skippedForLanguage} titoli in cinese esclusi)`);
  }

  return items;
}

// ---------- Main ----------

async function main() {
  console.log("\n🇮🇹 CATALOGO PER PIATTAFORMA (TMDB)\n");

  const providers = await discoverAllProviders();
  console.log(`Piattaforme trovate in Italia: ${providers.length}\n`);

  const result = [];

  const save = async () =>
    fs.writeFile(
      OUTPUT_FILE,
      JSON.stringify({ updatedAt: new Date().toISOString(), providers: result }, null, 2),
      "utf8"
    );

  for (const provider of providers) {
    console.log(`→ ${provider.name}`);

    const [movies, series] = await Promise.all([
      discoverCatalog("movie", provider.id),
      discoverCatalog("tv", provider.id)
    ]);

    // Saltiamo le piattaforme senza contenuti utili (spesso servizi minori
    // o con cataloghi troppo piccoli per meritare un catalogo dedicato).
    if (movies.length === 0 && series.length === 0) {
      console.log("  (nessun titolo trovato, saltata)");
      continue;
    }

    console.log(`  film: ${movies.length}, serie: ${series.length}`);
    result.push({ id: provider.id, name: provider.name, logo: provider.logo, movies, series });

    // Salviamo subito dopo ogni piattaforma completata: se il sync si
    // interrompe per il tempo massimo, le piattaforme già fatte restano.
    await save();
  }

  console.log("\n============================");
  console.log(`PIATTAFORME SALVATE: ${result.length}`);
  console.log("============================");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
