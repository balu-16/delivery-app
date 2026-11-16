import { create } from 'zustand';

type CartTarget = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CartTargetState = {
  target: CartTarget | null;
  setTarget: (target: CartTarget) => void;
};

/**
 * The flying add-to-cart layer needs the live screen position of the cart tab.
 * The tab bar measures itself on layout and publishes the target here.
 */
export const useCartTargetStore = create<CartTargetState>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
}));
