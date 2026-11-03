import { lazy, Suspense, useEffect, useState } from "react";
import type { Preferences, Project } from "../../shared/types.ts";
import { api, money } from "../api.ts";
import { navigate } from "../App.tsx";
import Chat from "../components/Chat.tsx";
import Overview from "../components/Overview.tsx";
import PartsTab from "../components/PartsTab.tsx";
import Schematic from "../components/Schematic.tsx";
import GuideTab from "../components/GuideTab.tsx";
import CodeTab from "../components/CodeTab.tsx";

const CadViewer = lazy(() => import("../components/CadViewer.tsx"));

const TABS = ["Overview", "Parts", "Wiring", "3D CAD", "Guide", "Code"] as const;
type Tab = (typeof TABS)[number];

export default function Workspace({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>(() => (TABS.find((t) => `#${t.toLowerCase().replace(/\s/g, "")}` === window.location.hash) as Tab) ?? "Overview");
  const [starred, setStarred] = useState(() => {
    try {
      return localStorage.getItem(`star:${id}`) === "1";
    } catch {
      return false;
    }
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.get(id).then(setProject).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    history.replaceState(null, "", `#${tab.toLowerCase().replace(/\s/g, "")}`);
  }, [tab]);

  async function send(text: string, answers?: Preferences) {
    if (!project) return;
    setBusy(true);
    setError("");
    const optimistic: Project = { ...project, messages: [...project.messages, { role: "user", text: text || "Generate", ts: Date.now() }] };
    if (text) setProject(optimistic);
    try {
      setProject(await api.send(project.id, text, answers));
    } catch (e) {
      setError((e as Error).message);
      setProject(project);
    } finally {
      setBusy(false);
    }
  }

  async function toggleStar() {
    if (!project) return;
    const next = !starred;
    setStarred(next);
    try {
      localStorage.setItem(`star:${id}`, next ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
    setProject(await api.star(project.id, !next));
  }

  if (error && !project) return <main className="center muted">{error}</main>;
  if (!project) return <main className="center muted">Loading blueprint…</main>;
  const bp = project.blueprint;

  return (
    <main className="workspace">
      <aside className="side">
        <Chat project={project} busy={busy} onSend={send} />
        {error && <p className="error pad">{error}</p>}
      </aside>
      <section className="main">
        <div className="ws-head">
          <div>
            <button className="link" onClick={() => navigate("/")}>
              ← Projects
            </button>
            <h1>{bp?.plan.title ?? project.prompt}</h1>
            {bp && (
              <div className="ws-stats">
                <span>{bp.totals.parts} parts</span>
                <span>{money(bp.totals.cost)} est.</span>
                <span>{bp.wiring.connections.length} connections</span>
                <span>v{bp.version}</span>
              </div>
            )}
          </div>
          <div className="ws-actions">
            <button className={`btn ghost ${starred ? "active" : ""}`} onClick={toggleStar} aria-pressed={starred}>
              ★ {project.stars}
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                navigator.clipboard?.writeText(window.location.href.split("#")[0]);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Link copied" : "Share"}
            </button>
          </div>
        </div>

        {!bp ? (
          <div className="empty">
            <div className="spinner-lg" data-busy={busy} />
            <h2>{busy ? "Designing your blueprint…" : "Answer a few questions to start"}</h2>
            <p className="muted">Pick options in the chat, or press “Generate now” to use sensible defaults.</p>
          </div>
        ) : (
          <>
            <nav className="tabs" role="tablist">
              {TABS.map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                  {t}
                </button>
              ))}
            </nav>
            <div className={`tab-body ${busy ? "dim" : ""}`}>
              {tab === "Overview" && <Overview bp={bp} onTab={(t) => setTab(t as Tab)} />}
              {tab === "Parts" && <PartsTab bp={bp} />}
              {tab === "Wiring" && <Schematic bp={bp} />}
              {tab === "3D CAD" && (
                <Suspense fallback={<p className="muted pad">Loading 3D viewer…</p>}>
                  <CadViewer bp={bp} />
                </Suspense>
              )}
              {tab === "Guide" && <GuideTab bp={bp} projectId={project.id} />}
              {tab === "Code" && <CodeTab bp={bp} />}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
