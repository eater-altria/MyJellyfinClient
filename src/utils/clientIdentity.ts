import { availableServerConnectors, type ServerProtocol } from '../api/connectors';
import { normalizeClientIdentityText, type ClientIdentity } from './clientIdentityValues';
export * from './clientIdentityValues';

export type ClientIdentityProtocol = ServerProtocol;
export type ClientIdentities = Record<ServerProtocol, ClientIdentity>;

// Presets are metadata; player capabilities are supplied by the actual player.
export const CLIENT_NAME_PRESETS = Object.fromEntries(availableServerConnectors.map(({ id, clientNamePresets }) =>
  [id, clientNamePresets])) as Record<ServerProtocol, readonly string[]>;

export function normalizeClientIdentities(value: unknown): ClientIdentities {
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalize = (entry: unknown): ClientIdentity => {
    const fields = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
    return {
      name: normalizeClientIdentityText('name' in fields ? fields.name : ''),
      version: normalizeClientIdentityText('version' in fields ? fields.version : ''),
      deviceName: normalizeClientIdentityText('deviceName' in fields ? fields.deviceName : ''),
    };
  };
  return Object.fromEntries(availableServerConnectors.map(({ id }) =>
    [id, normalize(id in entries ? (entries as Record<string, unknown>)[id] : null)])) as ClientIdentities;
}
