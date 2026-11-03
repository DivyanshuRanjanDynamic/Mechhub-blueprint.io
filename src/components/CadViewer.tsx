import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { Blueprint, MechPart } from "../../shared/types.ts";
import { download, fileSafe } from "../api.ts";
import { toStep } from "../lib/step.ts";
import { BLUE, NAVY, makeMesh } from "../lib/scene.ts";

export default function CadViewer({ bp }: { bp: Blueprint }) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef<{ group: THREE.Group; meshes: THREE.Mesh[]; renderer: THREE.WebGLRenderer; frame: () => void } | null>(null);
  const [explode, setExplode] = useState(0);
  const [selected, setSelected] = useState<MechPart | null>(null);
  const [printedOnly, setPrintedOnly] = useState(false);
  const [error, setError] = useState("");
  const parts = bp.mech;
  const bomName = useMemo(() => new Map(bp.bom.map((b) => [b.id, b])), [bp.bom]);

  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch {
      setError("WebGL is not available in this browser, so the 3D view can't be shown. Exports still work.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(NAVY);
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    scene.add(sun);

    const group = new THREE.Group();
    const meshes = parts.map((p) => makeMesh(p));
    meshes.forEach((m) => group.add(m));
    scene.add(group);

    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) || 200;
    const grid = new THREE.GridHelper(radius * 3, 30, BLUE, 0x22406e);
    grid.position.y = box.min.y - 0.5;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    scene.add(grid);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(radius * 3, radius * 3), new THREE.ShadowMaterial({ opacity: 0.3 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = box.min.y - 0.6;
    ground.receiveShadow = true;
    scene.add(ground);
    const s = radius * 1.5;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, far: radius * 8 });
    sun.position.set(center.x + radius, center.y + radius * 2, center.z + radius * 1.2);
    sun.target.position.copy(center);
    scene.add(sun.target);

    camera.position.set(center.x + radius * 1.3, center.y + radius * 0.9, center.z + radius * 1.5);
    controls.target.copy(center);

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

    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    let down = { x: 0, y: 0 };
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const r = renderer.domElement.getBoundingClientRect();
      ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ptr, camera);
      const hit = ray.intersectObjects(meshes, false).find((h) => (h.object as THREE.Mesh).visible);
      setSelected(hit ? (hit.object.userData.part as MechPart) : null);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    let raf = 0;
    const frame = () => {
      controls.update();
      renderer.render(scene, camera);
    };
    const loop = () => {
      frame();
      raf = requestAnimationFrame(loop);
    };
    loop();
    state.current = { group, meshes, renderer, frame };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      meshes.forEach((m) => {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
      state.current = null;
    };
  }, [parts]);

  // explode / highlight
  useEffect(() => {
    const st = state.current;
    if (!st) return;
    for (const m of st.meshes) {
      const p = m.userData.part as MechPart;
      const ex = p.explode ?? [0, 0, 0];
      m.position.set(p.position[0] + ex[0] * explode, p.position[1] + ex[1] * explode, p.position[2] + ex[2] * explode);
      const mat = m.material as THREE.MeshStandardMaterial;
      const isSel = selected?.id === p.id;
      mat.emissive.set(isSel ? BLUE : 0x000000);
      mat.emissiveIntensity = isSel ? 0.45 : 0;
      const faded = printedOnly && !p.printed;
      mat.opacity = faded ? 0.12 : p.opacity ?? 1;
      mat.transparent = faded || (p.opacity ?? 1) < 1;
      mat.depthWrite = !mat.transparent;
    }
  }, [explode, selected, printedOnly, parts]);

  const title = fileSafe(bp.plan.title);

  function exportStl(which: "all" | "printed" | "selected") {
    const list = which === "selected" && selected ? parts.filter((p) => p.id === selected.id) : which === "printed" ? parts.filter((p) => p.printed) : parts;
    if (!list.length) return;
    const g = new THREE.Group();
    // export at assembled positions (or at the origin for a single part, ready to slice)
    for (const p of list) {
      const m = makeMesh(which === "selected" ? { ...p, position: [0, p.size[1] / 2, 0] } : p);
      m.children.forEach((c) => c.removeFromParent());
      g.add(m);
    }
    g.rotation.x = Math.PI / 2; // Y-up scene → Z-up for slicers
    g.updateMatrixWorld(true);
    const data = new STLExporter().parse(g, { binary: true }) as DataView;
    download(`${title}${which === "selected" ? "-" + fileSafe(selected!.name) : which === "printed" ? "-printed-parts" : ""}.stl`, data.buffer as ArrayBuffer, "model/stl");
  }

  function exportGlb() {
    const g = new THREE.Group();
    for (const p of parts) {
      const m = makeMesh(p);
      m.children.forEach((c) => c.removeFromParent());
      m.scale.setScalar(1);
      g.add(m);
    }
    g.scale.setScalar(0.001); // glTF is in metres
    new GLTFExporter().parse(
      g,
      (out) => download(`${title}.glb`, out as ArrayBuffer, "model/gltf-binary"),
      (err) => setError(String(err)),
      { binary: true },
    );
  }

  function exportStep() {
    download(`${title}.step`, toStep(bp.plan.title, parts), "application/step");
  }

  function screenshot() {
    const st = state.current;
    if (!st) return;
    st.frame();
    st.renderer.domElement.toBlob((b) => b && download(`${title}.png`, b, "image/png"));
  }

  const sel = selected;
  const bom = sel?.bomId ? bomName.get(sel.bomId) : undefined;
  return (
    <div className="cad">
      <div className="toolbar">
        <div className="row-gap">
          <label className="slider">
            Explode
            <input type="range" min={0} max={1.5} step={0.01} value={explode} onChange={(e) => setExplode(Number(e.target.value))} />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={printedOnly} onChange={(e) => setPrintedOnly(e.target.checked)} />
            <span />
            Highlight 3D-printed
          </label>
        </div>
        <div className="row-gap">
          <button className="btn small" onClick={() => exportStl("all")}>
            STL
          </button>
          <button className="btn small" onClick={() => exportStl("printed")}>
            STL (printed)
          </button>
          <button className="btn small" onClick={exportStep}>
            STEP
          </button>
          <button className="btn small" onClick={exportGlb}>
            GLB
          </button>
          <button className="btn small ghost" onClick={screenshot}>
            PNG
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="cad-stage">
        <div ref={host} className="cad-canvas" />
        <div className="cad-hint muted small">Drag to orbit · right-drag to pan · scroll to zoom · click a part</div>
        {sel && (
          <div className="cad-info">
            <button className="close" onClick={() => setSelected(null)} aria-label="Close">
              ×
            </button>
            <h3>{sel.name}</h3>
            <p className="muted small">
              {sel.shape === "box" ? `${sel.size[0]} × ${sel.size[1]} × ${sel.size[2]} mm` : `Ø${sel.size[0] * 2} × ${sel.size[1]} mm`} · {sel.printed ? `3D print (${sel.material})` : sel.material}
            </p>
            {bom && <p className="small">BOM: {bom.name}</p>}
            {sel.printed && (
              <button className="btn small primary" onClick={() => exportStl("selected")}>
                Download this part (STL)
              </button>
            )}
          </div>
        )}
      </div>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>Body</th>
              <th>Dimensions (mm)</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => (
              <tr key={p.id} className={selected?.id === p.id ? "sel" : ""} onClick={() => setSelected(p)}>
                <td>
                  <span className="swatch" style={{ background: p.color }} /> {p.name}
                </td>
                <td className="mono">{p.shape === "box" ? p.size.join(" × ") : `Ø${p.size[0] * 2} × ${p.size[1]}`}</td>
                <td>{p.printed ? <span className="pill">3D print · {p.material}</span> : <span className="muted">{p.material}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
