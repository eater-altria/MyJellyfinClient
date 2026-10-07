import defaultIdentity from './defaultClientIdentity.json';

export interface ClientIdentity {
  name: string;
  version: string;
  deviceName: string;
}
export type ClientIdentityProtocol = 'jellyfin' | 'emby';
export type ClientIdentities = Record<ClientIdentityProtocol, ClientIdentity>;

export const CLIENT_IDENTITY_MAX_LENGTH = 128;
export const DEFAULT_CLIENT_IDENTITY: ClientIdentity = { ...defaultIdentity };

// Name presets only: playback capabilities still describe this application's player.
export const CLIENT_NAME_PRESETS = {
  jellyfin: ['Jellyfin Media Player', 'Jellyfin Web', 'Jellyfin Android', 'Infuse', 'SenPlayer'],
  emby: ['Emby Theater', 'Emby Web', 'Emby for Android', 'Infuse', 'SenPlayer'],
} as const;

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
  return {
    jellyfin: normalize('jellyfin' in entries ? entries.jellyfin : null),
    emby: normalize('emby' in entries ? entries.emby : null),
  };
}
