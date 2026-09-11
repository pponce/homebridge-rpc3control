import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { parseConfig } from '../dist/config.js';
import { config } from './fake-pdu.mjs';
import themeFixture from './theme-fixture.cjs';

test('settings UI preserves config, controls visibility, previews safely and fits mobile', { timeout: 60000 }, async t => {
  const fixture = [{ platform: 'Rpc3Control', name: 'RPC PDU Control', _bridge: { username: 'AA:BB:CC:DD:EE:FF' }, future: { keep: true }, pdus: [config(23, { id: 'rack', name: 'Main rack', resetAfterMs: 1250 })] }];
  fixture[0].pdus[0].outlets[0].resetAfterMs = 1250;
  const mock = `<script>
    window.__blocks = ${JSON.stringify(fixture)};
    window.__enabled = false;
    window.__updates = 0;
    window.homebridge = {
      getPluginConfig: async () => structuredClone(window.__blocks),
      updatePluginConfig: async blocks => {
        await new Promise(resolve => setTimeout(resolve, 40));
        window.__blocks = structuredClone(blocks); window.__updates++;
      },
      disableSaveButton: () => { window.__enabled = false; },
      enableSaveButton: () => { window.__enabled = true; },
      toast: { info() {}, warning() {} },
      request: async (path, body) => {
        const response = await fetch('/api' + path, { method: 'POST', body: JSON.stringify(body) });
        return response.json();
      }
    };
  </script>`;
  const server = createServer(async (request, response) => {
    try {
      if (request.url.startsWith('/api')) {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        let result;
        if (request.url === '/api/validate') {
          try { parseConfig(body.pdus); result = { valid: true }; }
          catch (error) { result = { valid: false, error: error.message }; }
        } else {
          result = { ok: true, checkedAt: new Date().toISOString(), outlets: [{ number: 1, name: '<img src=x onerror=alert(1)>', state: 'On' }, { number: 2, name: '', state: 'Unknown' }] };
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(result));
        return;
      }
      const path = request.url === '/' ? 'index.html' : request.url.slice(1);
      if (!['index.html', 'app.js', 'model.js', 'style.css'].includes(path)) { response.writeHead(404).end(); return; }
      const content = await readFile(`homebridge-ui/public/${path}`, 'utf8');
      response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(path === 'index.html' ? `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${mock}${content}` : content);
    } catch { response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__enabled);
  const first = page.getByRole('region', { name: 'PDU 1 settings' });
  assert.equal(await first.getByLabel('Recovery check delay (seconds)').isVisible(), false);
  assert.equal(await first.getByLabel('Status cache (seconds)').isVisible(), false);
  await first.getByLabel('Behavior').selectOption({ label: 'Power-aware reboot' });
  assert.ok((await first.locator('.rpc-reboot-help').textContent()).includes('PDU restores power itself'));
  assert.equal(await first.locator('.rpc-reboot-help').isVisible(), true);
  await first.getByLabel('Recovery check delay (seconds)').fill('2.75');
  await page.waitForFunction(() => window.__enabled && window.__blocks[0].pdus[0].outlets[0].resetAfterMs === 2750);
  await first.getByText('Advanced connection and timing settings', { exact: true }).click();
  await first.getByLabel('Status cache (seconds)').fill('15.001');
  await page.waitForFunction(() => window.__enabled && window.__blocks[0].pdus[0].cacheTtlMs === 15001);
  await first.getByLabel('Total physical outlets').fill('4');
  await first.getByRole('button', { name: 'Add missing outlets' }).click();
  await page.waitForFunction(() => window.__enabled && window.__blocks[0].pdus[0].outlets.length === 4);
  assert.equal(await first.getByLabel('Switch name', { exact: true }).first().inputValue(), 'Outlet 1');
  await first.getByLabel('Total physical outlets').fill('2');
  await page.waitForFunction(() => !window.__enabled);
  await page.waitForTimeout(400);
  assert.equal(await first.locator('.rpc-outlet').count(), 4);
  assert.equal(await page.evaluate(() => window.__enabled), false);
  await first.getByLabel('Total physical outlets').fill('4');
  await first.getByLabel('PDU name', { exact: true }).fill('Office rack');
  await page.waitForFunction(() => window.__enabled && window.__blocks[0].pdus[0].name === 'Office rack');
  const saved = await page.evaluate(() => window.__blocks);
  assert.deepEqual(saved[0]._bridge, fixture[0]._bridge);
  assert.deepEqual(saved[0].future, fixture[0].future);
  assert.equal(saved[0].pdus[0].id, 'rack');
  await first.getByText('Test connection and preview outlet states', { exact: true }).click();
  await first.getByRole('button', { name: 'Test connection', exact: true }).click();
  await first.getByText('Connection successful.', { exact: false }).waitFor();
  assert.equal(await first.locator('.rpc-preview img').count(), 0);
  assert.ok((await first.locator('.rpc-preview').textContent()).includes('Unknown'));
  await mkdir('test-results', { recursive: true });
  await themeFixture.checkThemeContrast(page, '.rpc-settings', 'test-results/settings');
  await page.screenshot({ path: 'test-results/settings-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: 'test-results/settings-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole('button', { name: 'Add PDU', exact: true }).click();
  const second = page.getByRole('region', { name: 'PDU 2 settings' });
  await second.getByLabel('IP address or hostname').fill('other-pdu.local');
  await second.getByRole('button', { name: 'Add missing outlets' }).click();
  await page.waitForFunction(() => window.__enabled && window.__blocks[0].pdus.length === 2);
  assert.equal(await second.locator('.rpc-outlet').count(), 8);
  await second.getByRole('button', { name: 'Remove PDU', exact: true }).click();
  await second.getByRole('button', { name: 'Confirm remove pdu', exact: true }).click();
  await page.waitForFunction(() => window.__enabled && window.__blocks[0].pdus.length === 1);
  assert.deepEqual(errors, []);
});
