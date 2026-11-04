// Runs the built Vercel output locally the way the platform does: static files first, /api/*
// rewritten to the bundled function as /api?__path=…, everything else falling back to index.html.
// Usage: npm run build:vercel && node scripts/vercel-smoke.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const out = path.resolve(".vercel/output");
const cfg = JSON.parse(fs.readFileSync(path.join(out, "functions/api.func/.vc-config.json"), "utf8"));
process.env.VERCEL = "1";
process.env.MECHHUB_PROVIDER = "offline";
process.env.MECHHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mechhub-vercel-"));
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;
const handler = createRequire(import.meta.url)(path.join(out, "functions/api.func", cfg.handler));
if (typeof handler !== "function") throw new Error("function bundle does not export a handler");

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const { pathname, search } = new URL(req.url, "http://x");
  const m = pathname.match(/^\/api\/(.*)$/);
  if (m) {
    req.url = `/api?__path=${m[1]}${search ? "&" + search.slice(1) : ""}`; // worst case: function sees only the rewritten URL
    return handler(req, res);
  }
  let file = path.join(out, "static", pathname);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(out, "static/index.html");
  res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(8898, r));
const base = "http://localhost:8898";
const j = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) fails++;
};
try {
  const health = await j("GET", "/api/health");
  check(health.status === 200 && health.body.ok, `health → ${JSON.stringify(health.body)}`);
  const list = await j("GET", "/api/projects");
  check(list.body.length === 4, `examples seeded on first request (${list.body.length})`);
  const created = await j("POST", "/api/projects", { prompt: "smart plant pot", generateNow: true });
  check(created.body.status === "ready" && created.body.blueprint.bom.length > 0, "create + generate a blueprint");
  const refined = await j("POST", `/api/projects/${created.body.id}/messages`, { text: "add a buzzer" });
  check(refined.body.blueprint.version === 2, "chat refinement through the function");
  const show = await j("GET", "/api/showcase");
  check(show.body.length === 5 && show.body.every((s) => Array.isArray(s.mech)), "showcase includes 3D bodies");
  const stats = await j("GET", "/api/stats");
  check(stats.body.blueprints === 5, `stats → ${JSON.stringify(stats.body)}`);
  const missing = await j("GET", "/api/nope");
  check(missing.status === 404, "unknown API route returns JSON 404");
  const page = await fetch(base + `/p/${created.body.id}`).then((r) => r.text());
  check(page.includes('<div id="root">'), "client route /p/<id> serves the SPA");
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
console.log(fails ? `\n${fails} failed` : "\nVercel output works locally");
process.exitCode = fails ? 1 : 0;
