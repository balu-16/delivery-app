/// <reference types="jest" />
import { act, render, screen } from '@testing-library/react-native';
import type { GestureResponderEvent } from 'react-native';
import { FlyToCartProvider, useFlyToCart } from '../components/animations/FlyToCart';

const motion = { enabled: true };
jest.mock('../hooks/useMotionEnabled', () => ({
  useMotionEnabled: () => motion.enabled,
}));
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true, default: { View },
    useSharedValue: (value: number) => React.useRef({ value }).current,
    useAnimatedStyle: (callback: () => unknown) => callback(),
    useReducedMotion: () => !motion.enabled,
    runOnJS: (fn: (key: number) => void) => fn,
    withTiming: (value: number) => value,
    Easing: { bezier: () => (value: number) => value },
  };
});
jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Image: () => React.createElement(View, { testID: 'flyer' }) };
});
jest.mock('../utils/layout', () => ({
  measureInWindow: jest.fn(async () => ({ x: 0, y: 0, width: 10, height: 10 })),
}));

function Harness({ onFly }: { onFly: (fly: ReturnType<typeof useFlyToCart>['fly']) => void }) {
  const { fly } = useFlyToCart();
  onFly(fly);
  return null;
}

function eventAt(x: number, y: number): GestureResponderEvent {
  return { nativeEvent: { pageX: x, pageY: y } } as unknown as GestureResponderEvent;
}

test('rapid taps keep at most three simultaneous flights', async () => {
  motion.enabled = true;
  let fly!: ReturnType<typeof useFlyToCart>['fly'];
  await render(<FlyToCartProvider><Harness onFly={(next) => { fly = next; }} /></FlyToCartProvider>);
  const image = { uri: 'file:///milk.png' };
  await act(async () => {
    for (let index = 0; index < 5; index += 1) fly(image, { current: null } as never, eventAt(10, 10));
  });
  expect(screen.getAllByTestId('flyer')).toHaveLength(3);
});

test('reduced motion adds no flight', async () => {
  motion.enabled = false;
  let fly!: ReturnType<typeof useFlyToCart>['fly'];
  await render(<FlyToCartProvider><Harness onFly={(next) => { fly = next; }} /></FlyToCartProvider>);
  await act(async () => { fly({ uri: 'file:///milk.png' }, { current: null } as never, eventAt(10, 10)); });
  expect(screen.queryByTestId('flyer')).toBeNull();
});
