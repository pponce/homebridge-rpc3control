export const timingFields = [
  { key: 'pollingIntervalMs', label: 'Status polling', value: 60000, min: 0, max: 86400, help: 'Seconds between status checks. Use 0 to disable recurring polling, or at least 5 seconds.' },
  { key: 'cacheTtlMs', label: 'Status cache', value: 15000, min: 0, max: 86400, help: 'Seconds to reuse a confirmed status. Use 0 to refresh on every read.' },
  { key: 'connectTimeoutMs', label: 'Connection timeout', value: 3000, min: 0.1, max: 30, help: 'Seconds allowed to open a connection.' },
  { key: 'operationTimeoutMs', label: 'Operation timeout', value: 8000, min: 0.5, max: 30, help: 'Seconds allowed for a complete session. Connection previews are capped at 10 seconds.' },
  { key: 'queueTimeoutMs', label: 'Queue wait', value: 3000, min: 0.1, max: 30, help: 'Seconds a command may wait for its turn.' },
];

export function fromSeconds(value) {
  if (value === '' || !Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 1000);
}

export function toSeconds(value, fallback) { return (value ?? fallback) / 1000; }

export function addMissingOutlets(pdu) {
  if (!Number.isInteger(pdu.outletCount) || pdu.outletCount < 1 || pdu.outletCount > 256) {
    throw new Error('Enter a total outlet count from 1 to 256 first.');
  }
  const existing = new Set(pdu.outlets.map(outlet => outlet.number));
  let added = 0;
  for (let number = 1; number <= pdu.outletCount; number++) {
    if (!existing.has(number)) {
      pdu.outlets.push({ number, name: `${pdu.name || 'PDU'} Outlet ${number}`, mode: 'power' });
      added++;
    }
  }
  return added;
}

export function newPdu(index, uniqueId) {
  return { id: `pdu-${uniqueId}`, name: `PDU ${index}`, host: '', outletCount: 8, outlets: [] };
}

// Preserve Homebridge metadata, unknown settings and additional config blocks.
export function loadConfig(blocks) {
  const copy = structuredClone(blocks);
  if (!Array.isArray(copy)) throw new Error('Homebridge returned an invalid configuration.');
  if (!copy.length) copy.push({ platform: 'Rpc3Control', name: 'RPC PDU Control', pdus: [] });
  const config = copy[0];
  config.pdus ??= [];
  if (!Array.isArray(config.pdus) || config.pdus.some(pdu => !pdu || typeof pdu !== 'object' || !Array.isArray(pdu.outlets))) {
    throw new Error('The existing PDU configuration needs correction in the Homebridge JSON editor.');
  }
  return copy;
}
