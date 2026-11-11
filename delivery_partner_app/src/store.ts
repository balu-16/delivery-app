import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  ATTEMPT_FEE,
  OFFER_FEE,
  ROUTE_FEE,
  isAttemptFeeEligible,
} from "./domain";

let storageWarningShown = false;
const safeStorage = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: async (key: string, value: string) => {
    try {
      await AsyncStorage.setItem(key, value);
    } catch {
      if (!storageWarningShown) {
        storageWarningShown = true;
        setTimeout(
          () =>
            useDemo.setState({
              notice: "Storage unavailable. Demo changes may not be saved.",
            }),
          0,
        );
      }
    }
  },
  removeItem: async (key: string) => {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      /* Memory state remains usable. */
    }
  },
};

export type Stop = {
  id: string;
  name: string;
  address: string;
  items: string;
  type: "silent" | "standard";
  cash: number;
  bottles: number;
  units: number;
  windowMinutes: number;
};
export type Event = {
  id: string;
  kind: string;
  stopId?: string;
  amount?: number;
  reason?: string;
  at: number;
  data?: string;
  pending?: boolean;
};
export const stops: Stop[] = [
  {
    id: "stop-1",
    name: "Ananya",
    address: "Demo Lane 1, Vijayawada",
    items: "A2 milk · 2 bottles",
    type: "silent",
    cash: 0,
    bottles: 2,
    units: 2,
    windowMinutes: 35,
  },
  {
    id: "stop-2",
    name: "Ravi",
    address: "Demo Lane 2, Vijayawada",
    items: "Milk · 1 bottle, curd",
    type: "standard",
    cash: 11000,
    bottles: 1,
    units: 2,
    windowMinutes: 50,
  },
  {
    id: "stop-3",
    name: "Priya",
    address: "Demo Lane 3, Vijayawada",
    items: "Milk · 2 bottles",
    type: "silent",
    cash: 0,
    bottles: 2,
    units: 2,
    windowMinutes: 65,
  },
  {
    id: "stop-4",
    name: "Kiran",
    address: "Demo Lane 4, Vijayawada",
    items: "Milk · 1 bottle, paneer",
    type: "standard",
    cash: 7500,
    bottles: 1,
    units: 2,
    windowMinutes: 80,
  },
  {
    id: "stop-5",
    name: "Meera",
    address: "Demo Lane 5, Vijayawada",
    items: "Milk · 1 bottle",
    type: "silent",
    cash: 0,
    bottles: 1,
    units: 1,
    windowMinutes: 95,
  },
];
type Draft = {
  bottles: string;
  cash: string;
  shortfall?: string;
  code?: string;
};
type State = {
  events: Event[];
  drafts: Record<string, Draft>;
  language: string;
  onboarded: boolean;
  signal: boolean;
  offerExpiresAt: number | null;
  offerId: string | null;
  offerCash: number;
  offerCounter: number;
  clockOffset: number;
  offersDuringRoute: boolean;
  simulateConflict: boolean;
  hapticsOn: boolean;
  hydrated: boolean;
  notice: string | null;
  record: (event: Omit<Event, "at">) => void;
  draft: (id: string, patch: Partial<Draft>) => void;
  setLanguage: (language: string) => void;
  setOnboarded: () => void;
  setSignal: (signal: boolean) => void;
  offer: (expiry: number | null) => void;
  advanceClock: () => void;
  toggleRouteOffers: () => void;
  setConflict: () => void;
  setHaptics: () => void;
  retrySync: () => void;
  reset: () => void;
  hydrateDone: (notice?: string) => void;
};
export function migrateDemo(data: unknown, version: number): Partial<State> {
  if (![0, 1, 2].includes(version) || !data || typeof data !== "object")
    throw new Error("Invalid demo data");
  const old = data as Partial<State>;
  if (old.events && !Array.isArray(old.events))
    throw new Error("Invalid events");
  return {
    ...old,
    language: old.language === "te" ? "en" : old.language,
    events: old.events ?? [],
    drafts: old.drafts ?? {},
  };
}
export const useDemo = create<State>()(
  persist(
    (set) => ({
      events: [],
      drafts: {},
      language: "en",
      onboarded: false,
      signal: true,
      offerExpiresAt: null,
      offerId: null,
      offerCash: 0,
      offerCounter: 0,
      clockOffset: 0,
      offersDuringRoute: true,
      simulateConflict: false,
      hapticsOn: true,
      hydrated: false,
      notice: null,
      record: (event) =>
        set((state) => {
          if (state.events.some((e) => e.id === event.id)) return state;
          if (
            ["cash-handover", "cash-collected"].includes(event.kind) &&
            (!Number.isSafeInteger(event.amount) || (event.amount ?? 0) < 1)
          )
            return state;
          if (
            event.kind === "cash-handover" &&
            (event.amount ?? 0) > cashBalance(state.events)
          )
            return state;
          if (
            event.kind === "cash-collected" &&
            state.events.some(
              (e) => e.kind === "cash-collected" && e.stopId === event.stopId,
            )
          )
            return state;
          const drafts = { ...state.drafts };
          if (
            ["delivered", "failed", "offer-completed", "offer-failed"].includes(
              event.kind,
            ) &&
            event.stopId
          )
            delete drafts[event.stopId];
          return {
            events: [
              ...state.events,
              {
                ...event,
                at: Date.now() + state.clockOffset,
                pending: !state.signal,
              },
            ],
            drafts,
          };
        }),
      draft: (id, patch) =>
        set((state) => ({
          drafts: {
            ...state.drafts,
            [id]: {
              ...(state.drafts[id] ?? { bottles: "", cash: "" }),
              ...patch,
            },
          },
        })),
      setLanguage: (language) => set({ language }),
      setOnboarded: () => set({ onboarded: true }),
      setSignal: (signal) =>
        set((state) => ({
          signal,
          notice:
            signal &&
            state.simulateConflict &&
            state.events.some((e) => e.pending)
              ? "Demo sync conflict. Review and retry pending actions."
              : state.notice,
          events:
            signal && !state.simulateConflict
              ? state.events.map((e) => ({ ...e, pending: false }))
              : state.events,
        })),
      offer: (offerExpiresAt) =>
        set((state) =>
          offerExpiresAt === null
            ? { offerExpiresAt }
            : {
                offerExpiresAt,
                offerId: `00000000-0000-4000-8000-${String(state.offerCounter + 1).padStart(12, "0")}`,
                offerCash: state.offerCounter % 2 === 0 ? 0 : 25000,
                offerCounter: state.offerCounter + 1,
              },
        ),
      advanceClock: () =>
        set((state) => ({ clockOffset: state.clockOffset + 300000 })),
      toggleRouteOffers: () =>
        set((state) => ({ offersDuringRoute: !state.offersDuringRoute })),
      setConflict: () => set({ simulateConflict: true }),
      setHaptics: () => set((state) => ({ hapticsOn: !state.hapticsOn })),
      retrySync: () =>
        set((state) => ({
          simulateConflict: false,
          notice: null,
          events: state.events.map((e) => ({ ...e, pending: false })),
        })),
      reset: () =>
        set({
          events: [],
          drafts: {},
          offerExpiresAt: null,
          offerId: null,
          offerCash: 0,
          offerCounter: 0,
          clockOffset: 0,
          offersDuringRoute: true,
          simulateConflict: false,
          signal: true,
          notice: null,
        }),
      hydrateDone: (notice) =>
        set((state) => ({ hydrated: true, notice: notice ?? state.notice })),
    }),
    {
      name: "@dairydirect/partner-demo",
      version: 3,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) =>
        ({
          events: s.events,
          drafts: s.drafts,
          language: s.language,
          onboarded: s.onboarded,
          signal: s.signal,
          offerExpiresAt: s.offerExpiresAt,
          offerId: s.offerId,
          offerCash: s.offerCash,
          offerCounter: s.offerCounter,
          clockOffset: s.clockOffset,
          offersDuringRoute: s.offersDuringRoute,
          simulateConflict: s.simulateConflict,
          hapticsOn: s.hapticsOn,
        }) as State,
      migrate: (data, version) => migrateDemo(data, version) as State,
      merge: (saved, current) => {
        if (saved === undefined) return current;
        if (!saved || typeof saved !== "object")
          return {
            ...current,
            notice: "Saved demo could not be restored. Starting fresh.",
          };
        const data = saved as Partial<State>;
        if (
          !Array.isArray(data.events) ||
          !data.drafts ||
          Array.isArray(data.drafts) ||
          typeof data.drafts !== "object" ||
          data.events.some(
            (e) =>
              !e ||
              typeof e.id !== "string" ||
              typeof e.kind !== "string" ||
              !Number.isFinite(e.at),
          )
        )
          return {
            ...current,
            notice: "Saved demo could not be restored. Starting fresh.",
          };
        if (
          Object.values(data.drafts).some(
            (d) =>
              !d ||
              typeof d !== "object" ||
              typeof d.bottles !== "string" ||
              typeof d.cash !== "string" ||
              (d.code !== undefined && typeof d.code !== "string") ||
              (d.shortfall !== undefined && typeof d.shortfall !== "string"),
          )
        )
          return {
            ...current,
            notice: "Saved demo could not be restored. Starting fresh.",
          };
        return {
          ...current,
          events: data.events,
          drafts: data.drafts,
          language: ["te", "en", "hi", "kn"].includes(data.language ?? "")
            ? data.language!
            : current.language,
          onboarded: data.onboarded === true,
          signal: data.signal !== false,
          offerExpiresAt:
            typeof data.offerExpiresAt === "number" &&
            Number.isFinite(data.offerExpiresAt)
              ? data.offerExpiresAt
              : null,
          offerId: typeof data.offerId === "string" ? data.offerId : null,
          offerCash:
            typeof data.offerCash === "number" &&
            Number.isFinite(data.offerCash)
              ? data.offerCash
              : 0,
          offerCounter:
            typeof data.offerCounter === "number" &&
            Number.isFinite(data.offerCounter)
              ? data.offerCounter
              : 0,
          clockOffset:
            typeof data.clockOffset === "number" &&
            Number.isFinite(data.clockOffset)
              ? data.clockOffset
              : 0,
          offersDuringRoute: data.offersDuringRoute !== false,
          simulateConflict: data.simulateConflict === true,
          hapticsOn: data.hapticsOn !== false,
          hydrated: false,
        };
      },
      onRehydrateStorage: () => (_state, error) => {
        setTimeout(
          () =>
            useDemo
              .getState()
              .hydrateDone(
                error
                  ? "Saved demo could not be restored. Starting fresh."
                  : undefined,
              ),
          0,
        );
      },
    },
  ),
);
export const has = (events: Event[], kind: string, stopId?: string) =>
  events.some(
    (e) => e.kind === kind && (stopId === undefined || e.stopId === stopId),
  );
export const cashBalance = (events: Event[]) =>
  events.reduce(
    (n, e) =>
      n +
      (e.kind === "cash-collected"
        ? (e.amount ?? 0)
        : e.kind === "cash-handover"
          ? -(e.amount ?? 0)
          : 0),
    0,
  );
export const earnings = (events: Event[]) =>
  events.reduce(
    (n, e) =>
      n +
      (e.kind === "delivered"
        ? ROUTE_FEE
        : e.kind === "offer-completed"
          ? OFFER_FEE
          : ["failed", "offer-failed"].includes(e.kind) &&
              isAttemptFeeEligible(e.reason)
            ? ATTEMPT_FEE
            : 0),
    0,
  );
export const money = (n: number, locale = "en-IN") =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "INR" }).format(
    n / 100,
  );
