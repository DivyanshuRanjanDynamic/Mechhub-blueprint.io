import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { buildDrone } from "../../lib/drone.ts";
import { BLUE, fitCamera } from "../../lib/scene.ts";

/** Line-drawing quadcopter that hovers, banks gently and spins its props — the hero visual. */
export default function HeroModel() {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 1, 10000);
    const { group, props } = buildDrone(BLUE);
    const pivot = new THREE.Group();
    pivot.add(group);
    scene.add(pivot);
    const { radius } = fitCamera(camera, pivot, 1.4, 0.62, 0.75);
    // Slide the camera sideways so the drone sits on the right of its canvas, clear of the headline
    camera.updateMatrixWorld();
    camera.position.addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), -radius * 0.12);

    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    let raf = 0;
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      if (!reduced) {
        pivot.rotation.y = t * 0.16;
        group.position.y = Math.sin(t * 1.1) * 6;
        group.rotation.z = Math.sin(t * 0.7) * 0.05;
        group.rotation.x = Math.sin(t * 0.5) * 0.04;
        for (const p of props) p.obj.rotation.y = t * 9 * p.dir;
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  if (failed) return null;
  return <div ref={host} className="hero-model" aria-hidden />;
}
