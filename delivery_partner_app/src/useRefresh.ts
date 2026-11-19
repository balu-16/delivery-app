import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Pull-to-refresh helper for scrollable views. Duplicate pulls while a
 * refresh is in flight share the same promise instead of issuing duplicate
 * reads; existing content stays visible because the load only updates
 * successful responses.
 */
export function useRefresh(load?: () => unknown | Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
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

  return { refreshing, onRefresh };
}
