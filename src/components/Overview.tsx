import type { Blueprint } from "../../shared/types.ts";
import { money } from "../api.ts";

export default function Overview({ bp, onTab }: { bp: Blueprint; onTab: (t: string) => void }) {
  const printed = bp.mech.filter((m) => m.printed).length;
  const mcu = bp.bom.find((b) => b.group === "MCU");
  const groups = new Map<string, number>();
  for (const b of bp.bom) groups.set(b.group, (groups.get(b.group) ?? 0) + b.qty * b.unitPrice);
  const max = Math.max(...groups.values());
  return (
    <div className="overview">
      <div className="summary-card">
        <div className="tags">
          {bp.plan.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
        <p className="summary">{bp.plan.summary}</p>
        <p className="muted small">
          Controller: <b>{mcu?.name}</b> · Power: <b>{bp.plan.power}</b>
          {bp.plan.budget ? (
            <>
              {" "}
              · Budget: <b>{money(bp.plan.budget)}</b>
            </>
          ) : null}
        </p>
      </div>

      <div className="tiles">
        {[
          ["Parts", String(bp.totals.parts), "Parts"],
          ["Est. cost", money(bp.totals.cost), "Parts"],
          ["Connections", String(bp.wiring.connections.length), "Wiring"],
          [`3D bodies · ${printed} printed`, String(bp.mech.length), "3D CAD"],
          ["Build steps", String(bp.steps.length), "Guide"],
          ["Firmware lines", String(bp.firmware.split("\n").length), "Code"],
        ].map(([k, v, t]) => (
          <button key={k} className="tile" onClick={() => onTab(t)}>
            <span className="muted">{k}</span>
            <b>{v}</b>
          </button>
        ))}
      </div>

      {bp.warnings.length > 0 && (
        <div className="callout warn">
          <h3>Design notes</h3>
          <ul>
            {bp.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="two-col">
        <div className="panel">
          <h3>Cost breakdown</h3>
          {[...groups.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([g, v]) => (
              <div key={g} className="bar-row">
                <span>{g}</span>
                <div className="bar">
                  <i style={{ width: `${(v / max) * 100}%` }} />
                </div>
                <span className="num">{money(v)}</span>
              </div>
            ))}
        </div>
        <div className="panel">
          <h3>Controller pin map</h3>
          <table className="table compact">
            <thead>
              <tr>
                <th>Pin</th>
                <th>Connected to</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {bp.wiring.pinMap.map((p) => (
                <tr key={p.label + p.pin}>
                  <td className="mono">{p.pin}</td>
                  <td>{p.label}</td>
                  <td className="muted">{p.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted small">
        Prices are estimates from typical maker-retailer listings; sourcing links open live searches so you can compare current prices. Always double-check voltages and pinouts against your exact module before powering up.
      </p>
    </div>
  );
}
