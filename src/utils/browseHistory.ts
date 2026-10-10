/** Identity keys and user-data notifications for mounted browsing pages. */
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
export function browseOwnerId(owner: object | null): number {
  if (!owner) return 0;
  if (!identities.has(owner)) identities.set(owner, ++nextIdentity);
  return identities.get(owner)!;
}
type Listener = (owner: object, itemId: string, fields: Record<string, unknown>) => void;
const listeners = new Set<Listener>();
export function subscribeBrowseUserData(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Detail actions should also update the list restored by Back. */
export function updateBrowseUserData(owner: object, itemId: string, fields: Record<string, unknown>) {
  for (const listener of listeners) listener(owner, itemId, fields);
}
