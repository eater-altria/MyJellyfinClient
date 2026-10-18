import type { ClientIdentity } from '../../utils/clientIdentityValues';
import { normalizeAddress } from '../helpers';
import { mediaBrowserAuthHeader } from './mediaBrowserAuth';

/** Wire identity observed in SenPlayer 6.2.2; keep our existing device identity. */
export const SENPLAYER_VERSION = '6.2.2';
export const SENPLAYER_CLIENT_IDENTITY = { name: 'SenPlayer', version: SENPLAYER_VERSION } as const;
export const SENPLAYER_USER_AGENT = `SenPlayer/${SENPLAYER_VERSION}`;

export function senPlayerClientIdentity(identity: ClientIdentity): ClientIdentity {
  return { ...identity, ...SENPLAYER_CLIENT_IDENTITY };
}

export function senPlayerAuthHeader(identity: ClientIdentity, deviceId: string, token?: string, userId?: string): string {
  const header = mediaBrowserAuthHeader(identity, token, 'MediaBrowser', undefined, deviceId);
  // SenPlayer puts the authenticated user before the shared device fields.
  return userId ? `MediaBrowser UserId="${encodeURIComponent(userId)}", ${header.slice('MediaBrowser '.length)}` : header;
}

export function senPlayerEmbyApiAddress(address: string): string {
  const base = normalizeAddress(address);
  return /\/(?:emby|mediabrowser)$/i.test(new URL(base).pathname) ? base : `${base}/emby`;
}
