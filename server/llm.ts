// Picks the planner backend. MECHHUB_PROVIDER=groq|claude|offline forces one; otherwise a
// GROQ_API_KEY selects Groq, an Anthropic credential selects Claude, and nothing selects offline.
import type { Blueprint } from "../shared/types.ts";
import { CLAUDE_MODEL, claudeClarify, claudeDesign, type ClarifyOutput, type DesignInput, type DesignOutput } from "./ai.ts";
import { GROQ_MODEL, groqClarify, groqDesign } from "./groq.ts";

export type Provider = Blueprint["engine"];

export function activeProvider(): Provider {
  const forced = process.env.MECHHUB_PROVIDER?.toLowerCase();
  if (process.env.MECHHUB_OFFLINE === "1" || forced === "offline") return "offline";
  if (forced === "groq") return process.env.GROQ_API_KEY ? "groq" : "offline";
  if (forced === "claude" || forced === "anthropic") return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? "claude" : "offline";
  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "claude";
  return "offline";
}

export function activeModel(): string | null {
  const p = activeProvider();
  return p === "groq" ? GROQ_MODEL : p === "claude" ? CLAUDE_MODEL : null;
}

export async function llmClarify(prompt: string): Promise<ClarifyOutput> {
  return activeProvider() === "groq" ? groqClarify(prompt) : claudeClarify(prompt);
}

export async function llmDesign(input: DesignInput): Promise<DesignOutput> {
  return activeProvider() === "groq" ? groqDesign(input) : claudeDesign(input);
}
