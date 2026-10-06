import { useRef } from 'react';
import { IconChevronLeft, IconChevronRight } from './icons';
import { useSettings } from '../store/settings';

/** Horizontally scrollable section with SenPlayer-style title and "N >" affordance. */
export default function SectionRow({
  title,
  count,
  children,
  onMore,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
  onMore?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const showCount = useSettings((settings) => settings.showItemCountInTitle);
  const scrollBy = (dir: number) =>
    scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.8, behavior: 'smooth' });

  return (
    <section className="mt-7">
      <div className="mb-2.5 flex items-center justify-between pr-1">
        <h2 className="text-[15px] font-semibold text-text-primary">{title}{showCount && count !== undefined ? `（${count}）` : ''}</h2>
        <div className="flex items-center gap-1">
          {onMore && (
            <button
              onClick={onMore}
              disabled={!onMore}
              aria-label={`查看全部${title}`}
              className="flex items-center text-[12px] text-gray-400 hover:text-gray-600"
            >
              <IconChevronRight size={13} />
            </button>
          )}
          <button
            onClick={() => scrollBy(-1)}
            aria-label={`${title}向左滚动`}
            className="hidden rounded-full p-1 text-gray-400 hover:bg-black/5 hover:text-gray-600 md:block"
          >
            <IconChevronLeft size={14} />
          </button>
          <button
            onClick={() => scrollBy(1)}
            aria-label={`${title}向右滚动`}
            className="hidden rounded-full p-1 text-gray-400 hover:bg-black/5 hover:text-gray-600 md:block"
          >
            <IconChevronRight size={14} />
          </button>
        </div>
      </div>
      <div
        ref={scroller}
        className="flex gap-3 overflow-x-auto pb-2 pr-1"
        style={{ scrollbarWidth: 'none' }}
      >
        {children}
      </div>
    </section>
  );
}
