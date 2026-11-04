// Project store with two backends:
//   • Upstash Redis — used when UPSTASH_REDIS_REST_URL/TOKEN (or Vercel's KV_REST_API_URL/TOKEN) are set.
//     Required on Vercel, where the filesystem is not persistent.
//   • JSON file — local development (data/projects.json, or MECHHUB_DATA_DIR).
// Redis layout: mh:p:<id> → full project, mh:mech:<id> → 3D bodies (for homepage thumbnails),
// hash mh:sum → id → summary (so listing never loads whole blueprints).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Redis } from "@upstash/redis";
import type { MechPart, Project, ProjectSummary } from "../shared/types.ts";

/** Summary plus the aggregates the stats endpoint needs. */
export type StoredSummary = ProjectSummary & { connections: number; printed: number };

/** The handful of Redis commands the store uses; Upstash's client satisfies it, and tests can fake it. */
export interface KV {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  hset(key: string, values: Record<string, unknown>): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null>;
  mget<T extends unknown[]>(...keys: string[]): Promise<T>;
}

interface Backend {
  readonly kind: "redis" | "file";
  get(id: string): Promise<Project | undefined>;
  save(p: Project, summary: StoredSummary): Promise<void>;
  remove(id: string): Promise<boolean>;
  summaries(): Promise<StoredSummary[]>;
  mech(ids: string[]): Promise<MechPart[][]>;
}

export function summarize(p: Project): StoredSummary {
  return {
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
    connections: p.blueprint?.wiring.connections.length ?? 0,
    printed: p.blueprint?.mech.filter((m) => m.printed).length ?? 0,
  };
}

export function redisBackend(kv: KV): Backend {
  return {
    kind: "redis",
    async get(id) {
      return (await kv.get<Project>(`mh:p:${id}`)) ?? undefined;
    },
    async save(p, summary) {
      await Promise.all([kv.set(`mh:p:${p.id}`, p), kv.set(`mh:mech:${p.id}`, p.blueprint?.mech ?? []), kv.hset("mh:sum", { [p.id]: summary })]);
    },
    async remove(id) {
      const [n] = await Promise.all([kv.del(`mh:p:${id}`, `mh:mech:${id}`), kv.hdel("mh:sum", id)]);
      return n > 0;
    },
    async summaries() {
      const all = await kv.hgetall<Record<string, StoredSummary | string>>("mh:sum");
      return Object.values(all ?? {}).map((v) => (typeof v === "string" ? (JSON.parse(v) as StoredSummary) : v));
    },
    async mech(ids) {
      if (!ids.length) return [];
      const rows = await kv.mget<(MechPart[] | null)[]>(...ids.map((id) => `mh:mech:${id}`));
      return rows.map((r) => r ?? []);
    },
  };
}

function fileBackend(dir: string): Backend {
  const file = path.join(dir, "projects.json");
  let projects = new Map<string, Project>();
  try {
    projects = new Map((JSON.parse(fs.readFileSync(file, "utf8")) as Project[]).map((p) => [p.id, p]));
  } catch {
    /* first run */
  }
  let timer: NodeJS.Timeout | null = null;
  const persist = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify([...projects.values()], null, 1));
      fs.renameSync(`${file}.tmp`, file);
    }, 150);
  };
  return {
    kind: "file",
    async get(id) {
      return projects.get(id);
    },
    async save(p) {
      projects.set(p.id, p);
      persist();
    },
    async remove(id) {
      const ok = projects.delete(id);
      persist();
      return ok;
    },
    async summaries() {
      return [...projects.values()].map(summarize);
    },
    async mech(ids) {
      return ids.map((id) => projects.get(id)?.blueprint?.mech ?? []);
    },
  };
}

function createBackend(): Backend {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) return redisBackend(new Redis({ url, token }) as unknown as KV);
  // Vercel's filesystem is read-only except /tmp, and /tmp is wiped between instances.
  const onVercel = Boolean(process.env.VERCEL);
  if (onVercel) console.warn("[store] No Upstash Redis configured — projects are kept in /tmp and WILL be lost. Add Upstash Redis to this Vercel project.");
  return fileBackend(process.env.MECHHUB_DATA_DIR ?? (onVercel ? "/tmp/mechhub" : path.resolve("data")));
}

let backend: Backend | null = null;
const db = () => (backend ??= createBackend());

/** Swap the backend (tests). */
export function useBackend(b: Backend) {
  backend = b;
}

export const kind = () => db().kind;
export const newId = () => crypto.randomBytes(9).toString("base64url");
export const get = (id: string) => db().get(id);

export async function save(p: Project): Promise<Project> {
  p.updatedAt = Date.now();
  await db().save(p, summarize(p));
  return p;
}

export const remove = (id: string) => db().remove(id);

/** Newest first; summary fields only. */
export async function list(): Promise<StoredSummary[]> {
  return (await db().summaries()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export const mech = (ids: string[]) => db().mech(ids);
