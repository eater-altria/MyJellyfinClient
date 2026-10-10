import { useEffect, useRef, type RefObject } from 'react';

/** Only visible near-end sentinels request another batch; errors require retry. */
export function useAutoPagination(root: RefObject<HTMLElement>, enabled: boolean, loadMore?: () => void, horizontal = false) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current, container = root.current;
    if (!element || !container || !enabled || !loadMore) return;
    const nearEnd = () => {
      if (container.clientHeight <= 0 || container.clientWidth <= 0) return;
      const remaining = horizontal ? container.scrollWidth - container.scrollLeft - container.clientWidth
        : container.scrollHeight - container.scrollTop - container.clientHeight;
      if (remaining < (horizontal ? 180 : 240)) loadMore();
    };
    container.addEventListener('scroll', nearEnd, { passive: true });
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && container.clientHeight > 0) loadMore();
    }, { root: container, rootMargin: horizontal ? '0px 180px 0px 0px' : '0px 0px 240px 0px' });
    observer?.observe(element);
    return () => { observer?.disconnect(); container.removeEventListener('scroll', nearEnd); };
  }, [root, enabled, loadMore, horizontal]);
  return sentinel;
}
