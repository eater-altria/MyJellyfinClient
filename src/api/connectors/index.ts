import { jellyfinConnector } from './jellyfin';
import { embyConnector } from './emby';
import type { ApiConnection, MediaServerApi, ServerConnector } from './types';

/** Add a connector here to expose it to connection, discovery and identity settings. */
export const serverConnectors = {
  jellyfin: jellyfinConnector,
  emby: embyConnector,
} as const satisfies Record<string, ServerConnector>;

export type ServerProtocol = keyof typeof serverConnectors;
export const DEFAULT_SERVER_PROTOCOL: ServerProtocol = 'jellyfin';
export const availableServerConnectors: readonly (ServerConnector & { id: ServerProtocol })[] = Object.values(serverConnectors);

export function getServerConnector(protocol: ServerProtocol = DEFAULT_SERVER_PROTOCOL): ServerConnector {
  // Persisted data can outlive a connector. Never silently send credentials using another protocol.
  if (!Object.prototype.hasOwnProperty.call(serverConnectors, protocol)) throw new Error('不支持的服务器连接器');
  return serverConnectors[protocol];
}

export function createServerApi(connection: ApiConnection & { protocol?: ServerProtocol }): MediaServerApi {
  return getServerConnector(connection.protocol).createApi(connection);
}

export const serverProtocolName = (protocol?: ServerProtocol) => getServerConnector(protocol).name;
export const supportedServerNames = availableServerConnectors.map(connector => connector.name).join(' 或 ');
export type { ApiConnection, MediaServerApi, ServerConnector, DetectedServer, DiscoveryOptions } from './types';
