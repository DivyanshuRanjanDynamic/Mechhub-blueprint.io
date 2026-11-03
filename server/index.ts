import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import type { Blueprint, ChatMessage, Plan, Preferences, Project } from "../shared/types.ts";
import { buildBlueprint } from "./builder.ts";
import { clarifyingQuestions, planOffline, refineOffline } from "./planner.ts";
import { activeModel, activeProvider, llmClarify, llmDesign, type Provider } from "./llm.ts";
import * as store from "./store.ts";

const app = express();
app.use(express.json({ limit: "1mb" }));

const msg = (role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, text, ts: Date.now(), ...extra });

async function clarify(prompt: string) {
  if (activeProvider() !== "offline") {
    try {
      return await llmClarify(prompt);
    } catch (err) {
      console.warn(`[${activeProvider()}] clarify failed, using offline planner:`, (err as Error).message);
    }
  }
  return clarifyingQuestions(prompt);
}

/** Totals come from the builder, not the model, which can't see the drivers and power parts added after it. */
const totalsLine = (b: Blueprint) => `\n\nEstimated total: $${b.totals.cost.toFixed(2)} · ${b.totals.parts} parts.`;

/** First full design for a project. */
async function generate(p: Project): Promise<void> {
  let plan: Plan | undefined;
  let reply: string | undefined;
  let engine: Provider = "offline";
  if (activeProvider() !== "offline") {
    try {
      const out = await llmDesign({ prompt: p.prompt, prefs: p.prefs, history: p.messages });
      plan = out.plan;
      reply = out.reply;
      engine = activeProvider();
    } catch (err) {
      console.warn(`[${activeProvider()}] design failed, using offline planner:`, (err as Error).message);
    }
  }
  plan ??= planOffline(p.prompt, p.prefs);
  const blueprint = buildBlueprint(plan, engine, 1);
  reply = reply ? `${reply}${totalsLine(blueprint)}` : `Here's your blueprint: ${blueprint.totals.parts} parts for about $${blueprint.totals.cost.toFixed(2)}. Explore the Parts, Wiring, Mech, Guide and Code tabs — and tell me what to change.`;
  p.blueprint = blueprint;
  p.status = "ready";
  p.messages.push(msg("assistant", reply));
}

async function refine(p: Project, text: string): Promise<void> {
  const current = p.blueprint!.plan;
  let plan: Plan | undefined;
  let reply: string | undefined;
  let engine: Provider = "offline";
  if (activeProvider() !== "offline") {
    try {
      const out = await llmDesign({ prompt: p.prompt, prefs: p.prefs, history: p.messages, current, message: text });
      plan = out.plan;
      reply = out.reply;
      engine = activeProvider();
    } catch (err) {
      console.warn(`[${activeProvider()}] refine failed, using offline planner:`, (err as Error).message);
    }
  }
  if (!plan) ({ plan, reply } = refineOffline(current, text));
  if (plan !== current) {
    p.blueprint = buildBlueprint(plan, engine, p.blueprint!.version + 1);
    if (engine !== "offline") reply += totalsLine(p.blueprint);
  }
  p.messages.push(msg("assistant", reply!));
}

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((err) => {
      console.error(err);
      res.status(500).json({ error: (err as Error).message });
    });

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ai: activeProvider() !== "offline", provider: activeProvider(), model: activeModel() });
});

app.get("/api/projects", (_req, res) => {
  res.json(store.list());
});

// Homepage data: finished projects with their 3D bodies (for rendered thumbnails), most-starred first
app.get("/api/showcase", (_req, res) => {
  const ready = store
    .list()
    .filter((s) => s.status === "ready")
    .sort((a, b) => b.stars - a.stars || b.updatedAt - a.updatedAt)
    .slice(0, 16);
  res.json(ready.map((s) => ({ ...s, mech: store.get(s.id)?.blueprint?.mech ?? [] })));
});

app.get("/api/stats", (_req, res) => {
  const all = store.list().map((s) => store.get(s.id)!);
  const ready = all.filter((p) => p.blueprint);
  res.json({
    projects: all.length,
    blueprints: ready.length,
    parts: ready.reduce((n, p) => n + p.blueprint!.totals.parts, 0),
    connections: ready.reduce((n, p) => n + p.blueprint!.wiring.connections.length, 0),
    printed: ready.reduce((n, p) => n + p.blueprint!.mech.filter((m) => m.printed).length, 0),
  });
});

app.post(
  "/api/projects",
  wrap(async (req, res) => {
    const prompt = String(req.body?.prompt ?? "").trim().slice(0, 600);
    if (!prompt) return res.status(400).json({ error: "Describe what you want to build." });
    const now = Date.now();
    const p: Project = { id: store.newId(), prompt, status: "clarifying", prefs: {}, messages: [msg("user", prompt)], stars: 0, createdAt: now, updatedAt: now };
    if (req.body?.generateNow) {
      await generate(p);
    } else {
      const q = await clarify(prompt);
      p.messages.push(msg("assistant", q.reply, { questions: q.questions }));
    }
    res.json(store.save(p));
  }),
);

app.get("/api/projects/:id", (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  res.json(p);
});

app.post(
  "/api/projects/:id/messages",
  wrap(async (req, res) => {
    const p = store.get(req.params.id);
    if (!p) return res.status(404).json({ error: "Project not found" });
    const text = String(req.body?.text ?? "").trim().slice(0, 1000);
    const answers = (req.body?.answers ?? {}) as Preferences;
    if (p.status === "clarifying") {
      p.prefs = { ...p.prefs, ...Object.fromEntries(Object.entries(answers).filter(([, v]) => typeof v === "string" && v)) };
      const answerText = Object.entries(p.prefs)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · ");
      p.messages.push(msg("user", text || (answerText ? answerText : "Generate with defaults")));
      if (text) p.prefs.goal = p.prefs.goal ? `${p.prefs.goal}; ${text}` : text;
      await generate(p);
    } else {
      if (!text) return res.status(400).json({ error: "Empty message" });
      p.messages.push(msg("user", text));
      await refine(p, text);
    }
    res.json(store.save(p));
  }),
);

app.post("/api/projects/:id/star", (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  p.stars += req.body?.unstar ? -1 : 1;
  p.stars = Math.max(0, p.stars);
  res.json(store.save(p));
});

app.delete("/api/projects/:id", (req, res) => {
  res.json({ ok: store.remove(req.params.id) });
});

// Production: serve the built SPA
const dist = path.resolve("dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

store.load();
if (store.count() === 0) seed();

function seed() {
  const examples: [string, Preferences][] = [
    ["Robotic arm that can pick up small objects", { budget: "$100–$250", controller: "Arduino Uno", power: "Wall adapter", goal: "Pick and place small objects" }],
    ["Smart weather station", { budget: "$40–$100", controller: "ESP32 (Wi-Fi + Bluetooth)", power: "Solar", goal: "Log to a cloud dashboard" }],
    ["Obstacle avoiding rover", { budget: "$40–$100", power: "Battery", goal: "Autonomous obstacle avoidance" }],
    ["Self-watering plant pot", { budget: "Under $40", power: "USB", goal: "Automatic watering while away" }],
  ];
  examples.forEach(([prompt, prefs], i) => {
    const now = Date.now() - (examples.length - i) * 3600_000;
    const plan = planOffline(prompt, prefs);
    const blueprint = buildBlueprint(plan, "offline");
    store.save({
      id: store.newId(),
      prompt,
      status: "ready",
      prefs,
      messages: [msg("user", prompt), msg("assistant", `Here's your blueprint: ${blueprint.totals.parts} parts for about $${blueprint.totals.cost.toFixed(2)}.`)],
      blueprint,
      stars: [12, 9, 7, 5][i],
      createdAt: now,
      updatedAt: now,
    });
  });
}

const PORT = Number(process.env.PORT ?? 8787);
app.listen(PORT, () => {
  console.log(`MechHub Blueprint API on http://localhost:${PORT} — planner: ${activeProvider()}${activeModel() ? ` (${activeModel()})` : ""}`);
});
