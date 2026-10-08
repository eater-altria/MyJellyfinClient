import type { RefObject } from 'react';
import GlassButton from './GlassButton';
import { IconChevronLeft, IconChevronRight } from './icons';

/** Shared navigation for horizontal media lists and their complete collection. */
export default function ListNavigation({ title, scroller, onMore, scrollDisabled = false, alwaysShowArrows = false }: {
  title: string;
  scroller: RefObject<HTMLDivElement>;
  onMore?: () => void;
  scrollDisabled?: boolean;
  alwaysShowArrows?: boolean;
}) {
  const scrollBy = (direction: number) => {
    const element = scroller.current;
    element?.scrollBy({ left: direction * element.clientWidth * 0.8, behavior: 'smooth' });
  };
  const arrowClass = `glass-icon-button h-8 min-h-0 w-8 text-text-secondary ${alwaysShowArrows ? 'flex' : 'hidden md:flex'}`;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {onMore && (
        <GlassButton onClick={onMore} aria-label={`查看全部${title}`}
          className="glass-button flex min-h-8 items-center gap-1 px-3 text-[11px] text-text-secondary">
          查看全部
          <IconChevronRight size={13} />
        </GlassButton>
      )}
      <GlassButton onClick={() => scrollBy(-1)} disabled={scrollDisabled}
        aria-label={`${title}向左滚动`} className={arrowClass}>
        <IconChevronLeft size={14} />
      </GlassButton>
      <GlassButton onClick={() => scrollBy(1)} disabled={scrollDisabled}
        aria-label={`${title}向右滚动`} className={arrowClass}>
        <IconChevronRight size={14} />
      </GlassButton>
    </div>
  );
}
