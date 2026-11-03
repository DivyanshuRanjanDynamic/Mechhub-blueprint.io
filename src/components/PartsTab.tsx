import { useState } from "react";
import type { Blueprint, BomItem } from "../../shared/types.ts";
import { download, fileSafe, money } from "../api.ts";

const ORDER = ["MCU", "Sensor", "Actuator", "Driver", "Display", "Communication", "Power", "Passive", "Structural", "Mechanism", "Misc", "3D Print"];

export default function PartsTab({ bp }: { bp: Blueprint }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const byCat = (["Electrical", "Mechanical"] as const).map((cat) => {
    const items = bp.bom.filter((b) => b.category === cat);
    const groups = ORDER.map((g) => ({ g, items: items.filter((i) => i.group === g) })).filter((x) => x.items.length);
    return { cat, items, groups };
  });

  function exportCsv() {
    const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
    const rows = [
      ["Category", "Group", "Designator", "Part", "Specs", "Qty", "Unit price (USD)", "Line total (USD)", "Buy link"],
      ...bp.bom.map((b) => [b.category, b.group, b.designator, b.name, b.specs, b.qty, b.unitPrice.toFixed(2), (b.qty * b.unitPrice).toFixed(2), b.sourcing[0]?.url ?? ""]),
    ];
    download(`${fileSafe(bp.plan.title)}-bom.csv`, rows.map((r) => r.map(esc).join(",")).join("\n"), "text/csv");
  }

  const total = (items: BomItem[]) => items.reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const count = (items: BomItem[]) => items.reduce((s, i) => s + i.qty, 0);

  return (
    <div>
      <div className="toolbar">
        <p className="muted">
          {bp.bom.length} line items · {bp.totals.parts} parts · Electrical {money(bp.totals.electrical)} · Mechanical {money(bp.totals.mechanical)}
        </p>
        <button className="btn" onClick={exportCsv}>
          Export CSV
        </button>
      </div>
      <div className="table-wrap">
        <table className="table bom">
          <thead>
            <tr>
              <th>Part</th>
              <th className="num">Qty</th>
              <th className="num">Unit</th>
              <th className="num">Total</th>
              <th>Buy</th>
            </tr>
          </thead>
          {byCat.map(({ cat, items, groups }) => (
            <tbody key={cat}>
              <tr className="cat-row">
                <td>{cat}</td>
                <td className="num">{count(items)}</td>
                <td />
                <td className="num">{money(total(items))}</td>
                <td />
              </tr>
              {groups.map(({ g, items: gi }) => {
                const key = `${cat}/${g}`;
                const open = !collapsed[key];
                return [
                  <tr key={key} className="group-row" onClick={() => setCollapsed((c) => ({ ...c, [key]: open }))}>
                    <td>
                      <button className="caret" aria-expanded={open}>
                        {open ? "▾" : "▸"}
                      </button>
                      {g}
                    </td>
                    <td className="num">{count(gi)}</td>
                    <td />
                    <td className="num">{money(total(gi))}</td>
                    <td />
                  </tr>,
                  ...(open
                    ? gi.map((b) => (
                        <tr key={b.id} className="item-row">
                          <td>
                            <div className="part-name">
                              <span className="desig">{b.designator}</span> {b.name}
                            </div>
                            <div className="muted small">
                              {b.specs}
                              {b.role ? ` · ${b.role}` : ""}
                            </div>
                          </td>
                          <td className="num">{b.qty}</td>
                          <td className="num">{money(b.unitPrice)}</td>
                          <td className="num">{money(b.qty * b.unitPrice)}</td>
                          <td>
                            <div className="buy">
                              {b.sourcing.slice(0, 4).map((s) =>
                                s.url.startsWith("#") ? (
                                  <span key={s.vendor} className="vendor self">
                                    {s.vendor}
                                  </span>
                                ) : (
                                  <a key={s.vendor} className="vendor" href={s.url} target="_blank" rel="noreferrer noopener">
                                    {s.vendor}
                                  </a>
                                ),
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    : []),
                ];
              })}
            </tbody>
          ))}
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="num">{bp.totals.parts}</td>
              <td />
              <td className="num">{money(bp.totals.cost)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
