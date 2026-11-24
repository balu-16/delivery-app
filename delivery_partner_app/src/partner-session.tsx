import { createContext, useContext, type ReactNode } from 'react';
import { restoreSession, type PartnerIdentity } from './auth/session';

type SessionValue = {
  identity: PartnerIdentity | null;
};

// Standalone singleton so cold-started detail routes can read the same
// signed-in account without depending on the tab stack being mounted.
let currentIdentity: PartnerIdentity | null = null;
const listeners = new Set<(identity: PartnerIdentity | null) => void>();

export function setPartnerIdentity(identity: PartnerIdentity | null) {
  currentIdentity = identity;
  listeners.forEach((fn) => fn(identity));
}

export function getPartnerIdentity(): PartnerIdentity | null {
  return currentIdentity;
}

export function subscribePartnerIdentity(fn: (identity: PartnerIdentity | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function ensurePartnerIdentity(): Promise<PartnerIdentity | null> {
  if (currentIdentity) return currentIdentity;
  try {
    const restored = await restoreSession();
    if (restored) setPartnerIdentity(restored);
    return restored;
  } catch {
    return null;
  }
}

const Ctx = createContext<SessionValue>({ identity: null });

/**
 * Stable session provider for the signed-in stack. Keeps the identity
 * mounted across expo-router route changes so shift, tracking, push and
 * realtime stay alive (plan3 §5 col 1). Warmed by app/index.tsx.
 */
export function PartnerSessionProvider({ identity, children }: { identity: PartnerIdentity; children: ReactNode }) {
  setPartnerIdentity(identity);
  return <Ctx.Provider value={{ identity }}>{children}</Ctx.Provider>;
}

export function usePartnerSession(): PartnerIdentity | null {
  const value = useContext(Ctx);
  if (value.identity) return value.identity;
  return currentIdentity;
}
