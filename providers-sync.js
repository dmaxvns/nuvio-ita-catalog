// Catalogo "per piattaforma streaming", indipendente da Vix Vocal.
// Usa solo TMDB: nessuno scraping di siti esterni, solo chiamate API.
// Per ogni piattaforma disponibile in Italia, scarica i titoli più
// popolari disponibili oggi in quel catalogo (film e serie separati).

import fs from "node:fs/promises";
import { TMDB_GENRES } from "./genres.js";

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

async function discoverAllProviders() {
  const [moviesProviders, seriesProviders] = await Promise.all([
    getProviders("movie"),
    getProviders("tv")
  ]);

  const byId = new Map();
  for (const p of [...moviesProviders, ...seriesProviders]) {
    if (!byId.has(p.id)) byId.set(p.id, p);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
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

async function discoverCatalog(kind, providerId) {
  const items = [];
  let totalPages = TMDB_MAX_PAGES;

  for (let page = 1; page <= Math.min(TMDB_MAX_PAGES, totalPages); page++) {
    const data = await tmdb(`/discover/${kind}`, {
      watch_region: "IT",
      with_watch_providers: providerId,
      // Solo abbonamento (flatrate): esclude noleggio e acquisto, così
      // negozi come Apple TV, Google Play, Chili... spariscono da soli
      // se non offrono nulla in abbonamento (restano con 0 risultati).
      with_watch_monetization_types: "flatrate",
      sort_by: "popularity.desc",
      include_adult: false,
      page
    });
    if (!data?.results?.length) break;

    totalPages = data.total_pages || 1;
    for (const raw of data.results) items.push(toItem(raw, kind));

    await sleep(200);
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
