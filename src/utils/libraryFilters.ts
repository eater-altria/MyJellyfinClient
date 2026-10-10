export interface LibraryFilters { genres: string[]; tags: string[]; years: number[]; favoritesOnly: boolean; }
export const EMPTY_LIBRARY_FILTERS: LibraryFilters = { genres: [], tags: [], years: [], favoritesOnly: false };
export function readLibraryFilters(search: URLSearchParams): LibraryFilters {
  const names = (key: string) => [...new Set(search.getAll(key).filter(value => value.trim()))];
  return {
    genres: names('genre'), tags: names('tag'),
    years: [...new Set(search.getAll('year').filter(year => /^\d{4}$/.test(year)).map(Number))],
    favoritesOnly: search.get('favorite') === '1' || search.get('view') === 'favorites',
  };
}
export function writeLibraryFilters(search: URLSearchParams, filters: LibraryFilters) {
  const next = new URLSearchParams(search);
  for (const key of ['genre', 'tag', 'year', 'favorite']) next.delete(key);
  filters.genres.forEach(value => next.append('genre', value));
  filters.tags.forEach(value => next.append('tag', value));
  filters.years.forEach(value => next.append('year', String(value)));
  if (filters.favoritesOnly) next.set('favorite', '1');
  if (next.get('view') === 'favorites' && !filters.favoritesOnly) next.set('view', 'items');
  return next;
}
export function libraryFilterParams(filters: LibraryFilters) {
  return { Genres: filters.genres.join('|'), Tags: filters.tags.join('|'), Years: filters.years.join(','),
    Filters: filters.favoritesOnly ? 'IsFavorite' : undefined };
}
