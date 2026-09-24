import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GENRE_NAMES } from "./genres.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "catalog.json");
const PORT = process.env.PORT || 10000;
const PAGE_SIZE = 100;

// Il catalogo viene letto una sola volta all'avvio.
let catalog = { updatedAt: null, source: "", movies: [], series: [] };
try {
  catalog = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch (error) {
  console.error("Impossibile leggere catalog.json:", error.message);
}

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
  if (item.overview) meta.description = item.overview;
  if (item.year) meta.releaseInfo = String(item.year);
  if (item.rating) meta.imdbRating = Number(item.rating).toFixed(1);
  const genres = (item.genreKeys || []).map(k => GENRE_NAMES[k]).filter(Boolean);
  if (genres.length) meta.genres = genres;
  return meta;
}

function createManifest() {
  const catalogs = [];
  for (const [type, label] of [["movie", "Film"], ["series", "Serie"]]) {
    for (const [key, name] of Object.entries(GENRE_NAMES)) {
      catalogs.push({
        type,
        id: `ita_${type}_${key}`,
        name: `🇮🇹 ${label} — ${name}`,
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
  const prefix = `ita_${type}_`;

  if ((type !== "movie" && type !== "series") || !id.startsWith(prefix)) {
    return res.json({ metas: [] });
  }

  const genre = id.slice(prefix.length);
  if (!GENRE_NAMES[genre]) return res.json({ metas: [] });

  const skip = Number(new URLSearchParams(extra || "").get("skip")) || 0;
  const ordered = getOrder(type, genre, skip === 0);

  const metas = ordered.slice(skip, skip + PAGE_SIZE).map(toMeta);

  res.set("Cache-Control", "no-store");
  res.json({ metas });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    source: catalog.source,
    updatedAt: catalog.updatedAt,
    movies: movies.length,
    series: series.length
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🇮🇹 Nuvio ITA in ascolto sulla porta ${PORT}`);
});
