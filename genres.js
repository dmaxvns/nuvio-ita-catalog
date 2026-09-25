export const GENRE_NAMES = {
  action: "Azione",
  adventure: "Avventura",
  animation: "Animazione",
  comedy: "Commedia",
  crime: "Crime",
  documentary: "Documentari",
  drama: "Drammatici",
  family: "Famiglia",
  fantasy: "Fantasy",
  horror: "Horror",
  mystery: "Mistero",
  romance: "Romantici",
  scifi: "Fantascienza",
  thriller: "Thriller",
  war: "Guerra",
  western: "Western"
};

export const TMDB_GENRES = {
  28: "action",
  12: "adventure",
  16: "animation",
  35: "comedy",
  80: "crime",
  99: "documentary",
  18: "drama",
  10751: "family",
  14: "fantasy",
  27: "horror",
  9648: "mystery",
  10749: "romance",
  878: "scifi",
  53: "thriller",
  10752: "war",
  37: "western",
  // generi specifici delle serie TV
  10759: "action",
  10765: "scifi",
  10768: "war"
};


// Le serie TV su TMDB usano un elenco di generi diverso da quello dei film:
// Horror, Thriller, Fantasy (da solo) e Romantici non esistono per le serie.
// Per questo, per le serie mostriamo solo le categorie che TMDB assegna
// davvero, con nomi leggermente diversi dove copre più di un genere.
export const SERIES_GENRE_KEYS = [
  "action",
  "animation",
  "comedy",
  "crime",
  "documentary",
  "drama",
  "family",
  "mystery",
  "scifi",
  "war",
  "western"
];

export const SERIES_GENRE_NAMES = {
  ...GENRE_NAMES,
  action: "Azione e Avventura",
  scifi: "Fantascienza e Fantasy",
  war: "Guerra e Politica"
};

// ---------- Generi extra per le serie (da parole chiave TMDB) ----------
// Non sostituiscono i generi normali: una serie compare anche qui,
// oltre che nel suo genere base, se le parole chiave corrispondono.
// Le parole chiave sono in inglese (così le restituisce TMDB).

export const EXTRA_SERIES_GENRE_NAMES = {
  horror: "Horror",
  thriller: "Thriller",
  romance: "Romantici",
  supernatural: "Soprannaturale",
  teen: "Teen",
  crime_investigation: "Crime investigativo"
};

export const EXTRA_SERIES_KEYWORDS = {
  horror: [
    "horror", "slasher", "zombie", "vampire", "ghost", "haunted",
    "monster", "demon", "possession", "occult", "gore", "cannibalism"
  ],
  thriller: [
    "thriller", "psychological thriller", "serial killer", "suspense",
    "conspiracy", "cat and mouse", "manhunt", "kidnapping"
  ],
  romance: [
    "romance", "love", "romantic comedy", "love triangle", "soap opera",
    "arranged marriage", "melodrama"
  ],
  supernatural: [
    "supernatural", "witch", "witchcraft", "afterlife", "psychic",
    "paranormal", "magic", "curse", "reincarnation"
  ],
  teen: [
    "teen drama", "high school", "coming of age", "teenager", "adolescence"
  ],
  crime_investigation: [
    "detective", "police investigation", "murder investigation",
    "true crime", "cold case", "forensic", "crime scene investigation",
    "whodunit"
  ]
};

