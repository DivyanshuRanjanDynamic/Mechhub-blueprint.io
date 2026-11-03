// Groq backend. Uses JSON-object mode (available on every Groq chat model) with the schema
// embedded in the prompt, then validates with zod. Smaller open models sometimes drift from the
// schema, so the output is normalised first and one corrective retry is made on failure.
import Groq from "groq-sdk";
import * as z from "zod/v4";
import type { Plan } from "../shared/types.ts";
import {
  ARCHETYPES,
  ClarifySchema,
  DesignSchema,
  SYSTEM,
  catalogIds,
  clarifyRequest,
  controllerIds,
  designRequest,
  finishPlan,
  type ClarifyOutput,
  type DesignInput,
  type DesignOutput,
} from "./ai.ts";

export const GROQ_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
let client: Groq | null = null;

const CATALOG_SET = new Set<string>(catalogIds);
const CONTROLLER_SET = new Set<string>(controllerIds);
const ARCHETYPE_SET = new Set<string>(ARCHETYPES);

/** Repair the usual small deviations (unknown ids, string numbers, missing arrays) before validating. */
function normalizeDesign(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as Record<string, unknown>;
  const plan = (r.plan ?? r) as Record<string, unknown>;
  if (!plan || typeof plan !== "object") return raw;
  const num = (v: unknown, d: number) => (typeof v === "number" ? v : Number.isFinite(Number(v)) ? Number(v) : d);
  plan.tags = Array.isArray(plan.tags) ? plan.tags.map(String) : [];
  plan.notes = Array.isArray(plan.notes) ? plan.notes.map(String) : [];
  plan.customParts = Array.isArray(plan.customParts) ? plan.customParts : [];
  if (!ARCHETYPE_SET.has(String(plan.archetype))) plan.archetype = "generic";
  if (!CONTROLLER_SET.has(String(plan.controller))) plan.controller = "esp32-devkit";
  if (!["usb", "battery", "mains", "solar"].includes(String(plan.power))) plan.power = "usb";
  plan.budget = plan.budget === null || plan.budget === undefined || plan.budget === "" ? null : num(plan.budget, 0) || null;
  plan.modules = (Array.isArray(plan.modules) ? plan.modules : [])
    .map((m: Record<string, unknown>) => ({ catalogId: String(m?.catalogId ?? m?.id ?? ""), qty: Math.round(num(m?.qty, 1)), role: String(m?.role ?? "") }))
    .filter((m) => CATALOG_SET.has(m.catalogId));
  plan.customParts = (plan.customParts as Record<string, unknown>[]).map((c) => ({ ...c, qty: Math.round(num(c?.qty, 1)), unitPrice: num(c?.unitPrice, 0) }));
  return { reply: String(r.reply ?? "Here's your design."), plan };
}

async function callGroq<T extends z.ZodType>(schema: T, user: string, normalize: (raw: unknown) => unknown = (x) => x): Promise<z.infer<T>> {
  client ??= new Groq();
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: `${SYSTEM}\n\nRespond with a single JSON object that validates against this JSON Schema, and nothing else:\n${jsonSchema}` },
    { role: "user", content: user },
  ];
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.chat.completions.create({
      model: GROQ_MODEL,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_completion_tokens: 8000,
    });
    const text = res.choices[0]?.message?.content ?? "";
    let parsed: unknown;
    try {
      parsed = normalize(JSON.parse(text));
    } catch {
      lastError = "Response was not valid JSON.";
      messages.push({ role: "assistant", content: text }, { role: "user", content: `${lastError} Reply again with only the JSON object.` });
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    lastError = z.prettifyError(result.error);
    messages.push({ role: "assistant", content: text }, { role: "user", content: `That JSON did not match the schema:\n${lastError}\nFix it and reply with only the corrected JSON object.` });
  }
  throw new Error(`Groq output failed validation: ${lastError}`);
}

export async function groqClarify(prompt: string): Promise<ClarifyOutput> {
  return callGroq(ClarifySchema, clarifyRequest(prompt));
}

export async function groqDesign(input: DesignInput): Promise<DesignOutput> {
  const out = await callGroq(DesignSchema, designRequest(input), normalizeDesign);
  return { reply: out.reply, plan: finishPlan(out.plan as Plan) };
}
