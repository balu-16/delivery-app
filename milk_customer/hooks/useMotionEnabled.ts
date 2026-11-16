import { useReducedMotion } from 'react-native-reanimated';

/**
 * Single switch every animation reads before moving pixels.
 * Reanimated listens to the OS "Reduce Motion" accessibility setting.
 */
export function useMotionEnabled() {
  const reduced = useReducedMotion();
  return !reduced;
}
