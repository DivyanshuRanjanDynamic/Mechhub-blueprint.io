# MechHub Blueprint

Describe a machine and get the whole blueprint: a parts list with prices and buy links, a pin-accurate wiring diagram, a 3D CAD assembly you can export (STL / STEP / GLB), ready-to-flash firmware, and a step-by-step build guide. A chat refines the design as you go.

## Quick start

```bash
npm install
npm run dev          # API on :8787, web app on http://localhost:5173
```

### Choosing the AI planner

Copy `.env.example` to `.env` and set one of these keys:

| Provider | Set | Default model |
| --- | --- | --- |
| **Groq** | `GROQ_API_KEY` (from [console.groq.com/keys](https://console.groq.com/keys)) | `openai/gpt-oss-120b` (`GROQ_MODEL` to change) |
| Claude | `ANTHROPIC_API_KEY` | `claude-opus-5-5` (`ANTHROPIC_MODEL` to change) |
| Offline | nothing | built-in keyword planner |

If more than one key is present, Groq wins. Set `MECHHUB_PROVIDER=groq|claude|offline` to choose explicitly. If an AI call fails, the server falls back to the offline planner, so a user always gets a blueprint.

```bash
npm test               # engine self-test: 9 project types × 4 controllers
npm run e2e:mock-groq  # real-user journey through the Groq backend (local mock, no key needed)
npm run e2e -- --provider groq   # same journey against the real Groq API
npm run test:storage  # full API on the Redis backend (in-memory stand-in for Upstash)
npm run test:vercel   # build the Vercel output and run it locally with Vercel-style routing
npm run build          # typecheck + production bundle
npm start              # serve API + built app on :8787
```

[TESTING.md](TESTING.md) has the full real-user test script and more prompts to try.

## Deploy to Vercel

The repo deploys with the [Build Output API](https://vercel.com/docs/build-output-api). `vercel.json` runs `npm run build:vercel` (`scripts/build-vercel.mjs`), which writes `.vercel/output/`:

- `static/`: the Vite site
- `functions/api.func/`: the whole Express API bundled into one Node 22 function, with a 60 s max duration
- `config.json`: `/api/*` goes to the function, then static files, and every other path falls back to `index.html`

1. **Push the repo to GitHub, GitLab or Bitbucket.** Then in Vercel choose **Add New → Project** and import it. Don't change the build settings; `vercel.json` sets them.
2. **Add storage.** Go to **Project → Storage → Create Database → Upstash for Redis** (free tier), then **Connect** it to the project. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you. You can instead set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` yourself.
3. **Add environment variables** under **Settings → Environment Variables**:
   - `GROQ_API_KEY`: your key
   - `MECHHUB_PROVIDER`: `groq`
   - `GROQ_MODEL`: optional

   Don't upload `.env`; it is gitignored.
4. **Deploy**, or redeploy after adding the variables, since they only apply to new deployments.
5. **Check it** at `https://<your-app>.vercel.app/api/health`. You should see `"provider":"groq"` and `"storage":"redis"`.

The four example projects are created on the first request. If `storage` says `file`, Redis isn't connected: the site works, but projects are written to `/tmp` and lost between function instances, and the logs show a warning.

You can deploy from the CLI instead, after setting up the same variables:

```bash
npx vercel
```

```bash
npx vercel --prod
```

## Features

| Feature | Where | How it works |
| --- | --- | --- |
| Text-to-hardware | Home → chat | The prompt becomes a `Plan` (archetype, controller, power source, catalog modules) from Groq, Claude or the offline planner. |
| Clarifying questions | Chat | First reply asks about goal, budget, microcontroller and power. You can answer with chips or skip with "Generate now". |
| Chat refinement | Chat | "add an OLED", "switch to Arduino Nano", "make it cheaper", "run it on battery". Each change rebuilds the blueprint (v1, v2, …). |
| Bill of materials | Parts tab | Grouped Electrical / Mechanical → MCU, Sensor, Actuator, Driver, Power, … 3D-print lines are costed from part volume. Buy links go to Amazon, AliExpress and DigiKey, plus the maker's own store where there is one. Exports to CSV. |
| Wiring & schematic | Wiring tab | Auto-laid-out SVG schematic with lane routing, a shared I²C bus, power/ground rail tags, net tracing on click, a full connection list and SVG export. |
| 3D CAD | 3D CAD tab | three.js assembly with orbit, part picking, an exploded view and a printed-part highlight. Exports STL (all, printed only, or one part), GLB, STEP (AP214 faceted B-rep) and PNG. |
| Assembly guide | Guide tab | Ordered steps with parts, tools and safety warnings, and a progress checklist. |
| Firmware | Code tab | An Arduino sketch generated for the exact pin map, with the libraries it needs listed. Download as `.ino`. |

## Architecture

```
shared/types.ts        Plan, Blueprint, BOM, wiring and mech types (shared by client and server)
server/catalog.ts      Component knowledge base: pins, supply rails, prices, firmware snippets, 3D footprints
server/planner.ts      Offline planner: archetype templates, keyword modules, clarifying questions, chat edits
server/ai.ts           Shared planner prompt + zod schemas; Claude backend (structured outputs, refusal fallback)
server/groq.ts         Groq backend (JSON mode + zod validation, normalisation, one corrective retry)
server/llm.ts          Picks the provider (MECHHUB_PROVIDER / available keys)
server/builder.ts      Deterministic Plan → Blueprint: drivers, power, pin allocation, wiring, firmware, CAD, BOM, steps
server/app.ts          Express API (shared by local and Vercel)
server/index.ts        Local entry: serves dist/ and listens on :8787
server/vercel.ts       Vercel function entry
server/store.ts        Project store: Upstash Redis (production) or data/projects.json (local)
src/                   React SPA: Home, Workspace (Chat + Overview/Parts/Wiring/3D CAD/Guide/Code)
src/lib/step.ts        STEP AP214 writer
scripts/e2e.ts         Real-user end-to-end test (scripted maker persona)
scripts/mock-groq.ts   Local stand-in for api.groq.com used by the e2e test
scripts/build-vercel.mjs  Builds .vercel/output (Build Output API)
scripts/vercel-smoke.mjs  Runs that output locally with Vercel-style routing
scripts/test-storage.ts   API against the Redis store (in-memory Upstash stand-in)
scripts/groq-budget.ts    Tokens per action vs. your Groq rate limits
```

The planner (Groq, Claude or offline) decides only what goes into the design. Everything that has to be electrically and mechanically consistent is derived deterministically in `builder.ts`. That covers:

- adding a PCA9685 when there are more than two servos, TB6612 motor drivers, A4988 stepper drivers and relays for loads
- choosing the power path (USB, 2S battery, 12/24 V supply or solar), adding a buck converter, and warning when the supply is too weak
- allocating MCU pins: the hardware UART first, then analog, then PWM, then digital, with a shared I²C bus, a shared stepper enable line, and analog pins used as digital on AVR and RP2040 boards
- level-shifting warnings for 3.3 V controllers

So an AI-planned design can't end up with impossible wiring.

### API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/health` | – |
| GET | `/api/projects` | – |
| POST | `/api/projects` | `{ prompt, generateNow? }` |
| GET | `/api/projects/:id` | – |
| POST | `/api/projects/:id/messages` | `{ text?, answers? }` (answers clarifying questions, or refines a ready design) |
| POST | `/api/projects/:id/star` | `{ unstar? }` |
| DELETE | `/api/projects/:id` | – |

## Reverse-engineering notes (Blueprint.io)

The feature set was mapped with [REA](https://github.com/morluto/rea) (`capture_browser_scenario`) against the public pages only: the landing page and one public community project. There was no login and no private APIs. This project's code is an original implementation; nothing was copied from their bundles.

What was seen:

- **Stack:** Vite-built SPA (`/assets/index-*.js`, a lazy `Landing-*.js` chunk), an API at `server.blueprint.io/api/*` (`features`, `trending`, `community?sort=trending`, `stats`), Supabase for auth, PostHog/Sentry/GA for telemetry.
- **Landing:** a prompt box ("Ask blueprint to build robots") with "Need an idea?", image upload, sketch input and a model tier toggle ("Lite"). There's a community gallery (part count, stars, author) and demo tabs for prompt / parts / wiring / mech.
- **Project page tabs:** INFO, PARTS, WIRING, MECH, INSTRUCTIONS, plus Star and Copy (fork).
- **BOM model:** Category (Electrical / Mechanical) → group (MCU, Sensor, Actuator, Power / Structural, Mechanism, Misc, 3D Print). Each has a part count and cost subtotal, with a total row. 3D-printed parts appear as costed BOM lines.

Not implemented here (out of scope for this first version): image and sketch input, user accounts, a public community feed, and live retailer price APIs. Prices are catalog estimates, and the buy links open live searches.

## Caveats

- Prices are estimates. Check current listings before ordering.
- Generated wiring and firmware come from the catalog's pinouts. Verify them against your exact modules before applying power.
- The STEP export is a faceted B-rep (flat faces). It imports as solids, but cylinders come in as 32-sided prisms.
