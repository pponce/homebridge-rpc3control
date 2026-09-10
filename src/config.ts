import { isIP } from 'node:net';
import { PduError } from './errors.js';

export interface OutletConfig {
  number: number;
  name: string;
  mode: 'power' | 'reboot';
  resetAfterMs: number;
}

export interface PduConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  outletCount: number;
  pollingIntervalMs: number;
  cacheTtlMs: number;
  connectTimeoutMs: number;
  operationTimeoutMs: number;
  queueTimeoutMs: number;
  outlets: OutletConfig[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PduError('CONFIG', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new PduError('CONFIG', `${label} must be nonempty text without control characters (maximum 128 characters)`);
  }
  return value.trim();
}

function credential(value: unknown): string {
  if (value === undefined) return '';
  // Avoid line/command injection, while preserving intentional spaces and punctuation.
  if (typeof value !== 'string' || value.length > 256 || /[^\x20-\x7e]/.test(value)) {
    throw new PduError('CONFIG', 'Credentials must be printable ASCII text of at most 256 characters');
  }
  return value;
}

function integer(value: unknown, label: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new PduError('CONFIG', `${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function parseConfig(value: unknown): PduConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PduError('CONFIG', 'pdus must be a list');
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  return value.map((item, index) => {
    const p = object(item, `PDU ${index + 1}`);
    const id = text(p.id, 'PDU id');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new PduError('CONFIG', 'PDU id must use 1-64 letters, digits, underscores, or hyphens');
    const host = text(p.host, 'PDU host').toLowerCase().replace(/\.$/, '');
    if (!isIP(host) && !/^(?=.{1,128}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) {
      throw new PduError('CONFIG', 'PDU host must be a hostname or IP address without a URL scheme or port');
    }
    const port = integer(p.port, 'port', 1, 65535, 23);
    const endpoint = `${host}:${port}`;
    if (ids.has(id) || endpoints.has(endpoint)) throw new PduError('CONFIG', 'Duplicate PDU id or host/port');
    ids.add(id);
    endpoints.add(endpoint);
    const outletCount = integer(p.outletCount, 'outletCount', 1, 256);
    if (!Array.isArray(p.outlets)) throw new PduError('CONFIG', 'Each PDU requires an outlets list');
    const numbers = new Set<number>();
    const outlets = p.outlets.map((entry) => {
      const o = object(entry, 'Outlet');
      const number = integer(o.number, 'outlet number', 1, outletCount);
      if (numbers.has(number)) throw new PduError('CONFIG', 'Duplicate outlet number within a PDU');
      numbers.add(number);
      if (o.mode !== 'power' && o.mode !== 'reboot') throw new PduError('CONFIG', 'Outlet mode must be power or reboot');
      return {
        number,
        name: text(o.name, 'outlet name'),
        mode: o.mode,
        resetAfterMs: integer(o.resetAfterMs, 'resetAfterMs', 100, 3600000, 3000),
      } satisfies OutletConfig;
    });
    const pollingIntervalMs = integer(p.pollingIntervalMs, 'pollingIntervalMs', 0, 86400000, 60000);
    if (pollingIntervalMs > 0 && pollingIntervalMs < 5000) throw new PduError('CONFIG', 'Polling must be disabled (0) or at least 5000 ms');
    return {
      id, host, port, outletCount, outlets, pollingIntervalMs,
      name: text(p.name, 'PDU name', id),
      username: credential(p.username),
      password: credential(p.password),
      cacheTtlMs: integer(p.cacheTtlMs, 'cacheTtlMs', 0, 86400000, 15000),
      connectTimeoutMs: integer(p.connectTimeoutMs, 'connectTimeoutMs', 100, 30000, 3000),
      operationTimeoutMs: integer(p.operationTimeoutMs, 'operationTimeoutMs', 500, 30000, 8000),
      queueTimeoutMs: integer(p.queueTimeoutMs, 'queueTimeoutMs', 100, 30000, 3000),
    };
  });
}

export function accessoryKey(pduId: string, outlet: Pick<OutletConfig, 'number' | 'mode'>): string {
  return JSON.stringify([pduId, outlet.number, outlet.mode]);
}
