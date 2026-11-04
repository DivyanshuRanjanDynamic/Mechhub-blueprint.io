// Builds a Vercel deployment with the Build Output API (https://vercel.com/docs/build-output-api):
//   .vercel/output/static/              ← the Vite site
//   .vercel/output/functions/api.func/  ← the whole Express API bundled into one file
//   .vercel/output/config.json          ← routing: /api/* → function, files, then SPA fallback
// Vercel runs this via vercel.json's buildCommand. Run it locally with `npm run build:vercel`.
import { build as viteBuild } from "vite";
import { build as esbuild } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const out = path.resolve(".vercel/output");
fs.rmSync(out, { recursive: true, force: true });

// 1. Static site
await viteBuild({ logLevel: "warn" });
fs.cpSync(path.resolve("dist"), path.join(out, "static"), { recursive: true });

// 2. API function (CommonJS bundle so the launcher can require it; deps are inlined)
const fn = path.join(out, "functions/api.func");
await esbuild({
  entryPoints: ["server/vercel.ts"],
  outfile: path.join(fn, "index.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: false,
  sourcemap: true,
  logLevel: "warning",
  // export the handler itself, not { default: handler }
  footer: { js: "module.exports = module.exports.default;" },
});
fs.writeFileSync(
  path.join(fn, ".vc-config.json"),
  JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.cjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      shouldAddSourcemapSupport: true,
      // AI design calls take 2–30 s (longer when Groq's free tier is throttling)
      maxDuration: 60,
    },
    null,
    2,
  ),
);

// 3. Routing
fs.writeFileSync(
  path.join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "^/api/(.*)$", dest: "/api?__path=$1" },
        { handle: "filesystem" },
        // client-side routes such as /p/<id> load the SPA
        { src: "^/(.*)$", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);

const kb = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)} KB`;
console.log(`✓ .vercel/output ready — function ${kb(path.join(fn, "index.cjs"))}, static ${fs.readdirSync(path.join(out, "static")).length} entries`);
