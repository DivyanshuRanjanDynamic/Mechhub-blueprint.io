import { useMemo, useState } from "react";
import type { Blueprint, Connection, WiringBlock } from "../../shared/types.ts";
import { download, fileSafe } from "../api.ts";

const BLOCK_W = 210;
const ROW = 18;
const HEAD = 42;
const GAP_Y = 26;
const PAD = 30;

interface Placed {
  block: WiringBlock;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  left: string[];
  right: string[];
  chips: { pin: string; net: string; color: string }[];
}

function layout(bp: Blueprint, showPower: boolean) {
  const { blocks, connections } = bp.wiring;
  const mcu = blocks.find((b) => b.kind === "mcu")!;
  const col = new Map<string, number>();
  for (const b of blocks) {
    if (b.kind === "power") col.set(b.id, 0);
    else if (b.kind === "mcu") col.set(b.id, 1);
  }
  const touchesMcuSignal = (b: WiringBlock) =>
    connections.some((c) => c.kind === "signal" && ((c.from.block === mcu.id && c.to.block === b.id) || (c.to.block === mcu.id && c.from.block === b.id)));
  for (const b of blocks) if (!col.has(b.id) && (b.kind === "driver" || touchesMcuSignal(b))) col.set(b.id, 2);
  for (const b of blocks) if (!col.has(b.id)) col.set(b.id, connections.some((c) => (c.kind === "motor" || c.kind === "signal") && (c.to.block === b.id || c.from.block === b.id)) ? 3 : 2);

  const drawn = connections.filter((c) => {
    const a = col.get(c.from.block)!;
    const b = col.get(c.to.block)!;
    if (c.kind === "ground") return false;
    if (c.kind === "power") return showPower && Math.abs(a - b) === 1;
    return Math.abs(a - b) <= 1;
  });

  const placed = new Map<string, Placed>();
  for (const b of blocks) {
    const c = col.get(b.id)!;
    const left = new Set<string>();
    const right = new Set<string>();
    for (const w of drawn) {
      const self = w.from.block === b.id ? w.from : w.to.block === b.id ? w.to : null;
      if (!self) continue;
      const other = w.from.block === b.id ? w.to.block : w.from.block;
      const oc = col.get(other)!;
      (oc < c ? left : right).add(self.pin);
    }
    const chips = new Map<string, Placed["chips"][number]>();
    for (const w of connections) {
      if (w.kind !== "power" && w.kind !== "ground") continue;
      if (drawn.includes(w)) continue;
      const self = w.from.block === b.id ? w.from : w.to.block === b.id ? w.to : null;
      if (!self) continue;
      chips.set(`${self.pin}|${w.net}`, { pin: self.pin, net: w.net, color: w.color });
    }
    const chipRows = Math.ceil(chips.size / 2);
    const w = b.kind === "mcu" ? BLOCK_W + 30 : BLOCK_W;
    const h = HEAD + Math.max(left.size, right.size, 1) * ROW + (chipRows ? chipRows * 20 + 10 : 6);
    placed.set(b.id, { block: b, col: c, x: 0, y: 0, w, h, left: [...left], right: [...right], chips: [...chips.values()] });
  }

  // Lanes between adjacent columns
  const lanes = new Map<string, number>();
  const laneCount = [0, 0, 0];
  const colsUsed = [0, 1, 2, 3].filter((c) => [...placed.values()].some((p) => p.col === c));
  // vertical stacking
  const heights = [0, 1, 2, 3].map((c) => [...placed.values()].filter((p) => p.col === c).reduce((s, p) => s + p.h + GAP_Y, -GAP_Y));
  const totalH = Math.max(...heights, 200);
  for (const c of [0, 1, 2, 3]) {
    let y = PAD + (totalH - Math.max(0, heights[c])) / 2;
    for (const p of [...placed.values()].filter((p) => p.col === c)) {
      p.y = y;
      y += p.h + GAP_Y;
    }
  }
  const pinY = (p: Placed, pin: string, side: "left" | "right") => p.y + HEAD + (side === "left" ? p.left : p.right).indexOf(pin) * ROW + ROW / 2;

  // assign lanes, ordered by source y to reduce crossings
  const sorted = drawn
    .map((w) => {
      const a = placed.get(w.from.block)!;
      const b = placed.get(w.to.block)!;
      const l = a.col <= b.col ? a : b;
      const lp = l === a ? w.from.pin : w.to.pin;
      return { w, gap: l.col, y: pinY(l, lp, "right") };
    })
    .sort((p, q) => p.y - q.y);
  const netLane = new Map<string, number>();
  for (const s of sorted) {
    const key = `${s.gap}|${s.w.net}`;
    // wires on the same net (e.g. a shared I²C bus) share one lane
    if (!netLane.has(key) || s.w.kind !== "signal" || !/^(SDA|SCL)$/.test(s.w.net)) netLane.set(key, laneCount[s.gap]++);
    lanes.set(s.w.id, netLane.get(key)!);
  }

  // x positions
  let x = PAD;
  const colX: number[] = [];
  for (const c of [0, 1, 2, 3]) {
    colX[c] = x;
    const w = Math.max(0, ...[...placed.values()].filter((p) => p.col === c).map((p) => p.w));
    x += w + (colsUsed.includes(c) ? Math.max(90, (laneCount[c] ?? 0) * 11 + 60) : 0);
  }
  for (const p of placed.values()) p.x = colX[p.col] + (Math.max(...[...placed.values()].filter((q) => q.col === p.col).map((q) => q.w)) - p.w) / 2;

  const wires = drawn.map((w) => {
    const a = placed.get(w.from.block)!;
    const b = placed.get(w.to.block)!;
    const same = a.col === b.col;
    const [l, r, lp, rp] = a.col <= b.col ? [a, b, w.from.pin, w.to.pin] : [b, a, w.to.pin, w.from.pin];
    const x1 = l.x + l.w;
    const y1 = pinY(l, lp, "right");
    const gapStart = colX[l.col] + Math.max(...[...placed.values()].filter((q) => q.col === l.col).map((q) => q.w));
    const lx = gapStart + 24 + lanes.get(w.id)! * 11;
    if (same) {
      const y2 = pinY(r, rp, "right");
      return { w, d: `M${x1} ${y1} H${lx} V${y2} H${r.x + r.w}` };
    }
    const x2 = r.x;
    const y2 = pinY(r, rp, "left");
    return { w, d: `M${x1} ${y1} H${lx} V${y2} H${x2}` };
  });

  return { placed: [...placed.values()], wires, width: x + PAD, height: totalH + PAD * 2, pinY };
}

export default function Schematic({ bp }: { bp: Blueprint }) {
  const [showPower, setShowPower] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [filter, setFilter] = useState("");
  const L = useMemo(() => layout(bp, showPower), [bp, showPower]);
  const label = new Map(bp.wiring.blocks.map((b) => [b.id, b.label]));
  const lit = (c: Connection) => !focus || c.net === focus || c.from.block === focus || c.to.block === focus;

  function exportSvg() {
    const svg = document.getElementById("schematic-svg");
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("style", "background:#0b1222;font-family:sans-serif");
    download(`${fileSafe(bp.plan.title)}-schematic.svg`, clone.outerHTML, "image/svg+xml");
  }

  const rows = bp.wiring.connections.filter((c) => {
    const q = filter.toLowerCase();
    return !q || `${label.get(c.from.block)} ${c.from.pin} ${label.get(c.to.block)} ${c.to.pin} ${c.net}`.toLowerCase().includes(q);
  });

  return (
    <div className="schematic">
      <div className="toolbar">
        <div className="legend">
          <span>
            <i style={{ background: "#ef4444" }} /> power
          </span>
          <span>
            <i style={{ background: "#1f2937", outline: "1px solid #64748b" }} /> ground
          </span>
          <span>
            <i style={{ background: "#3b82f6" }} /> SDA
          </span>
          <span>
            <i style={{ background: "#facc15" }} /> SCL / signal
          </span>
          <span>
            <i style={{ background: "#f59e0b" }} /> motor
          </span>
        </div>
        <div className="row-gap">
          <label className="toggle">
            <input type="checkbox" checked={showPower} onChange={(e) => setShowPower(e.target.checked)} />
            <span />
            Draw power wires
          </label>
          <button className="btn small" onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))} aria-label="Zoom out">
            −
          </button>
          <button className="btn small" onClick={() => setZoom((z) => Math.min(2, z + 0.15))} aria-label="Zoom in">
            +
          </button>
          <button className="btn small" onClick={exportSvg}>
            Export SVG
          </button>
        </div>
      </div>
      <div className="schematic-canvas" onClick={() => setFocus(null)}>
        <svg id="schematic-svg" width={L.width * zoom} height={L.height * zoom} viewBox={`0 0 ${L.width} ${L.height}`} role="img" aria-label="Wiring schematic">
          <defs>
            <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M20 0H0V20" fill="none" stroke="rgba(148,163,184,0.08)" />
            </pattern>
          </defs>
          <rect width={L.width} height={L.height} fill="url(#grid)" />
          {L.wires.map(({ w, d }) => (
            <path
              key={w.id}
              d={d}
              fill="none"
              stroke={w.color === "#1f2937" ? "#64748b" : w.color}
              strokeWidth={focus && lit(w) ? 3 : 2}
              strokeLinejoin="round"
              opacity={lit(w) ? 1 : 0.12}
              strokeDasharray={w.kind === "power" ? "6 3" : undefined}
              onMouseEnter={() => setFocus(w.net)}
              onClick={(e) => {
                e.stopPropagation();
                setFocus(w.net);
              }}
            >
              <title>{`${label.get(w.from.block)} ${w.from.pin} → ${label.get(w.to.block)} ${w.to.pin} (${w.net})`}</title>
            </path>
          ))}
          {L.placed.map((p) => {
            const active = !focus || focus === p.block.id || bp.wiring.connections.some((c) => lit(c) && (c.from.block === p.block.id || c.to.block === p.block.id));
            return (
              <g
                key={p.block.id}
                transform={`translate(${p.x},${p.y})`}
                opacity={active ? 1 : 0.3}
                onClick={(e) => {
                  e.stopPropagation();
                  setFocus(focus === p.block.id ? null : p.block.id);
                }}
                className="sch-block"
              >
                <rect width={p.w} height={p.h} rx="8" className={`sch-rect ${p.block.kind}`} />
                <text x="10" y="18" className="sch-title">
                  {p.block.label.length > 30 ? p.block.label.slice(0, 29) + "…" : p.block.label}
                </text>
                <text x="10" y="33" className="sch-sub">
                  {p.block.sublabel.length > 34 ? p.block.sublabel.slice(0, 33) + "…" : p.block.sublabel}
                </text>
                {p.left.map((pin, i) => (
                  <g key={`l${pin}`} transform={`translate(0,${HEAD + i * ROW + ROW / 2})`}>
                    <circle r="3.5" className="sch-pin" />
                    <text x="9" y="4" className="sch-pinlabel">
                      {pin}
                    </text>
                  </g>
                ))}
                {p.right.map((pin, i) => (
                  <g key={`r${pin}`} transform={`translate(${p.w},${HEAD + i * ROW + ROW / 2})`}>
                    <circle r="3.5" className="sch-pin" />
                    <text x="-9" y="4" textAnchor="end" className="sch-pinlabel">
                      {pin}
                    </text>
                  </g>
                ))}
                {p.chips.map((c, i) => {
                  const cx = 8 + (i % 2) * ((p.w - 16) / 2);
                  const cy = p.h - Math.ceil(p.chips.length / 2) * 20 - 4 + Math.floor(i / 2) * 20;
                  return (
                    <g key={c.pin + c.net} transform={`translate(${cx},${cy})`}>
                      <rect width={(p.w - 20) / 2} height="16" rx="8" fill={c.color === "#1f2937" ? "#334155" : c.color} opacity="0.25" />
                      <circle cx="8" cy="8" r="3" fill={c.color === "#1f2937" ? "#94a3b8" : c.color} />
                      <text x="15" y="12" className="sch-chip">
                        {c.pin === c.net ? c.pin : `${c.pin}→${c.net}`}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <p className="muted small">Click a block or wire to trace its connections. Power and ground are shown as rail tags on each block; every connection is listed below.</p>

      <div className="toolbar">
        <h3>Connection list ({bp.wiring.connections.length})</h3>
        <input className="input" placeholder="Filter (e.g. SDA, servo, GPIO25)" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>Wire</th>
              <th>From</th>
              <th>To</th>
              <th>Net</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} onMouseEnter={() => setFocus(c.net)}>
                <td>
                  <span className="swatch" style={{ background: c.color }} />
                </td>
                <td>
                  {label.get(c.from.block)} <b className="mono">{c.from.pin}</b>
                </td>
                <td>
                  {label.get(c.to.block)} <b className="mono">{c.to.pin}</b>
                </td>
                <td className="mono">{c.net}</td>
                <td className="muted">{c.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
