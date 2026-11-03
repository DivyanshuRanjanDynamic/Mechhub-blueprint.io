// Measures what one user session costs against your Groq rate limits, using the exact prompts
// the app sends. Prints token usage per call and the limit headers Groq returns for your org.
//   npx tsx scripts/groq-budget.ts
import "dotenv/config";
import Groq from "groq-sdk";
import * as z from "zod/v4";
import { ClarifySchema, DesignSchema, SYSTEM, clarifyRequest, designRequest } from "../server/ai.ts";
import { planOffline } from "../server/planner.ts";
import { GROQ_MODEL } from "../server/groq.ts";

const groq = new Groq();
const idea = "I want a smart weather station for my balcony that shows the temperature on a small screen and tells me when it starts raining";

async function measure(label: string, schema: z.ZodType, user: string) {
  const sys = `${SYSTEM}\n\nRespond with a single JSON object that validates against this JSON Schema, and nothing else:\n${JSON.stringify(z.toJSONSchema(schema))}`;
  const t = Date.now();
  const { data, response } = await groq.chat.completions
    .create({ model: GROQ_MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: user }], response_format: { type: "json_object" }, temperature: 0.3, max_completion_tokens: 8000 })
    .withResponse();
  const u = data.usage!;
  const h = (k: string) => response.headers.get(k);
  console.log(`${label.padEnd(10)} prompt=${u.prompt_tokens}  completion=${u.completion_tokens}  total=${u.total_tokens}  ${Date.now() - t} ms`);
  return { total: u.total_tokens, headers: { rpd: h("x-ratelimit-limit-requests"), tpm: h("x-ratelimit-limit-tokens"), remainingRpd: h("x-ratelimit-remaining-requests"), remainingTpm: h("x-ratelimit-remaining-tokens") } };
}

const plan = planOffline(idea, { budget: "$40–$100", controller: "ESP32", power: "Battery" });
const history = [{ role: "user" as const, text: idea, ts: 0 }];
const a = await measure("clarify", ClarifySchema, clarifyRequest(idea));
const b = await measure("design", DesignSchema, designRequest({ prompt: idea, prefs: { budget: "$40–$100" }, history }));
const c = await measure("refine", DesignSchema, designRequest({ prompt: idea, prefs: {}, history, current: plan, message: "Add a buzzer so it beeps when rain starts" }));
console.log(`\nmodel ${GROQ_MODEL}`);
console.log("limits from Groq headers:", c.headers);
console.log(JSON.stringify({ clarify: a.total, design: b.total, refine: c.total }));
