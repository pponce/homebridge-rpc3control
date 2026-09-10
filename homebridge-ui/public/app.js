import { addMissingOutlets, fromSeconds, loadConfig, newPdu, timingFields, toSeconds } from './model.js';

const hb = window.homebridge;
const form = document.querySelector('#rpc-form');
const message = document.querySelector('#rpc-message');
const pdusElement = document.querySelector('#rpc-pdus');
let blocks;
let config;
let fieldId = 0;
let revision = 0;
let syncing = false;
let syncTimer;
let testing = false;
let testButtons = [];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function feedback(text, kind = 'info') {
  message.className = `alert alert-${kind}`;
  message.textContent = text;
}

function button(label, action, className = 'btn btn-outline-secondary btn-sm') {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function field(parent, object, key, label, options = {}) {
  const wrapper = element('div', 'rpc-field');
  const id = `rpc-field-${++fieldId}`;
  const title = element('label', '', label);
  title.htmlFor = id;
  const input = element(options.choices ? 'select' : 'input', options.choices ? 'form-select' : 'form-control');
  input.id = id;
  input.name = id;
  if (options.choices) {
    for (const [value, text] of options.choices) {
      const option = element('option', '', text);
      option.value = value;
      input.append(option);
    }
  } else {
    input.type = options.type ?? 'text';
    if (options.type === 'password') input.autocomplete = 'new-password';
    if (options.type === 'number') input.step = options.seconds ? '0.001' : '1';
  }
  for (const attribute of ['min', 'max', 'maxLength', 'pattern', 'placeholder']) {
    if (options[attribute] !== undefined) input[attribute] = options[attribute];
  }
  input.required = options.required ?? false;
  input.value = options.seconds ? toSeconds(object[key], options.fallback) : (object[key] ?? options.fallback ?? '');
  input.addEventListener(options.choices ? 'change' : 'input', () => {
    object[key] = options.seconds ? fromSeconds(input.value)
      : options.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
    options.onEdit?.();
    changed();
  });
  wrapper.append(title, input);
  if (options.help) {
    const help = element('small', '', options.help);
    help.id = `${id}-help`;
    input.setAttribute('aria-describedby', help.id);
    wrapper.append(help);
  }
  parent.append(wrapper);
  return { wrapper, input };
}

function changed() {
  revision++;
  hb.disableSaveButton();
  feedback('Checking your changes…');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncConfig, 180);
}

async function syncConfig() {
  if (syncing) return;
  syncing = true;
  try {
    while (true) {
      const current = revision;
      if (!form.checkValidity()) {
        feedback('Check the required fields and allowed number ranges before saving.', 'warning');
        break;
      }
      const snapshot = structuredClone(blocks);
      const result = await hb.request('/validate', snapshot[0]);
      if (current !== revision) continue;
      if (!result.valid) { feedback(result.error, 'warning'); break; }
      await hb.updatePluginConfig(snapshot);
      if (current !== revision) continue;
      hb.enableSaveButton();
      feedback('Settings are ready. Use Save below to keep them.', 'success');
      break;
    }
  } catch {
    hb.disableSaveButton();
    feedback('Could not validate or update settings. Reopen this screen to try again; your changes have not been saved.', 'danger');
  } finally { syncing = false; }
}

function details(parent, title) {
  const container = element('details');
  container.append(element('summary', '', title));
  parent.append(container);
  return container;
}

function removalButton(label, action) {
  let armed = false;
  const remove = button(label, () => {
    if (!armed) {
      armed = true;
      remove.textContent = 'Confirm remove';
      remove.setAttribute('aria-label', `Confirm ${label.toLowerCase()}`);
      return;
    }
    action();
  }, 'btn btn-outline-danger btn-sm');
  remove.addEventListener('blur', () => { armed = false; remove.textContent = label; remove.removeAttribute('aria-label'); });
  return remove;
}

function renderOutlets(pdu, container) {
  container.replaceChildren();
  if (!pdu.outlets.length) container.append(element('p', 'rpc-empty', 'No switches yet. Set the outlet count above, then add the outlet entries. Remove any you do not want in HomeKit.'));
  for (const outlet of pdu.outlets) {
    const row = element('section', 'rpc-outlet');
    row.setAttribute('aria-label', `Outlet ${outlet.number}`);
    const grid = element('div', 'rpc-outlet-grid');
    row.append(grid);
    field(grid, outlet, 'number', 'Outlet', { type: 'number', min: 1, max: pdu.outletCount || 256, required: true });
    field(grid, outlet, 'name', 'Switch name', { required: true, maxLength: 128 });
    let reset;
    field(grid, outlet, 'mode', 'Behavior', {
      required: true,
      choices: [['power', 'Power (On / Off)'], ['reboot', 'Power-aware reboot']],
      onEdit: () => { reset.wrapper.hidden = outlet.mode !== 'reboot'; reset.input.disabled = outlet.mode !== 'reboot'; },
    });
    const behaviorHelp = element('p', 'rpc-reboot-help', 'Shows actual power state. When Off, request On to power up. When On, request Off to send the PDU native reboot command. The PDU restores power itself even if the network path drops. The switch returns to On after confirmation; it may show No Response while unreachable. Siri and scenes that turn this switch Off will reboot it.');
    behaviorHelp.hidden = outlet.mode !== 'reboot';
    grid.querySelector('select').addEventListener('change', () => { behaviorHelp.hidden = outlet.mode !== 'reboot'; });
    row.append(behaviorHelp);
    const actions = element('div', 'rpc-outlet-actions');
    reset = field(actions, outlet, 'resetAfterMs', 'Recovery check delay (seconds)', {
      type: 'number', seconds: true, fallback: 3000, min: 0.1, max: 3600, required: true,
      help: 'Seconds before checking power after an action. This never schedules an On command or forces the switch display. The PDU controls its native reboot cycle.',
    });
    reset.wrapper.hidden = outlet.mode !== 'reboot';
    reset.input.disabled = outlet.mode !== 'reboot';
    actions.append(removalButton('Remove outlet', () => {
      pdu.outlets.splice(pdu.outlets.indexOf(outlet), 1);
      renderOutlets(pdu, container);
      changed();
    }));
    row.append(actions);
    container.append(row);
  }
}

async function preview(pdu, container) {
  if (testing) return;
  testing = true;
  testButtons.forEach(node => { node.disabled = true; });
  container.replaceChildren(element('p', 'alert alert-info', 'Connecting and reading outlet states…'));
  const snapshot = structuredClone(pdu);
  try {
    const result = await hb.request('/test-connection', snapshot);
    container.replaceChildren();
    if (JSON.stringify(snapshot) !== JSON.stringify(pdu)) {
      container.append(element('p', 'alert alert-warning', 'Settings changed during the test. Run it again to check the new values.'));
    } else if (!result.ok) {
      container.append(element('p', 'alert alert-warning', result.error));
    } else {
      container.append(element('p', 'alert alert-success', 'Connection successful. This is a read-only snapshot; no outlet power commands were sent.'));
      const table = element('table', 'table table-sm');
      table.append(element('caption', '', `Outlet status checked ${new Date(result.checkedAt).toLocaleTimeString()}`));
      const head = element('thead');
      const heading = element('tr');
      for (const title of ['Outlet', 'PDU outlet name', 'State']) {
        const th = element('th', '', title);
        th.scope = 'col';
        heading.append(th);
      }
      head.append(heading);
      table.append(head);
      const body = element('tbody');
      for (const outlet of result.outlets) {
        const row = element('tr');
        for (const value of [outlet.number, outlet.name || 'Not reported', outlet.state]) row.append(element('td', '', String(value)));
        body.append(row);
      }
      table.append(body);
      container.append(table);
      if (result.outlets.some(outlet => outlet.state === 'Unknown')) {
        container.append(element('p', '', 'Some outlets were not reported. Check the total outlet count and device compatibility; missing states are shown as Unknown.'));
      }
    }
  } catch {
    container.replaceChildren(element('p', 'alert alert-danger', 'The connection test could not complete. Check the PDU address and credentials, then try again.'));
  } finally {
    testing = false;
    testButtons.forEach(node => { node.disabled = false; });
  }
}

function renderPdus() {
  pdusElement.replaceChildren();
  testButtons = [];
  if (!config.pdus.length) pdusElement.append(element('p', 'rpc-empty', 'Start with your first PDU. You can add more whenever your rack grows.'));
  for (const [index, pdu] of config.pdus.entries()) {
    const card = element('section', 'rpc-pdu');
    card.setAttribute('aria-label', `PDU ${index + 1} settings`);
    const header = element('div', 'rpc-heading');
    const title = element('h3', '', pdu.name || `PDU ${index + 1}`);
    header.append(title, removalButton('Remove PDU', () => {
      config.pdus.splice(config.pdus.indexOf(pdu), 1);
      renderPdus();
      changed();
    }));
    card.append(header);
    const connection = element('div', 'rpc-grid');
    field(connection, pdu, 'name', 'PDU name', { fallback: pdu.id, required: true, maxLength: 128, onEdit: () => { title.textContent = pdu.name; } });
    field(connection, pdu, 'host', 'IP address or hostname', { required: true, maxLength: 128, placeholder: '192.168.1.20' });
    const count = field(connection, pdu, 'outletCount', 'Total physical outlets', {
      type: 'number', min: 1, max: 256, required: true,
      help: 'Enter the count on your PDU. Changing it never removes existing switches.',
    });
    card.append(connection);
    const credentials = details(card, 'Login credentials (if your PDU asks for them)');
    const loginFields = element('div', 'rpc-grid');
    field(loginFields, pdu, 'username', 'Username', { maxLength: 256 });
    field(loginFields, pdu, 'password', 'Password', { type: 'password', maxLength: 256 });
    credentials.append(loginFields, element('p', '', 'Leave these empty if login is disabled on your PDU.'));

    const advanced = details(card, 'Advanced connection and timing settings');
    const advancedFields = element('div', 'rpc-grid');
    field(advancedFields, pdu, 'port', 'Telnet port', { type: 'number', fallback: 23, min: 1, max: 65535, required: true });
    field(advancedFields, pdu, 'id', 'Permanent PDU ID', {
      required: true, pattern: '[A-Za-z0-9_-]{1,64}', maxLength: 64,
      help: 'Generated for new PDUs. Keep it stable: changing it recreates the HomeKit accessories.',
    });
    for (const timing of timingFields) {
      field(advancedFields, pdu, timing.key, `${timing.label} (seconds)`, {
        type: 'number', seconds: true, fallback: timing.value, min: timing.min, max: timing.max, required: true, help: timing.help,
      });
    }
    advanced.append(advancedFields);
    card.append(element('h4', 'mt-3', 'Outlet switches'));
    card.append(element('p', '', 'Both behaviors show actual power state. Power switches turn outlets On or Off. Power-aware reboot switches turn an Off outlet On, or reboot an On outlet when you request Off. Changing behavior recreates that HomeKit accessory.'));
    const outletActions = element('div', 'rpc-actions');
    const outlets = element('div', 'rpc-outlets');
    outletActions.append(button('Add missing outlets', () => {
      try {
        const added = addMissingOutlets(pdu);
        renderOutlets(pdu, outlets);
        changed();
        hb.toast.info(added ? `Added ${added} outlet switch(es). Existing names and settings were kept.` : 'All physical outlet numbers already have entries.');
      } catch (error) { hb.toast.warning(error.message); }
    }));
    card.append(outletActions, outlets);
    renderOutlets(pdu, outlets);
    count.input.addEventListener('change', () => { renderOutlets(pdu, outlets); changed(); });

    const testArea = details(card, 'Test connection and preview outlet states');
    testArea.append(element('p', '', 'Reads status using these settings, even before saving. It never turns outlets on, off, or reboots them. Allow five seconds between tests.'));
    const result = element('div', 'rpc-preview');
    result.setAttribute('role', 'status');
    result.setAttribute('aria-live', 'polite');
    const test = button('Test connection', () => preview(pdu, result), 'btn btn-outline-primary');
    test.disabled = testing;
    testButtons.push(test);
    testArea.append(test, result);
    pdusElement.append(card);
  }
}

async function initialize() {
  hb.disableSaveButton();
  form.addEventListener('submit', event => event.preventDefault());
  try {
    blocks = loadConfig(await hb.getPluginConfig());
    config = blocks[0];
    field(document.querySelector('#rpc-platform'), config, 'name', 'Platform name', { fallback: 'RPC PDU Control', maxLength: 128 });
    renderPdus();
    document.querySelector('#rpc-add-pdu').addEventListener('click', () => {
      const unique = [...crypto.getRandomValues(new Uint32Array(2))].map(value => value.toString(16)).join('');
      config.pdus.push(newPdu(config.pdus.length + 1, unique));
      renderPdus();
      changed();
      pdusElement.lastElementChild?.querySelector('input')?.focus();
    });
    changed();
  } catch (error) {
    form.hidden = true;
    feedback(error.message || 'Could not load your settings. Close this screen and try again.', 'danger');
  }
}

void initialize();
