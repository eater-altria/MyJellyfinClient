import { availableServerConnectors, DEFAULT_SERVER_PROTOCOL } from '../api/mediaServer';
import type { SavedServer } from '../store/servers';

export const SYNC_MAX_BYTES = 2 * 1024 * 1024;
const FORMAT = 'myjellyfinclient-servers';
const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const aad = encoder.encode(`${FORMAT}:1`);

export type SyncedServer = Required<Pick<SavedServer, 'id' | 'name' | 'address' | 'protocol' | 'userId' | 'token' | 'deviceId'>>
  & Pick<SavedServer, 'userName' | 'clientName' | 'authorizationOnly' | 'remoteServerId' | 'version'>;
export interface ServerSnapshot { format: typeof FORMAT; version: 1; servers: SyncedServer[]; }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('同步配置格式无效');
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('同步配置包含无效字段');
  }
  return value;
}

/** Whitelist fields: never restore transient metadata or arbitrary persisted state. */
export function validateSyncedServers(value: unknown): SyncedServer[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('同步配置的服务器列表无效或过大');
  const ids = new Set<string>();
  return value.map(entry => {
    const row = object(entry);
    const protocol = availableServerConnectors.find(connector => connector.id === row.protocol)?.id;
    if (!protocol) throw new Error('同步配置包含当前版本不支持的服务器类型，请升级客户端');
    const address = text(row.address, 8192);
    let url: URL;
    try { url = new URL(address); } catch { throw new Error('同步配置的服务器地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      throw new Error('同步配置的服务器地址无效');
    }
    const result: SyncedServer = {
      id: text(row.id, 256), name: text(row.name, 8192), address, protocol,
      userId: text(row.userId, 1024), token: text(row.token, 16384), deviceId: text(row.deviceId, 128),
    };
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(result.id) || ['__proto__', 'constructor', 'prototype'].includes(result.id)) {
      throw new Error('同步配置的连接标识无效');
    }
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(result.deviceId)) throw new Error('同步配置的设备标识无效');
    for (const key of ['userName', 'clientName', 'remoteServerId', 'version'] as const) {
      if (row[key] !== undefined) result[key] = text(row[key], 1024);
    }
    if (row.authorizationOnly !== undefined) {
      if (typeof row.authorizationOnly !== 'boolean') throw new Error('同步配置的鉴权模式无效');
      result.authorizationOnly = row.authorizationOnly;
    }
    if (ids.has(result.id)) throw new Error('同步配置包含重复的服务器连接');
    ids.add(result.id);
    return result;
  });
}

export function createServerSnapshot(servers: readonly SavedServer[], fallbackDeviceId: string): ServerSnapshot {
  // Resolve legacy global IDs on the exporting device. Never use the receiving device's global ID with an imported token.
  const rows = servers.map(server => ({ ...server, protocol: server.protocol ?? DEFAULT_SERVER_PROTOCOL,
    deviceId: server.deviceId ?? fallbackDeviceId, remoteServerId: server.remoteServerId ?? server.jellyfinServerId }));
  return { format: FORMAT, version: 1, servers: validateSyncedServers(rows) };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

function unbase64(value: unknown, max: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('同步密文格式无效');
  }
  try {
    const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
    if (bytes.length > max) throw new Error();
    return bytes;
  } catch { throw new Error('同步密文格式无效'); }
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持安全加密，请使用桌面版或 HTTPS 网页');
  if (passphrase.length < 10 || passphrase.length > 1024 || !passphrase.trim()) throw new Error('加密口令须为 10–1024 个字符');
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptServerSnapshot(snapshot: ServerSnapshot, passphrase: string): Promise<string> {
  const payload = encoder.encode(JSON.stringify({ format: FORMAT, version: 1, servers: validateSyncedServers(snapshot.servers) }));
  if (payload.length > SYNC_MAX_BYTES / 2) throw new Error('同步配置过大');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, payload);
  return JSON.stringify({ format: FORMAT, version: 1, algorithm: 'PBKDF2-SHA256/AES-256-GCM', iterations: ITERATIONS,
    salt: base64(salt), iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) });
}

export async function decryptServerSnapshot(encrypted: string, passphrase: string): Promise<ServerSnapshot> {
  if (encoder.encode(encrypted).length > SYNC_MAX_BYTES) throw new Error('同步配置过大');
  let envelope: Record<string, unknown>;
  try { envelope = object(JSON.parse(encrypted)); } catch { throw new Error('同步密文格式无效'); }
  if (envelope.format !== FORMAT || envelope.version !== 1 || envelope.algorithm !== 'PBKDF2-SHA256/AES-256-GCM'
    || envelope.iterations !== ITERATIONS) throw new Error('不支持此同步文件格式或版本');
  const salt = unbase64(envelope.salt, 16), iv = unbase64(envelope.iv, 12);
  const ciphertext = unbase64(envelope.ciphertext, SYNC_MAX_BYTES / 2 + 16);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) throw new Error('同步密文格式无效');
  const key = await deriveKey(passphrase, salt);
  let payload: unknown;
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ciphertext);
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch { throw new Error('无法解密配置：口令不正确或文件已损坏'); }
  const parsed = object(payload);
  if (parsed.format !== FORMAT || parsed.version !== 1) throw new Error('不支持此同步配置版本');
  return { format: FORMAT, version: 1, servers: validateSyncedServers(parsed.servers) };
}

function connectionKey(server: SavedServer): string {
  const address = new URL(server.address);
  address.pathname = address.pathname.replace(/\/+$/, '');
  return JSON.stringify([server.protocol ?? DEFAULT_SERVER_PROTOCOL, address.toString(), server.userId]);
}

/** Remote order wins; connections unique to this device survive. Independently added identical accounts reuse their local ID. */
export function planServerImport(local: readonly SavedServer[], incoming: readonly SyncedServer[]) {
  const claimed = new Set<string>();
  let added = 0, updated = 0;
  const servers: SavedServer[] = incoming.map(remote => {
    const candidates = local.filter(server => connectionKey(server) === connectionKey(remote) && !claimed.has(server.id));
    const existing = local.find(server => server.id === remote.id)
      ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (existing && claimed.has(existing.id)) throw new Error('同步配置的服务器身份发生冲突');
    const id = existing?.id ?? remote.id;
    claimed.add(id);
    if (existing) updated++; else added++;
    return { ...remote, id };
  });
  return { servers: [...servers, ...local.filter(server => !claimed.has(server.id))], added, updated,
    retained: local.filter(server => !claimed.has(server.id)).length };
}
