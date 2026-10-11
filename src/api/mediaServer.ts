/** Stable application entry point; backend implementations live in connectors/. */
import { createServerApi, getServerConnector, DEFAULT_SERVER_PROTOCOL, type ServerProtocol } from './connectors';
import { DEFAULT_CLIENT_IDENTITY, type ClientIdentity } from '../utils/clientIdentityValues';
import type { MediaServerApi as MediaServerApiContract } from './connectors/types';

export * from './types';
export * from './helpers';
export { createServerApi, getServerConnector, availableServerConnectors, DEFAULT_SERVER_PROTOCOL,
  serverProtocolName, supportedServerNames } from './connectors';
export type { ServerProtocol, ServerConnector, ApiConnection } from './connectors';
export type MediaServerApi = MediaServerApiContract;

/** Backwards-compatible constructor. New callers should use createServerApi. */
export const MediaServerApi = function (
  baseUrl: string, token?: string, userId?: string, protocol: ServerProtocol = DEFAULT_SERVER_PROTOCOL,
  identity: () => ClientIdentity = () => DEFAULT_CLIENT_IDENTITY, deviceId?: string, authorizationOnly = false,
) {
  return createServerApi({ address: baseUrl, token, userId, protocol, identity, deviceId, authorizationOnly });
} as unknown as { new (
  baseUrl: string, token?: string, userId?: string, protocol?: ServerProtocol,
  identity?: () => ClientIdentity, deviceId?: string, authorizationOnly?: boolean,
): MediaServerApi };

/** Credential-free public discovery headers. */
export function clientIdentityHeaders(identity: ClientIdentity = DEFAULT_CLIENT_IDENTITY,
  protocol: ServerProtocol = DEFAULT_SERVER_PROTOCOL): Record<string, string> {
  return getServerConnector(protocol).publicHeaders(identity);
}
