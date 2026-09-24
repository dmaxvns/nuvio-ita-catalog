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

const byPopularity = (a, b) => (b.popularity || 0) - (a.popularity || 0);
const movies = [...(catalog.movies || [])].sort(byPopularity);
const series = [...(catalog.series || [])].sort(byPopularity);

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
  const source = type === "movie" ? movies : series;

  const metas = source
    .filter(item => Array.isArray(item.genreKeys) && item.genreKeys.includes(genre))
    .slice(skip, skip + PAGE_SIZE)
    .map(toMeta);

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
