// Unofficial API untuk mirainime.com (metadata saja)
// Jalankan: npm i express cheerio && node server.js
const express = require("express");
const cheerio = require("cheerio");

const BASE = "https://mirainime.com";
const app = express();
const cache = new Map();

// Biar edge cache Vercel yang menyimpan hasilnya (cache in-memory tidak awet di serverless)
app.use((req, res, next) => {
  res.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  next();
});
const TTL = 5 * 60 * 1000; // cache 5 menit supaya tidak membebani situs

async function getHtml(path) {
  const url = path.startsWith("http") ? path : BASE + path;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < TTL) return hit.html;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; UnofficialAPI/1.0)" },
  });
  if (!res.ok) throw new Error(`Upstream ${res.status}`);
  const html = await res.text();
  cache.set(url, { html, t: Date.now() });
  return html;
}

const abs = (u) => (u ? new URL(u, BASE).href : null);
const slugOf = (href) => (href.match(/\/anime\/([^/?#]+)/) || [])[1];

// Ambil kartu anime dari link /anime/{slug} (tanpa /episode/)
function parseAnimeLinks($) {
  const seen = new Set();
  const out = [];
  $('a[href*="/anime/"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    if (href.includes("/episode/")) return;
    const slug = slugOf(href);
    if (!slug || seen.has(slug)) return;
    const title = $(el).find("img").attr("alt") || $(el).text().trim();
    if (!title) return;
    seen.add(slug);
    out.push({
      slug,
      title: title.replace(/\s+/g, " ").slice(0, 150),
      poster: abs($(el).find("img").attr("src")),
      url: abs(href),
    });
  });
  return out;
}

// Ambil episode dari link /anime/{slug}/episode/{n}
function parseEpisodes($) {
  const seen = new Set();
  const out = [];
  $('a[href*="/episode/"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/\/anime\/([^/]+)\/episode\/(\d+)/);
    if (!m || seen.has(href)) return;
    seen.add(href);
    out.push({
      anime: m[1],
      episode: Number(m[2]),
      text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 200),
      url: abs(href),
    });
  });
  return out;
}

const wrap = (fn) => async (req, res) => {
  try {
    res.json({ ok: true, data: await fn(req) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
};

app.get("/", (_, res) =>
  res.json({
    endpoints: [
      "/home",
      "/ongoing",
      "/upcoming",
      "/schedule",
      "/search?q=",
      "/genre/:name",
      "/anime/:slug",
      "/anime/:slug/episode/:n",
    ],
  })
);

app.get("/home", wrap(async () => {
  const $ = cheerio.load(await getHtml("/"));
  return { latestEpisodes: parseEpisodes($), anime: parseAnimeLinks($) };
}));

app.get("/ongoing", wrap(async () => parseAnimeLinks(cheerio.load(await getHtml("/ongoing")))));
app.get("/upcoming", wrap(async () => parseAnimeLinks(cheerio.load(await getHtml("/upcoming")))));
app.get("/schedule", wrap(async () => parseAnimeLinks(cheerio.load(await getHtml("/jadwal-tayang-anime")))));

app.get("/search", wrap(async (req) => {
  const q = encodeURIComponent(req.query.q || "");
  return parseAnimeLinks(cheerio.load(await getHtml(`/search?q=${q}`)));
}));

app.get("/genre/:name", wrap(async (req) =>
  parseAnimeLinks(cheerio.load(await getHtml(`/genre/${encodeURIComponent(req.params.name)}`)))
));

app.get("/anime/:slug", wrap(async (req) => {
  const $ = cheerio.load(await getHtml(`/anime/${encodeURIComponent(req.params.slug)}`));
  return {
    slug: req.params.slug,
    title: $("h1").first().text().trim(),
    synopsis: $('meta[name="description"]').attr("content") || null,
    poster: abs($('meta[property="og:image"]').attr("content")),
    genres: $('a[href*="/genre/"]').map((_, e) => $(e).text().trim()).get(),
    episodes: parseEpisodes($),
  };
}));

app.get("/anime/:slug/episode/:n", wrap(async (req) => {
  const $ = cheerio.load(await getHtml(`/anime/${req.params.slug}/episode/${req.params.n}`));
  return {
    title: $("h1").first().text().trim(),
    anime: req.params.slug,
    episode: Number(req.params.n),
    url: `${BASE}/anime/${req.params.slug}/episode/${req.params.n}`,
  };
}));

// Jalan lokal: node api/index.js | Di Vercel: diekspor sebagai handler
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, "0.0.0.0", () => console.log(`API jalan di port ${PORT}`));
}

module.exports = app;
