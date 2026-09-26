import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENRE_NAMES,
  SERIES_GENRE_KEYS,
  SERIES_GENRE_NAMES,
  EXTRA_SERIES_GENRE_NAMES
} from "./genres.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "catalog.json");
const PROVIDERS_FILE = path.join(__dirname, "providers-catalog.json");
const PORT = process.env.PORT || 10000;
const PAGE_SIZE = 100;

// Il catalogo viene letto una sola volta all'avvio.
let catalog = { updatedAt: null, source: "", movies: [], series: [] };
try {
  catalog = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch (error) {
  console.error("Impossibile leggere catalog.json:", error.message);
}

// Catalogo per piattaforma streaming, indipendente da Vix Vocal.
// Se il file non esiste ancora (prima del primo providers-sync), l'addon
// funziona comunque: semplicemente non compare nessun catalogo extra.
let providersData = { updatedAt: null, providers: [] };
try {
  providersData = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
} catch (error) {
  console.log("providers-catalog.json non trovato: cataloghi per piattaforma disattivati.");
}
const providers = providersData.providers || [];

const movies = catalog.movies || [];
const series = catalog.series || [];

// Ordine casuale "pesato": ogni volta che si apre un catalogo (skip = 0)
// i titoli vengono rimescolati, ma i più popolari hanno più probabilità
// di finire in alto. Le pagine successive usano lo stesso ordine.
const orders = new Map();

function shuffledByPopularity(list) {
  return list
    .map(item => {
      const weight = Math.sqrt(Math.max(item.popularity || 0, 0)) + 1;
      return { item, key: Math.random() ** (1 / weight) };
    })
    .sort((a, b) => b.key - a.key)
    .map(x => x.item);
}

function getExtraOrder(key, fresh) {
  const cacheKey = `extra:${key}`;
  if (fresh || !orders.has(cacheKey)) {
    const list = series.filter(
      item => Array.isArray(item.extraGenreKeys) && item.extraGenreKeys.includes(key)
    );
    orders.set(cacheKey, shuffledByPopularity(list));
  }
  return orders.get(cacheKey);
}

const latestOrders = new Map();

const providerOrders = new Map();

function getProviderOrder(providerId, type) {
  const cacheKey = `${providerId}:${type}`;
  if (!providerOrders.has(cacheKey)) {
    const provider = providers.find(p => String(p.id) === String(providerId));
    const source = provider ? (type === "movie" ? provider.movies : provider.series) || [] : [];
    // Non mescoliamo: qui l'ordine riflette la popolarità attuale sulla
    // piattaforma, non serve varietà come nei cataloghi Vix Vocal.
    const list = [...source].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    providerOrders.set(cacheKey, list);
  }
  return providerOrders.get(cacheKey);
}

// Cataloghi "per genere, da tutte le piattaforme insieme": un film o una
// serie disponibile su più servizi compare una sola volta, con l'elenco
// di dove si trova.
let combinedStreaming = null;

function getCombinedStreaming(type) {
  if (!combinedStreaming) combinedStreaming = { movie: new Map(), series: new Map() };
  if (combinedStreaming[type].size === 0) {
    for (const provider of providers) {
      const source = (type === "movie" ? provider.movies : provider.series) || [];
      for (const item of source) {
        const key = item.tmdbId;
        if (combinedStreaming[type].has(key)) {
          combinedStreaming[type].get(key).platforms.push(provider.name);
        } else {
          combinedStreaming[type].set(key, { ...item, platforms: [provider.name] });
        }
      }
    }
  }
  return [...combinedStreaming[type].values()];
}

const streamingGenreOrders = new Map();

function getStreamingGenreOrder(type, genre) {
  const cacheKey = `${type}:${genre}`;
  if (!streamingGenreOrders.has(cacheKey)) {
    const list = getCombinedStreaming(type)
      .filter(item => Array.isArray(item.genreKeys) && item.genreKeys.includes(genre))
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    streamingGenreOrders.set(cacheKey, list);
  }
  return streamingGenreOrders.get(cacheKey);
}

function getLatestOrder(type) {
  if (!latestOrders.has(type)) {
    const source = type === "movie" ? movies : series;
    // Finché non tutte le opere hanno la data esatta (dopo la migrazione),
    // quelle che hanno solo l'anno vengono messe in fondo al loro anno.
    const sortKey = item => item.releaseDate || (item.year ? `${item.year}-00-00` : "0000-00-00");
    const list = [...source]
      .filter(item => item.releaseDate || item.year)
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)) || ((b.popularity || 0) - (a.popularity || 0)));
    latestOrders.set(type, list);
  }
  return latestOrders.get(type);
}

function getOrder(type, genre, fresh) {
  const cacheKey = `${type}:${genre}`;
  if (fresh || !orders.has(cacheKey)) {
    const source = type === "movie" ? movies : series;
    const list = source.filter(
      item => Array.isArray(item.genreKeys) && item.genreKeys.includes(genre)
    );
    orders.set(cacheKey, shuffledByPopularity(list));
  }
  return orders.get(cacheKey);
}

function toMeta(item) {
  const meta = {
    id: item.imdbId || `tmdb:${item.tmdbId}`,
    type: item.type,
    name: item.name
  };
  if (item.poster) meta.poster = `https://image.tmdb.org/t/p/w500${item.poster}`;
  if (item.overview || item.platforms) {
    const platformLine = item.platforms?.length ? `\n\n📺 Disponibile su: ${item.platforms.join(", ")}` : "";
    meta.description = (item.overview || "") + platformLine;
  }
  if (item.year) meta.releaseInfo = String(item.year);
  if (item.rating) meta.imdbRating = Number(item.rating).toFixed(1);
  const names = item.type === "series" ? SERIES_GENRE_NAMES : GENRE_NAMES;
  const genres = (item.genreKeys || []).map(k => names[k]).filter(Boolean);
  if (genres.length) meta.genres = genres;
  return meta;
}

function createManifest() {
  const catalogs = [];

  catalogs.push({
    type: "movie",
    id: "ita_movie_latest",
    name: "🇮🇹 Film — Ultime uscite",
    extra: [{ name: "skip" }]
  });

  for (const [key, name] of Object.entries(GENRE_NAMES)) {
    catalogs.push({
      type: "movie",
      id: `ita_movie_${key}`,
      name: `🇮🇹 Film — ${name}`,
      extra: [{ name: "skip" }]
    });
  }

  for (const key of SERIES_GENRE_KEYS) {
    catalogs.push({
      type: "series",
      id: `ita_series_${key}`,
      name: `🇮🇹 Serie — ${SERIES_GENRE_NAMES[key]}`,
      extra: [{ name: "skip" }]
    });
  }

  catalogs.push({
    type: "series",
    id: "ita_series_latest",
    name: "🇮🇹 Serie — Ultime uscite",
    extra: [{ name: "skip" }]
  });

  for (const [key, name] of Object.entries(EXTRA_SERIES_GENRE_NAMES)) {
    catalogs.push({
      type: "series",
      id: `ita_series_extra_${key}`,
      name: `🇮🇹 Serie — ${name}`,
      extra: [{ name: "skip" }]
    });
  }

  // Un catalogo film e uno serie per ogni piattaforma streaming disponibile
  // in Italia (dati da TMDB/JustWatch, non da Vix Vocal).
  for (const provider of providers) {
    if (provider.movies?.length) {
      catalogs.push({
        type: "movie",
        id: `prov_movie_${provider.id}`,
        name: `🇮🇹 ${provider.name} — Film`,
        extra: [{ name: "skip" }]
      });
    }
    if (provider.series?.length) {
      catalogs.push({
        type: "series",
        id: `prov_series_${provider.id}`,
        name: `🇮🇹 ${provider.name} — Serie`,
        extra: [{ name: "skip" }]
      });
    }
  }

  // Cataloghi per genere che uniscono tutte le piattaforme insieme
  // (stesso titolo su più servizi appare una volta sola).
  for (const [key, name] of Object.entries(GENRE_NAMES)) {
    if (getStreamingGenreOrder("movie", key).length > 0) {
      catalogs.push({
        type: "movie",
        id: `str_movie_${key}`,
        name: `🇮🇹 In streaming — Film — ${name}`,
        extra: [{ name: "skip" }]
      });
    }
  }

  for (const key of SERIES_GENRE_KEYS) {
    if (getStreamingGenreOrder("series", key).length > 0) {
      catalogs.push({
        type: "series",
        id: `str_series_${key}`,
        name: `🇮🇹 In streaming — Serie — ${SERIES_GENRE_NAMES[key]}`,
        extra: [{ name: "skip" }]
      });
    }
  }

  return {
    id: "com.nuvio.italian.catalog",
    version: "1.0.0",
    name: "🇮🇹 Nuvio ITA",
    description: "Film e serie con doppiaggio italiano documentato.",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs
  };
}

const app = express();

app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  next();
});

app.get("/", (_req, res) => {
  res.type("html").send(`
    <h1>🇮🇹 Nuvio ITA</h1>
    <p>Addon cataloghi italiani.</p>
    <p><a href="/manifest.json">Manifest</a></p>
    <p><a href="/health">Health</a></p>
  `);
});

app.get("/manifest.json", (_req, res) => {
  res.json(createManifest());
});

app.get(["/catalog/:type/:id.json", "/catalog/:type/:id/:extra.json"], (req, res) => {
  const { type, id, extra } = req.params;
  if (type !== "movie" && type !== "series") return res.json({ metas: [] });

  const skip = Number(new URLSearchParams(extra || "").get("skip")) || 0;
  const extraPrefix = `ita_${type}_extra_`;
  const prefix = `ita_${type}_`;
  const providerPrefix = `prov_${type}_`;
  const streamingGenrePrefix = `str_${type}_`;

  let ordered;

  if (id.startsWith(providerPrefix)) {
    const providerId = id.slice(providerPrefix.length);
    ordered = getProviderOrder(providerId, type);
  } else if (id.startsWith(streamingGenrePrefix)) {
    const genre = id.slice(streamingGenrePrefix.length);
    const validGenres = type === "series" ? SERIES_GENRE_KEYS : Object.keys(GENRE_NAMES);
    if (!validGenres.includes(genre)) return res.json({ metas: [] });
    ordered = getStreamingGenreOrder(type, genre);
  } else if (id === `ita_${type}_latest`) {
    ordered = getLatestOrder(type);
  } else if (type === "series" && id.startsWith(extraPrefix)) {
    const key = id.slice(extraPrefix.length);
    if (!(key in EXTRA_SERIES_GENRE_NAMES)) return res.json({ metas: [] });
    ordered = getExtraOrder(key, skip === 0);
  } else if (id.startsWith(prefix)) {
    const genre = id.slice(prefix.length);
    const validGenres = type === "series" ? SERIES_GENRE_KEYS : Object.keys(GENRE_NAMES);
    if (!validGenres.includes(genre)) return res.json({ metas: [] });
    ordered = getOrder(type, genre, skip === 0);
  } else {
    return res.json({ metas: [] });
  }

  const metas = ordered.slice(skip, skip + PAGE_SIZE).map(toMeta);

  res.set("Cache-Control", "no-store");
  res.json({ metas });
});

app.get("/stats", (_req, res) => {
  const countByGenre = (source, key, names) =>
    Object.fromEntries(
      Object.keys(names).map(g => [
        names[g],
        source.filter(item => Array.isArray(item[key]) && item[key].includes(g)).length
      ])
    );

  const yearStats = source => {
    const years = source.map(item => item.year).filter(Boolean);
    if (!years.length) return { min: null, max: null, per_decennio: {} };

    const perDecade = {};
    for (const y of years) {
      const decade = `${Math.floor(y / 10) * 10}s`;
      perDecade[decade] = (perDecade[decade] || 0) + 1;
    }
    // Ordina i decenni dal più recente al più vecchio
    const ordered = Object.fromEntries(
      Object.entries(perDecade).sort((a, b) => b[0].localeCompare(a[0]))
    );

    return { min: Math.min(...years), max: Math.max(...years), per_decennio: ordered };
  };

  res.json({
    movies: {
      totale: movies.length,
      con_anno: movies.filter(m => m.year).length,
      anni: yearStats(movies),
      generi: countByGenre(movies, "genreKeys", GENRE_NAMES)
    },
    serie: {
      totale: series.length,
      con_anno: series.filter(s => s.year).length,
      anni: yearStats(series),
      generi: Object.fromEntries(
        SERIES_GENRE_KEYS.map(g => [
          SERIES_GENRE_NAMES[g],
          series.filter(item => Array.isArray(item.genreKeys) && item.genreKeys.includes(g)).length
        ])
      ),
      generi_extra: countByGenre(series, "extraGenreKeys", EXTRA_SERIES_GENRE_NAMES)
    },
    piattaforme: {
      aggiornato: providersData.updatedAt,
      totale: providers.length,
      dettaglio: Object.fromEntries(
        providers.map(p => [p.name, { film: p.movies?.length || 0, serie: p.series?.length || 0 }])
      )
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    source: catalog.source,
    updatedAt: catalog.updatedAt,
    movies: movies.length,
    series: series.length,
    piattaforme: providers.length,
    piattaforme_aggiornate: providersData.updatedAt
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🇮🇹 Nuvio ITA in ascolto sulla porta ${PORT}`);
});
