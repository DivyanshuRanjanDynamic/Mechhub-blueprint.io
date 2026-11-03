// Tiny JSON-file project store. Swap for a database when this outgrows one machine.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Project, ProjectSummary } from "../shared/types.ts";

const DATA_DIR = process.env.MECHHUB_DATA_DIR ?? path.resolve("data");
const FILE = path.join(DATA_DIR, "projects.json");

let projects = new Map<string, Project>();

export function load(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as Project[];
    projects = new Map(raw.map((p) => [p.id, p]));
  } catch {
    projects = new Map();
  }
}

let timer: NodeJS.Timeout | null = null;
function persist(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...projects.values()], null, 1));
    fs.renameSync(tmp, FILE);
  }, 150);
}

export const newId = () => crypto.randomBytes(9).toString("base64url");

export function get(id: string): Project | undefined {
  return projects.get(id);
}

export function save(p: Project): Project {
  p.updatedAt = Date.now();
  projects.set(p.id, p);
  persist();
  return p;
}

export function remove(id: string): boolean {
  const ok = projects.delete(id);
  persist();
  return ok;
}

export function count(): number {
  return projects.size;
}

export function list(): ProjectSummary[] {
  return [...projects.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((p) => ({
      id: p.id,
      title: p.blueprint?.plan.title ?? p.prompt,
      prompt: p.prompt,
      status: p.status,
      parts: p.blueprint?.totals.parts ?? 0,
      cost: p.blueprint?.totals.cost ?? 0,
      stars: p.stars,
      tags: p.blueprint?.plan.tags ?? [],
      archetype: p.blueprint?.plan.archetype,
      updatedAt: p.updatedAt,
    }));
}
