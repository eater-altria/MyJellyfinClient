import { useState } from 'react';
import { BaseItem, MediaStream, formatDuration, formatSize } from '../api/mediaServer';
import SectionRow from './SectionRow';
import LiquidGlass from './LiquidGlass';

const yesNo = (value?: boolean) => value === undefined ? undefined : value ? '是' : '否';
const bitrate = (value?: number) => value ? `${Math.round(value / 1000)} kbps` : undefined;

function StreamCard({ stream }: { stream: MediaStream }) {
  const type = stream.Type === 'Video' ? '视频' : stream.Type === 'Audio' ? '音频' : '字幕';
  const fps = stream.RealFrameRate ?? stream.AverageFrameRate;
  const fields: [string, string | number | undefined][] = [
    ['标题', stream.DisplayTitle ?? stream.Title], ['语言', stream.Language],
    ['编码', stream.Codec?.toUpperCase()], ['布局', stream.ChannelLayout], ['声道', stream.Channels],
    ['分辨率', stream.Width && stream.Height ? `${stream.Width} × ${stream.Height}` : undefined],
    ['帧率', fps ? `${fps.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} fps` : undefined],
    ['比特率', bitrate(stream.BitRate)], ['采样率', stream.SampleRate ? `${stream.SampleRate} Hz` : undefined],
    ['动态范围', stream.VideoRangeType ?? stream.VideoRange], ['配置', stream.Profile], ['级别', stream.Level],
    ['长宽比', stream.AspectRatio], ['交错', stream.Type === 'Video' ? yesNo(stream.IsInterlaced) : undefined],
    ['位深', stream.BitDepth], ['像素格式', stream.PixelFormat], ['色彩空间', stream.ColorSpace],
    ['色彩原色', stream.ColorPrimaries], ['传递函数', stream.ColorTransfer],
    ['外部', yesNo(stream.IsExternal)], ['默认', yesNo(stream.IsDefault)],
    ['强制', stream.Type === 'Subtitle' ? yesNo(stream.IsForced) : undefined],
  ];
  return (
    <article className="glass-surface media-stream-glass w-[260px] shrink-0 rounded-[24px] p-5">
      <h3 className="mb-3 flex items-center gap-2 text-[14px] font-semibold">
        {type}{stream.Index != null && <span className="text-xs font-normal text-gray-400">#{stream.Index}</span>}
        {stream.IsDefault && <span className="glass-badge text-[10px] text-accent">默认</span>}
      </h3>
      <dl className="space-y-2 text-[12px]">
        {fields.filter(([, value]) => value !== undefined && value !== '').map(([label, value]) => (
          <div key={label} className="grid grid-cols-[64px_minmax(0,1fr)] gap-2">
            <dt className="text-text-secondary">{label}</dt><dd className="min-w-0 [overflow-wrap:anywhere] text-text-primary">{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

export default function MediaInfo({ item, serverName }: { item: BaseItem; serverName?: string }) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const sources = item.MediaSources ?? [];
  const source = sources[sourceIndex] ?? sources[0];
  if (!source) return null;
  const streams = source.MediaStreams?.filter((s) => ['Video', 'Audio', 'Subtitle'].includes(s.Type ?? '')) ?? [];
  const path = source.Path ?? item.Path;
  const filename = path?.split(/[\\/]/).pop();
  return (
    <section className="mt-7" aria-label="媒体信息">
      <LiquidGlass intensity="prominent" className="media-info-panel">
      {sources.length > 1 && <div className="mb-3 flex flex-wrap items-center gap-3 text-[13px]">
        <label htmlFor="media-source-version" className="text-text-secondary">文件版本</label><select id="media-source-version" className="glass-input min-w-0 max-w-full px-4 py-2 sm:max-w-lg" value={sourceIndex} onChange={(e) => setSourceIndex(Number(e.target.value))}>
          {sources.map((s, i) => <option key={s.Id} value={i}>{s.Name ?? `版本 ${i + 1}`}</option>)}
        </select>
      </div>}
      <SectionRow title="媒体信息">
        {streams.map((stream, i) => <StreamCard key={`${source.Id}-${stream.Index ?? i}`} stream={stream} />)}
      </SectionRow>
      <div className="glass-surface media-file-glass mt-4 rounded-[24px] px-5 py-5 text-[12px]">
        <div className="break-all font-medium">{filename ?? source.Name ?? item.Name}</div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-text-secondary">
          {[serverName, source.Container?.toUpperCase(), formatSize(source.Size),
            formatDuration(source.RunTimeTicks ?? item.RunTimeTicks), bitrate(source.Bitrate)].filter(Boolean).map((value, i) => <span key={i}>{value}</span>)}
        </div>
        {path && <div className="mt-2 break-all text-[11px] text-text-secondary">{path}</div>}
      </div>
      </LiquidGlass>
    </section>
  );
}
