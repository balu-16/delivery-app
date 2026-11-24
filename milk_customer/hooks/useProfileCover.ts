import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { profileCoverApi, type ProfileCover } from '@/src/api/profile-cover';
import { accessToken } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';

type CoverState = { userId: string; cover?: ProfileCover; failed: boolean };

export function useProfileCover(userId: string | undefined) {
  const [state, setState] = useState<CoverState>();
  const activeRead = useRef<AbortController | null>(null);
  const isOwner = useCallback(
    () => !!userId && useCustomer.getState().profile?.userId === userId,
    [userId],
  );

  const refresh = useCallback(async () => {
    if (!userId || !isOwner()) return null;
    activeRead.current?.abort();
    const request = new AbortController();
    activeRead.current = request;
    try {
      const token = await accessToken();
      if (!isOwner() || request.signal.aborted) return null;
      const cover = await profileCoverApi.get(token, request.signal);
      if (!request.signal.aborted && isOwner()) {
        setState({ userId, cover, failed: false });
        return cover;
      }
    } catch {
      if (!request.signal.aborted && isOwner()) {
        setState((current) => ({
          userId,
          cover: current?.userId === userId ? current.cover : undefined,
          failed: true,
        }));
      }
    }
    return null;
  }, [isOwner, userId]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      return () => {
        activeRead.current?.abort();
        // Keep a confirmed cover across tab switches, and discard it on logout.
        if (!isOwner()) setState(undefined);
      };
    }, [isOwner, refresh]),
  );

  const apply = useCallback(
    (cover: ProfileCover) => {
      if (!userId || !isOwner()) return;
      activeRead.current?.abort();
      setState({ userId, cover, failed: false });
    },
    [isOwner, userId],
  );

  const current = state?.userId === userId ? state : undefined;
  return {
    cover: current?.cover,
    coverFailed: current?.failed === true,
    refreshCover: refresh,
    applyCover: apply,
  };
}
