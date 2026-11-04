// Connectivity check for the Upstash database in .env: writes, reads and deletes a temporary
// key using the same commands the store uses, and reports what MechHub data already exists.
//   npx tsx scripts/check-redis.ts
import "dotenv/config";
import { Redis } from "@upstash/redis";

const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
if (!url || !token) {
  console.error("No Upstash credentials in the environment.");
  process.exit(1);
}
const redis = new Redis({ url, token });
const key = `mh:check:${Date.now()}`;
const t = Date.now();
await redis.set(key, { ok: true, n: 42 });
const back = await redis.get<{ ok: boolean; n: number }>(key);
await redis.hset(`${key}:h`, { a: { x: 1 } });
const h = await redis.hgetall<Record<string, { x: number }>>(`${key}:h`);
const [m] = await redis.mget<({ ok: boolean } | null)[]>(key);
await redis.del(key, `${key}:h`);
const gone = await redis.get(key);
const ok = back?.n === 42 && h?.a?.x === 1 && m?.ok === true && gone === null;
const projects = Object.keys((await redis.hgetall("mh:sum")) ?? {}).length;
console.log(`${ok ? "✓" : "✗"} Upstash read/write/delete via ${new URL(url).host} (${Date.now() - t} ms)`);
console.log(`  MechHub projects stored: ${projects}`);
process.exitCode = ok ? 0 : 1;
