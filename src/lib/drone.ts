// Procedural quadcopter used as the homepage hero. All dimensions in mm, Y up, nose along +Z.
// Built from simple primitives so it reads cleanly as a line drawing.
import * as THREE from "three";
import { wireObject } from "./scene.ts";

export interface Drone {
  group: THREE.Group;
  /** propeller groups, spun in alternating directions by the caller */
  props: { obj: THREE.Object3D; dir: 1 | -1 }[];
}

export function buildDrone(color: number): Drone {
  const group = new THREE.Group();
  const props: Drone["props"] = [];
  const add = (geo: THREE.BufferGeometry, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], parent: THREE.Object3D = group, fill = 0.05) => {
    const o = wireObject(geo, color, fill, 24);
    o.position.set(...pos);
    o.rotation.set(...rot);
    parent.add(o);
    return o;
  };

  // Fuselage: lower deck, upper deck, canopy and battery
  add(new THREE.BoxGeometry(76, 14, 120), [0, 0, 0]);
  add(new THREE.BoxGeometry(64, 6, 100), [0, 12, -4]);
  add(new THREE.SphereGeometry(34, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), [0, 15, 18], [0, 0, 0], group, 0.04).scale.set(0.9, 0.6, 1.25);
  add(new THREE.BoxGeometry(40, 18, 70), [0, 24, -20]);
  for (const x of [-26, 26]) for (const z of [-44, 36]) add(new THREE.CylinderGeometry(2, 2, 12, 6), [x, 6, z]);

  // Arms, motors, propellers and guards
  const reach = 150;
  [45, 135, 225, 315].forEach((deg, i) => {
    const a = THREE.MathUtils.degToRad(deg);
    const dx = Math.sin(a);
    const dz = Math.cos(a);
    add(new THREE.BoxGeometry(12, 9, reach), [dx * reach * 0.52, 2, dz * reach * 0.52], [0, a, 0]);
    const mx = dx * reach;
    const mz = dz * reach;
    add(new THREE.CylinderGeometry(15, 15, 6, 16), [mx, 4, mz]);
    add(new THREE.CylinderGeometry(13, 14, 18, 16), [mx, 16, mz]);
    add(new THREE.CylinderGeometry(3, 3, 8, 8), [mx, 29, mz]);
    // two-blade prop with a little pitch on each blade
    const prop = new THREE.Group();
    prop.position.set(mx, 33, mz);
    group.add(prop);
    add(new THREE.CylinderGeometry(6, 6, 4, 12), [0, 0, 0], [0, 0, 0], prop);
    add(new THREE.BoxGeometry(62, 1.6, 13), [35, 0, 0], [0.18, 0, 0], prop, 0.12);
    add(new THREE.BoxGeometry(62, 1.6, 13), [-35, 0, 0], [-0.18, 0, 0], prop, 0.12);
    props.push({ obj: prop, dir: i % 2 ? 1 : -1 });
    // prop guard ring with two struts back to the arm
    add(new THREE.TorusGeometry(74, 1.6, 3, 48), [mx, 33, mz], [Math.PI / 2, 0, 0], group, 0.02);
    for (const off of [-0.55, 0.55]) {
      const sa = a + Math.PI + off;
      add(new THREE.BoxGeometry(3, 3, 64), [mx + Math.sin(sa) * 40, 22, mz + Math.cos(sa) * 40], [0.38, sa, 0]);
    }
  });

  // Landing gear: two skids on angled legs
  for (const side of [-1, 1]) {
    add(new THREE.CylinderGeometry(3, 3, 170, 8), [side * 52, -58, 0], [Math.PI / 2, 0, 0]);
    for (const z of [-42, 42]) add(new THREE.CylinderGeometry(2.6, 2.6, 62, 8), [side * 42, -30, z], [0, 0, side * 0.42]);
  }

  // Camera gimbal under the nose
  add(new THREE.BoxGeometry(26, 10, 22), [0, -12, 46]);
  add(new THREE.SphereGeometry(15, 12, 8), [0, -30, 50]);
  add(new THREE.CylinderGeometry(7, 7, 10, 12), [0, -30, 64], [Math.PI / 2, 0, 0], group, 0.12);

  // GPS mast and antennas
  add(new THREE.CylinderGeometry(2, 2, 34, 6), [0, 48, -44]);
  add(new THREE.CylinderGeometry(12, 12, 5, 16), [0, 66, -44]);
  for (const x of [-22, 22]) add(new THREE.CylinderGeometry(1.5, 1.5, 46, 6), [x, 18, -66], [-0.5, 0, x > 0 ? -0.25 : 0.25]);

  return { group, props };
}
