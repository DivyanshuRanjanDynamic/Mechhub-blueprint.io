import React, { useEffect, useState } from "react";
import Home from "./pages/Home.tsx";
import Workspace from "./pages/Workspace.tsx";
import { api, PROVIDER_NAME, type Health } from "./api.ts";

export function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [ai, setAi] = useState<Health | null>(null);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    api.health().then(setAi).catch(() => setAi({ ok: false, ai: false, provider: "offline", model: null }));
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = (to: string, anchor?: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(to);
    if (anchor) setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth" }), 80);
    else window.scrollTo({ top: 0 });
  };

  const match = path.match(/^\/p\/([\w-]+)/);
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/" onClick={go("/")}>
            <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden>
              <rect width="32" height="32" fill="var(--blue)" />
              <path d="M8 23V9l8 7 8-7v14" fill="none" stroke="#fff" strokeWidth="3" />
            </svg>
            <span>
              MechHub <b>Blueprint</b>
            </span>
          </a>
          <nav className="nav" aria-label="Main">
            <a href="/" onClick={go("/")}>
              <span>01.</span>Build
            </a>
            <a href="/#gallery" onClick={go("/", "gallery")}>
              <span>02.</span>Gallery
            </a>
            <a href="https://www.mechhub.in/" target="_blank" rel="noreferrer">
              <span>03.</span>Manufacture<span className="arrow">↗</span>
            </a>
          </nav>
          <div className="topbar-right">
            {ai && (
              <span className={`engine ${ai.ai ? "on" : ""}`} title={ai.ai ? `Designs planned by ${ai.model}` : "Set GROQ_API_KEY or ANTHROPIC_API_KEY on the server to enable an AI planner"}>
                <i /> {PROVIDER_NAME[ai.provider]}
              </span>
            )}
            <a className="btn-cta sm" href="/" onClick={go("/")}>
              →New blueprint
            </a>
          </div>
        </div>
      </header>
      {match ? <Workspace key={match[1]} id={match[1]} /> : <Home />}
    </div>
  );
}
