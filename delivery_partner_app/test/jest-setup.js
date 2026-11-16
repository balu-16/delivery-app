// Render the loading UI without a native animation runtime in Jest.
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true, default: { View },
    useSharedValue: value => React.useRef({ value }).current,
    useAnimatedStyle: callback => callback(),
    useReducedMotion: () => true,
    withRepeat: value => value, withTiming: value => value,
    cancelAnimation: () => {}, Easing: { quad: value => value, inOut: value => value },
  };
});
