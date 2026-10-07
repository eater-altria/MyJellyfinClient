import { useRef } from 'react';
import { IconChevronLeft, IconChevronRight } from './icons';
import { useSettings } from '../store/settings';
import LiquidGlass from './LiquidGlass';
import GlassButton from './GlassButton';

/** Content-first horizontal section with a compact glass navigation cluster. */
export default function SectionRow({
  title,
  count,
  children,
  onMore,
  onLoadMore,
  glass = false,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
  onMore?: () => void;
  onLoadMore?: () => void;
  glass?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const showCount = useSettings((settings) => settings.showItemCountInTitle);
  const scrollBy = (dir: number) =>
    scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.8, behavior: 'smooth' });

  const content = (
    <>
      <div className="mb-3.5 flex min-w-0 items-center justify-between gap-3 pr-1">
        <h2 className="min-w-0 text-[17px] font-semibold tracking-tight text-text-primary">{title}{showCount && count !== undefined ? <span className="ml-2 text-[12px] font-normal text-text-secondary">{`（${count}）`}</span> : ''}</h2>
        <div className="flex shrink-0 items-center gap-1.5">
          {onMore && (
            <GlassButton
              onClick={onMore}
              disabled={!onMore}
              aria-label={`查看全部${title}`}
              className="glass-button flex min-h-8 items-center gap-1 px-3 text-[11px] text-text-secondary"
            >
              查看全部
              <IconChevronRight size={13} />
            </GlassButton>
          )}
          <GlassButton
            onClick={() => scrollBy(-1)}
            aria-label={`${title}向左滚动`}
            className="glass-icon-button hidden h-8 min-h-0 w-8 text-text-secondary md:flex"
          >
            <IconChevronLeft size={14} />
          </GlassButton>
          <GlassButton
            onClick={() => scrollBy(1)}
            aria-label={`${title}向右滚动`}
            className="glass-icon-button hidden h-8 min-h-0 w-8 text-text-secondary md:flex"
          >
            <IconChevronRight size={14} />
          </GlassButton>
        </div>
      </div>
      <div
        ref={scroller}
        tabIndex={0}
        aria-label={`${title}列表`}
        className="flex gap-4 overflow-x-auto pb-3 pr-1 pt-1"
        style={{ scrollbarWidth: 'none' }}
        onScroll={e => {
          const el = e.currentTarget;
          if (el.scrollWidth - el.scrollLeft - el.clientWidth < 180) onLoadMore?.();
        }}
      >
        {children}
      </div>
    </>
  );

  return (
    <section className="mt-8">
      {glass ? <LiquidGlass intensity="prominent" className="detail-glass-section">{content}</LiquidGlass> : content}
    </section>
  );
}
