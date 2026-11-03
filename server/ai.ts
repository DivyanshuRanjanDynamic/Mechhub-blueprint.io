// Prompts and output schemas shared by every LLM planner, plus the Claude backend.
// The model chooses parts (constrained to the catalog) and writes the human-facing text;
// builder.ts derives the wiring, CAD and BOM from that plan.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import type { ChatMessage, Plan, Preferences, Question } from "../shared/types.ts";
import { CATALOG, CONTROLLERS } from "./catalog.ts";

export const catalogIds = CATALOG.map((c) => c.id) as [string, ...string[]];
export const controllerIds = Object.keys(CONTROLLERS) as [string, ...string[]];
export const ARCHETYPES = ["robotic-arm", "rover", "weather-station", "cnc", "plant-care", "smart-home", "security", "wearable", "generic"] as const;

export const PlanSchema = z.object({
  title: z.string().describe("Short product name, 2–5 words, Title Case"),
  summary: z.string().describe("2–3 sentence plain-language description of what the device does and how"),
  tags: z.array(z.string()).describe("3–5 lowercase tags"),
  archetype: z.enum(ARCHETYPES),
  controller: z.enum(controllerIds),
  power: z.enum(["usb", "battery", "mains", "solar"]),
  budget: z.number().nullable().describe("USD budget ceiling, or null"),
  modules: z
    .array(z.object({ catalogId: z.enum(catalogIds), qty: z.number().int(), role: z.string() }))
    .describe("Catalog parts. Do NOT add drivers, buck converters, batteries or PSUs for motors/servos — the builder adds those automatically."),
  customParts: z
    .array(
      z.object({
        name: z.string(),
        category: z.enum(["Electrical", "Mechanical"]),
        group: z.enum(["Sensor", "Actuator", "Display", "Communication", "Passive", "Structural", "Mechanism", "Misc"]),
        qty: z.number().int(),
        unitPrice: z.number(),
        specs: z.string(),
      }),
    )
    .describe("Only for real, purchasable parts that have no catalog equivalent and need no MCU pins (e.g. springs, bearings, fabric, magnets)."),
  notes: z.array(z.string()),
});

export const DesignSchema = z.object({
  reply: z.string().describe("What you designed or changed, in 1–4 friendly sentences. Mention trade-offs or anything the user should decide."),
  plan: PlanSchema,
});

export const ClarifySchema = z.object({
  reply: z.string().describe("One or two sentences restating the idea and inviting the user to answer"),
  questions: z
    .array(z.object({ id: z.enum(["goal", "budget", "controller", "power", "size", "environment"]), text: z.string(), options: z.array(z.string()) }))
    .describe("2–4 multiple-choice questions, 3–5 short options each"),
});

export type DesignOutput = { reply: string; plan: Plan };
export type ClarifyOutput = { reply: string; questions: Question[] };
export interface DesignInput {
  prompt: string;
  prefs: Preferences;
  history: ChatMessage[];
  current?: Plan;
  message?: string;
}

const catalogDigest = CATALOG.map((c) => `- ${c.id}: ${c.name} [${c.group}] $${c.price} — ${c.specs}`).join("\n");
const controllerDigest = Object.values(CONTROLLERS)
  .map((c) => `- ${c.id}: ${c.catalog.name}, ${c.logic} logic${c.wifi ? ", Wi-Fi" : ""}, ${c.digital.length} digital / ${c.analog.length} analog pins`)
  .join("\n");

export const SYSTEM = `You are the hardware design engine behind MechHub Blueprint, which turns plain-language ideas into buildable electronics + mechanical projects for makers with no engineering degree.

You choose what goes into the design; a deterministic builder then allocates MCU pins, adds motor/servo drivers and power regulation, lays out the 3D model, writes firmware and the assembly guide from your plan. So:
- Pick parts only from the catalog below, by id, with realistic quantities. Prefer the fewest parts that fully deliver the idea.
- Pick the archetype whose mechanical layout best fits (generic = an enclosure for anything else).
- Respect the user's budget, controller and power preferences when given. Choose ESP32 or Pico W when the idea needs Wi-Fi/Bluetooth.
- On a refinement, start from the current plan and change only what the user asked for, keeping everything else.
- Never invent catalog ids. Custom parts are for passive mechanical/misc items only.
- In your reply, never state a total cost or part count: the builder adds drivers, power parts and hardware after you, and the app appends the computed totals itself. Talk about what changed and why.

Controllers:
${controllerDigest}

Catalog:
${catalogDigest}`;

export function clarifyRequest(prompt: string): string {
  return `A user wants to build: "${prompt}".\nAsk the 2–4 clarifying questions that would most change the parts list (always cover goal, budget and microcontroller preference; add power or environment if relevant). Use ids goal, budget, controller, power, size, environment. For controller, include "You choose" as an option.`;
}

export function designRequest(input: DesignInput): string {
  const history = input.history
    .slice(-10)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");
  return [
    `Original idea: "${input.prompt}"`,
    `Preferences: ${JSON.stringify(input.prefs)}`,
    history ? `Conversation so far:\n${history}` : "",
    input.current ? `Current plan (JSON):\n${JSON.stringify(input.current)}` : "",
    input.message ? `Latest user request: "${input.message}"\nUpdate the plan accordingly.` : "Create the first complete plan for this idea.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function finishPlan(plan: Plan): Plan {
  plan.modules = plan.modules.filter((m) => m.qty > 0);
  return plan;
}

// ───────────────────────── Claude backend ─────────────────────────

export const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
let client: Anthropic | null = null;

async function callClaude<T extends z.ZodType>(schema: T, user: string, effort: "low" | "medium"): Promise<z.infer<T>> {
  client ??= new Anthropic();
  const response = await client.beta.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    output_config: { effort, format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined this request");
  if (response.stop_reason === "max_tokens") throw new Error("Claude response was cut off");
  if (!response.parsed_output) throw new Error("Claude returned no structured output");
  return response.parsed_output as z.infer<T>;
}

export async function claudeClarify(prompt: string): Promise<ClarifyOutput> {
  return callClaude(ClarifySchema, clarifyRequest(prompt), "low");
}

export async function claudeDesign(input: DesignInput): Promise<DesignOutput> {
  const out = await callClaude(DesignSchema, designRequest(input), "medium");
  return { reply: out.reply, plan: finishPlan(out.plan as Plan) };
}
