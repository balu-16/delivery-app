import AsyncStorage from '@react-native-async-storage/async-storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { create } from 'zustand';

import { subscriptionPlan } from '@/data/subscription';

type SubscriptionState = {
  status: 'active' | 'paused';
  bottleCount: number;
  days: boolean[];
  vacationUntil: string | null;
  togglePause: () => void;
  setBottleCount: (count: number) => void;
  toggleDay: (index: number) => void;
  setVacation: (until: string | null) => void;
};

export const useSubscriptionStore = create<SubscriptionState>()(persist((set) => ({
  status: 'active',
  bottleCount: subscriptionPlan.bottleCount,
  days: subscriptionPlan.days.map((day) => day.active),
  vacationUntil: null,
  togglePause: () =>
    set((state) => ({ status: state.status === 'active' ? 'paused' : 'active' })),
  setBottleCount: (count) => set({ bottleCount: Math.max(1, Math.min(6, count)) }),
  toggleDay: (index) =>
    set((state) => ({ days: state.days.map((active, i) => (i === index ? !active : active)) })),
  setVacation: (until) => set({ vacationUntil: until, status: until ? 'paused' : 'active' }),
}), { name: '@dairydirect/demo-subscription-v1', storage: createJSONStorage(() => AsyncStorage), skipHydration: true }));

export const monthlyTotalFor = (bottleCount: number) => subscriptionPlan.dailyPrice * bottleCount * 30;
