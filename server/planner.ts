// Offline planner: keyword-driven design planning used when no ANTHROPIC_API_KEY is configured,
// and as the safety net if a Claude call fails.
import type { Archetype, ControllerId, Plan, PowerSource, Preferences, Question } from "../shared/types.ts";
import { CATALOG, CONTROLLERS, getItem } from "./catalog.ts";

interface Template {
  archetype: Archetype;
  match: RegExp;
  controller: ControllerId;
  power: PowerSource;
  modules: [string, number, string?][];
  tags: string[];
  goals: string[];
  blurb: string;
}

const TEMPLATES: Template[] = [
  {
    archetype: "robotic-arm",
    match: /\b(robot(ic)?\s*arm|arm|manipulator|gripper|pick\s*and\s*place)\b/i,
    controller: "arduino-uno",
    power: "mains",
    modules: [
      ["servo-mg996r", 3, "Base / shoulder / elbow joints"],
      ["servo-sg90", 2, "Wrist + gripper"],
      ["potentiometer", 2, "Manual joint control"],
      ["button", 1, "Grip / record button"],
    ],
    tags: ["robotics", "servo", "desktop"],
    goals: ["Pick and place small objects", "Learn robot kinematics", "Draw / write with a pen", "Teach-and-repeat motions"],
    blurb: "a five-joint desktop arm with a two-finger gripper, driven by a PCA9685 servo controller",
  },
  {
    archetype: "rover",
    match: /\b(rover|robot\s*car|rc\s*car|car|tank|vehicle|line\s*follow\w*|obstacle|explorer|wheeled)\b/i,
    controller: "esp32-devkit",
    power: "battery",
    modules: [
      ["dc-gear-motor", 4, "4WD drive"],
      ["hcsr04", 1, "Obstacle detection"],
      ["servo-sg90", 1, "Sensor pan"],
    ],
    tags: ["robotics", "mobile", "wifi"],
    goals: ["Autonomous obstacle avoidance", "Wi-Fi remote control from a phone", "Line following", "Outdoor exploring"],
    blurb: "a two-deck 4WD rover with obstacle sensing and Wi-Fi remote control",
  },
  {
    archetype: "weather-station",
    match: /\b(weather|meteo|climate\s*station|rain\s*gauge|anemometer)\b/i,
    controller: "esp32-devkit",
    power: "solar",
    modules: [
      ["bme280", 1, "Temperature / humidity / pressure"],
      ["rain-sensor", 1, "Rain detection"],
      ["anemometer", 1, "Wind speed"],
      ["ldr", 1, "Daylight level"],
      ["oled-128x64", 1, "Local readout"],
    ],
    tags: ["iot", "outdoor", "sensors", "wifi"],
    goals: ["Log to a cloud dashboard", "Display readings at home", "Garden / farm monitoring", "Learn about sensors"],
    blurb: "a mast-mounted station with a radiation shield, rain and wind sensing that reports over Wi-Fi",
  },
  {
    archetype: "cnc",
    match: /\b(cnc|mill|router|engrav\w*|plotter|laser|3d\s*printer|gantry)\b/i,
    controller: "arduino-uno",
    power: "mains",
    modules: [
      ["stepper-nema17", 3, "X / Y / Z axes"],
      ["limit-switch", 3, "Homing"],
      ["relay-1ch", 1, "Spindle on/off"],
    ],
    tags: ["cnc", "fabrication", "stepper"],
    goals: ["Carve wood and plastic", "PCB milling", "Pen plotting", "Engraving signs"],
    blurb: "a compact three-axis gantry machine with lead-screw drives and GRBL-style homing",
  },
  {
    archetype: "plant-care",
    match: /\b(plant|garden|water(ing)?|irrigat\w*|greenhouse|hydroponic\w*|soil)\b/i,
    controller: "esp32-devkit",
    power: "usb",
    modules: [
      ["soil-moisture", 1, "Soil moisture"],
      ["water-pump", 1, "Watering"],
      ["dht22", 1, "Air temperature / humidity"],
      ["ldr", 1, "Light level"],
      ["oled-128x64", 1, "Status display"],
    ],
    tags: ["iot", "garden", "automation"],
    goals: ["Automatic watering while away", "Monitor plant health", "Indoor herb garden", "Greenhouse control"],
    blurb: "a self-watering planter that reads soil moisture and runs a pump from a reservoir",
  },
  {
    archetype: "security",
    match: /\b(security|alarm|intruder|surveillance|doorbell|camera|cctv|guard)\b/i,
    controller: "esp32-devkit",
    power: "usb",
    modules: [
      ["pir", 1, "Motion trigger"],
      ["camera-ov2640", 1, "Snapshot camera"],
      ["buzzer", 1, "Siren"],
      ["button", 1, "Arm / disarm"],
    ],
    tags: ["security", "iot", "camera"],
    goals: ["Phone alerts on motion", "Record snapshots", "Loud local alarm", "Smart doorbell"],
    blurb: "a motion-triggered alarm with a camera module and phone notifications",
  },
  {
    archetype: "wearable",
    match: /\b(wearable|watch|wrist|fitness|step\s*counter|band|glove|helmet)\b/i,
    controller: "esp32-devkit",
    power: "battery",
    modules: [
      ["mpu6050", 1, "Motion tracking"],
      ["oled-128x64", 1, "Display"],
      ["button", 1, "Mode button"],
    ],
    tags: ["wearable", "imu", "bluetooth"],
    goals: ["Step / activity tracking", "Gesture control", "Fall detection", "Notifications display"],
    blurb: "a wrist-worn motion tracker with a small OLED display",
  },
  {
    archetype: "smart-home",
    match: /\b(smart\s*(home|light|lamp|mirror|switch|plug|lock)|home\s*automation|lamp|thermostat|light)\b/i,
    controller: "esp32-devkit",
    power: "usb",
    modules: [
      ["dht22", 1, "Room climate"],
      ["pir", 1, "Occupancy"],
      ["neopixel-ring", 1, "Ambient light"],
      ["relay-1ch", 1, "Appliance switch"],
    ],
    tags: ["smart-home", "iot", "wifi"],
    goals: ["Phone / voice control", "Automate on presence", "Energy saving", "Mood lighting"],
    blurb: "a Wi-Fi room controller with presence-triggered lighting and an appliance relay",
  },
];

const GENERIC: Template = {
  archetype: "generic",
  match: /.*/,
  controller: "esp32-devkit",
  power: "usb",
  modules: [["oled-128x64", 1, "Status display"]],
  tags: ["prototype"],
  goals: ["A working prototype", "A finished, enclosed product", "A learning project", "A gift"],
  blurb: "a compact enclosed device",
};

export function detectTemplate(prompt: string): Template {
  return TEMPLATES.find((t) => t.match.test(prompt)) ?? GENERIC;
}

export const CONTROLLER_OPTIONS: Record<string, ControllerId | null> = {
  "ESP32 (Wi-Fi + Bluetooth)": "esp32-devkit",
  "Arduino Uno": "arduino-uno",
  "Arduino Nano": "arduino-nano",
  "Raspberry Pi Pico W": "rpi-pico-w",
  "You choose": null,
};

export function clarifyingQuestions(prompt: string): { reply: string; questions: Question[] } {
  const t = detectTemplate(prompt);
  return {
    reply: `Great idea — I can design ${t.archetype === "generic" ? "this" : `this as ${t.blurb}`}. A few quick questions so the parts list fits you (or hit “Generate now” and I'll use sensible defaults):`,
    questions: [
      { id: "goal", text: "What's the main goal?", options: t.goals },
      { id: "budget", text: "What's your budget?", options: ["Under $40", "$40–$100", "$100–$250", "No limit"] },
      { id: "controller", text: "Preferred microcontroller?", options: Object.keys(CONTROLLER_OPTIONS) },
      { id: "power", text: "How will it be powered?", options: ["USB", "Battery", "Wall adapter", "Solar"] },
    ],
  };
}

export function parseBudget(s?: string): number | null {
  if (!s) return null;
  if (/no limit/i.test(s)) return null;
  const nums = [...s.matchAll(/\$?\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (!nums.length) return null;
  return Math.max(...nums);
}

export function parseController(s?: string): ControllerId | null {
  if (!s) return null;
  if (CONTROLLER_OPTIONS[s] !== undefined) return CONTROLLER_OPTIONS[s];
  if (/esp\s*32/i.test(s)) return "esp32-devkit";
  if (/nano/i.test(s)) return "arduino-nano";
  if (/pico|rp2040/i.test(s)) return "rpi-pico-w";
  if (/uno|arduino/i.test(s)) return "arduino-uno";
  return null;
}

export function parsePower(s?: string): PowerSource | null {
  if (!s) return null;
  if (/solar/i.test(s)) return "solar";
  if (/batter|portable|li-?ion|lipo|18650/i.test(s)) return "battery";
  if (/wall|mains|adapter|plug|outlet/i.test(s)) return "mains";
  if (/usb/i.test(s)) return "usb";
  return null;
}

const CHEAPER: Record<string, string> = {
  bme280: "dht22",
  "servo-mg996r": "servo-sg90",
  "anemometer": "",
  "camera-ov2640": "",
  "lora-sx1276": "",
};

function titleFrom(prompt: string): string {
  let cleaned = prompt.trim();
  // Strip conversational lead-ins ("I want to build me a…", "Can you design…", "I'd like a…")
  for (let prev = ""; prev !== cleaned; ) {
    prev = cleaned;
    cleaned = cleaned
      .replace(/^(please|hey|hi|so|i\s+want(\s+to)?|i\s+would\s+like(\s+to)?|i'd\s+like(\s+to)?|i\s+need|can\s+you|could\s+you|help\s+me|let's|lets)\s+/i, "")
      .replace(/^(build|make|create|design|generate|get)\s+(me\s+)?/i, "")
      .replace(/^(a|an|the|my|some)\s+/i, "");
  }
  cleaned = cleaned
    .split(/\s+(that|which|with|for|to|using)\s+/i)[0]
    .replace(/[^\w\s-]/g, "")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 5);
  if (!words.length) return "Untitled Device";
  return words.map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1).toLowerCase())).join(" ");
}

/** Keywords in the prompt pull in extra modules beyond the template. */
function keywordModules(text: string, existing: Set<string>): [string, number, string][] {
  const lower = text.toLowerCase();
  const out: [string, number, string][] = [];
  const coveredKeywords = new Set<string>();
  for (const id of existing) getItem(id)?.keywords.forEach((k) => coveredKeywords.add(k));
  for (const item of CATALOG) {
    if (item.group === "Power" || item.driverKind === "pca9685" || item.driverKind === "motor-driver" || item.driverKind === "stepper-driver") continue;
    if (existing.has(item.id)) continue;
    const hit = item.keywords.find((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(lower));
    if (!hit || coveredKeywords.has(hit)) continue;
    out.push([item.id, 1, `Requested: ${hit}`]);
    existing.add(item.id);
    item.keywords.forEach((k) => coveredKeywords.add(k));
  }
  return out;
}

export function planOffline(prompt: string, prefs: Preferences): Plan {
  const t = detectTemplate(prompt);
  const budget = parseBudget(prefs.budget);
  const controller = parseController(prefs.controller) ?? (/wifi|wi-fi|iot|app|phone|cloud|bluetooth/i.test(prompt) ? "esp32-devkit" : t.controller);
  const power = parsePower(prefs.power) ?? parsePower(prompt) ?? t.power;

  const modules = t.modules.map(([catalogId, qty, role]) => ({ catalogId, qty, role }));
  const ids = new Set(modules.map((m) => m.catalogId));
  for (const [catalogId, qty, role] of keywordModules(`${prompt} ${prefs.goal ?? ""}`, ids)) modules.push({ catalogId, qty, role });

  let plan: Plan = {
    title: titleFrom(prompt),
    summary: "",
    tags: [...t.tags],
    archetype: t.archetype,
    controller,
    power,
    budget,
    modules,
    customParts: t.archetype === "cnc" ? [] : [],
    notes: prefs.goal ? [`Goal: ${prefs.goal}`] : [],
  };
  if (budget !== null && budget < 60) plan = cheapen(plan);
  plan.summary = summarize(plan, t.blurb, prefs.goal);
  return plan;
}

function cheapen(plan: Plan): Plan {
  const modules = plan.modules
    .map((m) => (m.catalogId in CHEAPER ? { ...m, catalogId: CHEAPER[m.catalogId] } : m))
    .filter((m) => m.catalogId);
  const controller = plan.controller === "arduino-uno" ? "arduino-nano" : plan.controller;
  return { ...plan, modules, controller, notes: [...plan.notes, "Budget-optimised part choices"] };
}

function summarize(plan: Plan, blurb: string, goal?: string): string {
  const ctrl = CONTROLLERS[plan.controller].catalog.name;
  const names = plan.modules.map((m) => getItem(m.catalogId)?.name.split(/[(,]/)[0].trim()).filter(Boolean) as string[];
  const powerText = { usb: "USB power", battery: "a rechargeable 2S Li-ion pack", mains: "a wall adapter", solar: "a solar-charged battery" }[plan.power];
  return `${plan.title} is ${blurb}. It is built around the ${ctrl}, combining ${listify(names.slice(0, 5))}${names.length > 5 ? " and more" : ""}, and runs from ${powerText}.${goal ? ` Designed for: ${goal.toLowerCase()}.` : ""}`;
}

function listify(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, another: 1 };

function findItemByText(text: string) {
  const lower = text.toLowerCase();
  let best: { id: string; score: number } | null = null;
  for (const item of CATALOG) {
    let score = 0;
    for (const k of item.keywords) if (lower.includes(k)) score += k.length;
    const short = item.name.toLowerCase().split(/[\s(]/)[0];
    if (short.length > 2 && lower.includes(short)) score += 20;
    if (lower.includes(item.id)) score += 25;
    if (score && (!best || score > best.score)) best = { id: item.id, score };
  }
  return best?.id;
}

/** Apply a chat refinement to an existing plan without an LLM. */
export function refineOffline(plan: Plan, message: string): { plan: Plan; reply: string } {
  const next: Plan = structuredClone(plan);
  const changes: string[] = [];
  const lower = message.toLowerCase();

  const ctrl = /\b(use|switch|change|swap|move)\b/.test(lower) ? parseController(message) : null;
  if (ctrl && ctrl !== next.controller) {
    next.controller = ctrl;
    changes.push(`switched the controller to the ${CONTROLLERS[ctrl].catalog.name}`);
  }
  const pw = /\b(power|run|battery|solar|wall|usb|portable)\b/.test(lower) ? parsePower(message) : null;
  if (pw && pw !== next.power) {
    next.power = pw;
    changes.push(`changed power to ${pw}`);
  }
  if (/budget|cheaper|cheap|cost less|under \$/.test(lower)) {
    const b = parseBudget(message);
    if (b) next.budget = b;
    Object.assign(next, cheapen(next));
    changes.push(b ? `targeted a $${b} budget with cheaper parts` : "swapped in cheaper parts");
  }

  for (const clause of message.split(/,|\band\b|;|\./i)) {
    const c = clause.trim();
    if (!c) continue;
    const remove = /\b(remove|delete|drop|without|no|get rid of)\b/i.test(c);
    const addish = /\b(add|include|put|with|plus|also|attach|need|want)\b/i.test(c);
    if (!remove && !addish) continue;
    const id = findItemByText(c);
    if (!id) continue;
    const item = getItem(id)!;
    if (remove) {
      const before = next.modules.length;
      next.modules = next.modules.filter((m) => m.catalogId !== id);
      if (next.modules.length !== before) changes.push(`removed the ${item.name}`);
      continue;
    }
    const qtyMatch = c.match(/\b(\d+|a|an|one|two|three|four|five|six|another)\b/i);
    const qty = qtyMatch ? Number(qtyMatch[1]) || NUMBER_WORDS[qtyMatch[1].toLowerCase()] || 1 : 1;
    const existing = next.modules.find((m) => m.catalogId === id);
    if (existing && /another|more|extra/i.test(c)) existing.qty += qty;
    else if (existing) existing.qty = Math.max(existing.qty, qty);
    else next.modules.push({ catalogId: id, qty, role: "Added in chat" });
    changes.push(`added ${qty}× ${item.name}`);
  }

  if (!changes.length) {
    return {
      plan,
      reply:
        "I'm running in offline mode, so I understand direct edits best. Try things like “add an OLED display”, “remove the buzzer”, “add 2 more servos”, “switch to Arduino Nano”, “run it on battery” or “make it cheaper”. Set ANTHROPIC_API_KEY on the server for free-form design conversations.",
    };
  }
  const t = detectTemplate(next.title + " " + next.tags.join(" "));
  next.summary = summarize(next, t.archetype === next.archetype ? t.blurb : "a custom device", undefined);
  return { plan: next, reply: `Done — I ${listify(changes)}. The parts list, wiring, 3D model, code and guide are updated.` };
}
