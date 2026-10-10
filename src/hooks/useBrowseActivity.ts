import { createContext, useContext } from 'react';
export const BrowseActivity = createContext(true);
export function useBrowseActivity() { return useContext(BrowseActivity); }
