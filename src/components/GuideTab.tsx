import { useEffect, useState } from "react";
import type { Blueprint } from "../../shared/types.ts";

export default function GuideTab({ bp, projectId }: { bp: Blueprint; projectId: string }) {
  const key = `guide:${projectId}:v${bp.version}`;
  const [done, setDone] = useState<number[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "[]");
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(done));
    } catch {
      /* storage unavailable */
    }
  }, [done, key]);

  const pct = Math.round((done.length / bp.steps.length) * 100);
  return (
    <div className="guide">
      <div className="progress">
        <div className="bar">
          <i style={{ width: `${pct}%` }} />
        </div>
        <span className="muted">
          {done.length}/{bp.steps.length} steps done
        </span>
      </div>
      <ol className="steps">
        {bp.steps.map((s) => {
          const checked = done.includes(s.n);
          return (
            <li key={s.n} className={`step ${checked ? "done" : ""}`}>
              <label className="step-head">
                <input type="checkbox" checked={checked} onChange={() => setDone((d) => (checked ? d.filter((x) => x !== s.n) : [...d, s.n]))} />
                <span className="step-n">{s.n}</span>
                <h3>{s.title}</h3>
              </label>
              <div className="step-body">
                {s.body.split("\n").map((line, i) => (line.trim() ? <p key={i}>{line}</p> : null))}
                {s.warning && <div className="callout warn small">⚠ {s.warning}</div>}
                {(s.parts.length > 0 || s.tools.length > 0) && (
                  <div className="step-meta">
                    {s.parts.length > 0 && (
                      <div>
                        <h4>Parts</h4>
                        <div className="chips small">
                          {s.parts.slice(0, 14).map((p) => (
                            <span key={p} className="chip static">
                              {p}
                            </span>
                          ))}
                          {s.parts.length > 14 && <span className="muted small">+{s.parts.length - 14} more</span>}
                        </div>
                      </div>
                    )}
                    {s.tools.length > 0 && (
                      <div>
                        <h4>Tools</h4>
                        <div className="chips small">
                          {s.tools.map((t) => (
                            <span key={t} className="chip static tool">
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
