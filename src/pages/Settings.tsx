import { useEffect, useState } from 'react';
import { useSettings, AccentColor, AppSettings, PLAYER_CACHE_MIN_MB, PLAYER_CACHE_MAX_MB,
  CLIENT_IDENTITY_MAX_LENGTH, CLIENT_NAME_PRESETS, DEFAULT_CLIENT_IDENTITY } from '../store/settings';
import Toggle from '../components/Toggle';
import LiquidGlass from '../components/LiquidGlass';
import { isTauri } from '../platform/window';
import type { ClientIdentity, ClientIdentityProtocol } from '../utils/clientIdentity';
import {
  IconSettings,
  IconList,
  IconLibrary,
  IconPlay,
  IconMonitor,
  IconGesture,
  IconVideo,
  IconAudio,
  IconSubtitle,
  IconDanmaku,
  IconCheck,
} from '../components/icons';

/* ---------------- shared building blocks ---------------- */

function Section({
  label,
  children,
  footnote,
}: {
  label: string;
  children: React.ReactNode;
  footnote?: string;
}) {
  return (
    <section className="mb-7">
      <h3 className="mb-2.5 px-5 text-[12px] font-medium text-text-secondary">{label}</h3>
      <div className="glass-surface divide-y divide-black/[0.045] overflow-hidden">
        {children}
      </div>
      {footnote && (
        <p className="mt-2.5 px-5 text-[12px] leading-relaxed text-text-secondary">{footnote}</p>
      )}
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4">
      <div className="min-w-0 text-[13px] text-text-primary">{label}</div>
      <div className="flex max-w-full flex-shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function ToggleRow<K extends keyof AppSettings>({
  label,
  field,
  disabled,
}: {
  label: string;
  field: K extends keyof AppSettings
    ? AppSettings[K] extends boolean
      ? K
      : never
    : never;
  disabled?: boolean;
}) {
  const value = useSettings((s) => s[field]) as boolean;
  const set = useSettings((s) => s.set);
  return (
    <Row label={label}>
      <Toggle label={label} disabled={disabled} on={value} onChange={(v) => set(field, v as AppSettings[typeof field])} />
    </Row>
  );
}

const selectCls =
  'glass-input max-w-full rounded-full px-3 py-1.5 text-[12px] no-drag disabled:cursor-not-allowed disabled:opacity-50';

function SelectRow<K extends keyof AppSettings>({
  label,
  field,
  options,
  numeric,
  disabled,
}: {
  label: string;
  field: K;
  options: { label: string; value: string }[];
  numeric?: boolean;
  disabled?: boolean;
}) {
  const value = useSettings((s) => s[field]);
  const set = useSettings((s) => s.set);
  return (
    <Row label={label}>
      <select
        aria-label={label}
        className={selectCls}
        value={String(value)}
        disabled={disabled}
        onChange={(e) =>
          set(field, (numeric ? Number(e.target.value) : e.target.value) as AppSettings[K])
        }
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

/* ---------------- tabs ---------------- */

function IdentityTextRow({ protocol, label, field, placeholder }: {
  protocol: ClientIdentityProtocol; label: string; field: keyof ClientIdentity; placeholder: string;
}) {
  const value = useSettings(s => s.clientIdentities[protocol][field]);
  const set = useSettings(s => s.setClientIdentity);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = () => {
    set(protocol, field, draft);
    setDraft(useSettings.getState().clientIdentities[protocol][field]);
  };
  return <Row label={label}>
    <input aria-label={`${protocol === 'jellyfin' ? 'Jellyfin' : 'Emby'} ${label}`} value={draft} placeholder={placeholder} maxLength={CLIENT_IDENTITY_MAX_LENGTH}
      autoComplete="off" spellCheck={false} onChange={event => setDraft(event.target.value)} onBlur={save}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); save(); } }}
      className={`${selectCls} w-64`} />
  </Row>;
}

function ClientIdentitySection({ protocol }: { protocol: ClientIdentityProtocol }) {
  const name = useSettings(s => s.clientIdentities[protocol].name);
  const set = useSettings(s => s.setClientIdentity);
  const product = protocol === 'jellyfin' ? 'Jellyfin' : 'Emby';
  const presets = CLIENT_NAME_PRESETS[protocol];
  const [custom, setCustom] = useState(false);
  const isPreset = presets.some(preset => preset === name);
  const selected = custom || (name && !isPreset) ? 'custom' : name || 'default';
  return <Section label={`${product} 客户端标识`}
    footnote={`用于 ${product} 的登录与服务器鉴权，留空使用 RodelPlayer 默认标识，按回车或离开输入框保存。桌面版 HTTP User-Agent 统一采用小幻格式；这些字段仅调整鉴权标识。${protocol === 'emby' ? '重新登记连接时填写的客户端名称优先于此预设；已有设备可能保留首次登记信息。' : '预设改变后用于后续请求；服务器显示的信息可能暂时保留。'}`}>
    <Row label="客户端预设">
      <select aria-label={`${product} 客户端预设`} value={selected} className={`${selectCls} w-64`}
        onChange={event => {
          const value = event.target.value;
          setCustom(value === 'custom');
          if (value === 'default') {
            set(protocol, 'name', ''); set(protocol, 'version', ''); set(protocol, 'deviceName', '');
          } else if (presets.some(preset => preset === value)) {
            set(protocol, 'name', value);
          }
        }}>
        <option value="default">{DEFAULT_CLIENT_IDENTITY.name}（默认）</option>
        {presets.map(preset => <option key={preset} value={preset}>{preset}</option>)}
        <option value="custom">自定义</option>
      </select>
    </Row>
    {selected === 'custom' && <IdentityTextRow protocol={protocol} label="客户端名称" field="name" placeholder={DEFAULT_CLIENT_IDENTITY.name} />}
    <IdentityTextRow protocol={protocol} label="客户端版本" field="version" placeholder={DEFAULT_CLIENT_IDENTITY.version} />
    <IdentityTextRow protocol={protocol} label="设备名称" field="deviceName" placeholder={DEFAULT_CLIENT_IDENTITY.deviceName} />
  </Section>;
}

const ACCENTS: AccentColor[] = [
  '#0a84ff',
  '#30b0c7',
  '#34c759',
  '#bf5af2',
  '#ff9f0a',
  '#ff6482',
  '#ff453a',
  '#7d7aff',
];

function GeneralTab() {
  const accent = useSettings((s) => s.accentColor);
  const defaultModule = useSettings((s) => s.defaultModule);
  const set = useSettings((s) => s.set);
  return (
    <div>
      <Section label="主题颜色">
        <div className="flex flex-wrap items-center gap-3 px-5 py-5">
          {ACCENTS.map((c) => {
            const active = c === accent;
            return (
              <button
                key={c}
                aria-label={`主题颜色 ${c}`}
                aria-pressed={active}
                onClick={() => set('accentColor', c)}
                className={`relative flex h-9 w-9 items-center justify-center rounded-full shadow-sm transition-transform hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent no-drag ${
                  active ? 'ring-2 ring-offset-4 ring-accent/30' : ''
                }`}
                style={{ background: c }}
              >
                {active && <IconCheck size={16} className="text-white" />}
              </button>
            );
          })}
        </div>
      </Section>
      <Section label="通用">
        <Row label="默认启动模块">
          <select
            aria-label="默认启动模块"
            className={selectCls}
            value={defaultModule}
            onChange={(e) =>
              set('defaultModule', e.target.value as AppSettings['defaultModule'])
            }
          >
            <option value="files">文件</option>
            <option value="servers">服务器</option>
            <option value="iptv">IPTV</option>
            <option value="history">记录</option>
            <option value="search">搜索</option>
          </select>
        </Row>
      </Section>
      <ClientIdentitySection protocol="jellyfin" />
      <ClientIdentitySection protocol="emby" />
      <div className="mt-10 flex justify-center">
        <button
          className="glass-button px-5 py-2.5 text-[13px] text-red-600"
          onClick={() => {
            if (window.confirm('确定恢复所有默认设置？')) {
              useSettings.getState().reset();
            }
          }}
        >
          恢复默认设置
        </button>
      </div>
    </div>
  );
}

function ListTab() {
  const previewTime = useSettings((s) => s.previewTimePercent);
  const previewEnabled = useSettings((s) => s.showPreviewImage);
  const preferCover = useSettings((s) => s.preferEmbeddedCover);
  const set = useSettings((s) => s.set);
  return (
    <div>
      <Section label="页面配置">
        <ToggleRow label="列表标题显示项目数量" field="showItemCountInTitle" />
        <ToggleRow label="文件夹项目显示添加时间" field="showFolderTime" />
      </Section>
      <Section label="排序">
        <ToggleRow label="文件夹独立排序" field="sortFoldersSeparately" />
      </Section>
      <Section label="页面样式">
        <ToggleRow label="缩略图铺满" field="thumbnailFill" />
      </Section>
      <Section
        label="预览图"
        footnote="关闭封面优先后，使用最接近指定时间的服务器章节缩略图；服务器未生成章节图时回退到封面。"
      >
        <ToggleRow label="显示媒体预览图" field="showPreviewImage" />
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <label htmlFor="preview-time" className="flex-shrink-0 text-[13px]">视频预览图时间</label>
          <input
            id="preview-time"
            type="range"
            min={0}
            max={100}
            value={previewTime}
            disabled={!previewEnabled || preferCover}
            onChange={(e) => set('previewTimePercent', Number(e.target.value))}
            className="min-w-[80px] flex-1 accent-[var(--accent)] no-drag"
          />
          <div className="w-11 flex-shrink-0 text-right text-[12px] tabular-nums text-text-secondary">
            {previewTime}%
          </div>
        </div>
        <ToggleRow label="优先使用服务器封面" field="preferEmbeddedCover" disabled={!previewEnabled} />
      </Section>
      <Section label="进度">
        <ToggleRow label="显示播放进度" field="showPlayProgress" />
      </Section>
      <Section
        label="媒体信息展示"
        footnote="只显示服务器提供的媒体信息；缺少分辨率、HDR 或文件大小等元信息时不生成猜测值。"
      >
        <ToggleRow label="媒体时长" field="showMediaDuration" />
        <ToggleRow label="文件大小" field="showFileSize" />
        <ToggleRow label="New 标记" field="showNewBadge" />
        <ToggleRow label="HDR 标记" field="showHdrBadge" />
        <ToggleRow label="帧率" field="showFrameRate" />
        <ToggleRow label="分辨率" field="showResolution" />
        <ToggleRow label="分辨率简化显示" field="simplifyResolution" />
      </Section>
    </div>
  );
}

function InfoCard({ text }: { text: string }) {
  return (
    <div className="glass-surface px-6 py-12 text-center text-[13px] leading-relaxed text-text-secondary">
      {text}
    </div>
  );
}

function PlayTab() {
  const cacheSize = useSettings((s) => s.playerCacheSizeMB);
  const set = useSettings((s) => s.set);
  const [cacheDraft, setCacheDraft] = useState(String(cacheSize));
  useEffect(() => setCacheDraft(String(cacheSize)), [cacheSize]);
  const saveCacheSize = () => {
    if (cacheDraft.trim() && Number.isFinite(Number(cacheDraft))) {
      set('playerCacheSizeMB', Number(cacheDraft));
    }
    setCacheDraft(String(useSettings.getState().playerCacheSizeMB));
  };
  return (
    <div>
      <Section label="播放" footnote="可提高调节进度的时间准确度，但可能影响定位的速度">
        <ToggleRow label="从上次进度播放" field="resumeFromLastPosition" />
        <ToggleRow label="精准定位进度" field="preciseSeek" />
      </Section>
      <Section label="缓存" footnote={isTauri
        ? '预读视频的缓存上限，支持 1–8192 MB，默认 150 MB。输入后按回车或离开输入框保存，下次开始播放时生效。'
        : '缓存大小仅适用于桌面 mpv 播放器；浏览器缓存由浏览器管理。'}>
        <Row label="缓存大小">
          <input type="number" aria-label="缓存大小" aria-describedby="player-cache-hint"
            min={PLAYER_CACHE_MIN_MB} max={PLAYER_CACHE_MAX_MB} step={1}
            value={cacheDraft} disabled={!isTauri}
            onChange={event => setCacheDraft(event.target.value)} onBlur={saveCacheSize}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); saveCacheSize(); }
            }}
            className={`${selectCls} w-28 text-right tabular-nums`} />
          <span id="player-cache-hint" className="text-[12px] text-text-secondary">MB</span>
        </Row>
      </Section>
      <Section label="快退快进" footnote="对所有用到“快退快进”的功能均生效">
        <SelectRow
          label="快退时间"
          field="rewindSeconds"
          numeric
          options={[5, 10, 15, 30].map((n) => ({
            label: `${n} 秒`,
            value: String(n),
          }))}
        />
        <SelectRow
          label="快进时间"
          field="forwardSeconds"
          numeric
          options={[5, 10, 15, 30].map((n) => ({
            label: `${n} 秒`,
            value: String(n),
          }))}
        />
      </Section>
    </div>
  );
}

function UiTab() {
  return (
    <div>
      <Section label="控制栏">
        <SelectRow
          label="自动隐藏"
          field="autoHideControlsSeconds"
          numeric
          options={[2, 3, 5, 10].map((n) => ({
            label: `${n} 秒`,
            value: String(n),
          }))}
        />
      </Section>
      <Section label="窗口" footnote={isTauri ? '窗口比例仅在非全屏时调整；关闭后可自由改变比例。' : '视频比例调整窗口只适用于桌面客户端；浏览器全屏需要用户允许。'}>
        <ToggleRow label="播放视频自动进入全屏" field="autoFullscreenOnPlay" />
        <ToggleRow label="窗口比例和视频比例保持一致" field="matchWindowToVideoRatio" disabled={!isTauri} />
      </Section>
      <Section label="自定义播放器按钮">
        <ToggleRow label="快退快进按钮" field="showSkipButtons" />
        <ToggleRow label="切换媒体按钮" field="showSwitchMediaButton" />
        <ToggleRow label="截图按钮" field="showScreenshotButton" />
      </Section>
      <Section label="提示信息">
        <ToggleRow label="开始播放提示标题" field="showPlayTitleToast" />
      </Section>
    </div>
  );
}

function GestureTab() {
  return (
    <div>
      <Section label="键盘" footnote="轻按方向键快退/快进，长按临时变速，松开恢复；数字键 1～9 对应 1～9 倍速，0 恢复 1 倍速。">
        <SelectRow
          label="长按左方向键倍速"
          field="longPressLeftRate"
          numeric
          options={[0.25, 0.5, 1.0].map((n) => ({
            label: `${n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '.0')} X`,
            value: String(n),
          }))}
        />
        <SelectRow
          label="长按右方向键倍速"
          field="longPressRightRate"
          numeric
          options={[1.5, 2.0, 3.0].map((n) => ({
            label: `${n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '.0')} X`,
            value: String(n),
          }))}
        />
        <ToggleRow label="数字键切换倍速" field="numberKeyRateSwitch" />
      </Section>
      <Section label="鼠标">
        <SelectRow label="左键单击" field="mouseLeftClick" options={[
          { label: '仅显示控制栏', value: 'none' }, { label: '播放/暂停', value: 'playpause' },
        ]} />
        <SelectRow label="左键双击" field="mouseLeftDoubleClick" options={[
          { label: '播放/暂停', value: 'playpause' }, { label: '无', value: 'none' },
        ]} />
        <SelectRow
          label="右键单击"
          field="mouseRightClick"
          options={[
            { label: '显示/隐藏控制栏', value: 'toggleControls' },
            { label: '无', value: 'none' },
          ]}
        />
      </Section>
    </div>
  );
}

function VideoTab() {
  const preferHw = useSettings((s) => s.preferHwDecode);
  const screenshotFormat = useSettings((s) => s.screenshotFormat);
  const set = useSettings((s) => s.set);
  return (
    <div>
      <Section
        label="视频"
        footnote={isTauri ? '硬解码更高效，软解码兼容性更强。' : '浏览器的解码模式由浏览器决定；此选项仅适用于桌面客户端。'}
      >
        <Row label="首选解码模式">
          <select
            aria-label="首选解码模式"
            className={selectCls}
            value={String(preferHw)}
            disabled={!isTauri}
            onChange={(e) => set('preferHwDecode', e.target.value === 'true')}
          >
            <option value="true">硬解码 (HW)</option>
            <option value="false">软解码 (SW)</option>
          </select>
        </Row>
      </Section>
      <Section label="视频截图" footnote={isTauri ? '默认保存到系统图片目录，无法写入时使用应用数据目录；开发版使用开发数据目录。截图完成后会显示实际保存路径。' : '截图需服务器允许跨域访问；复制图片需浏览器允许剪贴板权限。'}>
        <SelectRow
          label="截图格式"
          field="screenshotFormat"
          options={[
            { label: 'jpg', value: 'jpg' },
            { label: 'png', value: 'png' },
          ]}
        />
        <SelectRow
          label="JPEG 图像质量"
          field="jpegQuality"
          numeric
          disabled={screenshotFormat !== 'jpg'}
          options={[60, 70, 80, 90, 100].map((n) => ({
            label: `${n}%`,
            value: String(n),
          }))}
        />
        <ToggleRow label="自动复制到剪贴板" field="copyScreenshotToClipboard" />
      </Section>
    </div>
  );
}

function AudioTab() {
  return (
    <div>
      <Section
        label="音频"
        footnote={isTauri ? '开启增强后可将音量提高到 100% 以上；关闭后音量上限为 100%。' : '浏览器音轨设置用于提供多音轨的 HLS 媒体；音量上限为 100%，增强只适用于桌面客户端。'}
      >
        <ToggleRow label="记住所选音轨" field="rememberAudioTrack" />
        <SelectRow
          label="音频首选语言"
          field="preferredAudioLanguage"
          options={['默认', '中文', '英文', '日文'].map((l) => ({
            label: l,
            value: l,
          }))}
        />
        <ToggleRow label="音频增强" field="audioBoost" disabled={!isTauri} />
      </Section>
    </div>
  );
}

function SubtitleTab() {
  return (
    <div>
      <Section label="字幕" footnote="字幕搜索用于筛选当前视频的字幕列表。外挂规则根据服务器提供的文件路径筛选；未提供路径时保留已关联字幕。">
        <ToggleRow label="记住所选字幕" field="rememberSubtitle" />
        <ToggleRow label="记住字幕列表搜索记录" field="subtitleSearchHistory" />
        <SelectRow
          label="字幕首选语言"
          field="preferredSubtitleLanguage"
          options={['默认', '简中', '繁中', '英文', '日文'].map((l) => ({
            label: l,
            value: l,
          }))}
        />
        <SelectRow
          label="外挂字幕加载规则"
          field="externalSubtitleRule"
          options={[
            { label: '同文件夹同名字幕', value: 'sameFolderSameName' },
            { label: '同文件夹', value: 'sameFolder' },
            { label: '不加载', value: 'none' },
          ]}
        />
        <ToggleRow label="随 HDR 亮度调整字幕" field="hdrSubtitle" disabled={!isTauri} />
        <div className="px-5 py-4 text-[12px] leading-relaxed text-text-secondary">桌面播放器可按 HDR 画面亮度调整字幕；关闭后使用 SDR 白色亮度。</div>
      </Section>
    </div>
  );
}

/* ---------------- page ---------------- */

type TabId =
  | 'general'
  | 'list'
  | 'library'
  | 'play'
  | 'ui'
  | 'gesture'
  | 'video'
  | 'audio'
  | 'subtitle'
  | 'danmaku';

const TABS: { id: TabId; label: string; Icon: (p: { size?: number; className?: string }) => JSX.Element }[] = [
  { id: 'general', label: '通用', Icon: IconSettings },
  { id: 'list', label: '列表', Icon: IconList },
  { id: 'library', label: '媒体库', Icon: IconLibrary },
  { id: 'play', label: '播放', Icon: IconPlay },
  { id: 'ui', label: '界面', Icon: IconMonitor },
  { id: 'gesture', label: '手势', Icon: IconGesture },
  { id: 'video', label: '视频', Icon: IconVideo },
  { id: 'audio', label: '音频', Icon: IconAudio },
  { id: 'subtitle', label: '字幕', Icon: IconSubtitle },
  { id: 'danmaku', label: '弹幕', Icon: IconDanmaku },
];

export default function Settings() {
  const [tab, setTab] = useState<TabId>('general');

  return (
    <div className="h-full overflow-y-auto px-4 pb-10 sm:px-8">
      <div className="mx-auto max-w-[760px] pb-6 pt-8">
        <h1 className="page-heading">设置</h1>
        <p className="page-subtitle mt-2">让每一次播放，都更合你的习惯。</p>
      </div>
      <div className="sticky top-3 z-10 mx-auto max-w-[760px]">
        <LiquidGlass intensity="subtle" className="glass-toolbar flex gap-1 overflow-x-auto p-2" role="tablist" aria-label="设置分类">
        {TABS.map(({ id, label, Icon }) => {
          const active = id === tab;
          return (
            <button
              key={id}
              id={`settings-tab-${id}`}
              role="tab"
              aria-selected={active}
              aria-controls="settings-content"
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(event) => {
                const currentIndex = TABS.findIndex((entry) => entry.id === id);
                let nextIndex: number;
                if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % TABS.length;
                else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
                else if (event.key === 'Home') nextIndex = 0;
                else if (event.key === 'End') nextIndex = TABS.length - 1;
                else return;
                event.preventDefault();
                setTab(TABS[nextIndex].id);
                document.getElementById(`settings-tab-${TABS[nextIndex].id}`)?.focus();
              }}
              className={`flex min-w-[60px] flex-1 flex-col items-center gap-1.5 rounded-[18px] px-2 py-2.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent no-drag ${active ? 'bg-white/85 text-accent shadow-sm ring-1 ring-white' : 'text-text-secondary hover:bg-white/45 hover:text-text-primary'}`}
            >
              <div
                className="p-1"
              >
                <Icon size={20} />
              </div>
              <div
                className={`text-[11px] ${active ? 'font-semibold' : 'font-medium'}`}
              >
                {label}
              </div>
            </button>
          );
        })}
        </LiquidGlass>
      </div>

      {/* content */}
      <div id="settings-content" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="mx-auto max-w-[680px] pb-16 pt-8">
        {tab === 'general' && <GeneralTab />}
        {tab === 'list' && <ListTab />}
        {tab === 'library' && <InfoCard text="媒体库设置将在后续版本提供" />}
        {tab === 'play' && <PlayTab />}
        {tab === 'ui' && <UiTab />}
        {tab === 'gesture' && <GestureTab />}
        {tab === 'video' && <VideoTab />}
        {tab === 'audio' && <AudioTab />}
        {tab === 'subtitle' && <SubtitleTab />}
        {tab === 'danmaku' && <InfoCard text="弹幕功能将在后续版本提供" />}
      </div>
    </div>
  );
}
