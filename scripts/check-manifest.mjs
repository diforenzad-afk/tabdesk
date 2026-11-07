import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('extension');
const errors = [];
const checks = [];

function ok(condition, message) {
  checks.push(message);
  if (!condition) errors.push(message);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));

ok(manifest.manifest_version === 3, 'manifest_version is 3');
ok(typeof manifest.name === 'string' && manifest.name.length > 0, 'name is set');
ok(/^\d+\.\d+\.\d+$/.test(manifest.version), 'version is a three-part number');

const gecko = manifest.browser_specific_settings?.gecko;
ok(typeof gecko?.id === 'string' && gecko.id.includes('@'), 'gecko id is a stable add-on id');
ok(Number.parseFloat(gecko?.strict_min_version) >= 128, 'strict_min_version is Firefox 128 or newer');

ok(manifest.chrome_url_overrides?.newtab === 'newtab.html', 'new tab is overridden by newtab.html');
ok(Array.isArray(manifest.background?.scripts) && manifest.background.scripts.join(',') === 'background.js', 'background is an event page script');
ok(manifest.background?.type === 'module', 'background scripts use ES modules');
ok(manifest.background?.service_worker === undefined, 'no service worker is declared');

const permissions = [...(manifest.permissions ?? [])].sort();
ok(JSON.stringify(permissions) === JSON.stringify(['alarms', 'storage']), 'only storage and alarms are required permissions');
ok(manifest.host_permissions === undefined || manifest.host_permissions.length === 0, 'no broad required host permissions');
ok(
  Array.isArray(manifest.optional_host_permissions)
    && manifest.optional_host_permissions.length === 1
    && manifest.optional_host_permissions[0] === 'https://*/*',
  'optional host permissions are HTTPS-only and requested per origin at runtime',
);

const csp = manifest.content_security_policy?.extension_pages ?? '';
ok(csp.includes("script-src 'self'"), 'CSP allows only packaged scripts');
ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), 'CSP forbids inline and eval');
ok(csp.includes("object-src 'none'"), 'CSP forbids plugin objects');

for (const file of ['newtab.html', 'newtab.js', 'background.js', 'styles.css', 'lib/state.js', 'lib/urls.js', 'lib/availability.js', 'lib/watch.js']) {
  ok(await exists(path.join(root, file)), `${file} exists`);
}

const files = await walk(root);
const jsFiles = files.filter((file) => file.endsWith('.js'));
const htmlFiles = files.filter((file) => file.endsWith('.html'));

for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)].map((match) => match[1]);
  ok(scriptTags.every((attrs) => /\bsrc\s*=/.test(attrs)), `${path.relative(root, file)} has no inline scripts`);
  ok(!/\son[a-z]+\s*=/i.test(html), `${path.relative(root, file)} has no inline event handlers`);
  ok(!/\b(?:src|href)\s*=\s*["']https?:\/\//i.test(html), `${path.relative(root, file)} loads no remote assets`);
}

for (const file of jsFiles) {
  const source = await readFile(file, 'utf8');
  ok(!/\binnerHTML\b/.test(source), `${path.relative(root, file)} avoids innerHTML`);
  ok(!/\beval\s*\(/.test(source) && !/\bnew\s+Function\s*\(/.test(source), `${path.relative(root, file)} avoids eval`);
}

if (errors.length > 0) {
  console.error('Manifest/static checks failed:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Manifest/static checks passed (${checks.length} checks).`);
}
