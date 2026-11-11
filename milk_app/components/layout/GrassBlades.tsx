import { memo, useMemo } from 'react';
import { Canvas, Circle, Group, Path, Skia } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

type Blade = { x: number; height: number; width: number; phase: number; lean: number; color: string };
export type GrassProps = { width: number; height: number; time: SharedValue<number>; brushX: SharedValue<number>; brushStrength: SharedValue<number> };
const colors = ['#426921', '#577b24', '#729635', '#88a23c', '#3e6421', '#9aa947', '#648625'];
function bladeFor(i: number, width: number): Blade {
  const random = (n: number) => { const x = Math.sin((i + 1) * n) * 43758.5453; return x - Math.floor(x); };
  return { x: (i / 155) * (width + 20) - 10, height: 20 + random(12.23) * 42, width: 2 + random(8.13) * 4, phase: random(4.72) * 6.28, lean: (random(5.61) - 0.5) * 18, color: colors[i % colors.length] };
}
function BladeGroup({ blades, center, time, brushX, brushStrength }: { blades: Blade[]; center: number } & Omit<GrassProps, 'width' | 'height'>) {
  const paths = useMemo(() => blades.map((blade) => {
    const p = Skia.PathBuilder.Make();
    p.moveTo(blade.x - blade.width / 2, 62);
    p.quadTo(blade.x, 62 - blade.height * 0.56, blade.x + blade.lean, 62 - blade.height);
    p.quadTo(blade.x + blade.width, 62 - blade.height * 0.43, blade.x + blade.width / 2, 62);
    p.close();
    return p.detach();
  }), [blades]);
  const transform = useDerivedValue(() => {
    const wind = Math.sin(time.value * 6.283 + center * 0.015) * 0.09;
    const distance = center - brushX.value;
    const touch = Math.max(0, 1 - Math.abs(distance) / 65) * brushStrength.value * (distance < 0 ? -0.2 : 0.2);
    return [{ rotate: wind + touch }];
  });
  return <Group origin={{ x: center, y: 62 }} transform={transform}>{paths.map((path, i) => <Path key={i} path={path} color={blades[i].color} />)}</Group>;
}
function Flower({ i, width, time, brushX, brushStrength }: GrassProps & { i: number }) {
  const x = (i + 0.5) * width / 9;
  const y = 8 + (i % 4) * 4;
  const transform = useDerivedValue(() => {
    const wind = Math.sin(time.value * 6.283 + x * 0.02) * 3;
    const distance = x - brushX.value;
    const touch = Math.max(0, 1 - Math.abs(distance) / 65) * brushStrength.value * (distance < 0 ? -8 : 8);
    return [{ translateX: wind + touch }];
  });
  const stem = Skia.PathBuilder.Make(); stem.moveTo(x, 62); stem.quadTo(x - 3, y + 18, x, y); const path = stem.detach();
  return <Group transform={transform}><Path path={path} color="#557b2d" style="stroke" strokeWidth={1.3} />{Array.from({ length: 6 }, (_, petal) => <Circle key={petal} cx={x + Math.cos(petal * Math.PI / 3) * 3.3} cy={y + Math.sin(petal * Math.PI / 3) * 3.3} r={2.1} color={i % 4 === 0 ? '#ffe7a1' : '#fffdf0'} />)}<Circle cx={x} cy={y} r={1.8} color="#e7aa35" /></Group>;
}
const GrassBlades = memo(function GrassBlades({ width, height, time, brushX, brushStrength }: GrassProps) {
  const groups = useMemo(() => Array.from({ length: 12 }, (_, group) => Array.from({ length: 13 }, (_, i) => bladeFor(group * 13 + i, width))), [width]);
  return <Canvas style={{ width, height }}><Group transform={[{ scaleY: height / 62 }]}>{groups.map((blades, i) => <BladeGroup key={i} blades={blades} center={(i + 0.5) * width / 12} time={time} brushX={brushX} brushStrength={brushStrength} />)}{Array.from({ length: 9 }, (_, i) => <Flower key={`flower-${i}`} i={i} width={width} height={height} time={time} brushX={brushX} brushStrength={brushStrength} />)}</Group></Canvas>;
});
export default GrassBlades;
