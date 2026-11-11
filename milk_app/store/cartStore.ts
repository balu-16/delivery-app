import AsyncStorage from '@react-native-async-storage/async-storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { create } from 'zustand';

import { getProduct, products } from '@/data/products';

export type CartLine = {
  id: string;
  quantity: number;
};

type CartState = {
  items: CartLine[];
  lastAddedId: string | null;
  addItem: (id: string, quantity?: number) => void;
  removeItem: (id: string) => void;
  increment: (id: string) => void;
  decrement: (id: string) => void;
  setQuantity: (id: string, quantity: number) => void;
  clear: () => void;
};

const seedItems: CartLine[] = [
  { id: 'a2-cow-milk', quantity: 1 },
  { id: 'paneer', quantity: 1 },
  { id: 'desi-ghee', quantity: 1 },
];

export const useCartStore = create<CartState>()(persist((set) => ({
  items: seedItems,
  lastAddedId: null,
  addItem: (id, quantity = 1) =>
    set((state) => {
      if (!getProduct(id)) return state;
      const existing = state.items.find((line) => line.id === id);
      return {
        items: existing
          ? state.items.map((line) =>
              line.id === id ? { ...line, quantity: Math.min(20, line.quantity + quantity) } : line,
            )
          : [...state.items, { id, quantity }],
        lastAddedId: id,
      };
    }),
  removeItem: (id) => set((state) => ({ items: state.items.filter((line) => line.id !== id) })),
  increment: (id) =>
    set((state) => ({
      items: state.items.map((line) =>
        line.id === id ? { ...line, quantity: Math.min(20, line.quantity + 1) } : line,
      ),
      lastAddedId: id,
    })),
  decrement: (id) =>
    set((state) => ({
      items: state.items
        .map((line) => (line.id === id ? { ...line, quantity: line.quantity - 1 } : line))
        .filter((line) => line.quantity > 0),
    })),
  setQuantity: (id, quantity) =>
    set((state) => ({
      items:
        quantity <= 0
          ? state.items.filter((line) => line.id !== id)
          : state.items.map((line) => (line.id === id ? { ...line, quantity } : line)),
    })),
  clear: () => set({ items: [], lastAddedId: null }),
}), { name: '@dairydirect/demo-cart-v1', storage: createJSONStorage(() => AsyncStorage), skipHydration: true }));

export const FREE_DELIVERY_THRESHOLD = 299;
export const DISCOUNT_THRESHOLD = 476;

export function getCartTotals(items: CartLine[]) {
  const lines = items
    .map((line) => ({ ...line, product: getProduct(line.id) }))
    .filter((line): line is CartLine & { product: NonNullable<ReturnType<typeof getProduct>> } =>
      Boolean(line.product),
    );

  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const mrpTotal = lines.reduce(
    (sum, line) => sum + (line.product.mrp ?? line.product.price) * line.quantity,
    0,
  );
  const savings = mrpTotal - subtotal;
  const deliveryFee = subtotal === 0 || subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : 29;
  const total = subtotal + deliveryFee;
  const toFreeDelivery = Math.max(0, FREE_DELIVERY_THRESHOLD - subtotal);
  const toDiscount = Math.max(0, DISCOUNT_THRESHOLD - subtotal);
  const totalMrp = products.reduce((sum, product) => sum + product.price, 0);

  return {
    lines,
    count,
    subtotal,
    savings,
    deliveryFee,
    total,
    toFreeDelivery,
    toDiscount,
    freeDeliveryProgress: Math.min(1, subtotal / FREE_DELIVERY_THRESHOLD),
    discountProgress: Math.min(1, subtotal / DISCOUNT_THRESHOLD),
    allProductCount: totalMrp,
  };
}
