import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const siteDirectory = resolve(scriptDirectory, '../../site');
const pagePath = join(siteDirectory, 'index.html');
const stylesheetPath = join(siteDirectory, 'styles.css');

await access(pagePath);
await access(stylesheetPath);

const html = await readFile(pagePath, 'utf8');
const stylesheet = await readFile(stylesheetPath, 'utf8');
assert.match(html, /<main\b/i, 'The guide should have a main landmark.');
assert.match(html, /<h1\b/i, 'The guide should have a page heading.');
assert.match(html, /styles\.css/, 'The guide should load its stylesheet.');
assert.ok(stylesheet.length > 0, 'The site stylesheet should not be empty.');
assert.match(stylesheet, /--background:\s*#0b1015/i, 'The guide should use the mobile app background color.');
assert.match(stylesheet, /--accent:\s*#f3a444/i, 'The guide should use the mobile app accent color.');
assert.match(stylesheet, /@media\s*\(max-width:\s*760px\)/, 'The guide should have a responsive mobile layout.');

const requiredSections = ['windows', 'linux', 'pairing', 'troubleshooting'];
const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/gi)].map((match) => match[1]));
for (const section of requiredSections) {
  assert.ok(ids.has(section), `The guide is missing its ${section} section.`);
}

const pageText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
for (const requiredContent of [
  'node.js 20',
  'native linux',
  'proton',
  'experimental',
  'demo mode',
  'trusted wi-fi',
  '3210',
  'public internet',
]) {
  assert.ok(pageText.includes(requiredContent), `The guide is missing required content: ${requiredContent}`);
}

const localIds = new Map([[pagePath, ids]]);
const references = [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)];
const links = [...html.matchAll(/\bhref=["']([^"']+)["']/gi)].map((match) => match[1]);
for (const requiredLink of [
  'https://github.com/LeviM-0323/ATS-Companion',
  'https://github.com/LeviM-0323/ATS-Companion/releases',
  'https://github.com/LeviM-0323/ATS-Companion/tree/main/mobile',
]) {
  assert.ok(links.includes(requiredLink), `The guide is missing a required link: ${requiredLink}`);
}

for (const [, reference] of references) {
  if (/^(?:https?:|mailto:|data:)/i.test(reference)) {
    if (/^https?:/i.test(reference)) {
      const url = new URL(reference);
      assert.ok(url.hostname, `Invalid external URL: ${reference}`);
    }
    continue;
  }

  const resolvedUrl = new URL(reference, pathToFileURL(pagePath));
  assert.equal(resolvedUrl.protocol, 'file:', `Unsupported local reference: ${reference}`);
  const targetPath = resolve(decodeURIComponent(resolvedUrl.pathname));
  await access(targetPath);
  if (resolvedUrl.hash) {
    if (!localIds.has(targetPath)) {
      const targetHtml = await readFile(targetPath, 'utf8');
      localIds.set(
        targetPath,
        new Set([...targetHtml.matchAll(/\bid=["']([^"']+)["']/gi)].map((match) => match[1])),
      );
    }
    assert.ok(
      localIds.get(targetPath).has(decodeURIComponent(resolvedUrl.hash.slice(1))),
      `Broken local link fragment: ${reference}`,
    );
  }
}

console.log('GitHub Pages guide checks passed.');
