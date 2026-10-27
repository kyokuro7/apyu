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
  if (!res.ok) throw new Error(`Upstream ${res.status} untuk ${url}`);
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
  const byHref = new Map();
  $('a[href*="/episode/"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/\/anime\/([^/]+)\/episode\/(\d+)/);
    if (!m) return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const prev = byHref.get(href);
    if (!prev || text.length > prev.text.length) {
      byHref.set(href, { anime: m[1], number: Number(m[2]), text, href });
    }
  });
  return [...byHref.values()].map((e) => ({
    anime: e.anime,
    number: e.number,
    title: (e.text.match(/EP\d+\s*-\s*(.+?)\s*(?:Subtitle|Sub)\s*Indo/i) || [])[1] || null,
    date: (e.text.match(/•\s*(.+)$/) || [])[1] || null,
    url: abs(e.href),
  }));
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
      "/anime?page=1",
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

const animeList = wrap(async (req) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const q = page > 1 ? `?page=${page}` : "";
  let lastErr;
  for (const base of ["/anime-list", "/anime"]) {
    try {
      const $ = cheerio.load(await getHtml(base + q));
      const results = parseAnimeLinks($);
      if (results.length) return { page, source: base, results };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Daftar anime kosong");
});
app.get("/anime", animeList);
app.get("/anime-list", animeList);

app.get("/anime/:slug", wrap(async (req) => {
  const $ = cheerio.load(await getHtml(`/anime/${encodeURIComponent(req.params.slug)}`));

  // Abaikan menu genre di navigasi (isinya puluhan genre di setiap halaman)
  const genres = new Set();
  $('a[href*="/genre/"]').each((_, el) => {
    let box = $(el).parent();
    while (box.length && box.find('a[href*="/genre/"]').length < 2) box = box.parent();
    if (box.find('a[href*="/genre/"]').length > 15) return;
    const g = $(el).text().trim();
    if (g) genres.add(g);
  });

  const meta = (n) => $(`meta[property="${n}"]`).attr("content") || $(`meta[name="${n}"]`).attr("content") || null;
  const rawTitle = $("h1").first().text().trim() || (meta("og:title") || "").split(" - ")[0] || "";
  const title = rawTitle.replace(/\s*(?:Sub(?:title)?\s*Indo.*|:\s*Episode.*|Episode\s*\d+.*)$/i, "").trim() || null;

  // Sinopsis = paragraf terpanjang yang bukan teks SEO
  const seo = /nonton|streaming|download|subtitle indonesia|batch/i;
  let synopsis = null;
  $("p").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (synopsis || t.length <= 60 || seo.test(t) || $(el).closest("a").length) return;
    synopsis = t;
  });

  return {
    slug: req.params.slug,
    title,
    synopsis: synopsis || meta("og:description") || meta("description"),
    poster: abs(meta("og:image")),
    genres: [...genres],
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

// Bantuan debug: /debug?path=/anime/one-piece&q=kata -> potongan HTML di sekitar kata itu
app.get("/debug", async (req, res) => {
  try {
    const path = String(req.query.path || "/");
    if (!path.startsWith("/")) return res.status(400).type("text").send("path harus diawali /");
    const html = await getHtml(path);
    const q = String(req.query.q || "");
    const i = q ? html.indexOf(q) : 0;
    if (i < 0) return res.status(404).type("text").send("kata tidak ditemukan");
    res.type("text").send(html.slice(Math.max(0, i - 500), i + 1200));
  } catch (e) {
    res.status(502).type("text").send(e.message);
  }
});

app.use((req, res) =>
  res.status(404).json({ ok: false, error: `Route tidak ada: ${req.path}`, see: "/" })
);

// Jalan lokal: node api/index.js | Di Vercel: diekspor sebagai handler
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, "0.0.0.0", () => console.log(`API jalan di port ${PORT}`));
}

module.exports = app;
