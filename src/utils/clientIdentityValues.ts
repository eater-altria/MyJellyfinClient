import defaultIdentity from './defaultClientIdentity.json';

export interface ClientIdentity {
  name: string;
  version: string;
  deviceName: string;
}
export const CLIENT_IDENTITY_MAX_LENGTH = 128;
export const DEFAULT_CLIENT_IDENTITY: ClientIdentity = { ...defaultIdentity };

export function normalizeClientIdentityText(value: unknown): string {
  // Strip header controls and malformed UTF-16 before URL-encoding header values.
  return typeof value === 'string'
    ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '').trim())
      .filter(character => !/^[\ud800-\udfff]$/.test(character)).slice(0, CLIENT_IDENTITY_MAX_LENGTH).join('')
    : '';
}

export function resolveClientIdentity(settings: {
  name?: unknown; version?: unknown; deviceName?: unknown;
}): ClientIdentity {
  return {
    name: normalizeClientIdentityText(settings.name) || DEFAULT_CLIENT_IDENTITY.name,
    version: normalizeClientIdentityText(settings.version) || DEFAULT_CLIENT_IDENTITY.version,
    deviceName: normalizeClientIdentityText(settings.deviceName) || DEFAULT_CLIENT_IDENTITY.deviceName,
  };
}
