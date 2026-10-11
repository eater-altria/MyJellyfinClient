import { createPortal } from 'react-dom';
import { useServerReorder } from '../store/serverReorder';
import { useServers } from '../store/servers';
import { serverProtocolName } from '../api/mediaServer';
import ServerIcon from './ServerIcon';

export default function ServerReorderFeedback({ instructionId }: { instructionId: string }) {
  const drag = useServerReorder(state => state.drag);
  const announcement = useServerReorder(state => state.announcement);
  const server = useServers(state => state.servers.find(server => server.id === drag?.sourceId));
  const online = useServers(state => server && state.reachability[server.id]?.address === server.address && state.reachability[server.id]?.reachable);
  return <>
    <p id={instructionId} className="sr-only">按住拖动调整服务器顺序，松开保存，Esc 取消。也可按 Alt 加上下方向键移动。</p>
    <span className="sr-only" role="status" aria-live="polite">{announcement?.owner === instructionId ? announcement.text : ''}</span>
    {drag?.owner === instructionId && server && createPortal(
      <div className={`server-reorder-ghost glass-surface ${drag.surface === 'grid' ? 'server-reorder-card' : 'server-reorder-row'}`} aria-hidden="true"
        style={{ width: drag.width, height: drag.height,
          left: Math.max(8, Math.min(drag.x - drag.offsetX + 6, window.innerWidth - drag.width - 8)),
          top: Math.max(8, Math.min(drag.y - drag.offsetY + 6, window.innerHeight - drag.height - 8)) }}>
        {drag.surface === 'grid' ? <>
          <div className="mb-4 flex h-11 items-center gap-3"><ServerIcon protocol={server.protocol} size={40} />
            {online && <span className="flex items-center gap-1.5 text-[11px] text-text-secondary"><span className="h-1.5 w-1.5 rounded-full bg-green-500" />服务器可达</span>}
          </div>
          <span className="truncate text-[17px] font-semibold tracking-tight">{server.name}</span>
          <span className="mt-3 text-[12px] text-text-secondary">媒体库 {server.libraryCount ?? 0} 个</span>
          <span className="glass-badge mt-auto self-start">{serverProtocolName(server.protocol)}</span>
        </> : <>
          <ServerIcon protocol={server.protocol} size={24} className="shrink-0" />
          <div className="flex min-w-0 flex-col gap-1"><span className="truncate text-[13px] font-medium">{server.name}</span>
            <span className="text-[11px] text-text-secondary">{serverProtocolName(server.protocol)}</span></div>
        </>}
      </div>, document.body,
    )}
  </>;
}
