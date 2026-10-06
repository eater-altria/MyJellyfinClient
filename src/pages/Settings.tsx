import { useState } from 'react';
import { useSettings, AccentColor, AppSettings } from '../store/settings';
import Toggle from '../components/Toggle';
import { isTauri } from '../platform/window';
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
    <div className="mb-6">
      <div className="mb-1.5 px-1 text-[12px] text-gray-400">{label}</div>
      <div className="rounded-2xl bg-white shadow-card divide-y divide-black/5">
        {children}
      </div>
      {footnote && (
        <div className="mt-1.5 px-1 text-[11px] text-gray-400">{footnote}</div>
      )}
    </div>
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
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="text-[13px]">{label}</div>
      <div className="flex flex-shrink-0 items-center gap-2">{children}</div>
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
      <Toggle disabled={disabled} on={value} onChange={(v) => set(field, v as AppSettings[typeof field])} />
    </Row>
  );
}

const selectCls =
  'rounded-lg bg-gray-100 px-2 py-1 text-[12px] outline-none no-drag';

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
        <div className="flex items-center gap-3 px-4 py-3.5">
          {ACCENTS.map((c) => {
            const active = c === accent;
            return (
              <button
                key={c}
                onClick={() => set('accentColor', c)}
                className={`relative flex h-[34px] w-[34px] items-center justify-center rounded-full no-drag ${
                  active ? 'ring-2 ring-offset-2 ring-gray-300' : ''
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
      <div className="mt-10 flex justify-center">
        <button
          className="text-[13px] text-red-500 hover:opacity-80"
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
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex-shrink-0 text-[13px]">视频预览图时间</div>
          <input
            type="range"
            min={0}
            max={100}
            value={previewTime}
            disabled={!previewEnabled || preferCover}
            onChange={(e) => set('previewTimePercent', Number(e.target.value))}
            className="w-full accent-[var(--accent)] no-drag"
          />
          <div className="w-11 flex-shrink-0 text-right text-[12px] text-gray-500">
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
    <div className="rounded-2xl bg-white px-4 py-6 text-center text-[13px] text-gray-400 shadow-card">
      {text}
    </div>
  );
}

function PlayTab() {
  return (
    <div>
      <Section label="播放" footnote="可提高调节进度的时间准确度，但可能影响定位的速度">
        <ToggleRow label="从上次进度播放" field="resumeFromLastPosition" />
        <ToggleRow label="精准定位进度" field="preciseSeek" />
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
        <div className="px-4 py-3 text-[11px] text-gray-400">桌面播放器可按 HDR 画面亮度调整字幕；关闭后使用 SDR 白色亮度。</div>
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
    <div className="h-full overflow-y-auto bg-page-bg">
      {/* tab bar */}
      <div className="flex justify-center gap-1 pt-4">
        {TABS.map(({ id, label, Icon }) => {
          const active = id === tab;
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              className="flex w-16 flex-col items-center gap-1 no-drag"
            >
              <div
                className={`rounded-xl p-2 transition-colors ${
                  active
                    ? 'bg-accent text-white'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                <Icon size={20} />
              </div>
              <div
                className={`text-[11px] ${
                  active ? 'font-medium text-accent' : 'text-gray-400'
                }`}
              >
                {label}
              </div>
            </button>
          );
        })}
      </div>

      {/* content */}
      <div className="mx-auto max-w-[640px] px-6 pb-16 pt-6">
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
