import { useEffect, useState } from "react";
import type { MechPart } from "../../../shared/types.ts";
import type { RenderMode } from "../../lib/scene.ts";

// Renders queue through one offscreen WebGL renderer, one per idle slot, so a page of cards
// doesn't block the main thread or exhaust WebGL contexts.
let queue: Promise<unknown> = Promise.resolve();
const idle = () => new Promise<void>((r) => ("requestIdleCallback" in window ? requestIdleCallback(() => r(), { timeout: 400 }) : setTimeout(r, 16)));

export default function Thumb({ id, parts, mode = "solid", alt, width = 560, height = 420, wire }: { id: string; parts: MechPart[]; mode?: RenderMode; alt: string; width?: number; height?: number; wire?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!parts.length) return;
    queue = queue.then(async () => {
      if (!live) return;
      await idle();
      const { renderThumbnail } = await import("../../lib/scene.ts");
      const url = renderThumbnail(id, parts, mode, width, height, null, wire);
      if (live) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [id, parts, mode, width, height, wire]);
  return src ? <img className="thumb" src={src} alt={alt} width={width} height={height} /> : <div className="thumb skeleton" role="img" aria-label={alt} />;
}
