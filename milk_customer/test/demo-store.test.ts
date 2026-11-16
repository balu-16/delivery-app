/// <reference types="jest" />
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useUserStore } from '../store/userStore';
import { getCartTotals, useCartStore } from '../store/cartStore';
import { useSubscriptionStore } from '../store/subscriptionStore';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

test('a selected demo address is restored from local storage', async () => {
  useUserStore.getState().addAddress({ label: 'Farm', line1: '123 Demo Road', line2: 'Sampletown' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stored = await AsyncStorage.getItem('@dairydirect/demo-user-v1');
  expect(stored).toBeTruthy();
  useUserStore.setState({ addressId: 'home', location: 'Home' });
  await AsyncStorage.setItem('@dairydirect/demo-user-v1', stored!);
  await useUserStore.persist.rehydrate();
  const state = useUserStore.getState();
  expect(state.location).toBe('Farm, Sampletown');
  expect(state.addresses.find((address) => address.id === state.addressId)?.line1).toBe('123 Demo Road');
});

test('cart quantities, demo orders, and settings change together', () => {
  useCartStore.getState().clear();
  useCartStore.getState().addItem('a2-cow-milk', 2);
  const totals = getCartTotals(useCartStore.getState().items);
  expect(totals.count).toBe(2);
  useUserStore.getState().addOrder({ id: 'DEMO-1', title: 'Demo order', date: 'Demo', items: 'Milk × 2', amount: totals.total, status: 'Scheduled' });
  useCartStore.getState().clear();
  expect(useCartStore.getState().items).toHaveLength(0);
  expect(useUserStore.getState().orders[0].id).toBe('DEMO-1');
  useUserStore.getState().setHapticsOn(false);
  expect(useUserStore.getState().hapticsOn).toBe(false);
});

test('subscription and bill changes are stored in the demo state', () => {
  useSubscriptionStore.getState().setBottleCount(3);
  useSubscriptionStore.getState().setVacation('tomorrow');
  useUserStore.getState().payBill('demo-bill');
  expect(useSubscriptionStore.getState().bottleCount).toBe(3);
  expect(useSubscriptionStore.getState().status).toBe('paused');
  expect(useUserStore.getState().paidBills).toContain('demo-bill');
});


test('rapid product additions are counted once per tap and respect the quantity limit', () => {
  useCartStore.getState().clear();
  for (let i = 0; i < 25; i += 1) useCartStore.getState().addItem('a2-cow-milk');
  expect(useCartStore.getState().items).toEqual([{ id: 'a2-cow-milk', quantity: 20 }]);
  useCartStore.getState().addItem('paneer');
  expect(getCartTotals(useCartStore.getState().items).count).toBe(21);
});
