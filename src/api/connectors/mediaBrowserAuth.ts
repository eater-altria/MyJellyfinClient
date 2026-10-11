import type { ClientIdentity } from '../../utils/clientIdentityValues';

export function getDeviceId(): string {
  let id = localStorage.getItem('mjc:deviceId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('mjc:deviceId', id);
  }
  return id;
}

export function mediaBrowserAuthHeader(identity: ClientIdentity, token?: string, scheme: 'Emby' | 'MediaBrowser' = 'MediaBrowser', userId?: string, deviceId = getDeviceId()): string {
  const parts = [
    `Client="${encodeURIComponent(identity.name)}"`,
    `Device="${encodeURIComponent(identity.deviceName)}"`,
    `DeviceId="${encodeURIComponent(deviceId)}"`,
    `Version="${encodeURIComponent(identity.version)}"`,
  ];
  if (userId) parts.push(`UserId="${encodeURIComponent(userId)}"`);
  if (token) parts.push(`Token="${encodeURIComponent(token)}"`);
  return `${scheme} ${parts.join(', ')}`;
}
