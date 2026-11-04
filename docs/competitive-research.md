# Competitive research: Blueprint.io

Internal notes, kept out of the public README.

The feature set of Blueprint.io (an AI hardware design tool) was mapped with [REA](https://github.com/morluto/rea) (`capture_browser_scenario`) against **public pages only**: the landing page and one public community project. There was no login and no private APIs were used. MechHub Blueprint is an original implementation: no code, images, logos or other assets were copied from Blueprint.io.

## Observations

- **Stack:** a Vite-built SPA (`/assets/index-*.js` plus a lazy `Landing-*.js` chunk) and an API at `server.blueprint.io/api/*` (`features`, `trending`, `community?sort=trending`, `stats`). It uses Supabase for auth and PostHog, Sentry and GA for telemetry.
- **Landing page:**
  - a prompt box ("Ask blueprint to build robots") with "Need an idea?", image upload, sketch input and a model-tier toggle ("Lite")
  - a community gallery showing part count, stars and author
  - demo tabs for prompt / parts / wiring / mech
- **Project page tabs:** INFO, PARTS, WIRING, MECH, INSTRUCTIONS, plus Star and Copy (fork).
- **BOM model:** Category (Electrical / Mechanical) → group (MCU, Sensor, Actuator, Power / Structural, Mechanism, Misc, 3D Print), each with a part count and cost subtotal, and a total row. 3D-printed parts appear as costed BOM lines.

## Gaps relative to Blueprint.io

These are not yet in MechHub Blueprint and are tracked in the README roadmap: image and sketch input, user accounts, a public community feed with forking, and live retailer pricing.
