import { useEffect, useState } from "react";
import type { Project } from "../../../shared/types.ts";
import { money } from "../../api.ts";
import Thumb from "./Thumb.tsx";

const TABS = ["prompt", "parts", "wiring", "mech"] as const;
type Tab = (typeof TABS)[number];

/** Live preview of a real generated project, one tab per output. */
export default function DemoPanel({ project, onTry }: { project: Project | null; onTry: (prompt: string) => void }) {
  const [tab, setTab] = useState<Tab>("prompt");
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!auto || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setTab((x) => TABS[(TABS.indexOf(x) + 1) % TABS.length]), 4200);
    return () => clearInterval(t);
  }, [auto]);

  const bp = project?.blueprint;
  const pick = (t: Tab) => {
    setAuto(false);
    setTab(t);
  };

  const groups = bp
    ? [...new Set(bp.bom.map((b) => b.group))].map((g) => ({ g, items: bp.bom.filter((b) => b.group === g) })).slice(0, 6)
    : [];
  const signals = bp?.wiring.connections.filter((c) => c.kind === "signal").slice(0, 9) ?? [];
  const label = new Map(bp?.wiring.blocks.map((b) => [b.id, b.label]) ?? []);

  return (
    <div className="demo">
      <div className="demo-tabs" role="tablist" aria-label="Blueprint outputs">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => pick(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="demo-body" role="tabpanel">
        {!bp ? (
          <div className="thumb skeleton" />
        ) : tab === "prompt" ? (
          <div className="demo-visual">
            <Thumb id={`${project!.id}-v${bp.version}`} parts={bp.mech} mode="wire" alt={`${bp.plan.title} line drawing`} wire={0x8fb0ff} />
          </div>
        ) : tab === "parts" ? (
          <div className="demo-list">
            {groups.map(({ g, items }) => (
              <div key={g} className="demo-row">
                <span className="mono-label">{g}</span>
                <span className="demo-names">{items.map((i) => i.name.split(/[(,]/)[0]).join(" · ")}</span>
                <span className="mono-num">{money(items.reduce((s, i) => s + i.qty * i.unitPrice, 0))}</span>
              </div>
            ))}
            <div className="demo-row total">
              <span className="mono-label">total</span>
              <span className="demo-names">{bp.totals.parts} parts with buy links</span>
              <span className="mono-num">{money(bp.totals.cost)}</span>
            </div>
          </div>
        ) : tab === "wiring" ? (
          <div className="demo-list">
            {signals.map((c) => (
              <div key={c.id} className="demo-row wire">
                <i style={{ background: c.color }} />
                <span className="demo-names">
                  {label.get(c.from.block)?.split("·")[0]} <b>{c.from.pin}</b> → {label.get(c.to.block)?.split("·")[1]?.trim()} <b>{c.to.pin}</b>
                </span>
                <span className="mono-label">{c.net}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="demo-visual">
            <Thumb id={`${project!.id}-v${bp.version}`} parts={bp.mech} mode="exploded" alt={`${bp.plan.title} exploded view`} />
          </div>
        )}
      </div>
      <button className="demo-input" onClick={() => onTry(project?.prompt ?? "")}>
        <span className="mono-label">›</span>
        <span>{project?.prompt.toLowerCase() ?? "create a robotic arm"}</span>
        <span className="demo-go">→</span>
      </button>
    </div>
  );
}
