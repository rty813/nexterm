import React from "react";
import {
  Bookmark,
  Box,
  Bug,
  Circle,
  Cloud,
  Container,
  Cpu,
  Database,
  Droplet,
  Flag,
  Folder,
  GitBranch,
  Heart,
  KeyRound,
  LoaderPinwheel,
  Rocket,
  Server,
  Square,
  Star,
  Tag,
  Terminal,
  Wifi,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { parseQuickIcon, type QuickIconShape } from "../utils/quickCommands";

const SHAPES: Record<QuickIconShape, LucideIcon> = {
  tag: Tag,
  square: Square,
  circle: Circle,
  heart: Heart,
  star: Star,
  pinwheel: LoaderPinwheel,
  waterdrop: Droplet,
  wifi: Wifi,
  bookmark: Bookmark,
  flag: Flag,
  zap: Zap,
  terminal: Terminal,
  rocket: Rocket,
  bug: Bug,
  cloud: Cloud,
  database: Database,
  server: Server,
  container: Container,
  box: Box,
  key: KeyRound,
  wrench: Wrench,
  folder: Folder,
  branch: GitBranch,
  cpu: Cpu,
};

/** Closed shapes get a tinted fill, like WindTerm's colored session marks. */
const FILLED = new Set<QuickIconShape>(["tag", "square", "circle", "heart", "star", "waterdrop", "bookmark", "flag", "cloud", "box"]);

/** A quick command's icon: a shape drawn in its color ("tag-coral"). */
export const QuickIcon: React.FC<{ icon?: string; size?: number }> = ({ icon, size = 12 }) => {
  const { shape, color } = parseQuickIcon(icon);
  const Icon = SHAPES[shape];
  const solid = FILLED.has(shape);
  return (
    <Icon
      size={size}
      className="quick-icon"
      style={{ color }}
      fill={solid ? "currentColor" : "none"}
      fillOpacity={solid ? 0.28 : undefined}
    />
  );
};
