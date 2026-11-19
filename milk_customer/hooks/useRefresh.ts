import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Pull-to-refresh helper for scrollable views.
 *
 * The load function is a read/reconciliation action (revalidate the current
 * filter/address/record, reconcile pending writes). Duplicate pulls while a
 * refresh is already in flight share the same promise instead of issuing
 * duplicate reads; each completed refresh updates `updatedAt`.
 */
export function useRefresh(load?: () => unknown | Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  const inFlight = useRef<Promise<void> | null>(null);
  const loadRef = useRef<(() => unknown | Promise<unknown>) | undefined>(load);
  useEffect(() => { loadRef.current = load; });

  const onRefresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    setRefreshing(true);
    let settle: () => void = () => undefined;
    const task = new Promise<void>((resolve) => { settle = resolve; });
    inFlight.current = task;
    void (async () => {
      try {
        await loadRef.current?.();
        setUpdatedAt(new Date());
      } catch {
        // Load errors surface through the screen's own state; keep content.
      } finally {
        if (inFlight.current === task) {
          inFlight.current = null;
          setRefreshing(false);
        }
        settle();
      }
    })();
    return task;
  }, []);

  return { refreshing, onRefresh, updatedAt };
}
