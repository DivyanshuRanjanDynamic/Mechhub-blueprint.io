// Shared three.js helpers: build meshes from MechPart data, and render still thumbnails
// through a single offscreen renderer (browsers cap live WebGL contexts at ~16).
import * as THREE from "three";
import type { MechPart } from "../../shared/types.ts";

export type RenderMode = "solid" | "wire" | "exploded";

export const BLUE = 0x0f46e1;
export const NAVY = 0x101d33;

export function makeMesh(p: MechPart, edges = true): THREE.Mesh {
  const geo = p.shape === "box" ? new THREE.BoxGeometry(p.size[0], p.size[1], p.size[2]) : new THREE.CylinderGeometry(p.size[0], p.size[2], p.size[1], 48);
  const mat = new THREE.MeshStandardMaterial({
    color: p.color,
    roughness: p.printed ? 0.55 : 0.4,
    metalness: p.material === "Purchased" ? 0.35 : 0.05,
    transparent: (p.opacity ?? 1) < 1,
    opacity: p.opacity ?? 1,
    depthWrite: (p.opacity ?? 1) >= 1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = p.name;
  mesh.position.set(...p.position);
  mesh.rotation.set(...p.rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.part = p;
  if (edges) {
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: 0x0b1222, transparent: true, opacity: 0.35 }));
    e.userData.isEdge = true;
    mesh.add(e);
  }
  return mesh;
}

/** A line-drawing version of a geometry: faint blue fill plus crisp edges. */
export function wireObject(geo: THREE.BufferGeometry, color = BLUE, fillOpacity = 0.06, threshold = 20): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fillOpacity, depthWrite: false })));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, threshold), new THREE.LineBasicMaterial({ color })));
  return g;
}

export function fitCamera(camera: THREE.PerspectiveCamera, object: THREE.Object3D, distance = 1.35, elevation = 0.55, azimuth = 0.85) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z) || 100;
  camera.position.set(center.x + Math.sin(azimuth) * r * distance * 1.3, center.y + r * elevation * distance, center.z + Math.cos(azimuth) * r * distance * 1.3);
  camera.near = r / 100;
  camera.far = r * 20;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return { center, radius: r, box };
}

let shared: { renderer: THREE.WebGLRenderer; w: number; h: number } | null = null;
const cache = new Map<string, string>();

function getRenderer(w: number, h: number) {
  if (!shared) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    shared = { renderer, w: 0, h: 0 };
  }
  if (shared.w !== w || shared.h !== h) {
    shared.renderer.setSize(w, h, false);
    shared.w = w;
    shared.h = h;
  }
  return shared.renderer;
}

/** Render a still image of a model. Returns a PNG data URL (cached per key). */
export function renderThumbnail(key: string, parts: MechPart[], mode: RenderMode = "solid", w = 560, h = 420, background: number | null = null, wireColor = BLUE): string | null {
  const cacheKey = `${key}|${mode}|${w}x${h}|${background}|${wireColor}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = getRenderer(w, h);
  } catch {
    return null;
  }
  const scene = new THREE.Scene();
  if (background !== null) scene.background = new THREE.Color(background);
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  for (const p of parts) {
    const ex = mode === "exploded" ? p.explode ?? [0, 0, 0] : [0, 0, 0];
    const placed = { ...p, position: [p.position[0] + ex[0] * 1.1, p.position[1] + ex[1] * 1.1, p.position[2] + ex[2] * 1.1] as [number, number, number] };
    if (mode === "wire") {
      const geo = p.shape === "box" ? new THREE.BoxGeometry(...p.size) : new THREE.CylinderGeometry(p.size[0], p.size[2], p.size[1], 28);
      const obj = wireObject(geo, wireColor, (p.opacity ?? 1) < 1 ? 0.02 : 0.07);
      obj.position.set(...placed.position);
      obj.rotation.set(...p.rotation);
      group.add(obj);
      disposables.push(geo);
    } else {
      const m = makeMesh(placed);
      group.add(m);
      disposables.push(m.geometry, m.material as THREE.Material);
    }
  }
  scene.add(group);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9bb8, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1, 2, 1.4);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(32, w / h, 1, 10000);
  fitCamera(camera, group, 1.45, 0.5);
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");
  disposables.forEach((d) => d.dispose());
  cache.set(cacheKey, url);
  return url;
}
