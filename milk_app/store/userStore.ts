import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { profileUser, savedAddresses, type SavedAddress } from '@/data/profile';
import type { SubscriptionOrder } from '@/data/subscription';

type UserState = {
  name: string; phone: string; location: string; addressId: string; addresses: SavedAddress[];
  wallet: number; unread: number; favorites: string[]; orders: SubscriptionOrder[]; paidBills: string[]; walletActivity: { id: string; amount: number; title: string }[];
  hapticsOn: boolean; notificationsOn: boolean; offersOn: boolean;
  setLocation: (location: string) => void; setAddress: (id: string) => void;
  addAddress: (address: Omit<SavedAddress, 'id' | 'isDefault'>) => void;
  markNotificationsRead: () => void; toggleFavorite: (id: string) => void; topUpWallet: (amount: number) => void;
  addOrder: (order: SubscriptionOrder) => void; payBill: (id: string) => void;
  setHapticsOn: (value: boolean) => void; setNotificationsOn: (value: boolean) => void; setOffersOn: (value: boolean) => void;
};
export const useUserStore = create<UserState>()(persist((set) => ({
  name: profileUser.name, phone: profileUser.phone, location: profileUser.address, addressId: 'home',
  addresses: [...savedAddresses], wallet: profileUser.walletBalance, unread: 3, favorites: ['a2-cow-milk'], orders: [], paidBills: [], walletActivity: [],
  hapticsOn: true, notificationsOn: true, offersOn: true,
  setLocation: (location) => set({ location }),
  setAddress: (id) => set((state) => { const address = state.addresses.find((entry) => entry.id === id); return address ? { addressId: id, location: `${address.label}, ${address.line2.split(',')[0]}` } : {}; }),
  addAddress: (address) => set((state) => { const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; return { addresses: [...state.addresses, { ...address, id, isDefault: false }], addressId: id, location: `${address.label}, ${address.line2.split(',')[0]}` }; }),
  markNotificationsRead: () => set({ unread: 0 }),
  toggleFavorite: (id) => set((state) => ({ favorites: state.favorites.includes(id) ? state.favorites.filter((item) => item !== id) : [...state.favorites, id] })),
  topUpWallet: (amount) => set((state) => ({ wallet: state.wallet + amount, walletActivity: [{ id: `credit-${Date.now()}`, amount, title: 'Demo credit' }, ...state.walletActivity] })),
  addOrder: (order) => set((state) => ({ orders: [order, ...state.orders] })),
  payBill: (id) => set((state) => ({ paidBills: state.paidBills.includes(id) ? state.paidBills : [...state.paidBills, id] })),
  setHapticsOn: (hapticsOn) => set({ hapticsOn }), setNotificationsOn: (notificationsOn) => set({ notificationsOn }), setOffersOn: (offersOn) => set({ offersOn }),
}), { name: '@dairydirect/demo-user-v1', storage: createJSONStorage(() => AsyncStorage), skipHydration: true }));
