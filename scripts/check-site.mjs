import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('public');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const files = walk(root);
const htmlFiles = files.filter(file => file.endsWith('.html'));
const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
assert.equal(new Set(urls).size, urls.length, 'Duplicate sitemap URL');
assert.equal([...sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].every(match => match[1] === '2026-10-17'), true);
const routes = new Map();

function assetFor(url) {
  const name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  return [name, `${name}.html`, name ? `${name.replace(/\/$/, '')}/index.html` : 'index.html']
    .map(candidate => path.resolve(root, candidate))
    .find(candidate => candidate.startsWith(`${root}${path.sep}`) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/);
  const ownPath = canonical?.[1] || `https://dropitover.com/${path.relative(root, file).replaceAll(path.sep, '/')}`;
  assert.doesNotMatch(html, /class="ad-slot"|class="ad-label"|<ins\b[^>]*adsbygoogle|>Advertisement</, file);
  for (const script of html.matchAll(/<script[^>]*src="([^"]*adsbygoogle[^\"]*)"/g)) {
    assert.ok(html.indexOf(script[0]) < html.indexOf('</head>'), `Ad script outside head: ${file}`);
  }
  for (const schema of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(schema[1]);
  if (canonical && !/name="robots" content="noindex/.test(html)) {
    assert.ok(urls.includes(canonical[1]), `Missing sitemap entry: ${canonical[1]}`);
    routes.set(new URL(canonical[1]).pathname, file);
    assert.match(html, /<h1\b/, `No static heading: ${file}`);
  }
  if (file === path.join(root, 'guides', 'index.html')) {
    const main = html.match(/<main>([\s\S]*?)<\/main>/)[1];
    const count = main.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).length;
    assert.ok(count >= 1000 && count <= 1500, `Guide hub: ${count} words`);
  }
  if (/[\\/](guides|vs)[\\/]/.test(file) && !file.endsWith(`${path.sep}index.html`)) {
    const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/)?.[1];
    assert.ok(article, `No static article: ${file}`);
    const words = article.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).length;
    assert.ok(words >= 1000 && words <= 1500, `${file}: ${words} article words`);
    assert.match(article, /<table\b/, `No practical matrix: ${file}`);
    assert.match(article, /Calculat|calculat/, `Unlabeled performance estimates: ${file}`);
  }
  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    assert.ok(match[1] !== '#', `Placeholder anchor: ${file}`);
    const url = new URL(match[1].replaceAll('&amp;', '&'), ownPath);
    if (url.origin !== 'https://dropitover.com') continue;
    const target = assetFor(url);
    assert.ok(target, `Broken local link: ${file} -> ${url.pathname}`);
    if (url.hash) {
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(content.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `Missing fragment: ${file} -> ${url.href}`);
    }
  }
}
for (const url of urls) {
  assert.equal(new URL(url).origin, 'https://dropitover.com');
  assert.ok(assetFor(new URL(url)), `Missing sitemap page: ${url}`);
}
const robots = fs.readFileSync(path.join(root, 'robots.txt'), 'utf8');
for (const agent of ['Googlebot', 'Mediapartners-Google']) assert.ok(robots.includes(`User-agent: ${agent}`));
assert.match(robots, /Sitemap: https:\/\/dropitover.com\/sitemap.xml/);
const ads = fs.readFileSync(path.join(root, 'ads.txt'), 'utf8').trim();
assert.equal(ads, 'google.com, pub-8645479142211810, DIRECT, f08c47fec0942fa0');
console.log(`Static checks passed: ${htmlFiles.length} HTML files, all local links/fragments, 17 article lengths, ${urls.length} sitemap URLs.`);

const base = process.argv[2];
if (base) {
  const paths = [...routes.keys(), '/guides', '/sitemap.xml', '/robots.txt', '/ads.txt'];
  for (const agent of ['Mozilla/5.0', 'Googlebot', 'Mediapartners-Google']) {
    for (const pathname of paths) {
      const res = await fetch(new URL(pathname, base), { redirect: 'manual', headers: { 'user-agent': agent }, signal: AbortSignal.timeout(15000) });
      assert.equal(res.status, 200, `${agent} ${pathname}: ${res.status}`);
      const body = await res.text();
      if (routes.has(pathname) || pathname === '/guides') {
        assert.match(res.headers.get('content-type'), /text\/html/);
        assert.match(body, /<h1\b/);
        const expected = fs.readFileSync(routes.get(pathname) || routes.get('/guides/'), 'utf8').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)[1];
        assert.ok(body.includes(expected), `Wrong page or stale content: ${pathname}`);
      }
      if (pathname === '/ads.txt') assert.equal(body.trim(), ads);
    }
  }
  for (const pathname of ['/this-page-does-not-exist', '/guides/not-a-real-guide']) {
    assert.equal((await fetch(new URL(pathname, base), { redirect: 'manual' })).status, 404, `Soft 404: ${pathname}`);
  }
  console.log(`HTTP checks passed: ${paths.length} routes for browsers, Googlebot, and Mediapartners-Google; unknown pages return 404.`);
}
