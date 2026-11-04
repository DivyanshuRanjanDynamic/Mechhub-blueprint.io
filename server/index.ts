// Local / self-hosted entry point. On Vercel the same app runs as a function (server/vercel.ts).
import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import app from "./app.ts";
import { activeModel, activeProvider } from "./llm.ts";
import * as store from "./store.ts";

// Production: serve the built SPA from the same server
const dist = path.resolve("dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const PORT = Number(process.env.PORT ?? 8787);
app.listen(PORT, () => {
  console.log(`MechHub Blueprint API on http://localhost:${PORT} — planner: ${activeProvider()}${activeModel() ? ` (${activeModel()})` : ""} · storage: ${store.kind()}`);
});
