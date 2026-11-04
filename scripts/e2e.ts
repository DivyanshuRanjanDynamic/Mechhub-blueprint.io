// End-to-end "real user" test. It drives the HTTP API exactly as the web app does, playing a
// first-time maker who wants a balcony weather station:
//   describe the idea → answer the clarifying questions → get the blueprint
//   → ask for two changes in chat → download BOM, firmware and CAD.
//
// Usage
//   npm run e2e                  # spawns its own server; Groq if GROQ_API_KEY is set, else offline
//   npm run e2e -- --provider groq|claude|offline
//   npm run e2e:mock-groq        # exercises the Groq backend against a local mock (no key needed)
//   npm run e2e -- --url http://localhost:8787   # test an already-running server
//
// Structural invariants are hard failures. Content expectations ("it picked a rain sensor") are
// soft for LLM planners, because a model may reasonably choose differently, and hard offline.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Blueprint, Preferences, Project, Question } from "../shared/types.ts";
import { toStep } from "../src/lib/step.ts";
import { startMockGroq } from "./mock-groq.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mockGroq = args.includes("--mock-groq");
const externalUrl = flag("url");
const provider = mockGroq ? "groq" : flag("provider") ?? (process.env.GROQ_API_KEY ? "groq" : "offline");
const PORT = 8899;
const BASE = externalUrl ?? `http://localhost:${PORT}`;

const USER = {
  name: "Aarav (first-time maker)",
  idea: "I want a smart weather station for my balcony that shows the temperature on a small screen and tells me when it starts raining",
  context: "It will be mounted on a balcony railing outside, about 5 m from my Wi-Fi router.",
  wants: { goal: /display|screen|see|reading/i, budget: /40\s*[–-]\s*\$?100/i, controller: /esp32/i, power: /batter/i },
  changes: ["Add a buzzer so it beeps when rain starts", "Make it cheaper"],
};

// ───────────── reporting ─────────────
const results: { level: "pass" | "warn" | "fail"; msg: string }[] = [];
const strictContent = provider === "offline";
function check(ok: boolean, msg: string, hard = true) {
  results.push({ level: ok ? "pass" : hard ? "fail" : "warn", msg });
  console.log(`  ${ok ? "✓" : hard ? "✗" : "!"} ${msg}`);
}
const expect = (ok: boolean, msg: string) => check(ok, msg, strictContent);
const step = (title: string) => console.log(`\n▶ ${title}`);

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const t = Date.now();
  const res = await fetch(BASE + url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${json.error}`);
  console.log(`  · ${method} ${url} (${Date.now() - t} ms)`);
  return json as T;
}

/** Pick the option a real user would click, falling back to the first one. */
function choose(q: Question, want?: RegExp): string {
  return q.options.find((o) => want?.test(o)) ?? q.options[0];
}

function validateBlueprint(bp: Blueprint, label: string) {
  const blocks = new Set(bp.wiring.blocks.map((b) => b.id));
  check(bp.bom.length > 0 && bp.totals.parts > 0, `${label}: BOM has ${bp.bom.length} lines / ${bp.totals.parts} parts`);
  check(bp.totals.cost > 0, `${label}: estimated cost $${bp.totals.cost.toFixed(2)}`);
  check(bp.bom.filter((b) => b.group === "MCU").length === 1, `${label}: exactly one microcontroller`);
  check(bp.bom.every((b) => b.group === "3D Print" || b.sourcing.some((s) => /^https:\/\//.test(s.url))), `${label}: every purchasable part has a buy link`);
  check(bp.wiring.connections.length > 0, `${label}: ${bp.wiring.connections.length} wiring connections`);
  check(
    bp.wiring.connections.every((c) => blocks.has(c.from.block) && blocks.has(c.to.block)),
    `${label}: no wire points at a missing component`,
  );
  check(!bp.wiring.pinMap.some((p) => p.pin === "NC"), `${label}: every signal got a controller pin`);
  const exclusive = bp.wiring.pinMap.filter((p) => !["sda", "scl"].includes(p.role) && !p.role.includes("shared")).map((p) => p.pin);
  check(new Set(exclusive).size === exclusive.length, `${label}: no controller pin is used twice`);
  check(bp.wiring.connections.some((c) => c.kind === "ground"), `${label}: ground is wired`);
  check(bp.mech.length > 0 && bp.mech.every((m) => m.size.every((s) => s > 0)), `${label}: ${bp.mech.length} CAD bodies with valid dimensions`);
  check(bp.steps.length >= 5 && bp.steps.every((s, i) => s.n === i + 1 && s.title && s.body), `${label}: ${bp.steps.length} ordered assembly steps`);
  check(/void setup\(\)/.test(bp.firmware) && /void loop\(\)/.test(bp.firmware), `${label}: firmware has setup() and loop()`);
}

const has = (bp: Blueprint, id: string | RegExp) => bp.bom.some((b) => (typeof id === "string" ? b.id === id : id.test(b.id)));

// ───────────── server lifecycle ─────────────
async function startServer(): Promise<ChildProcess | null> {
  if (externalUrl) return null;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
    MECHHUB_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "mechhub-e2e-")),
    MECHHUB_PROVIDER: provider,
  };
  if (mockGroq) Object.assign(env, { GROQ_API_KEY: "mock-key", GROQ_BASE_URL: "http://localhost:8898" });
  // Keep test projects out of a real Redis configured in .env (dotenv never overrides set variables)
  Object.assign(env, { UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", KV_REST_API_URL: "", KV_REST_API_TOKEN: "" });
  const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
  const child = spawn(process.execPath, [tsx, "server/index.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr?.on("data", (d) => process.stderr.write(`  [server] ${d}`));
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${BASE}/api/health`);
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  child.kill();
  throw new Error("Server did not start");
}

async function main() {
  const mock = mockGroq ? await startMockGroq(8898) : null;
  const server = await startServer();
  const started = Date.now();
  try {
    console.log(`MechHub Blueprint — real-user E2E test\nUser: ${USER.name}\nServer: ${BASE}`);

    step("0. App loads");
    const health = await api<{ provider: string; model: string | null }>("GET", "/api/health");
    console.log(`  planner: ${health.provider}${health.model ? ` (${health.model})` : ""}${mockGroq ? " — mocked Groq API" : ""}`);
    if (!externalUrl) check(health.provider === provider, `server is using the ${provider} planner`);

    step(`1. User types their idea: “${USER.idea}”`);
    let project = await api<Project>("POST", "/api/projects", { prompt: USER.idea, generateNow: false });
    check(project.status === "clarifying", "app asks clarifying questions before designing");
    const questions = project.messages.at(-1)?.questions ?? [];
    check(questions.length >= 2, `${questions.length} questions asked: ${questions.map((q) => q.id).join(", ")}`);
    check(questions.some((q) => q.id === "budget"), "a budget question is asked", false);
    check(questions.some((q) => q.id === "controller"), "a microcontroller question is asked", false);

    step("2. User answers the questions and adds context");
    const answers: Preferences = {};
    for (const q of questions) {
      if (["goal", "budget", "controller", "power"].includes(q.id)) {
        answers[q.id as keyof Preferences] = choose(q, USER.wants[q.id as keyof typeof USER.wants]);
      }
    }
    console.log(`  answers: ${JSON.stringify(answers)}`);
    project = await api<Project>("POST", `/api/projects/${project.id}/messages`, { text: USER.context, answers });
    check(project.status === "ready" && !!project.blueprint, "a complete blueprint is generated");
    let bp = project.blueprint!;
    console.log(`  → “${bp.plan.title}”: ${bp.totals.parts} parts, $${bp.totals.cost.toFixed(2)}, engine=${bp.engine}`);
    if (provider !== "offline") check(bp.engine === provider, `blueprint was planned by ${provider} (not the offline fallback)`);
    validateBlueprint(bp, "v1");
    if (/esp32/i.test(answers.controller ?? "")) check(bp.plan.controller === "esp32-devkit", "the chosen ESP32 is used", false);
    expect(has(bp, /bme280|dht22/), "has a temperature sensor");
    expect(has(bp, "oled-128x64"), "has a small screen");
    expect(has(bp, "rain-sensor"), "has a rain sensor");
    if (mockGroq) check(!bp.bom.some((b) => b.id.includes("x9000")), "invented part id from the model was dropped");

    step(`3. User asks: “${USER.changes[0]}”`);
    const v1 = bp;
    project = await api<Project>("POST", `/api/projects/${project.id}/messages`, { text: USER.changes[0] });
    bp = project.blueprint!;
    check(bp.version === v1.version + 1, `blueprint updated to v${bp.version}`);
    expect(has(bp, "buzzer"), "buzzer added to the parts list");
    expect(bp.wiring.connections.some((c) => c.to.block.startsWith("M") && /buzzer/i.test(bp.wiring.blocks.find((b) => b.id === c.to.block)?.label ?? "")), "buzzer is wired to the controller");
    validateBlueprint(bp, `v${bp.version}`);

    step(`4. User asks: “${USER.changes[1]}”`);
    const before = bp.totals.cost;
    project = await api<Project>("POST", `/api/projects/${project.id}/messages`, { text: USER.changes[1] });
    bp = project.blueprint!;
    check(bp.totals.cost <= before, `cost went from $${before.toFixed(2)} to $${bp.totals.cost.toFixed(2)}`, false);
    validateBlueprint(bp, `v${bp.version}`);
    console.log(`  assistant: “${project.messages.at(-1)?.text}”`);

    step("5. User downloads the files");
    const out = path.resolve("test-output", provider + (mockGroq ? "-mock" : ""));
    fs.mkdirSync(out, { recursive: true });
    const csv = [["Group", "Part", "Qty", "Unit", "Link"], ...bp.bom.map((b) => [b.group, b.name, b.qty, b.unitPrice, b.sourcing[0]?.url ?? ""])]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const step214 = toStep(bp.plan.title, bp.mech);
    const files: Record<string, string> = {
      "bom.csv": csv,
      "firmware.ino": bp.firmware,
      "model.step": step214,
      "blueprint.json": JSON.stringify(project, null, 2),
    };
    for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(out, name), data);
    const ids = new Set(step214.split("\n").filter((l) => l.startsWith("#")).map((l) => l.slice(1, l.indexOf("="))));
    const dangling = [...step214.matchAll(/#(\d+)/g)].filter((m) => !ids.has(m[1])).length;
    check(step214.startsWith("ISO-10303-21;") && dangling === 0, `STEP file is well-formed (${(step214.length / 1024).toFixed(0)} KB, ${bp.mech.length} bodies)`);
    check(csv.split("\n").length === bp.bom.length + 1, `BOM CSV has ${bp.bom.length} rows`);
    console.log(`  saved to ${path.relative(process.cwd(), out)}${path.sep}`);

    step("6. Project shows up on the home page");
    const list = await api<{ id: string; status: string }[]>("GET", "/api/projects");
    check(list.some((p) => p.id === project.id && p.status === "ready"), "project is listed as ready");
  } finally {
    server?.kill();
    mock?.close();
  }

  const fails = results.filter((r) => r.level === "fail");
  const warns = results.filter((r) => r.level === "warn");
  console.log(`\n${results.length - fails.length - warns.length} passed, ${warns.length} warnings, ${fails.length} failed — ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (mock) console.log(`mock Groq API received ${mock.calls()} requests (including the forced retry)`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => {
  console.error("\nE2E run crashed:", err.message);
  process.exit(1);
});
