#!/usr/bin/env node
/**
 * Soro -> static blog + RSS generator (no dependencies, Node 18+).
 *
 * Reads the same data the Soro embed uses:
 *   1. GET  {SORO_API_BASE}/api/embed/{SORO_TOKEN}          -> JS containing SORO_ARTICLES = [...]
 *   2. GET  {SORO_API_BASE}/api/embed/{SORO_TOKEN}/article/{id} -> { content: "<html>" }
 * and writes a static site into ./dist:
 *   index.html, feed.xml, sitemap.xml, robots.txt, /<slug>/index.html
 *
 * Local testing without network:  SORO_SCRIPT_FILE=./test-fixture-embed.js SORO_OFFLINE=1 node generate.mjs
 */
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(__dirname, 'config.json'), 'utf8'));

const SORO_TOKEN = process.env.SORO_TOKEN || undefined;
const SORO_API_BASE = (process.env.SORO_API_BASE || 'https://app.trysoro.com').replace(/\/$/, '');
const SITE_URL = (process.env.SITE_URL || config.siteUrl).replace(/\/$/, '');
const OFFLINE = process.env.SORO_OFFLINE === '1';
const OUT = path.join(__dirname, 'dist');
const FEED_LIMIT = config.feedItemLimit ?? 50;

if (!SORO_TOKEN && !process.env.SORO_SCRIPT_FILE) throw new Error('Missing SORO_TOKEN');

// ---------- helpers ----------
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cdata = (s = '') => `<![CDATA[${String(s).replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
const rfc822 = (iso) => new Date(iso).toUTCString();
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Sydney' });

async function getJson(url, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'luxe-soro-feed/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return await r.json();
    } catch (e) { lastErr = e; await new Promise((res) => setTimeout(res, 800 * i)); }
  }
  throw lastErr;
}

// Pull the SORO_ARTICLES JSON array out of the embed script without executing it.
function extractArticles(scriptText) {
  const marker = 'var SORO_ARTICLES =';
  const start = scriptText.indexOf(marker);
  if (start === -1) throw new Error('SORO_ARTICLES not found - Soro may have changed the embed format');
  const arrStart = scriptText.indexOf('[', start);
  // bracket-match while respecting JSON strings
  let depth = 0, inStr = false, esc_ = false;
  for (let i = arrStart; i < scriptText.length; i++) {
    const c = scriptText[i];
    if (inStr) { if (esc_) esc_ = false; else if (c === '\\') esc_ = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return JSON.parse(scriptText.slice(arrStart, i + 1)); }
  }
  throw new Error('Could not parse SORO_ARTICLES array');
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

// ---------- 1. load articles ----------
let scriptText;
if (process.env.SORO_SCRIPT_FILE) scriptText = await readFile(process.env.SORO_SCRIPT_FILE, 'utf8');
else {
  const r = await fetch(`${SORO_API_BASE}/api/embed/${SORO_TOKEN}`, { headers: { 'user-agent': 'luxe-soro-feed/1.0' } });
  if (!r.ok) throw new Error(`Embed script fetch failed: HTTP ${r.status}`);
  scriptText = await r.text();
}
let articles = extractArticles(scriptText);
if (!articles.length) throw new Error('Soro returned zero articles - refusing to publish an empty blog');
const token = SORO_TOKEN || (scriptText.match(/var SORO_TOKEN = '([^']+)'/) || [])[1];

articles.sort((a, b) => new Date(b.isoDate) - new Date(a.isoDate));

// Unique slugs (Soro can return two articles with the same slug)
const seen = new Set();
for (const a of articles) {
  let s = a.slug;
  if (seen.has(s)) s = `${a.slug}-${a.id.slice(0, 8)}`;
  seen.add(s); a.outSlug = s;
}

// ---------- 2. fetch article bodies ----------
console.log(`Found ${articles.length} articles. Fetching content...`);
let failures = 0;
await pool(articles, 5, async (a) => {
  if (a.content) return;
  if (OFFLINE) { a.content = `<p>[offline test body for ${esc(a.title)}]</p>`; return; }
  try {
    const data = await getJson(`${SORO_API_BASE}/api/embed/${token}/article/${a.id}`);
    if (!data.content) throw new Error('empty content');
    a.content = data.content;
  } catch (e) { failures++; console.error(`FAILED ${a.slug}: ${e.message}`); }
});
if (failures) {
  // Fail loudly so the previously deployed site stays live rather than publishing a partial blog.
  console.error(`${failures} article(s) failed - aborting so nothing partial is published.`);
  process.exit(1);
}

// ---------- 3. write site ----------
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const canonicalFor = (a) => config.canonicalBase
  ? `${config.canonicalBase}?post=${encodeURIComponent(a.slug)}`
  : `${SITE_URL}/${a.outSlug}/`;
const urlFor = (a) => `${SITE_URL}/${a.outSlug}/`;

const css = await readFile(path.join(__dirname, 'style.css'), 'utf8');
const shell = ({ title, desc, canonical, body, jsonld, ogImage, ogType = 'website' }) => `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="alternate" type="application/rss+xml" title="${esc(config.siteTitle)} RSS" href="${SITE_URL}/feed.xml">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="${ogType}">
<meta property="og:url" content="${esc(canonical)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ''}
<style>${css}</style>
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
</head>
<body>
<header class="site"><div class="wrap">
  <a class="brand" href="${esc(config.mainSiteUrl)}">${esc(config.brandName)}</a>
  <nav><a href="${esc(config.mainSiteUrl)}">Main site</a><a href="${SITE_URL}/">Blog</a><a class="rss" href="${SITE_URL}/feed.xml">RSS</a></nav>
</div></header>
<main class="wrap">${body}</main>
<footer class="site"><div class="wrap">
  <p>${esc(config.footerNote)}</p>
  <p><a href="${SITE_URL}/feed.xml">Subscribe via RSS</a> &middot; <a href="${esc(config.mainSiteUrl)}">${esc(config.brandName)}</a></p>
</div></footer>
</body></html>`;

// Index
const indexBody = `<h1>${esc(config.blogHeading)}</h1>
<p class="lede">${esc(config.siteDescription)} <a href="${SITE_URL}/feed.xml">Subscribe via RSS</a>.</p>
<section class="list">
${articles.map((a) => `<a class="card" href="/${a.outSlug}/">
  ${a.image ? `<img src="${esc(a.image)}" alt="${esc(a.title)}" loading="lazy" width="140" height="100">` : ''}
  <div><h2>${esc(a.title)}</h2><p>${esc(a.excerpt)}</p><time datetime="${a.isoDate}">${fmtDate(a.isoDate)}</time></div>
</a>`).join('\n')}
</section>`;
await writeFile(path.join(OUT, 'index.html'), shell({
  title: `${config.blogHeading} | ${config.brandName}`, desc: config.siteDescription, canonical: `${SITE_URL}/`, body: indexBody,
  jsonld: { '@context': 'https://schema.org', '@type': 'Blog', name: config.siteTitle, url: `${SITE_URL}/`,
    blogPost: articles.map((a) => ({ '@type': 'BlogPosting', headline: a.title, url: urlFor(a), datePublished: a.isoDate, image: a.image || undefined })) },
}));

// Article pages
for (const a of articles) {
  const dir = path.join(OUT, a.outSlug);
  await mkdir(dir, { recursive: true });
  const body = `<p class="back"><a href="/">&larr; All articles</a></p>
<article>
<h1>${esc(a.title)}</h1>
<time datetime="${a.isoDate}">${fmtDate(a.isoDate)}</time>
${a.image ? `<img class="hero" src="${esc(a.image)}" alt="${esc(a.title)}">` : ''}
<div class="content">${a.content}</div>
</article>
${config.disclaimer ? `<aside class="disclaimer">${esc(config.disclaimer)}</aside>` : ''}`;
  await writeFile(path.join(dir, 'index.html'), shell({
    title: `${a.title} | ${config.brandName}`, desc: a.excerpt, canonical: canonicalFor(a), body, ogImage: a.image, ogType: 'article',
    jsonld: { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: a.title, description: a.excerpt,
      datePublished: a.isoDate, image: a.image || undefined, mainEntityOfPage: canonicalFor(a),
      author: { '@type': 'Organization', name: config.brandName }, publisher: { '@type': 'Organization', name: config.brandName } },
  }));
}

// RSS 2.0
const feedItems = articles.slice(0, FEED_LIMIT);
const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>${esc(config.siteTitle)}</title>
  <link>${SITE_URL}/</link>
  <description>${esc(config.siteDescription)}</description>
  <language>en-au</language>
  <lastBuildDate>${rfc822(feedItems[0].isoDate)}</lastBuildDate>
  <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
${feedItems.map((a) => `  <item>
    <title>${esc(a.title)}</title>
    <link>${urlFor(a)}</link>
    <guid isPermaLink="false">soro-${a.id}</guid>
    <pubDate>${rfc822(a.isoDate)}</pubDate>
    <description>${cdata(a.excerpt)}</description>
    <content:encoded>${cdata(a.content)}</content:encoded>
${a.image ? `    <media:content url="${esc(a.image)}" medium="image"/>\n` : ''}  </item>`).join('\n')}
</channel>
</rss>
`;
await writeFile(path.join(OUT, 'feed.xml'), feed);

// sitemap + robots
await writeFile(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${SITE_URL}/</loc><lastmod>${articles[0].isoDate.slice(0, 10)}</lastmod></url>
${articles.map((a) => `<url><loc>${urlFor(a)}</loc><lastmod>${a.isoDate.slice(0, 10)}</lastmod></url>`).join('\n')}
</urlset>
`);
await writeFile(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
if (config.cname) await writeFile(path.join(OUT, 'CNAME'), config.cname + '\n');
await writeFile(path.join(OUT, '.nojekyll'), '');

console.log(`Done: ${articles.length} articles, ${feedItems.length} in feed -> ${OUT}`);
