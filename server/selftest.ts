// Smoke test for the offline planner + builder: every archetype and controller must produce
// a consistent blueprint (no unallocated pins, no dangling wiring, positive cost).
import { buildBlueprint } from "./builder.ts";
import { planOffline, refineOffline } from "./planner.ts";
import type { ControllerId } from "../shared/types.ts";

const prompts = [
  "robotic arm",
  "smart weather station",
  "obstacle avoiding rover with gps",
  "mini cnc machine",
  "self watering plant pot",
  "home security alarm with camera",
  "fitness wearable step counter",
  "smart lamp with motion sensor",
  "a cat feeder that opens a latch on a timer with a display",
];
const controllers: ControllerId[] = ["esp32-devkit", "arduino-uno", "arduino-nano", "rpi-pico-w"];

let failures = 0;
const fail = (m: string) => {
  failures++;
  console.error("  ✗", m);
};

for (const prompt of prompts) {
  for (const c of controllers) {
    const ctrlName = { "esp32-devkit": "ESP32", "arduino-uno": "Arduino Uno", "arduino-nano": "Arduino Nano", "rpi-pico-w": "Raspberry Pi Pico W" }[c];
    const plan = planOffline(prompt, { controller: ctrlName });
    const bp = buildBlueprint(plan, "offline");
    const ids = new Set(bp.wiring.blocks.map((b) => b.id));
    for (const w of bp.wiring.connections) {
      if (!ids.has(w.from.block) || !ids.has(w.to.block)) fail(`${prompt}/${c}: dangling connection ${w.id}`);
    }
    if (bp.wiring.pinMap.some((p) => p.pin === "NC")) fail(`${prompt}/${c}: unallocated pin`);
    const pins = bp.wiring.pinMap.filter((p) => !p.role.includes("shared")).map((p) => p.pin).filter((p) => !["GPIO21", "GPIO22", "A4", "A5", "GP4", "GP5"].includes(p));
    const dup = pins.find((p, i) => pins.indexOf(p) !== i);
    if (dup) fail(`${prompt}/${c}: pin ${dup} used twice`);
    if (!(bp.totals.cost > 0)) fail(`${prompt}/${c}: zero cost`);
    if (!bp.mech.length) fail(`${prompt}/${c}: empty model`);
    if (!bp.firmware.includes("void setup()")) fail(`${prompt}/${c}: no firmware`);
    if (c === "esp32-devkit")
      console.log(`✓ ${plan.title.padEnd(34)} ${plan.archetype.padEnd(16)} ${String(bp.totals.parts).padStart(3)} parts  $${bp.totals.cost.toFixed(2).padStart(7)}  ${bp.wiring.connections.length} wires  ${bp.mech.length} bodies  ${bp.steps.length} steps  ${bp.warnings.length} warnings`);
  }
}

const base = planOffline("robotic arm", {});
const r = refineOffline(base, "add an OLED display and remove the button, switch to ESP32");
console.log("refine:", r.reply);
if (!r.plan.modules.some((m) => m.catalogId === "oled-128x64")) fail("refine did not add OLED");
if (r.plan.modules.some((m) => m.catalogId === "button")) fail("refine did not remove button");
if (r.plan.controller !== "esp32-devkit") fail("refine did not switch controller");

console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
