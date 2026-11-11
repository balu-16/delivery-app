import { memo, useMemo } from 'react';
import Svg, { Circle, G, Path } from 'react-native-svg';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
export type GrassProps = { width: number; height: number; time: SharedValue<number>; brushX: SharedValue<number>; brushStrength: SharedValue<number> };
const AnimatedGroup = Animated.createAnimatedComponent(G);
const colors = ['#426921', '#577b24', '#729635', '#88a23c', '#3e6421', '#9aa947', '#648625'];
function BladeGroup({ group, width, time, brushX, brushStrength }: GrassProps & { group: number }) {
  const center = (group + 0.5) * width / 12;
  const blades = useMemo(() => Array.from({ length: 13 }, (_, j) => {
    const i = group * 13 + j;
    const random = (n: number) => { const v = Math.sin((i + 1) * n) * 43758.5453; return v - Math.floor(v); };
    const x = (i / 155) * (width + 20) - 10, h = 20 + random(12.23) * 42, w = 2 + random(8.13) * 4, lean = (random(5.61) - 0.5) * 18;
    return { d: `M ${x-w/2} 62 Q ${x} ${62-h*0.56} ${x+lean} ${62-h} Q ${x+w} ${62-h*0.43} ${x+w/2} 62 Z`, color: colors[i % colors.length] };
  }), [group, width]);
  const props = useAnimatedProps(() => {
    const wind = Math.sin(time.value * 6.283 + center * 0.015) * 5.16;
    const distance = center - brushX.value;
    const touch = Math.max(0, 1 - Math.abs(distance) / 65) * brushStrength.value * (distance < 0 ? -11.46 : 11.46);
    return { transform: `rotate(${wind + touch}, ${center}, 62)` };
  });
  return <AnimatedGroup animatedProps={props}>{blades.map((blade, i) => <Path key={i} d={blade.d} fill={blade.color} />)}</AnimatedGroup>;
}
function Flower({ i, width, time, brushX, brushStrength }: GrassProps & { i: number }) {
  const x = (i + 0.5) * width / 9, y = 8 + (i % 4) * 4;
  const props = useAnimatedProps(() => {
    const wind = Math.sin(time.value * 6.283 + x * 0.02) * 3;
    const distance = x - brushX.value;
    const touch = Math.max(0, 1 - Math.abs(distance) / 65) * brushStrength.value * (distance < 0 ? -8 : 8);
    return { transform: `translate(${wind + touch}, 0)` };
  });
  return <AnimatedGroup animatedProps={props}><Path d={`M ${x} 62 Q ${x - 3} ${y + 18} ${x} ${y}`} stroke="#557b2d" strokeWidth={1.3} fill="none" />{Array.from({ length: 6 }, (_, petal) => <Circle key={petal} cx={x + Math.cos(petal * Math.PI / 3) * 3.3} cy={y + Math.sin(petal * Math.PI / 3) * 3.3} r={2.1} fill={i % 4 === 0 ? '#ffe7a1' : '#fffdf0'} />)}<Circle cx={x} cy={y} r={1.8} fill="#e7aa35" /></AnimatedGroup>;
}
const GrassBlades = memo(function GrassBlades(props: GrassProps) {
  return <Svg width={props.width} height={props.height} viewBox={`0 0 ${props.width} 62`} preserveAspectRatio="none">{Array.from({ length: 12 }, (_, group) => <BladeGroup key={group} group={group} {...props} />)}{Array.from({ length: 9 }, (_, i) => <Flower key={`flower-${i}`} i={i} {...props} />)}</Svg>;
});
export default GrassBlades;
