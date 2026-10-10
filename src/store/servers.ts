import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { MediaServerApi, AuthResult, normalizeAddress, type ServerProtocol } from '../api/mediaServer';
import { detectServer } from '../api/detectServer';
import { getClientIdentity } from './settings';
import { normalizeClientIdentityText } from '../utils/clientIdentity';

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
  addServer: (address: string, username: string, password: string, name?: string, onDetected?: (protocol: ServerProtocol) => void) => Promise<SavedServer>;
  updateServer: (id: string, options: { name: string; address: string; username: string; password?: string; onDetected?: (protocol: ServerProtocol) => void; registerNewDevice?: { clientName: string } }) => Promise<void>;
  removeServer: (id: string) => void;
  setActive: (id: string | null) => void;
  refreshServer: (id: string) => Promise<void>;
  getApi: (id?: string | null) => MediaServerApi | null;
}

function makeApi(s: SavedServer): MediaServerApi {
  return new MediaServerApi(s.address, s.token, s.userId, s.protocol, () => {
    const identity = getClientIdentity(s.protocol ?? 'jellyfin');
    return s.clientName ? { ...identity, name: s.clientName } : identity;
  }, s.deviceId);
}

const discoveryIdentities = () => ({ jellyfin: getClientIdentity('jellyfin'), emby: getClientIdentity('emby') });

export const useServers = create<ServersState>()(
  persist(
    (set, get) => ({
      servers: [],
      activeServerId: null,
      apis: {},
      reachability: {},
      setReachability(id, address, reachable) {
        // An old probe must not update a removed or edited connection.
        if (!get().servers.some((s) => s.id === id && s.address === address)) return;
        set((state) => ({ reachability: { ...state.reachability, [id]: { address, reachable } } }));
      },

      async addServer(address, username, password, name, onDetected) {
        const { address: base, protocol, info } = await detectServer(address, { clientIdentities: discoveryIdentities() });
        onDetected?.(protocol);
        const api = new MediaServerApi(base, undefined, undefined, protocol, () => getClientIdentity(protocol));
        const auth: AuthResult = await api.authenticate(username, password);
        const saved: SavedServer = {
          id: crypto.randomUUID(),
          name: name?.trim() || info.ServerName || base,
          address: base,
          protocol,
          userId: auth.userId,
          userName: auth.userName,
          token: auth.token,
          remoteServerId: auth.serverId || info.Id,
          version: info.Version,
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
        if (address !== original.address || options.username !== original.userName || options.password !== undefined || options.registerNewDevice) {
          const identities = discoveryIdentities();
          if (options.registerNewDevice) {
            identities.emby = { ...identities.emby, name: normalizeClientIdentityText(options.registerNewDevice.clientName) || identities.emby.name };
          }
          const detected = await detectServer(address, { clientIdentities: identities });
          if (options.registerNewDevice && detected.protocol !== 'emby') throw new ServerRegistrationError('重新登记登录设备仅适用于 Emby 服务器');
          options.onDetected?.(detected.protocol);
          const registration = options.registerNewDevice && detected.protocol === 'emby' ? {
            deviceId: crypto.randomUUID(),
            clientName: normalizeClientIdentityText(options.registerNewDevice.clientName) || getClientIdentity(detected.protocol).name,
          } : {};
          const loginServer = { ...saved, ...registration, address: detected.address, protocol: detected.protocol };
          const api = makeApi({ ...loginServer, token: undefined, userId: undefined });
          const info = detected.info;
          const auth = await api.authenticate(options.username, options.password ?? '');
          saved = { ...loginServer,
            userId: auth.userId, userName: auth.userName, token: auth.token,
            remoteServerId: auth.serverId || info.Id, version: info.Version,
            lastConnected: new Date().toISOString(), lastError: undefined,
            libraryCount: undefined, itemCount: undefined };
        }
        set((state) => ({
          servers: state.servers.map((s) => s.id === id ? saved : s),
          apis: { ...state.apis, [id]: makeApi(saved) },
        }));
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
          && cached.userId === s.userId && cached.protocol === (s.protocol ?? 'jellyfin') ? cached : makeApi(s);
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
