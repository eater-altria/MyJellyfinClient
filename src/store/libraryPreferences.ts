import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { normalizeLibrarySort, type LibrarySort } from '../utils/librarySort';

interface LibraryPreferencesState {
  sorts: Record<string, LibrarySort>;
  setSort: (scope: string, sort: LibrarySort) => void;
}

function normalizeSorts(value: unknown): Record<string, LibrarySort> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([scope, sort]) => [scope, normalizeLibrarySort(sort)]));
}

export const useLibraryPreferences = create<LibraryPreferencesState>()(
  persist<LibraryPreferencesState, [], [], Pick<LibraryPreferencesState, 'sorts'>>(
    set => ({
      sorts: {},
      setSort: (scope, sort) => set(state => ({
        sorts: { ...state.sorts, [scope]: normalizeLibrarySort(sort) },
      })),
    }),
    {
      name: 'mjc:library-preferences',
      partialize: state => ({ sorts: state.sorts }),
      merge: (persisted, current) => ({
        ...current,
        sorts: normalizeSorts(persisted && typeof persisted === 'object' && 'sorts' in persisted ? persisted.sorts : null),
      }),
    },
  ),
);
