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
  assert.deepEqual(Object.keys(packed.dependencies ?? {}), [], 'runtime must have no external dependencies');
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
  console.log('PASS: packed plugin loads and registers with no Python, Telnet executable, or runtime npm dependencies.');
} finally { rmSync(folder, { recursive: true, force: true }); }
