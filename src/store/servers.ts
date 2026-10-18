import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createServerApi, getServerConnector, availableServerConnectors, DEFAULT_SERVER_PROTOCOL,
  normalizeAddress, type MediaServerApi, type AuthResult, type PublicSystemInfo, type ServerProtocol } from '../api/mediaServer';
import { detectServer } from '../api/detectServer';
import { getClientIdentity } from './settings';
import { normalizeClientIdentityText } from '../utils/clientIdentity';
import { planServerImport, validateSyncedServers, type SyncedServer } from '../sync/serverSync';

export class ServerRegistrationError extends Error {}

export interface SavedServer {
  id: string; // local uuid
  name: string;
  address: string;
  protocol?: ServerProtocol; // Existing saved connections default to Jellyfin.
  userId?: string;
  userName?: string;
  token?: string;
  deviceId?: string; // Explicit per-connection registration; legacy connections keep the global ID.
  clientName?: string; // Optional per-connection client name, chosen when registering a new device.
  /** Historical field, ignored by current connection behavior. */
  connectionMode?: 'standard' | 'senplayer';
  authorizationOnly?: boolean; // Public probe verified a proxy that permits only the standard auth header.
  remoteServerId?: string;
  jellyfinServerId?: string; // Legacy saved connection field.
  version?: string;
  lastConnected?: string; // ISO
  lastError?: string;
  libraryCount?: number;
  itemCount?: number;
}

interface ServersState {
  servers: SavedServer[];
  activeServerId: string | null;
  reachability: Record<string, { address: string; reachable: boolean }>;
  setReachability: (id: string, address: string, reachable: boolean) => void;
  /** live API instances keyed by saved server id */
  apis: Record<string, MediaServerApi>;
  addServer: (address: string, username: string, password: string, name?: string, onDetected?: (protocol: ServerProtocol) => void, protocol?: ServerProtocol, connectionMode?: SavedServer['connectionMode']) => Promise<SavedServer>;
  updateServer: (id: string, options: { name: string; address: string; username: string; password?: string; protocol?: ServerProtocol; connectionMode?: SavedServer['connectionMode']; onDetected?: (protocol: ServerProtocol) => void; registerNewDevice?: { clientName: string } }) => Promise<void>;
  removeServer: (id: string) => void;
  reorderServer: (id: string, targetId: string, placement: 'before' | 'after') => void;
  setActive: (id: string | null) => void;
  refreshServer: (id: string) => Promise<void>;
  getApi: (id?: string | null) => MediaServerApi | null;
  importServers: (incoming: readonly SyncedServer[], expected: readonly SavedServer[]) => void;
}

function makeApi(s: SavedServer): MediaServerApi {
  return createServerApi({ address: s.address, token: s.token, userId: s.userId, protocol: s.protocol, identity: () => {
    const identity = getClientIdentity(s.protocol ?? DEFAULT_SERVER_PROTOCOL);
    return s.clientName ? { ...identity, name: s.clientName } : identity;
  }, deviceId: s.deviceId, authorizationOnly: s.authorizationOnly });
}

const discoveryIdentities = () => Object.fromEntries(availableServerConnectors.map(({ id }) => [id, getClientIdentity(id)]));

async function prepareConnection(address: string, protocol: ServerProtocol | undefined,
  clientIdentities = discoveryIdentities()) {
  const resolveAddress = protocol && getServerConnector(protocol).loginAddress;
  if (!resolveAddress) return detectServer(address, { clientIdentities, protocol });
  return { address: resolveAddress(address), protocol, info: undefined, authorizationOnly: undefined };
}

// SenPlayer logs in before reading metadata. A blocked public endpoint must not
// discard a valid session; do not probe alternate hosts with account credentials.
async function readConnectionInfo(api: MediaServerApi): Promise<PublicSystemInfo | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const info = await api.getPublicSystemInfo(controller.signal);
    return info && typeof info.Id === 'string' && info.Id && typeof info.Version === 'string' && info.Version
      ? info : undefined;
  } catch { return undefined; }
  finally { clearTimeout(timeout); }
}

export const useServers = create<ServersState>()(
  persist(
    (set, get) => ({
      servers: [],
      activeServerId: null,
      apis: {},
      reachability: {},
      importServers(incoming, expected) {
        if (get().servers !== expected) throw new Error('本地服务器配置已改变，请重新下载后合并');
        const { servers } = planServerImport(expected, validateSyncedServers(incoming));
        // Construct everything before committing, so malformed/unsupported imports cannot partially replace live sessions.
        const apis = Object.fromEntries(servers.map(server => {
          const previous = expected.find(row => row === server);
          return [server.id, previous && get().apis[server.id] ? get().apis[server.id] : makeApi(server)];
        }));
        set(state => ({ servers, apis, reachability: {},
          activeServerId: servers.some(server => server.id === state.activeServerId) ? state.activeServerId : servers[0]?.id ?? null }));
      },
      setReachability(id, address, reachable) {
        // An old probe must not update a removed or edited connection.
        if (!get().servers.some((s) => s.id === id && s.address === address)) return;
        set((state) => ({ reachability: { ...state.reachability, [id]: { address, reachable } } }));
      },

      async addServer(address, username, password, name, onDetected, selectedProtocol) {
        const detected = await prepareConnection(address, selectedProtocol);
        const { address: base, protocol, authorizationOnly } = detected;
        onDetected?.(protocol);
        const api = createServerApi({ address: base, protocol, identity: () => getClientIdentity(protocol), authorizationOnly });
        const auth: AuthResult = await api.authenticate(username, password);
        const info = detected.info ?? await readConnectionInfo(createServerApi({ address: base, protocol,
          token: auth.token, userId: auth.userId, identity: () => getClientIdentity(protocol) }));
        const saved: SavedServer = {
          id: crypto.randomUUID(),
          name: name?.trim() || (typeof info?.ServerName === 'string' ? info.ServerName : '') || base,
          address: base,
          protocol,
          ...(authorizationOnly ? { authorizationOnly: true } : {}),
          userId: auth.userId,
          userName: auth.userName,
          token: auth.token,
          remoteServerId: auth.serverId || info?.Id,
          version: info?.Version,
          lastConnected: new Date().toISOString(),
        };
        const authed = makeApi(saved);
        try {
          const views = await authed.getUserViews();
          saved.libraryCount = views.Items.length;
          saved.itemCount = views.Items.reduce(
            (acc, v) => acc + (v.RecursiveItemCount ?? 0),
            0,
          );
        } catch {
          /* ignore */
        }
        set((st) => ({
          servers: [...st.servers, saved],
          apis: { ...st.apis, [saved.id]: authed },
          activeServerId: st.activeServerId ?? saved.id,
        }));
        return saved;
      },

      async updateServer(id, options) {
        const original = get().servers.find((s) => s.id === id);
        if (!original) throw new Error('服务器不存在');
        const address = normalizeAddress(options.address);
        let saved = { ...original, name: options.name.trim() || original.name, address };
        if (address !== original.address || options.username !== original.userName || options.password !== undefined || options.registerNewDevice
          || (options.protocol !== undefined && options.protocol !== (original.protocol ?? DEFAULT_SERVER_PROTOCOL))) {
          const identities = discoveryIdentities();
          if (options.registerNewDevice) {
            const registrationProtocol = options.protocol ?? original.protocol ?? DEFAULT_SERVER_PROTOCOL;
            if (!getServerConnector(registrationProtocol).supportsDeviceRegistration) {
              throw new ServerRegistrationError('此服务器连接器不支持重新登记登录设备');
            }
            identities[registrationProtocol] = { ...identities[registrationProtocol],
              name: normalizeClientIdentityText(options.registerNewDevice.clientName) || identities[registrationProtocol].name };
          }
          const selected = options.protocol ?? original.protocol ?? DEFAULT_SERVER_PROTOCOL;
          // Reauthenticate at an already verified route. Never rewrite a saved
          // root/proxy route merely because new Emby logins default to /emby.
          const sameEndpoint = address === original.address && selected === (original.protocol ?? DEFAULT_SERVER_PROTOCOL);
          const detected = sameEndpoint && getServerConnector(selected).loginAddress
            ? { address, protocol: selected, info: undefined, authorizationOnly: original.authorizationOnly }
            : await prepareConnection(address, options.protocol, identities);
          if (options.registerNewDevice && !getServerConnector(detected.protocol).supportsDeviceRegistration) throw new ServerRegistrationError('此服务器连接器不支持重新登记登录设备');
          options.onDetected?.(detected.protocol);
          const registration = options.registerNewDevice ? {
            deviceId: crypto.randomUUID(),
            ...(getServerConnector(detected.protocol).fixedClientIdentity ? {} : {
              clientName: normalizeClientIdentityText(options.registerNewDevice.clientName) || getClientIdentity(detected.protocol).name,
            }),
          } : {};
          const loginServer = { ...saved, ...registration, address: detected.address, protocol: detected.protocol,
            authorizationOnly: detected.authorizationOnly };
          const api = makeApi({ ...loginServer, token: undefined, userId: undefined });
          const auth = await api.authenticate(options.username, options.password ?? '');
          const info = detected.info ?? await readConnectionInfo(makeApi({ ...loginServer, token: auth.token, userId: auth.userId }));
          saved = { ...loginServer,
            userId: auth.userId, userName: auth.userName, token: auth.token,
            remoteServerId: auth.serverId || info?.Id, version: info?.Version,
            lastConnected: new Date().toISOString(), lastError: undefined,
            libraryCount: undefined, itemCount: undefined };
        }
        set((state) => ({
          servers: state.servers.map((s) => s.id === id ? saved : s),
          apis: { ...state.apis, [id]: makeApi(saved) },
        }));
      },

      reorderServer(id, targetId, placement) {
        const servers = get().servers;
        const from = servers.findIndex(server => server.id === id);
        const target = servers.findIndex(server => server.id === targetId);
        if (from < 0 || target < 0 || from === target) return;
        const next = [...servers];
        const [server] = next.splice(from, 1);
        const insertion = next.findIndex(item => item.id === targetId) + (placement === 'after' ? 1 : 0);
        if (insertion === from) return;
        next.splice(insertion, 0, server);
        // Both surfaces consume this persisted array. Keep connections/API instances intact.
        set({ servers: next });
      },

      removeServer(id) {
        set((st) => {
          const apis = { ...st.apis };
          delete apis[id];
          const reachability = { ...st.reachability };
          delete reachability[id];
          return {
            servers: st.servers.filter((s) => s.id !== id),
            apis,
            reachability,
            activeServerId: st.activeServerId === id ? null : st.activeServerId,
          };
        });
      },

      setActive(id) {
        set({ activeServerId: id });
      },

      async refreshServer(id) {
        const s = get().servers.find((x) => x.id === id);
        if (!s) return;
        const cached = get().apis[id];
        const api = cached && cached.baseUrl === s.address && cached.token === s.token
          && cached.userId === s.userId && cached.protocol === (s.protocol ?? DEFAULT_SERVER_PROTOCOL) ? cached : makeApi(s);
        const stillCurrent = () => {
          const current = get().servers.find((x) => x.id === id);
          return current?.address === s.address && current.token === s.token && current.protocol === s.protocol
            && current.userId === s.userId && current.deviceId === s.deviceId && current.clientName === s.clientName;
        };
        try {
          const views = await api.getUserViews();
          if (!stillCurrent()) return;
          set((st) => ({
            servers: st.servers.map((x) =>
              x.id === id
                ? {
                    ...x,
                    lastConnected: new Date().toISOString(),
                    lastError: undefined,
                    libraryCount: views.Items.length,
                  }
                : x,
            ),
            apis: { ...st.apis, [id]: api },
          }));
        } catch (e) {
          if (!stillCurrent()) return;
          set((st) => ({
            servers: st.servers.map((x) =>
              x.id === id ? { ...x, lastError: String(e) } : x,
            ),
          }));
        }
      },

      getApi(id) {
        const sid = id ?? get().activeServerId;
        if (!sid) return null;
        const st = get();
        if (st.apis[sid]) return st.apis[sid];
        const s = st.servers.find((x) => x.id === sid);
        if (!s || !s.token) return null;
        const api = makeApi(s);
        set((prev) => ({ apis: { ...prev.apis, [sid]: api } }));
        return api;
      },
    }),
    {
      name: 'mjc:servers',
      partialize: (st) => ({ servers: st.servers, activeServerId: st.activeServerId }),
    },
  ),
);
