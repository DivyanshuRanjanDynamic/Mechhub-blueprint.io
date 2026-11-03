import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Project } from "../../shared/types.ts";
import { api, money, PROVIDER_NAME, type Health, type ShowcaseItem, type Stats } from "../api.ts";
import { navigate } from "../App.tsx";
import DemoPanel from "../components/home/DemoPanel.tsx";
import Thumb from "../components/home/Thumb.tsx";

const HeroModel = lazy(() => import("../components/home/HeroModel.tsx"));

const EXAMPLES = [
  "Robotic arm that sorts LEGO bricks by colour",
  "Smart weather station for my balcony",
  "Self-watering plant pot with a water-level alert",
  "Obstacle-avoiding rover with GPS",
  "Mini CNC machine for engraving wood",
  "Motion-triggered security camera",
  "Smart lamp that turns on when I walk in",
  "Fitness wristband that counts steps",
];

const ARCHETYPE_LABEL: Record<string, string> = {
  "robotic-arm": "Robotics",
  rover: "Mobile robot",
  "weather-station": "IoT · Outdoor",
  cnc: "Fabrication",
  "plant-care": "Garden",
  "smart-home": "Smart home",
  security: "Security",
  wearable: "Wearable",
  generic: "Device",
};

function useCountUp(target: number, run: boolean) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!run) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setN(target);
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / 1200);
      setN(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [target, run]);
  return n;
}

function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, seen] as const;
}

function ProjectCard({ p, compact = false }: { p: ShowcaseItem; compact?: boolean }) {
  return (
    <a
      href={`/p/${p.id}`}
      className={`pcard ${compact ? "compact" : ""}`}
      onClick={(e) => {
        e.preventDefault();
        navigate(`/p/${p.id}`);
      }}
    >
      <div className="pcard-media">
        <Thumb id={`${p.id}-${p.updatedAt}`} parts={p.mech} alt={p.title} width={compact ? 420 : 560} height={compact ? 320 : 420} />
        <span className="corner tl" />
        <span className="corner br" />
      </div>
      <div className="pcard-body">
        <h3>{p.title}</h3>
        <div className="pcard-meta">
          <span className="tag-blue">{p.parts} parts</span>
          <span className="tag-ink">★ {p.stars}</span>
          <span className="muted">{money(p.cost)}</span>
        </div>
        {!compact && <p className="mono-label">{ARCHETYPE_LABEL[p.archetype ?? "generic"]}</p>}
      </div>
    </a>
  );
}

function Stat({ icon, value, label, run }: { icon: JSX.Element; value: number; label: string; run: boolean }) {
  const n = useCountUp(value, run);
  return (
    <div className="stat">
      <div className="stat-icon">{icon}</div>
      <div className="stat-value">[{n.toLocaleString("en-US")}]</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [askFirst, setAskFirst] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [showcase, setShowcase] = useState<ShowcaseItem[] | null>(null);
  const [featured, setFeatured] = useState<Project | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsRef, statsSeen] = useInView<HTMLDivElement>();
  const rail = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
    api.stats().then(setStats).catch(() => {});
    api
      .showcase()
      .then((list) => {
        setShowcase(list);
        const f = list.find((p) => p.archetype === "robotic-arm") ?? list[0];
        if (f) api.get(f.id).then(setFeatured).catch(() => {});
      })
      .catch(() => setShowcase([]));
  }, []);

  async function start(text = prompt) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const p = await api.create(text.trim(), !askFirst);
      navigate(`/p/${p.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const tryPrompt = (text: string) => {
    setPrompt(text);
    window.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => input.current?.focus(), 400);
  };
  const scrollRail = (dir: 1 | -1) => rail.current?.scrollBy({ left: dir * (rail.current.clientWidth * 0.8), behavior: "smooth" });
  const top4 = showcase?.slice(0, 4) ?? [];

  return (
    <main className="home">
      {/* ── Hero ── */}
      <section className="hero">
        <div className="hero-art">
          <Suspense fallback={null}>
            <HeroModel />
          </Suspense>
        </div>
        <div className="wrap hero-inner">
          <p className="eyebrow">
            <span className="dot" /> MechHub Blueprint · AI hardware design
          </p>
          <h1>
            Turn any idea into <em>buildable</em> hardware
          </h1>
          <p className="lede">Describe a machine. Get the parts list, wiring diagram, 3D CAD, firmware and a step-by-step build guide in seconds.</p>

          <form
            className="prompt"
            onSubmit={(e) => {
              e.preventDefault();
              start();
            }}
          >
            <textarea
              ref={input}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask Blueprint to build… a robotic arm that waters my plants"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  start();
                }
              }}
              aria-label="Describe what you want to build"
            />
            <div className="prompt-bar">
              <div className="prompt-tools">
                <button type="button" className="tool" onClick={() => setPrompt(EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)])}>
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                    <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.9V16h5v-.2c0-.8.4-1.5 1-1.9A6 6 0 0 0 12 3Z" fill="none" stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                  Need an idea?
                </button>
                <label className="toggle">
                  <input type="checkbox" checked={askFirst} onChange={(e) => setAskFirst(e.target.checked)} />
                  <span />
                  Ask me questions first
                </label>
              </div>
              <div className="prompt-tools">
                {health && (
                  <span className="model-chip" title={health.model ?? "Built-in planner"}>
                    {PROVIDER_NAME[health.provider]}
                    {health.model ? ` · ${health.model.split("/").pop()}` : ""}
                  </span>
                )}
                <button className="btn-cta" disabled={!prompt.trim() || busy}>
                  {busy ? "Designing…" : "→Generate"}
                </button>
              </div>
            </div>
          </form>
          {error && <p className="error">{error}</p>}
        </div>

        <div className="wrap">
          <div className="strip">
            <div className="strip-head">
              <span className="mono-label">[ community projects ]</span>
              <button className="btn-ghost-sm" onClick={() => document.getElementById("gallery")?.scrollIntoView({ behavior: "smooth" })}>
                See more
              </button>
            </div>
            <div className="strip-grid">
              {showcase === null
                ? Array.from({ length: 4 }, (_, i) => <div key={i} className="pcard compact"><div className="thumb skeleton" /></div>)
                : top4.map((p) => <ProjectCard key={p.id} p={p} compact />)}
            </div>
          </div>
        </div>
      </section>

      {/* ── Make any idea real ── */}
      <section className="section">
        <div className="wrap split">
          <div className="split-copy">
            <p className="mono-label">01 — How it works</p>
            <h2>
              Make any <em>idea</em> real
            </h2>
            <p className="body">
              Blueprint turns your idea into a wiring diagram, a full parts list and exactly where to buy every piece. It works out the drivers, power rails and pin assignments for ESP32, Arduino and Pico, then gives you the 3D model and a build guide. No engineering degree required.
            </p>
            <ul className="checks">
              <li>Parts list with prices and buy links</li>
              <li>Pin-accurate wiring and schematic</li>
              <li>3D CAD with STL · STEP · GLB export</li>
              <li>Firmware and step-by-step assembly</li>
            </ul>
            <button className="btn-cta" onClick={() => tryPrompt(featured?.prompt ?? EXAMPLES[0])}>
              →Try with your idea
            </button>
          </div>
          <DemoPanel project={featured} onTry={tryPrompt} />
        </div>
      </section>

      {/* ── Idea band ── */}
      <section className="band">
        <div className="wrap">
          <h2 className="band-title">
            You have an idea for something that <em>doesn't exist yet.</em>
          </h2>
          <div className="frames">
            {(["wire", "exploded", "solid"] as const).map((mode, i) => (
              <figure key={mode} className="frame">
                {featured?.blueprint ? (
                  <Thumb id={`${featured.id}-band`} parts={featured.blueprint.mech} mode={mode} alt={`${featured.blueprint.plan.title}, ${mode} view`} wire={0x8fb0ff} />
                ) : (
                  <div className="thumb skeleton dark" />
                )}
                <figcaption className="mono-label">
                  0{i + 1} · {["Concept", "Engineered", "Built"][i]}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* ── Stats ── */}
      <section className="section stats-section">
        <div className="wrap stats-grid" ref={statsRef}>
          <div>
            <p className="mono-label">02 — Screen to hand</p>
            <h2>
              Screen <span className="swap">⇄</span> <em>to hand</em>
            </h2>
            <p className="body">Every blueprint is generated from a real component library with pinouts, supply rails and prices, so what you see on screen is something you can actually wire up.</p>
          </div>
          <div className="stats">
            <Stat
              run={statsSeen}
              value={stats?.blueprints ?? 0}
              label="Blueprints generated"
              icon={
                <svg viewBox="0 0 24 24" aria-hidden>
                  <rect x="3" y="3" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M3 9h18M9 21V9" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              }
            />
            <Stat
              run={statsSeen}
              value={stats?.parts ?? 0}
              label="Parts specified with sourcing"
              icon={
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 0v20M3 7l9 5 9-5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              }
            />
            <Stat
              run={statsSeen}
              value={stats?.connections ?? 0}
              label="Wires routed pin-to-pin"
              icon={
                <svg viewBox="0 0 24 24" aria-hidden>
                  <circle cx="5" cy="6" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <circle cx="19" cy="18" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M7 6h6v12h4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              }
            />
          </div>
        </div>
      </section>

      {/* ── Gallery ── */}
      <section className="section" id="gallery">
        <div className="wrap">
          <div className="gallery-head">
            <div>
              <p className="mono-label">03 — Gallery</p>
              <h2>
                Nothing stays <em>theoretical</em>
              </h2>
            </div>
            <div className="rail-nav">
              <button className="circle" onClick={() => scrollRail(-1)} aria-label="Previous projects">
                ←
              </button>
              <button className="circle" onClick={() => scrollRail(1)} aria-label="Next projects">
                →
              </button>
            </div>
          </div>
        </div>
        <div className="rail" ref={rail}>
          {showcase?.length === 0 && <p className="muted wrap">No projects yet — describe your first machine above.</p>}
          {showcase?.map((p) => <ProjectCard key={p.id} p={p} />)}
        </div>
      </section>

      {/* ── Footer CTA ── */}
      <footer className="footer">
        <div className="wrap">
          <div className="footer-top">
            <h2>
              Help us make every <em>idea</em> real.
            </h2>
            <div className="footer-cta">
              <p className="mono-label">[ start with any idea. Blueprint makes it real. ]</p>
              <button className="btn-cta light" onClick={() => tryPrompt("")}>
                →Start building
              </button>
            </div>
          </div>
          <div className="wordmark" aria-hidden>
            MECHHUB
          </div>
          <div className="footer-bottom">
            <span>© {new Date().getFullYear()} MechHub · Manufacturing Tomorrow Together</span>
            <span>
              <a href="https://www.mechhub.in/" target="_blank" rel="noreferrer">
                mechhub.in
              </a>{" "}
              · Prices are estimates · Verify pinouts before powering up
            </span>
          </div>
        </div>
      </footer>
    </main>
  );
}
