import { availableServerConnectors, getServerConnector, supportedServerNames } from './connectors';
import { ServerDetectionError, type DetectedServer, type DiscoveryOptions } from './connectors/types';
import { normalizeAddress } from './helpers';

export { ServerDetectionError } from './connectors/types';
export type { DetectedServer, DiscoveryOptions } from './connectors/types';

/** Credentials are sent only after discovery succeeds; manual choice stays authoritative. */
export async function detectServer(input: string, options: DiscoveryOptions = {}): Promise<DetectedServer> {
  let address: string;
  try { address = normalizeAddress(input); }
  catch { throw new ServerDetectionError('服务器地址无效，请输入 HTTP 或 HTTPS 地址'); }
  const connectors = options.protocol ? [getServerConnector(options.protocol)] : availableServerConnectors;
  const handlers = [...new Set(connectors.map(connector => connector.discover))];
  let failure: ServerDetectionError | undefined;
  for (const discover of handlers) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      // Manual selection controls auth/product, while related API aliases remain discoverable.
      return await discover(address, options, availableServerConnectors.filter(connector => connector.discover === discover));
    } catch (error) {
      if (!(error instanceof ServerDetectionError)) throw error;
      failure = error;
    }
  }
  throw failure ?? new ServerDetectionError(`未检测到 ${supportedServerNames} 服务器，请检查地址、网络和反向代理路径`);
}
