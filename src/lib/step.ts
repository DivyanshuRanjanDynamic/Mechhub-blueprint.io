// Minimal STEP (ISO 10303-21, AP214) writer. Each model body becomes a FACETED_BREP built from
// planar faces: boxes give 6 quads, cylinders give side quads plus two polygon caps. FreeCAD,
// Fusion 360 and other OpenCascade-based tools import these as solids.
import type { MechPart } from "../../shared/types.ts";

type V3 = [number, number, number];

function rotate([x, y, z]: V3, [rx, ry, rz]: V3): V3 {
  // Matches three.js Euler order "XYZ": world = Rx · Ry · Rz · v
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
  // Rz
  let x1 = x * cz - y * sz;
  let y1 = x * sz + y * cz;
  let z1 = z;
  // Ry
  const x2 = x1 * cy + z1 * sy;
  const z2 = -x1 * sy + z1 * cy;
  x1 = x2;
  z1 = z2;
  // Rx
  const y3 = y1 * cx - z1 * sx;
  const z3 = y1 * sx + z1 * cx;
  return [x1, y3, z3];
}

/** Faces as vertex loops, counter-clockwise when viewed from outside. */
export function partFaces(p: MechPart, explode = 0): V3[][] {
  const pos: V3 = [p.position[0] + (p.explode?.[0] ?? 0) * explode, p.position[1] + (p.explode?.[1] ?? 0) * explode, p.position[2] + (p.explode?.[2] ?? 0) * explode];
  const tf = (v: V3): V3 => {
    const r = rotate(v, p.rotation);
    return [r[0] + pos[0], r[1] + pos[1], r[2] + pos[2]];
  };
  if (p.shape === "box") {
    const [w, h, d] = p.size.map((s) => s / 2) as V3;
    const c = (sx: number, sy: number, sz: number): V3 => tf([sx * w, sy * h, sz * d]);
    return [
      [c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)], // +z
      [c(1, -1, -1), c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1)], // -z
      [c(1, -1, 1), c(1, -1, -1), c(1, 1, -1), c(1, 1, 1)], // +x
      [c(-1, -1, -1), c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1)], // -x
      [c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1), c(-1, 1, -1)], // +y
      [c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)], // -y
    ];
  }
  const [rTop, h, rBot] = p.size;
  const n = 32;
  const top: V3[] = [];
  const bot: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    top.push(tf([Math.sin(a) * rTop, h / 2, Math.cos(a) * rTop]));
    bot.push(tf([Math.sin(a) * rBot, -h / 2, Math.cos(a) * rBot]));
  }
  const faces: V3[][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([bot[i], bot[j], top[j], top[i]]);
  }
  faces.push(top.slice());
  faces.push(bot.slice().reverse());
  return faces;
}

const f = (n: number) => {
  const s = (Math.round(n * 1e4) / 1e4).toString();
  return s.includes(".") || s.includes("e") ? s : `${s}.`;
};
const str = (s: string) => `'${s.replace(/'/g, "''").replace(/[^\x20-\x7e]/g, "_")}'`;

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: V3): V3 {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function toStep(title: string, parts: MechPart[]): string {
  const lines: string[] = [];
  let id = 0;
  const e = (def: string) => {
    id++;
    lines.push(`#${id}=${def};`);
    return `#${id}`;
  };

  const appCtx = e("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
  e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})`);
  const prodCtx = e(`PRODUCT_CONTEXT('',${appCtx},'mechanical')`);
  const pdCtx = e(`PRODUCT_DEFINITION_CONTEXT('part definition',${appCtx},'design')`);
  const product = e(`PRODUCT(${str(title)},${str(title)},'',(${prodCtx}))`);
  e(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${product}))`);
  const pdf = e(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
  const pd = e(`PRODUCT_DEFINITION('design','',${pdf},${pdCtx})`);
  const pds = e(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
  const lenUnit = e("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))");
  const angUnit = e("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))");
  const solUnit = e("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())");
  const unc = e(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-04),${lenUnit},'distance_accuracy_value','confusion accuracy')`);
  const geoCtx = e(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${lenUnit},${angUnit},${solUnit}))REPRESENTATION_CONTEXT('Context3D','3D context'))`);

  const breps: string[] = [];
  for (const p of parts) {
    const faces = partFaces(p);
    const ptCache = new Map<string, string>();
    const point = (v: V3) => {
      const k = v.map((n) => n.toFixed(4)).join(",");
      let ref = ptCache.get(k);
      if (!ref) {
        ref = e(`CARTESIAN_POINT('',(${f(v[0])},${f(v[1])},${f(v[2])}))`);
        ptCache.set(k, ref);
      }
      return ref;
    };
    const faceRefs: string[] = [];
    for (const loop of faces) {
      const nrm = norm(cross(sub(loop[1], loop[0]), sub(loop[loop.length - 1], loop[0])));
      const refDir = norm(sub(loop[1], loop[0]));
      const poly = e(`POLY_LOOP('',(${loop.map(point).join(",")}))`);
      const bound = e(`FACE_OUTER_BOUND('',${poly},.T.)`);
      const origin = point(loop[0]);
      const zDir = e(`DIRECTION('',(${f(nrm[0])},${f(nrm[1])},${f(nrm[2])}))`);
      const xDir = e(`DIRECTION('',(${f(refDir[0])},${f(refDir[1])},${f(refDir[2])}))`);
      const axis = e(`AXIS2_PLACEMENT_3D('',${origin},${zDir},${xDir})`);
      const plane = e(`PLANE('',${axis})`);
      faceRefs.push(e(`FACE_SURFACE('',(${bound}),${plane},.T.)`));
    }
    const shell = e(`CLOSED_SHELL('',(${faceRefs.join(",")}))`);
    breps.push(e(`FACETED_BREP(${str(p.name)},${shell})`));
  }
  const o = e("CARTESIAN_POINT('',(0.,0.,0.))");
  const z = e("DIRECTION('',(0.,0.,1.))");
  const x = e("DIRECTION('',(1.,0.,0.))");
  const world = e(`AXIS2_PLACEMENT_3D('',${o},${z},${x})`);
  const rep = e(`FACETED_BREP_SHAPE_REPRESENTATION(${str(title)},(${[...breps, world].join(",")}),${geoCtx})`);
  e(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`);

  const now = new Date().toISOString().slice(0, 19);
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('MechHub Blueprint assembly export'),'2;1');",
    `FILE_NAME(${str(title + ".step")},'${now}',('MechHub Blueprint'),(''),'MechHub Blueprint STEP writer','MechHub Blueprint','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;",
    "DATA;",
    ...lines,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}
