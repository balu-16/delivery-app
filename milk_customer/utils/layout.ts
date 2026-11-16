import type { RefObject } from 'react';

import type { AssetSource } from '@/constants/assets';

export type LayoutBox = { x: number; y: number; width: number; height: number };

export function measureInWindow(ref: RefObject<unknown>): Promise<LayoutBox | null> {
  return new Promise((resolve) => {
    const node = ref.current as
      | {
          measureInWindow?: (
            callback: (x: number, y: number, width: number, height: number) => void,
          ) => void;
        }
      | null;

    if (!node?.measureInWindow) {
      resolve(null);
      return;
    }

    node.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });
}

export type FlyImage = AssetSource;
