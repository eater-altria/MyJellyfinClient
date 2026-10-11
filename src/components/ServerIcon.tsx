import { getServerConnector, type ServerProtocol } from '../api/mediaServer';
import { IconJellyfin, IconEmby, IconServer } from './icons';

/** Unknown visual branding uses the generic server icon; protocol behavior stays in the connector. */
export default function ServerIcon({ protocol, size, className }: { protocol?: ServerProtocol; size?: number; className?: string }) {
  const icon = getServerConnector(protocol).icon;
  const Icon = icon === 'jellyfin' ? IconJellyfin : icon === 'emby' ? IconEmby : IconServer;
  return <Icon size={size} className={className} />;
}
