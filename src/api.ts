import type { Blueprint, MechPart, Preferences, Project, ProjectSummary } from "../shared/types.ts";

export type ShowcaseItem = ProjectSummary & { mech: MechPart[] };
export interface Stats {
  projects: number;
  blueprints: number;
  parts: number;
  connections: number;
  printed: number;
}

export interface Health {
  ok: boolean;
  ai: boolean;
  provider: Blueprint["engine"];
  model: string | null;
}

export const PROVIDER_NAME: Record<Blueprint["engine"], string> = { claude: "Claude", groq: "Groq", offline: "Offline" };

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  health: () => req<Health>("/api/health"),
  list: () => req<ProjectSummary[]>("/api/projects"),
  showcase: () => req<ShowcaseItem[]>("/api/showcase"),
  stats: () => req<Stats>("/api/stats"),
  get: (id: string) => req<Project>(`/api/projects/${id}`),
  create: (prompt: string, generateNow: boolean) => req<Project>("/api/projects", { method: "POST", body: JSON.stringify({ prompt, generateNow }) }),
  send: (id: string, text: string, answers?: Preferences) =>
    req<Project>(`/api/projects/${id}/messages`, { method: "POST", body: JSON.stringify({ text, answers }) }),
  star: (id: string, unstar = false) => req<Project>(`/api/projects/${id}/star`, { method: "POST", body: JSON.stringify({ unstar }) }),
  remove: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
};

export function download(filename: string, data: BlobPart, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const fileSafe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "blueprint";
export const money = (n: number) => `$${n.toFixed(2)}`;
