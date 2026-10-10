import { useRef } from 'react';
import { useSettings } from '../store/settings';
import LiquidGlass from './LiquidGlass';
import ListNavigation from './ListNavigation';
import { useAutoPagination } from '../hooks/useAutoPagination';
import { useBrowseActivity } from '../hooks/useBrowseActivity';

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
  const active = useBrowseActivity();
  const sentinel = useAutoPagination(scroller, active && !!onLoadMore, onLoadMore, true);
  const showCount = useSettings((settings) => settings.showItemCountInTitle);

  const content = (
    <>
      <div className="mb-3.5 flex min-w-0 items-center justify-between gap-3 pr-1">
        <h2 className="min-w-0 text-[17px] font-semibold tracking-tight text-text-primary">{title}{showCount && count !== undefined ? <span className="ml-2 text-[12px] font-normal text-text-secondary">{`（${count}）`}</span> : ''}</h2>
        <ListNavigation title={title} scroller={scroller} onMore={onMore} />
      </div>
      <div
        ref={scroller}
        tabIndex={0}
        aria-label={`${title}列表`}
        className="flex gap-4 overflow-x-auto pb-3 pr-1 pt-1"
        style={{ scrollbarWidth: 'none' }}
        onScroll={e => {
          const el = e.currentTarget;
          if (active && el.scrollWidth - el.scrollLeft - el.clientWidth < 180) onLoadMore?.();
        }}
      >
        {children}
        {onLoadMore && <div ref={sentinel} className="w-px shrink-0" aria-hidden="true" />}
      </div>
    </>
  );

  return (
    <section className="mt-8">
      {glass ? <LiquidGlass intensity="prominent" className="detail-glass-section">{content}</LiquidGlass> : content}
    </section>
  );
}
