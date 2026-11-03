// Types shared by the API server and the web client.

export type ControllerId = "esp32-devkit" | "arduino-uno" | "arduino-nano" | "rpi-pico-w";

export type Archetype =
  | "robotic-arm"
  | "rover"
  | "weather-station"
  | "cnc"
  | "plant-care"
  | "smart-home"
  | "security"
  | "wearable"
  | "generic";

export type PowerSource = "usb" | "battery" | "mains" | "solar";

export type BomCategory = "Electrical" | "Mechanical";
export type BomGroup =
  | "MCU"
  | "Sensor"
  | "Actuator"
  | "Driver"
  | "Display"
  | "Communication"
  | "Power"
  | "Passive"
  | "Structural"
  | "Mechanism"
  | "Misc"
  | "3D Print";

/** What the planner (Claude or the offline planner) decides; the builder turns it into a full blueprint. */
export interface Plan {
  title: string;
  summary: string;
  tags: string[];
  archetype: Archetype;
  controller: ControllerId;
  power: PowerSource;
  budget: number | null;
  modules: { catalogId: string; qty: number; role?: string }[];
  customParts: CustomPart[];
  notes: string[];
}

export interface CustomPart {
  name: string;
  category: BomCategory;
  group: BomGroup;
  qty: number;
  unitPrice: number;
  specs: string;
}

export interface SourcingLink {
  vendor: string;
  url: string;
}

export interface BomItem {
  id: string;
  designator: string;
  name: string;
  category: BomCategory;
  group: BomGroup;
  qty: number;
  unitPrice: number;
  specs: string;
  sourcing: SourcingLink[];
  role?: string;
}

export type BlockKind = "power" | "mcu" | "driver" | "device";

export interface WiringBlock {
  id: string;
  label: string;
  sublabel: string;
  kind: BlockKind;
  bomId: string;
}

export type NetKind = "signal" | "power" | "ground" | "motor";

export interface Connection {
  id: string;
  from: { block: string; pin: string };
  to: { block: string; pin: string };
  net: string;
  kind: NetKind;
  color: string;
  note?: string;
}

export interface Wiring {
  blocks: WiringBlock[];
  connections: Connection[];
  pinMap: { label: string; pin: string; role: string }[];
}

export type MechShape = "box" | "cylinder";

export interface MechPart {
  id: string;
  name: string;
  shape: MechShape;
  /** box: [width(x), height(y), depth(z)]; cylinder: [radiusTop, height, radiusBottom] — all mm */
  size: [number, number, number];
  position: [number, number, number];
  /** Euler radians */
  rotation: [number, number, number];
  color: string;
  printed: boolean;
  material: string;
  opacity?: number;
  /** links a model body back to its BOM line */
  bomId?: string;
  /** direction this part moves in the exploded view */
  explode?: [number, number, number];
}

export interface AssemblyStep {
  n: number;
  title: string;
  body: string;
  parts: string[];
  tools: string[];
  warning?: string;
}

export interface Question {
  id: string;
  text: string;
  options: string[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  questions?: Question[];
  ts: number;
}

export interface Preferences {
  goal?: string;
  budget?: string;
  controller?: string;
  power?: string;
}

export interface Blueprint {
  plan: Plan;
  bom: BomItem[];
  wiring: Wiring;
  mech: MechPart[];
  steps: AssemblyStep[];
  firmware: string;
  totals: { parts: number; cost: number; electrical: number; mechanical: number };
  warnings: string[];
  engine: "claude" | "groq" | "offline";
  version: number;
}

export interface Project {
  id: string;
  prompt: string;
  status: "clarifying" | "ready";
  prefs: Preferences;
  messages: ChatMessage[];
  blueprint?: Blueprint;
  stars: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary {
  id: string;
  title: string;
  prompt: string;
  status: Project["status"];
  parts: number;
  cost: number;
  stars: number;
  tags: string[];
  archetype?: Archetype;
  updatedAt: number;
}
