import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const archive = resolve(`${packageJson.name}-${packageJson.version}.tgz`);
const folder = mkdtempSync(join(tmpdir(), 'rpc3-package-'));
try {
  execFileSync('tar', ['-xzf', archive, '-C', folder]);
  const root = join(folder, 'package');
  const packed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(packed.dependencies ?? {}), ['@homebridge/plugin-ui-utils'], 'only the Homebridge settings server needs an external dependency');
  for (const file of ['server.js', 'public/index.html', 'public/app.js', 'public/model.js', 'public/style.css']) {
    assert.ok(readFileSync(join(root, 'homebridge-ui', file)).length, `missing custom UI asset: ${file}`);
  }
  assert.equal(readdirSync(root).includes('node_modules'), false);
  assert.equal(readdirSync(root).includes('src'), false);
  const plugin = await import(pathToFileURL(join(root, packed.main)).href);
  let registered = false;
  plugin.default({ registerPlatform(name, alias, constructor) {
    assert.equal(name, packageJson.name);
    assert.equal(alias, 'Rpc3Control');
    assert.equal(typeof constructor, 'function');
    registered = true;
  } });
  assert.equal(registered, true);
  const { VERSION } = await import(pathToFileURL(join(root, 'dist/settings.js')).href);
  assert.equal(VERSION, packageJson.version);
  const schema = JSON.parse(readFileSync(join(root, 'config.schema.json'), 'utf8'));
  assert.equal(schema.pluginAlias, 'Rpc3Control');
  assert.equal(schema.customUi, true);
  console.log('PASS: packed plugin loads and registers with no Python, Telnet executable, or installed runtime dependencies; custom UI assets are included.');
} finally { rmSync(folder, { recursive: true, force: true }); }
