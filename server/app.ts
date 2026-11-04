import express from "express";
import type { Blueprint, ChatMessage, Plan, Preferences, Project } from "../shared/types.ts";
import { buildBlueprint } from "./builder.ts";
import { clarifyingQuestions, planOffline, refineOffline } from "./planner.ts";
import { activeModel, activeProvider, llmClarify, llmDesign, type Provider } from "./llm.ts";
import * as store from "./store.ts";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Seed the example projects once per store, on the first API request an instance handles
let seeding: Promise<void> | null = null;
app.use("/api", (_req, _res, next) => {
  seeding ??= seedIfEmpty().catch((err) => {
    seeding = null;
    console.error("[store] seeding failed:", err);
  });
  seeding.then(() => next(), next);
});

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
  res.json({ ok: true, ai: activeProvider() !== "offline", provider: activeProvider(), model: activeModel(), storage: store.kind() });
});

app.get(
  "/api/projects",
  wrap(async (_req, res) => {
    res.json(await store.list());
  }),
);

// Homepage data: finished projects with their 3D bodies (for rendered thumbnails), most-starred first
app.get(
  "/api/showcase",
  wrap(async (_req, res) => {
    const ready = (await store.list())
      .filter((s) => s.status === "ready")
      .sort((a, b) => b.stars - a.stars || b.updatedAt - a.updatedAt)
      .slice(0, 16);
    const mech = await store.mech(ready.map((s) => s.id));
    res.json(ready.map((s, i) => ({ ...s, mech: mech[i] })));
  }),
);

app.get(
  "/api/stats",
  wrap(async (_req, res) => {
    const all = await store.list();
    const ready = all.filter((s) => s.status === "ready");
    res.json({
      projects: all.length,
      blueprints: ready.length,
      parts: ready.reduce((n, s) => n + s.parts, 0),
      connections: ready.reduce((n, s) => n + s.connections, 0),
      printed: ready.reduce((n, s) => n + s.printed, 0),
    });
  }),
);

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
    res.json(await store.save(p));
  }),
);

app.get(
  "/api/projects/:id",
  wrap(async (req, res) => {
    const p = await store.get(req.params.id);
    if (!p) return res.status(404).json({ error: "Project not found" });
    res.json(p);
  }),
);

app.post(
  "/api/projects/:id/messages",
  wrap(async (req, res) => {
    const p = await store.get(req.params.id);
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
    res.json(await store.save(p));
  }),
);

app.post(
  "/api/projects/:id/star",
  wrap(async (req, res) => {
    const p = await store.get(req.params.id);
    if (!p) return res.status(404).json({ error: "Project not found" });
    p.stars = Math.max(0, p.stars + (req.body?.unstar ? -1 : 1));
    res.json(await store.save(p));
  }),
);

app.delete(
  "/api/projects/:id",
  wrap(async (req, res) => {
    res.json({ ok: await store.remove(req.params.id) });
  }),
);

// Unknown API routes and thrown errors return JSON, so a failed request never leaves the function in a bad state
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});



async function seedIfEmpty() {
  if ((await store.list()).length > 0) return;
  const examples: [string, string, Preferences][] = [
    ["example-robotic-arm", "Robotic arm that can pick up small objects", { budget: "$100–$250", controller: "Arduino Uno", power: "Wall adapter", goal: "Pick and place small objects" }],
    ["example-weather-station", "Smart weather station", { budget: "$40–$100", controller: "ESP32 (Wi-Fi + Bluetooth)", power: "Solar", goal: "Log to a cloud dashboard" }],
    ["example-rover", "Obstacle avoiding rover", { budget: "$40–$100", power: "Battery", goal: "Autonomous obstacle avoidance" }],
    ["example-plant-pot", "Self-watering plant pot", { budget: "Under $40", power: "USB", goal: "Automatic watering while away" }],
  ];
  // Fixed ids: two instances seeding at once overwrite each other rather than duplicating
  await Promise.all(
    examples.map(([id, prompt, prefs], i) => {
      const now = Date.now() - (examples.length - i) * 3600_000;
      const blueprint = buildBlueprint(planOffline(prompt, prefs), "offline");
      return store.save({
        id,
        prompt,
        status: "ready",
        prefs,
        messages: [msg("user", prompt), msg("assistant", `Here's your blueprint: ${blueprint.totals.parts} parts for about $${blueprint.totals.cost.toFixed(2)}.`)],
        blueprint,
        stars: [12, 9, 7, 5][i],
        createdAt: now,
        updatedAt: now,
      });
    }),
  );
}

export default app;
