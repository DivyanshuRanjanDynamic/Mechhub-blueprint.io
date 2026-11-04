// Vercel function entry. scripts/build-vercel.mjs bundles this into .vercel/output/functions/api.func.
// Environment variables come from the Vercel project settings, not .env.
import type { IncomingMessage, ServerResponse } from "node:http";
import app from "./app.ts";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  // The route rewrites /api/<path> to this function as /api?__path=<path>. Restore the original
  // path so Express routing matches, whichever URL the platform hands us.
  const url = new URL(req.url ?? "/", "http://localhost");
  const original = url.searchParams.get("__path");
  if (original !== null) {
    url.searchParams.delete("__path");
    const pathname = url.pathname.startsWith("/api/") ? url.pathname : `/api/${original}`;
    req.url = pathname + url.search;
  }
  return app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
