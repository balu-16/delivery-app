import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Small pull-to-refresh helper used by the four scrolling screens.
 * It refreshes a fake "last synced" timestamp after a short delay.
 */
export function useRefresh(delay = 900) {
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onRefresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    timeout.current = setTimeout(() => {
      setRefreshing(false);
      setUpdatedAt(new Date());
    }, delay);
  }, [delay, refreshing]);

  useEffect(
    () => () => {
      if (timeout.current) clearTimeout(timeout.current);
    },
    [],
  );

  return { refreshing, onRefresh, updatedAt };
}
