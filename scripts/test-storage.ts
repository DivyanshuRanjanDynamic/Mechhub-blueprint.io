// Exercises the Redis store end to end against an in-memory stand-in for Upstash, so the
// production storage path is tested without an Upstash account.
//   npx tsx scripts/test-storage.ts
import type { AddressInfo } from "node:net";
import * as store from "../server/store.ts";
import type { KV } from "../server/store.ts";

/** Behaves like @upstash/redis: values are JSON-serialised on write and parsed on read. */
function memoryKV(): KV & { keys(): string[] } {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const enc = (v: unknown) => JSON.stringify(v);
  const dec = <T>(s: string | undefined): T | null => (s === undefined ? null : (JSON.parse(s) as T));
  return {
    async get<T>(k: string) {
      return dec<T>(strings.get(k));
    },
    async set(k, v) {
      strings.set(k, enc(v));
      return "OK";
    },
    async del(...ks) {
      let n = 0;
      for (const k of ks) if (strings.delete(k) || hashes.delete(k)) n++;
      return n;
    },
    async hset(k, values) {
      const h = hashes.get(k) ?? new Map();
      for (const [f, v] of Object.entries(values)) h.set(f, enc(v));
      hashes.set(k, h);
      return Object.keys(values).length;
    },
    async hdel(k, ...fs) {
      const h = hashes.get(k);
      let n = 0;
      for (const f of fs) if (h?.delete(f)) n++;
      return n;
    },
    async hgetall<T extends Record<string, unknown>>(k: string) {
      const h = hashes.get(k);
      return h ? (Object.fromEntries([...h].map(([f, v]) => [f, JSON.parse(v)])) as T) : null;
    },
    async mget<T extends unknown[]>(...ks: string[]) {
      return ks.map((k) => dec(strings.get(k))) as T;
    },
    keys: () => [...strings.keys(), ...hashes.keys()],
  };
}

process.env.MECHHUB_PROVIDER = "offline";
const kv = memoryKV();
store.useBackend(store.redisBackend(kv));
const { default: app } = await import("../server/app.ts");
const server = app.listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const j = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) fails++;
};
try {
  const health = await j("GET", "/api/health");
  check(health.body.storage === "redis", "API reports Redis storage");
  const list = await j("GET", "/api/projects");
  check(list.body.length === 4, "examples seeded into Redis");
  const again = await j("GET", "/api/projects");
  check(again.body.length === 4, "seeding runs once (no duplicates)");
  const p = await j("POST", "/api/projects", { prompt: "rover with gps", generateNow: true });
  check(kv.keys().includes(`mh:p:${p.body.id}`) && kv.keys().includes(`mh:mech:${p.body.id}`), "project + 3D bodies written under mh:* keys");
  const got = await j("GET", `/api/projects/${p.body.id}`);
  check(got.body.blueprint.wiring.connections.length === p.body.blueprint.wiring.connections.length, "project reads back intact");
  const starred = await j("POST", `/api/projects/${p.body.id}/star`, {});
  check(starred.body.stars === 1, "star persists");
  const show = await j("GET", "/api/showcase");
  check(show.body.find((s: { id: string }) => s.id === p.body.id)?.mech.length > 0, "showcase reads 3D bodies from Redis");
  const stats = await j("GET", "/api/stats");
  check(stats.body.blueprints === 5 && stats.body.connections > 0, `stats from stored summaries → ${JSON.stringify(stats.body)}`);
  const del = await j("DELETE", `/api/projects/${p.body.id}`);
  check(del.body.ok && !kv.keys().includes(`mh:p:${p.body.id}`), "delete removes keys");
  const after = await j("GET", "/api/projects");
  check(after.body.length === 4, "summary removed from listing");
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
console.log(fails ? `\n${fails} failed` : "\nRedis storage path works");
process.exitCode = fails ? 1 : 0;
