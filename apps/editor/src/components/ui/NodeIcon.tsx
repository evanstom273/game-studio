/** Node type icons, coloured by family like Godot (2D blue, 3D red, audio amber, core grey). */
import {
  AudioLines,
  Box,
  CaseSensitive,
  Circle,
  Clapperboard,
  Columns3,
  Contrast,
  Crosshair,
  Film,
  Flashlight,
  Frame,
  Globe,
  Grid3x3,
  Hexagon,
  Image,
  Lamp,
  Layers,
  Lightbulb,
  Mountain,
  MousePointerClick,
  Move,
  Move3d,
  MoveHorizontal,
  Navigation,
  PaintBucket,
  PanelTop,
  PersonStanding,
  Radar,
  RectangleHorizontal,
  Route,
  Rows3,
  Scaling,
  Scan,
  ScanEye,
  Shapes,
  Sparkles,
  Speaker,
  Spline,
  Square,
  SquareDashed,
  SquareDashedMousePointer,
  Sun,
  Timer,
  Type,
  Video,
  Volume2,
  type LucideIcon,
} from 'lucide-react';
import { nodeTypes } from '@gs/core';
import { cx } from './primitives';

/** Icon names used by NodeTypeInfo.icon. Register new ones here when adding node types. */
const ICONS: Record<string, LucideIcon> = {
  circle: Circle,
  move: Move,
  image: Image,
  film: Film,
  hexagon: Hexagon,
  type: Type,
  video: Video,
  shapes: Shapes,
  square: Square,
  box: Box,
  'person-standing': PersonStanding,
  scan: Scan,
  'square-dashed': SquareDashed,
  'move-3d': Move3d,
  sun: Sun,
  lightbulb: Lightbulb,
  flashlight: Flashlight,
  globe: Globe,
  timer: Timer,
  'volume-2': Volume2,
  layers: Layers,
  crosshair: Crosshair,
  spline: Spline,
  route: Route,
  navigation: Navigation,
  sparkles: Sparkles,
  contrast: Contrast,
  lamp: Lamp,
  mountain: Mountain,
  'scan-eye': ScanEye,
  'grid-3x3': Grid3x3,
  'move-horizontal': MoveHorizontal,
  radar: Radar,
  'square-dashed-mouse-pointer': SquareDashedMousePointer,
  'paint-bucket': PaintBucket,
  'panel-top': PanelTop,
  'case-sensitive': CaseSensitive,
  'mouse-pointer-click': MousePointerClick,
  'rectangle-horizontal': RectangleHorizontal,
  frame: Frame,
  'columns-3': Columns3,
  'rows-3': Rows3,
  scaling: Scaling,
  'audio-lines': AudioLines,
  speaker: Speaker,
  clapperboard: Clapperboard,
};

export function nodeColorClass(type: string) {
  const info = nodeTypes.get(type);
  if (!info) return 'text-faint';
  if (info.category === 'Audio') return 'text-node-audio';
  if (info.category === 'UI') return 'text-node-ui';
  const dim = nodeTypes.dimension(type);
  return dim === '2d' ? 'text-node-2d' : dim === '3d' ? 'text-node-3d' : 'text-node-core';
}

export function NodeIcon({ type, size = 14, className }: { type: string; size?: number; className?: string }) {
  const Icon = ICONS[nodeTypes.get(type)?.icon ?? ''] ?? Circle;
  return <Icon size={size} className={cx('shrink-0', nodeColorClass(type), className)} aria-hidden />;
}
