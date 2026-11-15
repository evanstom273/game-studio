/** Node type icons, coloured by family like Godot (2D blue, 3D red, audio amber, core grey). */
import { Box, Circle, Film, Flashlight, Globe, Hexagon, Image, Lightbulb, Move, Move3d, PersonStanding, Scan, Shapes, Square, SquareDashed, Sun, Timer, Type, Video, Volume2, type LucideIcon } from 'lucide-react';
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
};

export function nodeColorClass(type: string) {
  const info = nodeTypes.get(type);
  if (!info) return 'text-faint';
  if (info.category === 'Audio') return 'text-node-audio';
  const dim = nodeTypes.dimension(type);
  return dim === '2d' ? 'text-node-2d' : dim === '3d' ? 'text-node-3d' : 'text-node-core';
}

export function NodeIcon({ type, size = 14, className }: { type: string; size?: number; className?: string }) {
  const Icon = ICONS[nodeTypes.get(type)?.icon ?? ''] ?? Circle;
  return <Icon size={size} className={cx('shrink-0', nodeColorClass(type), className)} aria-hidden />;
}
