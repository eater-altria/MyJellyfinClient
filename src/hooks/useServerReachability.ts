import { useEffect } from 'react';
import { MediaServerApi, type ServerProtocol } from '../api/mediaServer';
import { useServers } from '../store/servers';
import { getClientIdentity } from '../store/settings';

const INTERVAL_MS = 30_000;
const TIMEOUT_MS = 5_000;

/** Mounted once by App, including while the sidebar is hidden for playback. */
export function useServerReachability() {
  const connections = useServers((s) => JSON.stringify(s.servers.map(({ id, address, protocol }) => ({ id, address, protocol }))));

  useEffect(() => {
    const servers = JSON.parse(connections) as { id: string; address: string; protocol?: ServerProtocol }[];
    let disposed = false;
    let checking = false;
    const requests = new Set<AbortController>();
    const probe = async () => {
      if (checking || disposed) return;
      checking = true;
      try {
        await Promise.all(servers.map(async ({ id, address, protocol }) => {
          const controller = new AbortController();
          requests.add(controller);
          const timeout = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
          let reachable = false;
          try {
            const saved = useServers.getState().servers.find((s) => s.id === id && s.address === address);
            const api = saved ? useServers.getState().getApi(id) : null;
            const info = await (api ?? new MediaServerApi(address, saved?.token, saved?.userId, protocol,
              () => getClientIdentity(protocol ?? 'jellyfin'))).getPublicSystemInfo(controller.signal);
            // A proxy returning an unrelated JSON page is not a supported media server.
            reachable = !!(info.Id || info.ServerName || info.Version);
          } catch {
            // Network errors, timeouts and invalid responses all hide the dot.
          } finally {
            window.clearTimeout(timeout);
            requests.delete(controller);
          }
          if (!disposed) useServers.getState().setReachability(id, address, reachable);
        }));
      } finally {
        checking = false;
      }
    };
    void probe();
    const interval = window.setInterval(() => { void probe(); }, INTERVAL_MS);
    const checkNow = () => { void probe(); };
    window.addEventListener('online', checkNow);
    window.addEventListener('focus', checkNow);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      requests.forEach((controller) => controller.abort());
      window.removeEventListener('online', checkNow);
      window.removeEventListener('focus', checkNow);
    };
  }, [connections]);
}
