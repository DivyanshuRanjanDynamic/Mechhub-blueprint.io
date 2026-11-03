// Deterministic blueprint builder: Plan → BOM, wiring, 3D model, firmware and assembly guide.
// The planner only decides *what* goes in the design; everything that has to be electrically
// and mechanically consistent (pins, rails, drivers, layout) is derived here.
import type {
  AssemblyStep,
  Blueprint,
  BomGroup,
  BomItem,
  Connection,
  MechPart,
  NetKind,
  Plan,
  Wiring,
  WiringBlock,
} from "../shared/types.ts";
import {
  CONTROLLERS,
  getItem,
  searchLinksForName,
  sourcingFor,
  type CatalogItem,
  type ControllerSpec,
  type PinRole,
} from "./catalog.ts";

interface Inst {
  key: string;
  item: CatalogItem;
  designator: string;
  idx: number;
  role?: string;
  /** catalog pin name → MCU pin id (e.g. "25", "A0") */
  pins: Record<string, string>;
  driver?: Inst;
  channel?: number;
}

const DESIGNATOR: Record<BomGroup, string> = {
  MCU: "U",
  Sensor: "S",
  Actuator: "M",
  Driver: "D",
  Display: "DS",
  Communication: "C",
  Power: "PS",
  Passive: "SW",
  Structural: "X",
  Mechanism: "X",
  Misc: "X",
  "3D Print": "P",
};

const SIGNAL_COLORS = ["#facc15", "#22c55e", "#3b82f6", "#f97316", "#a855f7", "#14b8a6", "#ec4899", "#e5e7eb", "#84cc16", "#06b6d4"];
const RAIL_COLOR: Record<string, string> = {
  GND: "#1f2937",
  "3V3": "#fb923c",
  "5V": "#ef4444",
  VSERVO: "#dc2626",
  VMOTOR: "#b91c1c",
  VIN: "#991b1b",
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildBlueprint(plan: Plan, engine: Blueprint["engine"], version = 1): Blueprint {
  const ctrl = CONTROLLERS[plan.controller] ?? CONTROLLERS["esp32-devkit"];
  const warnings: string[] = [];
  const counters = new Map<string, number>();
  const perItem = new Map<string, number>();
  const insts: Inst[] = [];

  const add = (item: CatalogItem, role?: string): Inst => {
    const prefix = DESIGNATOR[item.group];
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    const idx = (perItem.get(item.id) ?? 0) + 1;
    perItem.set(item.id, idx);
    const inst: Inst = { key: `${prefix}${n}`, item, designator: `${prefix}${n}`, idx, role, pins: {} };
    insts.push(inst);
    return inst;
  };

  const mcu = add(ctrl.catalog, "Main controller");

  // 1. Requested modules
  for (const m of plan.modules) {
    const item = getItem(m.catalogId);
    if (!item || item.group === "MCU") continue;
    const qty = Math.max(1, Math.min(12, Math.round(m.qty || 1)));
    for (let i = 0; i < qty; i++) add(item, m.role);
  }

  // 2. Drivers for devices that can't hang off an MCU pin
  const devices = (kind: string) => insts.filter((i) => i.item.drivenBy === kind);
  const existingDrivers = (kind: string) => insts.filter((i) => i.item.driverKind === kind);

  const servos = devices("pca9685");
  const heavyServo = servos.some((s) => s.item.id === "servo-mg996r");
  if (servos.length > 2 || (servos.length > 0 && heavyServo && servos.length > 1) || existingDrivers("pca9685").length) {
    const pca = existingDrivers("pca9685")[0] ?? add(getItem("pca9685")!, "Servo PWM driver");
    servos.forEach((s, i) => {
      s.driver = pca;
      s.channel = i;
    });
  }

  const motors = devices("motor-driver");
  if (motors.length) {
    const perDriver = plan.archetype === "rover" ? 4 : 2; // rovers run left/right pairs in parallel
    const drivers = existingDrivers("motor-driver");
    while (drivers.length * perDriver < motors.length) drivers.push(add(getItem("tb6612")!, "DC motor driver"));
    motors.forEach((m, i) => {
      m.driver = drivers[Math.floor(i / perDriver)];
      m.channel = perDriver === 4 ? (i % 4 < 2 ? 0 : 1) : i % 2;
    });
  }

  const steppers = devices("stepper-driver");
  const stepDrivers = existingDrivers("stepper-driver");
  while (stepDrivers.length < steppers.length) stepDrivers.push(add(getItem("a4988")!, "Stepper driver"));
  steppers.forEach((m, i) => {
    m.driver = stepDrivers[i];
    m.channel = 0;
  });

  const relayed = devices("relay");
  const freeRelays = existingDrivers("relay").slice();
  relayed.forEach((d) => {
    d.driver = freeRelays.shift() ?? add(getItem("relay-1ch")!, `Switches ${shortName(d.item)}`);
    d.channel = 0;
  });

  // 3. Power architecture
  const needsServoRail = servos.length > 0;
  const motorLoads = [...motors, ...steppers, ...relayed];
  const needsMotorRail = motorLoads.length > 0;
  const needsStepperVolts = steppers.length > 0;
  const loadMa = insts.reduce((sum, i) => sum + i.item.currentMa, 0);
  let power = plan.power;
  const heavy = needsStepperVolts || heavyServo || motors.length > 0 || loadMa > 1500;

  if (power === "usb" && heavy) {
    warnings.push("USB cannot supply the motors/servos in this design, so a 12 V wall adapter and buck converter were added.");
    power = "mains";
  }
  if (power === "solar" && heavy) {
    warnings.push("A 2 W solar panel cannot run motors; the design uses a 2S battery pack for actuators and solar only tops up the logic.");
  }

  let mainSupply: Inst | undefined;
  let buck: Inst | undefined;
  if (power === "battery" || (power === "solar" && heavy)) {
    mainSupply = add(getItem("battery-2s-18650")!, "Main battery");
  } else if (power === "mains") {
    mainSupply = add(getItem(needsStepperVolts && steppers.length > 2 ? "psu-24v" : "psu-12v")!, "Main power supply");
  } else if (power === "solar") {
    mainSupply = add(getItem("solar-kit")!, "Solar power system");
  }
  const supplyVolts = mainSupply?.item.id === "psu-24v" ? 24 : mainSupply?.item.id === "psu-12v" ? 12 : mainSupply?.item.id === "battery-2s-18650" ? 7.4 : 5;
  if (mainSupply && supplyVolts > 5) buck = add(getItem("buck-lm2596")!, needsServoRail ? "6 V servo / 5 V rail" : "5 V rail");
  if (!insts.some((i) => i.item.id === "usb-cable")) add(getItem("usb-cable")!, power === "usb" ? "Power + programming" : "Programming");

  if (heavyServo && servos.length >= 3) {
    warnings.push(`${servos.length} MG996R servos can stall at ~2.5 A each; the LM2596 is rated 3 A, so avoid moving every joint at once or upgrade to a 10 A UBEC.`);
  }
  if (needsStepperVolts && mainSupply && supplyVolts < 12) {
    warnings.push("Stepper motors want 12–24 V; a battery pack will run them weakly.");
  }

  // 4. Pin allocation on the MCU
  const pools = {
    digital: ctrl.digital.slice(),
    pwm: ctrl.pwm.slice(),
    analog: ctrl.analog.slice(),
  };
  const used = new Set<string>();
  // Analog pins on AVR and RP2040 double as digital I/O (ESP32's 34–39 are input-only, so not there)
  const analogAsDigital = ctrl.id === "esp32-devkit" ? [] : pools.analog.filter((p) => !["A6", "A7"].includes(p));
  const take = (role: "digital" | "pwm" | "analog", who: string): string => {
    const order = role === "analog" ? pools.analog : role === "pwm" ? pools.pwm : pools.digital;
    const pin =
      order.find((p) => !used.has(p)) ??
      (role === "digital" ? pools.pwm.find((p) => !used.has(p)) ?? analogAsDigital.find((p) => !used.has(p)) : undefined);
    if (!pin) {
      warnings.push(`Ran out of ${role} pins on the ${ctrl.catalog.name} while wiring ${who}; consider an I/O expander or a bigger board.`);
      return "NC";
    }
    used.add(pin);
    return pin;
  };

  let uartUsed = false;
  const softSerial: string[] = [];
  const mcuFacing = insts.filter((i) => i !== mcu && !i.driver && i.item.group !== "Power");
  // UART devices first: the first one gets the hardware port, the rest use software serial
  for (const inst of mcuFacing.filter((i) => i.item.pins.some((p) => p.role === "tx"))) {
    const hw = ctrl.uart && !uartUsed ? ctrl.uart : null;
    for (const pin of inst.item.pins.filter((p) => p.role === "rx" || p.role === "tx")) {
      if (hw) {
        inst.pins[pin.name] = pin.role === "rx" ? hw.rx : hw.tx;
        used.add(inst.pins[pin.name]);
      } else {
        inst.pins[pin.name] = take("digital", `${inst.designator} ${shortName(inst.item)}`);
      }
    }
    if (hw) uartUsed = true;
    else softSerial.push(inst.key);
  }
  // Servos wired straight to the MCU (no PCA9685) claim PWM pins before plain digital I/O can
  for (const s of servos.filter((s) => !s.driver)) s.pins.SIG = take("pwm", `${s.designator} servo`);
  const order: PinRole[] = ["analog", "pwm", "digital"];
  let sharedEnable: string | undefined; // all stepper drivers share one enable line, like a CNC shield
  for (const role of order) {
    for (const inst of mcuFacing) {
      for (const pin of inst.item.pins.filter((p) => p.role === role)) {
        if (inst.pins[pin.name]) continue;
        if (inst.item.driverKind === "stepper-driver" && pin.name === "EN") {
          sharedEnable ??= take("digital", "stepper enable");
          inst.pins[pin.name] = sharedEnable;
          continue;
        }
        inst.pins[pin.name] = take(role as "digital" | "pwm" | "analog", `${inst.designator} ${shortName(inst.item)}`);
      }
    }
  }
  const i2cDevices = insts.filter((i) => i.item.pins.some((p) => p.role === "sda"));
  for (const d of i2cDevices) {
    for (const p of d.item.pins) {
      if (p.role === "sda") d.pins[p.name] = ctrl.sda;
      if (p.role === "scl") d.pins[p.name] = ctrl.scl;
    }
  }

  if (ctrl.logic === "3V3" && insts.some((i) => i.item.id === "hcsr04")) {
    warnings.push("HC-SR04 ECHO is a 5 V signal; a 1 kΩ / 2 kΩ divider is included to protect the 3.3 V input.");
  }

  // 5. Wiring graph
  const wiring = buildWiring(insts, mcu, ctrl, { mainSupply, buck, supplyVolts, needsServoRail, needsMotorRail });

  // 6. Firmware
  const firmware = buildFirmware(plan, insts, mcu, ctrl, softSerial);

  // 7. Mechanical model
  const mech = buildMech(plan, insts, mainSupply);

  // 8. BOM
  const bom = buildBom(plan, insts, mech, ctrl);
  if (ctrl.logic === "3V3" && insts.some((i) => i.item.id === "hcsr04")) {
    bom.push(bomLine("div", "R1–R2", "1 kΩ + 2 kΩ Resistor Divider (ECHO level shift)", "Electrical", "Passive", 1, 0.2, "1/4 W metal film"));
  }
  const electrical = bom.filter((b) => b.category === "Electrical").reduce((s, b) => s + b.qty * b.unitPrice, 0);
  const mechanical = bom.filter((b) => b.category === "Mechanical").reduce((s, b) => s + b.qty * b.unitPrice, 0);
  const cost = round2(electrical + mechanical);
  if (plan.budget && cost > plan.budget) {
    warnings.push(`Estimated cost $${cost.toFixed(2)} is over your $${plan.budget} budget; ask me to "make it cheaper" to swap in budget parts.`);
  }

  // 9. Assembly guide
  const steps = buildSteps(plan, insts, mcu, ctrl, wiring, mech, bom, warnings);

  return {
    plan,
    bom,
    wiring,
    mech,
    steps,
    firmware,
    totals: {
      parts: bom.reduce((s, b) => s + b.qty, 0),
      cost,
      electrical: round2(electrical),
      mechanical: round2(mechanical),
    },
    warnings,
    engine,
    version,
  };
}

function shortName(item: CatalogItem): string {
  return item.name.split(/[(,]/)[0].replace(/\s+(Sensor|Module)$/i, "").trim();
}

export function pinLabel(ctrl: ControllerSpec, pin: string): string {
  if (pin === "NC") return "NC";
  if (/^[A-Z]/.test(pin)) return pin;
  return `${ctrl.pinPrefix}${pin}`;
}

// ───────────────────────── Wiring ─────────────────────────

function buildWiring(
  insts: Inst[],
  mcu: Inst,
  ctrl: ControllerSpec,
  pw: { mainSupply?: Inst; buck?: Inst; supplyVolts: number; needsServoRail: boolean; needsMotorRail: boolean },
): Wiring {
  const blocks: WiringBlock[] = insts.map((i) => ({
    id: i.key,
    label: `${i.designator} · ${shortName(i.item)}`,
    sublabel: i.role ?? i.item.specs.split(",")[0],
    kind: i === mcu ? "mcu" : i.item.group === "Power" ? "power" : i.item.driverKind ? "driver" : "device",
    bomId: i.item.id,
  }));
  const connections: Connection[] = [];
  let sig = 0;
  const conn = (from: [Inst, string], to: [Inst, string], net: string, kind: NetKind, note?: string, color?: string) => {
    connections.push({
      id: `w${connections.length + 1}`,
      from: { block: from[0].key, pin: from[1] },
      to: { block: to[0].key, pin: to[1] },
      net,
      kind,
      color: color ?? (kind === "signal" ? SIGNAL_COLORS[sig++ % SIGNAL_COLORS.length] : kind === "motor" ? "#f59e0b" : RAIL_COLOR[net] ?? "#ef4444"),
      note,
    });
  };

  const logicNet = ctrl.logic === "3V3" ? "3V3" : "5V";
  const logicPin = ctrl.logic === "3V3" ? "3V3" : "5V";
  const mcu5vPin = ctrl.id === "esp32-devkit" ? "VIN" : ctrl.id === "rpi-pico-w" ? "VSYS" : "5V";

  // Rail sources
  const { mainSupply, buck } = pw;
  let fiveV: [Inst, string] = [mcu, mcu5vPin];
  if (mainSupply && buck) {
    const plus = mainSupply.item.pins[0].name;
    const minus = mainSupply.item.pins[1].name;
    conn([mainSupply, plus], [buck, "IN+"], "VIN", "power", `${pw.supplyVolts} V supply into buck`);
    conn([mainSupply, minus], [buck, "IN-"], "GND", "ground");
    conn([buck, "OUT+"], [mcu, mcu5vPin], "5V", "power", pw.needsServoRail ? "Buck set to 5.0 V for logic (servo rail tapped separately)" : "Buck set to 5.0 V");
    conn([buck, "OUT-"], [mcu, "GND"], "GND", "ground");
    fiveV = [buck, "OUT+"];
  } else if (mainSupply) {
    conn([mainSupply, mainSupply.item.pins[0].name], [mcu, mcu5vPin], "5V", "power");
    conn([mainSupply, mainSupply.item.pins[1].name], [mcu, "GND"], "GND", "ground");
    fiveV = [mainSupply, mainSupply.item.pins[0].name];
  }
  const motorRail: [Inst, string] = mainSupply && pw.supplyVolts > 5 ? [mainSupply, mainSupply.item.pins[0].name] : fiveV;
  const motorNet = mainSupply && pw.supplyVolts > 5 ? "VIN" : "5V";

  for (const inst of insts) {
    if (inst === mcu || inst.item.group === "Power") continue;
    // Supply
    const vccPins = inst.item.pins.filter((p) => p.role === "vcc");
    const gndPins = inst.item.pins.filter((p) => p.role === "gnd");
    if (!inst.driver) {
      if (inst.item.supply === "logic") vccPins.forEach((p) => conn([mcu, logicPin], [inst, p.name], logicNet, "power"));
      if (inst.item.supply === "5V") vccPins.forEach((p) => conn(fiveV[0] === mcu ? [mcu, mcu5vPin] : fiveV, [inst, p.name], "5V", "power"));
      if (inst.item.supply === "servo") vccPins.forEach((p) => conn(fiveV, [inst, p.name], "VSERVO", "power", "Servo power"));
      gndPins.forEach((p) => {
        if (inst.item.supply === "none" && p.role === "gnd" && inst.item.pins.length === 2) conn([mcu, "GND"], [inst, p.name], "GND", "ground");
        else conn([mcu, "GND"], [inst, p.name], "GND", "ground");
      });
    }
    // Signals to the MCU
    for (const [pinName, mcuPin] of Object.entries(inst.pins)) {
      if (inst.driver) continue;
      const pin = inst.item.pins.find((p) => p.name === pinName);
      const label = pinLabel(ctrl, mcuPin);
      const net = pin?.role === "sda" ? "SDA" : pin?.role === "scl" ? "SCL" : `${inst.designator}_${pinName}`;
      const color = pin?.role === "sda" ? "#3b82f6" : pin?.role === "scl" ? "#facc15" : undefined;
      conn([mcu, label], [inst, pinName], net, "signal", pin?.role === "tx" || pin?.role === "rx" ? "UART crossover (TX→RX)" : undefined, color);
    }
    // Driver-side power
    if (inst.item.driverKind === "pca9685") {
      conn(fiveV, [inst, "V+ (servo terminal)"], "VSERVO", "power", "Servo power terminal – keep off the MCU regulator");
    }
    if (inst.item.driverKind === "motor-driver") conn(motorRail, [inst, "VM"], motorNet === "VIN" ? "VMOTOR" : "5V", "power", "Motor supply");
    if (inst.item.driverKind === "stepper-driver") {
      conn(motorRail, [inst, "VMOT"], "VMOTOR", "power", "Add 100 µF electrolytic across VMOT/GND");
    }
    if (inst.item.driverKind === "relay") {
      const load = insts.find((d) => d.driver === inst);
      if (load) {
        const loadRail: [Inst, string] = load.item.id === "solenoid-lock" ? motorRail : fiveV;
        conn(loadRail, [inst, "COM"], load.item.id === "solenoid-lock" ? "VMOTOR" : "5V", "power", "Relay switches the load's positive lead");
      }
    }
  }

  // Driven devices → their driver
  for (const inst of insts.filter((i) => i.driver)) {
    const d = inst.driver!;
    const ch = inst.channel ?? 0;
    if (d.item.driverKind === "pca9685") {
      conn([d, `CH${ch} PWM`], [inst, "SIG"], `SERVO${ch}`, "signal");
      conn([d, `CH${ch} V+`], [inst, "V+"], "VSERVO", "power");
      conn([d, `CH${ch} GND`], [inst, "GND"], "GND", "ground");
    } else if (!d.item.driverKind) {
      // unreachable – kept for completeness
    } else if (d.item.driverKind === "motor-driver") {
      const side = ch === 0 ? "A" : "B";
      conn([d, `${side}O1`], [inst, "M+"], `MOT_${side}`, "motor", ch === 0 ? "Left side" : "Right side");
      conn([d, `${side}O2`], [inst, "M-"], `MOT_${side}`, "motor");
    } else if (d.item.driverKind === "stepper-driver") {
      conn([d, "1A"], [inst, "A+"], "COIL_A", "motor");
      conn([d, "1B"], [inst, "A-"], "COIL_A", "motor");
      conn([d, "2A"], [inst, "B+"], "COIL_B", "motor");
      conn([d, "2B"], [inst, "B-"], "COIL_B", "motor");
    } else if (d.item.driverKind === "relay") {
      conn([d, "NO"], [inst, "+"], `${inst.designator}_PWR`, "power", "Normally-open contact feeds the load");
      conn([mcu, "GND"], [inst, "-"], "GND", "ground");
    }
  }

  const pinMap: Wiring["pinMap"] = [];
  for (const inst of insts) {
    for (const [pinName, mcuPin] of Object.entries(inst.pins)) {
      const pin = inst.item.pins.find((p) => p.name === pinName);
      const shared = inst.item.driverKind === "stepper-driver" && pinName === "EN";
      pinMap.push({ label: `${inst.designator} ${shortName(inst.item)} · ${pinName}`, pin: pinLabel(ctrl, mcuPin), role: shared ? "digital (shared)" : pin?.role ?? "pwm" });
    }
  }
  pinMap.sort((a, b) => a.pin.localeCompare(b.pin, undefined, { numeric: true }));
  return { blocks, connections, pinMap };
}

// ───────────────────────── Firmware ─────────────────────────

function constName(inst: Inst, pin: string) {
  return `PIN_${inst.designator}_${pin.replace(/[^A-Za-z0-9]/g, "")}`.toUpperCase();
}

function buildFirmware(plan: Plan, insts: Inst[], mcu: Inst, ctrl: ControllerSpec, softSerial: string[]): string {
  const includes = new Set<string>(["<Arduino.h>"]);
  const libs = new Set<string>();
  const globals: string[] = [];
  const setup: string[] = [];
  const loop: string[] = [];
  const pinDefs: string[] = [];
  const isEsp = ctrl.id === "esp32-devkit";
  const pinValue = (p: string) => (p === "NC" ? "-1" : p);

  const hasI2c = insts.some((i) => i.item.pins.some((p) => p.role === "sda"));
  if (hasI2c) includes.add("<Wire.h>");

  for (const inst of insts) {
    if (inst === mcu) continue;
    for (const [pin, mcuPin] of Object.entries(inst.pins)) {
      pinDefs.push(`const int ${constName(inst, pin)} = ${pinValue(mcuPin)};  // ${inst.designator} ${shortName(inst.item)} ${pin}`);
    }
  }

  const uartInst = insts.find((i) => i.item.id === "gps-neo6m");
  if (uartInst) {
    const rx = constName(uartInst, "TX"); // module TX → MCU RX
    const tx = constName(uartInst, "RX");
    if (softSerial.includes(uartInst.key) || !ctrl.uart) {
      includes.add("<SoftwareSerial.h>");
      globals.push(`SoftwareSerial gpsSerial(${rx}, ${tx});\n#define GPS_SERIAL gpsSerial`);
      setup.push("GPS_SERIAL.begin(9600);");
    } else if (isEsp) {
      globals.push("#define GPS_SERIAL Serial2");
      setup.push(`GPS_SERIAL.begin(9600, SERIAL_8N1, ${rx}, ${tx});`);
    } else {
      globals.push("#define GPS_SERIAL Serial1");
      setup.push(`Serial1.setTX(${tx}); Serial1.setRX(${rx}); GPS_SERIAL.begin(9600);`);
    }
  }

  const expand = (tpl: string, inst: Inst) =>
    tpl.replace(/\{N\}/g, String(inst.idx)).replace(/\{PIN:([^}]+)\}/g, (_, p) => constName(inst, p));

  const seenGlobals = new Set<string>();
  for (const inst of insts) {
    const c = inst.item.code;
    inst.item.libs?.forEach((l) => libs.add(l));
    if (!c) continue;
    c.includes?.forEach((i) => includes.add(i));
    if (c.globals) {
      const g = expand(c.globals, inst);
      if (!seenGlobals.has(g)) globals.push(g);
      seenGlobals.add(g);
    }
    if (c.setup) setup.push(expand(c.setup, inst));
    if (c.loop) loop.push(expand(c.loop, inst));
  }

  // Servos
  const servos = insts.filter((i) => i.item.drivenBy === "pca9685");
  const direct = servos.filter((s) => !s.driver);
  if (direct.length) {
    includes.add(isEsp ? "<ESP32Servo.h>" : "<Servo.h>");
    libs.add(isEsp ? "ESP32Servo" : "Servo");
    direct.forEach((s) => {
      globals.push(`Servo servo${s.idx};`);
      setup.push(`servo${s.idx}.attach(${constName(s, "SIG")});`);
    });
    loop.push(`{ int deg = (millis() / 20) % 180; ${direct.map((s) => `servo${s.idx}.write(deg);`).join(" ")} }`);
  }
  const viaPca = servos.filter((s) => s.driver);
  if (viaPca.length) {
    const pcaIdx = viaPca[0].driver!.idx;
    loop.push(
      `// Sweep each joint gently between 60° and 120° (replace with your motion logic)\n  { int deg = 90 + 30 * sin(millis() / 1000.0);\n    for (uint8_t ch = 0; ch < ${viaPca.length}; ch++) setServo${pcaIdx}(ch, deg); }`,
    );
  }
  // DC motors
  const drivers = insts.filter((i) => i.item.driverKind === "motor-driver");
  if (drivers.length) loop.push(`// Drive forward; negative values reverse\n  ${drivers.map((d) => `drive${d.idx}(180, 180);`).join(" ")}`);
  // Relay-driven loads
  const relayLoads = insts.filter((i) => i.item.drivenBy === "relay" && i.driver);
  const soil = insts.find((i) => i.item.id === "soil-moisture");
  for (const load of relayLoads) {
    const pin = constName(load.driver!, "IN");
    if (load.item.id === "water-pump" && soil) {
      loop.push(`// Water when the soil reads dry (calibrate the threshold with your sensor)\n  digitalWrite(${pin}, soil${soil.idx} > 2000 ? LOW : HIGH);`);
    } else {
      loop.push(`digitalWrite(${pin}, (millis() / 10000) % 2 ? LOW : HIGH);  // toggle ${shortName(load.item)} every 10 s`);
    }
  }
  const buzzer = insts.find((i) => i.item.id === "buzzer");
  const pir = insts.find((i) => i.item.id === "pir");
  if (buzzer) {
    loop.push(
      pir
        ? `digitalWrite(${constName(buzzer, "+")}, digitalRead(${constName(pir, "OUT")}));  // sound while motion is present`
        : `digitalWrite(${constName(buzzer, "+")}, LOW);`,
    );
  }

  const wifi = ctrl.wifi && /wifi|wi-fi|iot|remote|app|cloud|dashboard|smart|web/i.test(plan.summary + plan.title + plan.tags.join(" "));
  if (wifi) {
    includes.add(isEsp ? "<WiFi.h>" : "<WiFi.h>");
    globals.unshift('const char* WIFI_SSID = "your-network";\nconst char* WIFI_PASS = "your-password";');
    setup.unshift('WiFi.begin(WIFI_SSID, WIFI_PASS);\n  for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; i++) delay(250);\n  Serial.println(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("Wi-Fi offline"));');
  }

  const wireBegin = !hasI2c ? "" : isEsp ? `Wire.begin(${ctrl.sda}, ${ctrl.scl});` : ctrl.id === "rpi-pico-w" ? `Wire.setSDA(${ctrl.sda}); Wire.setSCL(${ctrl.scl}); Wire.begin();` : "Wire.begin();";

  return `/*
 * ${plan.title}
 * Generated by MechHub Blueprint — review before flashing.
 *
 * Board:     ${ctrl.catalog.name}  (FQBN ${ctrl.board})
 * Libraries: ${[...libs].join(", ") || "none beyond the core"}
 */
${[...includes].map((i) => `#include ${i}`).join("\n")}

#if defined(ESP32)
#define IRAM_SAFE IRAM_ATTR
#else
#define IRAM_SAFE
#endif
#define LOOP_MS 200

// ── Pin map ──────────────────────────────────────────────
${pinDefs.join("\n") || "// no MCU pins used"}

// ── Devices ──────────────────────────────────────────────
${globals.join("\n\n")}

void setup() {
  Serial.begin(115200);
  ${[wireBegin, ...setup].filter(Boolean).join("\n  ")}
  Serial.println(F("${plan.title.replace(/"/g, "")} ready"));
}

void loop() {
  ${loop.join("\n  ") || "// add behaviour here"}
  delay(LOOP_MS);
}
`;
}

// ───────────────────────── Mechanical model ─────────────────────────

const box = (
  id: string,
  name: string,
  size: [number, number, number],
  position: [number, number, number],
  color: string,
  printed: boolean,
  extra: Partial<MechPart> = {},
): MechPart => ({ id, name, shape: "box", size, position, rotation: [0, 0, 0], color, printed, material: printed ? "PLA" : "Purchased", ...extra });

const cyl = (
  id: string,
  name: string,
  r: number,
  h: number,
  position: [number, number, number],
  color: string,
  printed: boolean,
  extra: Partial<MechPart> = {},
): MechPart => ({ id, name, shape: "cylinder", size: [r, h, extra.size?.[2] ?? r], position, rotation: [0, 0, 0], color, printed, material: printed ? "PLA" : "Purchased", ...extra });

/** Shelf-pack module footprints onto a rectangle and return model bodies resting on `y`. */
function placeModules(list: Inst[], x0: number, z0: number, width: number, y: number, explodeY = 40): { parts: MechPart[]; depth: number } {
  const parts: MechPart[] = [];
  let x = x0;
  let z = z0;
  let rowDepth = 0;
  const gap = 8;
  const sorted = list.slice().sort((a, b) => b.item.size[2] - a.item.size[2]);
  for (const inst of sorted) {
    const [w, h, d] = inst.item.size;
    if (x + w > x0 + width && x > x0) {
      x = x0;
      z += rowDepth + gap;
      rowDepth = 0;
    }
    parts.push(
      box(`e-${inst.key}`, `${inst.designator} ${shortName(inst.item)}`, [w, h, d], [x + w / 2, y + h / 2, z + d / 2], inst.item.color, false, {
        bomId: inst.item.id,
        material: "Electronics",
        explode: [0, explodeY, 0],
      }),
    );
    x += w + gap;
    rowDepth = Math.max(rowDepth, d);
  }
  return { parts, depth: z + rowDepth - z0 };
}

function footprint(list: Inst[], width: number): number {
  const area = list.reduce((s, i) => s + (i.item.size[0] + 8) * (i.item.size[2] + 8), 0);
  return Math.max(60, Math.ceil(area / width) + 40);
}

function buildMech(plan: Plan, insts: Inst[], mainSupply?: Inst): MechPart[] {
  const parts: MechPart[] = [];
  const isBoard = (i: Inst) => !["Actuator"].includes(i.item.group) && !["anemometer", "solar-kit", "psu-24v", "camera-ov2640"].includes(i.item.id) && i.item.id !== "usb-cable";
  const electronics = insts.filter(isBoard);
  const servos = insts.filter((i) => i.item.drivenBy === "pca9685");
  const motors = insts.filter((i) => i.item.drivenBy === "motor-driver");
  const steppers = insts.filter((i) => i.item.drivenBy === "stepper-driver");

  const controlBox = (cx: number, cz: number, list: Inst[], width = 170) => {
    const depth = footprint(list, width);
    const h = Math.max(...list.map((i) => i.item.size[1]), 20) + 22;
    parts.push(box("enc-base", "Electronics Tray", [width + 16, 4, depth + 16], [cx, 2, cz], "#cbd5e1", true, { explode: [0, -10, 0] }));
    parts.push(
      box("enc-shell", "Enclosure Shell", [width + 16, h, depth + 16], [cx, 4 + h / 2, cz], "#94a3b8", true, { opacity: 0.18, explode: [0, h + 60, 0] }),
    );
    const placed = placeModules(list, cx - width / 2, cz - depth / 2 + 12, width, 4, 30);
    parts.push(...placed.parts);
  };

  switch (plan.archetype) {
    case "robotic-arm": {
      parts.push(cyl("arm-base", "Base Housing", 70, 40, [0, 20, 0], "#e2e8f0", true, { explode: [0, -30, 0] }));
      parts.push(cyl("arm-turntable", "Turntable", 55, 12, [0, 46, 0], "#38bdf8", true, { explode: [0, 10, 0] }));
      parts.push(box("arm-shoulder", "Shoulder Bracket", [60, 50, 46], [0, 77, 0], "#e2e8f0", true, { explode: [0, 25, 0] }));
      parts.push(box("arm-upper", "Upper Arm Link", [32, 150, 22], [0, 177, 0], "#38bdf8", true, { explode: [0, 45, 0] }));
      parts.push(box("arm-elbow", "Elbow Bracket", [50, 40, 40], [0, 270, 0], "#e2e8f0", true, { explode: [0, 65, 0] }));
      parts.push(box("arm-fore", "Forearm Link", [28, 120, 20], [0, 350, 0], "#38bdf8", true, { explode: [0, 85, 0] }));
      parts.push(box("arm-wrist", "Wrist Block", [40, 30, 34], [0, 425, 0], "#e2e8f0", true, { explode: [0, 100, 0] }));
      parts.push(box("arm-palm", "Gripper Palm", [60, 14, 30], [0, 447, 0], "#38bdf8", true, { explode: [0, 115, 0] }));
      parts.push(box("arm-finger-l", "Gripper Finger (L)", [8, 50, 16], [-22, 479, 0], "#f472b6", true, { explode: [-20, 125, 0] }));
      parts.push(box("arm-finger-r", "Gripper Finger (R)", [8, 50, 16], [22, 479, 0], "#f472b6", true, { explode: [20, 125, 0] }));
      const joints: [number, number, number][] = [
        [0, 22, 45],
        [36, 77, 0],
        [32, 270, 0],
        [26, 425, 0],
        [0, 447, 20],
        [12, 460, 0],
      ];
      servos.forEach((s, i) => {
        const j = joints[i] ?? [0, 100 + i * 30, 50];
        parts.push(
          box(`e-${s.key}`, `${s.designator} ${shortName(s.item)} (joint ${i + 1})`, s.item.size, j, s.item.color, false, {
            bomId: s.item.id,
            material: "Electronics",
            explode: [40, 20 + i * 20, 0],
          }),
        );
      });
      controlBox(0, -190, electronics.filter((i) => i.item.group !== "Actuator"));
      break;
    }
    case "rover": {
      const L = 200;
      const W = 130;
      parts.push(box("rv-lower", "Lower Deck", [L, 4, W], [0, 42, 0], "#38bdf8", true, { explode: [0, 0, 0] }));
      parts.push(box("rv-upper", "Upper Deck", [L, 4, W], [0, 96, 0], "#38bdf8", true, { explode: [0, 70, 0] }));
      [
        [-L / 2 + 8, -W / 2 + 8],
        [L / 2 - 8, -W / 2 + 8],
        [-L / 2 + 8, W / 2 - 8],
        [L / 2 - 8, W / 2 - 8],
      ].forEach(([x, z], i) => parts.push(cyl(`rv-standoff-${i}`, "M3 Standoff 50 mm", 3, 50, [x, 69, z], "#d4d4d8", false, { explode: [0, 35, 0] })));
      const wheelPos: [number, number][] = motors.length >= 4 ? [[-62, -1], [62, -1], [-62, 1], [62, 1]] : [[0, -1], [0, 1]];
      motors.forEach((m, i) => {
        const [x, side] = wheelPos[i % wheelPos.length];
        parts.push(
          box(`e-${m.key}`, `${m.designator} Gear Motor`, [70, 22, 19], [x, 28, side * (W / 2 - 14)], m.item.color, false, {
            bomId: m.item.id,
            material: "Electronics",
            explode: [0, -20, side * 30],
          }),
        );
        parts.push(
          cyl(`rv-wheel-${i}`, "Wheel 65 mm", 33, 26, [x, 33, side * (W / 2 + 18)], "#18181b", false, {
            rotation: [Math.PI / 2, 0, 0],
            bomId: m.item.id,
            explode: [0, 0, side * 60],
          }),
        );
      });
      if (motors.length < 4) parts.push(cyl("rv-caster", "Ball Caster", 12, 20, [-L / 2 + 20, 18, 0], "#a1a1aa", false, { explode: [0, -30, 0] }));
      const top = electronics.filter((i) => i.item.group !== "Power" && i.item.id !== "hcsr04");
      const bottom = electronics.filter((i) => i.item.group === "Power");
      parts.push(...placeModules(top, -L / 2 + 12, -W / 2 + 12, L - 24, 98, 90).parts);
      parts.push(...placeModules(bottom, -L / 2 + 30, -W / 2 + 20, L - 60, 44, 20).parts);
      const sonar = insts.find((i) => i.item.id === "hcsr04");
      if (sonar) {
        parts.push(box("rv-sonar-bracket", "Sensor Bracket", [8, 30, 50], [L / 2 + 4, 113, 0], "#f472b6", true, { explode: [30, 70, 0] }));
        parts.push(box(`e-${sonar.key}`, `${sonar.designator} Ultrasonic`, [15, 20, 45], [L / 2 + 14, 118, 0], sonar.item.color, false, { bomId: sonar.item.id, material: "Electronics", explode: [50, 70, 0] }));
      }
      const pan = servos[0];
      if (pan) parts.push(box(`e-${pan.key}`, `${pan.designator} Pan Servo`, [23, 22, 12], [L / 2 - 20, 109, 0], pan.item.color, false, { bomId: pan.item.id, material: "Electronics", explode: [20, 80, 0] }));
      break;
    }
    case "weather-station": {
      parts.push(cyl("ws-mast", "Mast (25 mm PVC pipe)", 13, 700, [0, 350, 0], "#f8fafc", false, { explode: [0, 0, 0] }));
      parts.push(cyl("ws-foot", "Ground Spike Adapter", 30, 30, [0, 15, 0], "#e2e8f0", true, { explode: [0, -30, 0] }));
      parts.push(box("ws-clamp", "Enclosure Pipe Clamp", [40, 60, 30], [0, 260, 28], "#38bdf8", true, { explode: [0, 0, 30] }));
      const inside = electronics.filter((i) => !["rain-sensor", "bme280", "dht22", "ldr"].includes(i.item.id));
      const encW = 170;
      const encD = footprint(inside, encW);
      parts.push(box("ws-box", "IP65 Electronics Enclosure", [encW + 16, 90, encD + 16], [0, 260, 50 + encD / 2], "#cbd5e1", false, { opacity: 0.25, explode: [0, 0, 120] }));
      parts.push(...placeModules(inside, -encW / 2, 58, encW, 222, 0).parts.map((p) => ({ ...p, explode: [0, 0, 170] as [number, number, number] })));
      for (let i = 0; i < 6; i++) parts.push(cyl(`ws-shield-${i}`, `Radiation Shield Plate ${i + 1}`, 55, 4, [130, 420 + i * 16, 0], "#f8fafc", true, { size: [55, 4, 40], explode: [60, i * 12, 0] }));
      parts.push(box("ws-shield-arm", "Shield Arm", [110, 10, 20], [65, 418, 0], "#38bdf8", true, { explode: [30, 0, 0] }));
      const climate = insts.find((i) => ["bme280", "dht22"].includes(i.item.id));
      if (climate) parts.push(box(`e-${climate.key}`, `${climate.designator} ${shortName(climate.item)} (in shield)`, climate.item.size, [130, 450, 0], climate.item.color, false, { bomId: climate.item.id, material: "Electronics", explode: [60, 40, 0] }));
      const rain = insts.find((i) => i.item.id === "rain-sensor");
      if (rain) parts.push(box(`e-${rain.key}`, `${rain.designator} Rain Sensor`, rain.item.size, [-110, 520, 0], rain.item.color, false, { bomId: rain.item.id, rotation: [0, 0, 0.35], material: "Electronics", explode: [-60, 0, 0] }));
      if (rain) parts.push(box("ws-rain-arm", "Rain Sensor Arm", [90, 8, 20], [-55, 512, 0], "#38bdf8", true, { explode: [-30, 0, 0] }));
      const ldr = insts.find((i) => i.item.id === "ldr");
      if (ldr) parts.push(box(`e-${ldr.key}`, `${ldr.designator} Light Sensor`, ldr.item.size, [0, 307, 50 + encD + 10], ldr.item.color, false, { bomId: ldr.item.id, material: "Electronics", explode: [0, 0, 160] }));
      const wind = insts.find((i) => i.item.id === "anemometer");
      if (wind) {
        parts.push(cyl(`e-${wind.key}`, `${wind.designator} Anemometer hub`, 25, 40, [0, 720, 0], "#e5e7eb", false, { bomId: wind.item.id, explode: [0, 60, 0] }));
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          parts.push(cyl(`ws-cup-${i}`, "Anemometer Cup", 18, 22, [Math.cos(a) * 70, 735, Math.sin(a) * 70], "#e5e7eb", false, { rotation: [0, 0, Math.PI / 2], bomId: wind.item.id, explode: [Math.cos(a) * 30, 60, Math.sin(a) * 30] }));
        }
      }
      if (mainSupply?.item.id === "solar-kit" || insts.some((i) => i.item.id === "solar-kit")) {
        parts.push(box("ws-solar", "Solar Panel 136×110", [136, 3, 110], [0, 600, -70], "#1e3a8a", false, { rotation: [-0.7, 0, 0], bomId: "solar-kit", explode: [0, 0, -60] }));
        parts.push(box("ws-solar-mount", "Solar Panel Tilt Mount", [40, 40, 30], [0, 590, -25], "#38bdf8", true, { explode: [0, 0, -30] }));
      }
      break;
    }
    case "cnc": {
      const S = 320;
      const ext = "#a1a1aa";
      parts.push(box("cnc-fx1", "2020 Extrusion (front)", [S, 20, 20], [0, 10, S / 2], ext, false, { explode: [0, 0, 40] }));
      parts.push(box("cnc-fx2", "2020 Extrusion (back)", [S, 20, 20], [0, 10, -S / 2], ext, false, { explode: [0, 0, -40] }));
      parts.push(box("cnc-fz1", "2020 Extrusion (left)", [20, 20, S - 20], [-S / 2 + 10, 10, 0], ext, false, { explode: [-40, 0, 0] }));
      parts.push(box("cnc-fz2", "2020 Extrusion (right)", [20, 20, S - 20], [S / 2 - 10, 10, 0], ext, false, { explode: [40, 0, 0] }));
      parts.push(box("cnc-up1", "Gantry Upright (L)", [20, 220, 60], [-S / 2 + 10, 130, 0], "#38bdf8", true, { explode: [-60, 40, 0] }));
      parts.push(box("cnc-up2", "Gantry Upright (R)", [20, 220, 60], [S / 2 - 10, 130, 0], "#38bdf8", true, { explode: [60, 40, 0] }));
      parts.push(box("cnc-beam", "Gantry Beam (2040)", [S, 40, 20], [0, 220, 0], ext, false, { explode: [0, 80, 0] }));
      parts.push(box("cnc-bed", "MDF Spoilboard", [S - 60, 12, S - 60], [0, 36, 0], "#d6b38a", false, { explode: [0, -20, 0] }));
      parts.push(cyl("cnc-screw-x", "T8 Lead Screw (X)", 4, S - 40, [0, 190, 22], "#d4d4d8", false, { rotation: [0, 0, Math.PI / 2], explode: [0, 80, 40] }));
      parts.push(cyl("cnc-screw-y", "T8 Lead Screw (Y)", 4, S - 40, [0, 24, -40], "#d4d4d8", false, { rotation: [Math.PI / 2, 0, 0], explode: [0, -30, 0] }));
      parts.push(box("cnc-carriage", "Z Carriage Plate", [70, 90, 10], [0, 200, 20], "#38bdf8", true, { explode: [0, 90, 60] }));
      parts.push(cyl("cnc-spindle", "775 DC Spindle Motor", 22, 90, [0, 140, 45], "#e5e7eb", false, { explode: [0, 60, 90] }));
      const motorSpots: [number, number, number][] = [
        [S / 2 + 21, 190, 22],
        [0, 24, -S / 2 - 21],
        [0, 265, 45],
      ];
      steppers.forEach((m, i) => {
        parts.push(box(`e-${m.key}`, `${m.designator} ${["X", "Y", "Z"][i] ?? i + 1}-Axis Stepper`, [42, 42, 40], motorSpots[i] ?? [0, 300, 0], m.item.color, false, { bomId: m.item.id, material: "Electronics", explode: [0, 40, 0] }));
        parts.push(box(`cnc-mount-${i}`, `${["X", "Y", "Z"][i] ?? i + 1}-Axis Stepper Mount`, [50, 50, 6], (motorSpots[i] ?? [0, 300, 0]).map((v, k) => (k === 2 && i === 1 ? v + 23 : v)) as [number, number, number], "#f472b6", true, { explode: [0, 20, 0] }));
      });
      controlBox(S / 2 + 140, 0, electronics.filter((i) => i.item.group !== "Actuator" && i.item.id !== "psu-24v"));
      break;
    }
    case "plant-care": {
      parts.push(cyl("pc-pot", "Planter Pot", 75, 130, [0, 65, 0], "#d97706", true, { size: [75, 130, 58], explode: [0, 0, 0] }));
      parts.push(cyl("pc-soil", "Soil", 70, 6, [0, 124, 0], "#713f12", false, { material: "—", explode: [0, 0, 0] }));
      parts.push(box("pc-tank", "Water Reservoir (1 L)", [120, 140, 110], [170, 70, 0], "#bae6fd", false, { opacity: 0.45, explode: [60, 0, 0] }));
      parts.push(cyl("pc-tube", "Silicone Tube", 4, 140, [90, 150, 0], "#f8fafc", false, { rotation: [0, 0, Math.PI / 2], explode: [30, 30, 0] }));
      parts.push(box("pc-drip", "Drip Ring Holder", [30, 10, 20], [20, 140, 0], "#38bdf8", true, { explode: [0, 30, 0] }));
      const soil = insts.find((i) => i.item.id === "soil-moisture");
      if (soil) parts.push(box(`e-${soil.key}`, `${soil.designator} Soil Probe`, [22, 98, 3], [-30, 110, 0], soil.item.color, false, { bomId: soil.item.id, material: "Electronics", explode: [-40, 60, 0] }));
      const pump = insts.find((i) => i.item.id === "water-pump");
      if (pump) parts.push(box(`e-${pump.key}`, `${pump.designator} Pump (submerged)`, pump.item.size, [170, 20, 0], pump.item.color, false, { bomId: pump.item.id, material: "Electronics", explode: [60, -20, 0] }));
      const rest = electronics.filter((i) => !["soil-moisture"].includes(i.item.id));
      const w = 120;
      const d = footprint(rest, w);
      parts.push(box("pc-lid", "Reservoir Lid / Electronics Bay", [w + 10, 6, Math.max(110, d)], [170, 143, 0], "#38bdf8", true, { explode: [60, 40, 0] }));
      parts.push(...placeModules(rest, 170 - w / 2, -Math.max(110, d) / 2 + 6, w, 146, 80).parts);
      break;
    }
    case "wearable": {
      parts.push(box("wr-strap-a", "Strap Half A (TPU)", [26, 3, 90], [0, 1.5, 70], "#334155", true, { material: "TPU", explode: [0, 0, 30] }));
      parts.push(box("wr-strap-b", "Strap Half B (TPU)", [26, 3, 90], [0, 1.5, -70], "#334155", true, { material: "TPU", explode: [0, 0, -30] }));
      const w = 50;
      const d = footprint(electronics, w);
      parts.push(box("wr-case", "Wearable Case", [w + 10, 24, d], [0, 14, 0], "#38bdf8", true, { opacity: 0.3, explode: [0, 50, 0] }));
      parts.push(...placeModules(electronics, -w / 2, -d / 2 + 4, w, 3, 30).parts);
      break;
    }
    default: {
      const others = electronics;
      controlBox(0, 0, others, 190);
      const outside = insts.filter((i) => !isBoard(i) && i.item.id !== "usb-cable");
      outside.forEach((o, k) => {
        parts.push(box(`e-${o.key}`, `${o.designator} ${shortName(o.item)}`, o.item.size, [150 + (k % 3) * 60, o.item.size[1] / 2, -60 + Math.floor(k / 3) * 60], o.item.color, false, { bomId: o.item.id, material: "Electronics", explode: [40, 0, 0] }));
      });
    }
  }
  return parts;
}

function printedCost(p: MechPart): { grams: number; price: number } {
  const [a, b, c] = p.size;
  const solid = p.shape === "box" ? a * b * c : Math.PI * ((a + c) / 2) ** 2 * b;
  const area = p.shape === "box" ? 2 * (a * b + b * c + a * c) : 2 * Math.PI * ((a + c) / 2) * b + 2 * Math.PI * ((a + c) / 2) ** 2;
  const mm3 = Math.min(solid * 0.35, area * 2.4);
  const grams = Math.max(3, Math.round((mm3 / 1000) * 1.24));
  return { grams, price: Math.max(0.5, round2(grams * 0.025)) };
}

// ───────────────────────── BOM ─────────────────────────

function bomLine(
  id: string,
  designator: string,
  name: string,
  category: BomItem["category"],
  group: BomGroup,
  qty: number,
  unitPrice: number,
  specs: string,
  sourcing = searchLinksForName(name),
  role?: string,
): BomItem {
  return { id, designator, name, category, group, qty, unitPrice: round2(unitPrice), specs, sourcing, role };
}

function buildBom(plan: Plan, insts: Inst[], mech: MechPart[], ctrl: ControllerSpec): BomItem[] {
  const items: BomItem[] = [];
  const byItem = new Map<string, Inst[]>();
  for (const i of insts) byItem.set(i.item.id, [...(byItem.get(i.item.id) ?? []), i]);
  for (const [id, list] of byItem) {
    const item = list[0].item;
    const designators = list.map((l) => l.designator);
    const desig = designators.length > 2 ? `${designators[0]}–${designators[designators.length - 1]}` : designators.join(", ");
    items.push(
      bomLine(id, desig, item.name, item.category, item.group, list.length, item.price, item.specs, sourcingFor(item), [...new Set(list.map((l) => l.role).filter(Boolean))].join(" / ") || undefined),
    );
  }
  for (const c of plan.customParts) {
    items.push(bomLine(`custom-${slug(c.name)}`, "X", c.name, c.category, c.group, Math.max(1, Math.round(c.qty)), c.unitPrice, c.specs));
  }

  // Purchased structural parts that appear in the model
  const structural: Record<string, [string, BomGroup, number, string]> = {
    "Mast (25 mm PVC pipe)": ["25 mm PVC Pipe (0.7 m)", "Structural", 4, "Schedule 40, UV-stable paint recommended"],
    "IP65 Electronics Enclosure": ["IP65 ABS Junction Box", "Structural", 9, "With cable glands"],
    "M3 Standoff 50 mm": ["M3 × 50 mm Brass Standoff", "Mechanism", 0.4, "Male-female"],
    "Ball Caster": ["Ball Caster Wheel", "Mechanism", 2, "Metal ball, 12 mm"],
    "MDF Spoilboard": ["MDF Spoilboard 260 × 260 × 12 mm", "Structural", 6, "Replaceable sacrificial bed"],
    "Water Reservoir (1 L)": ["1 L Food-safe Reservoir", "Structural", 3, "PP container"],
    "Silicone Tube": ["Silicone Tube 6 mm × 1 m", "Mechanism", 2, "Food-grade"],
    "775 DC Spindle Motor": ["775 DC Spindle Motor 12–24 V + ER11 Collet", "Mechanism", 18, "~10 000 RPM"],
  };
  const extrusions = mech.filter((m) => m.name.startsWith("2020 Extrusion") || m.name.startsWith("Gantry Beam"));
  if (extrusions.length) items.push(bomLine("ext-2020", "X", "2020 V-Slot Aluminium Extrusion (cut to length)", "Mechanical", "Structural", extrusions.length, 6.5, "300–340 mm lengths, with T-nuts"));
  const screws = mech.filter((m) => m.name.startsWith("T8 Lead Screw"));
  if (screws.length) items.push(bomLine("t8", "X", "T8 Lead Screw 300 mm + Brass Nut", "Mechanical", "Mechanism", screws.length, 7, "8 mm lead, with 5×8 mm coupler"));
  const counts = new Map<string, number>();
  for (const m of mech) if (structural[m.name]) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  for (const [name, qty] of counts) {
    const [label, group, price, specs] = structural[name];
    items.push(bomLine(`mech-${slug(label)}`, "X", label, "Mechanical", group, qty, price, specs));
  }

  // 3D printed parts
  for (const p of mech.filter((m) => m.printed)) {
    const { grams, price } = printedCost(p);
    items.push({
      id: `print-${p.id}`,
      designator: "P",
      name: p.name,
      category: "Mechanical",
      group: "3D Print",
      qty: 1,
      unitPrice: price,
      specs: `${p.material}, ~${grams} g, 0.2 mm layers, 25 % infill`,
      sourcing: [{ vendor: "Print it yourself", url: "#mech" }, { vendor: "Craftcloud (print service)", url: "https://craftcloud3d.com/" }],
    });
  }

  // Consumables
  const wires = Math.max(10, insts.reduce((s, i) => s + i.item.pins.length, 0));
  items.push(bomLine("jumpers", "X", "Dupont Jumper Wire Kit (M-M / M-F / F-F)", "Electrical", "Passive", 1, wires > 40 ? 7 : 5, `${wires}+ connections in this design`));
  if (ctrl.id !== "arduino-uno") items.push(bomLine("perfboard", "X", "Double-sided Perfboard 70 × 90 mm + Header Strips", "Electrical", "Passive", 1, 3, "For a permanent build; a breadboard works for prototyping"));
  items.push(bomLine("screws", "X", "M3 Socket Head Screw + Nut Assortment", "Mechanical", "Misc", 1, 6, "M3 × 6/8/12/16 mm, heat-set inserts optional"));
  items.push(bomLine("heatshrink", "X", "Heat-shrink Tubing Assortment", "Electrical", "Passive", 1, 3, "2–6 mm"));
  return items;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ───────────────────────── Assembly guide ─────────────────────────

function buildSteps(
  plan: Plan,
  insts: Inst[],
  mcu: Inst,
  ctrl: ControllerSpec,
  wiring: Wiring,
  mech: MechPart[],
  bom: BomItem[],
  warnings: string[],
): AssemblyStep[] {
  const steps: Omit<AssemblyStep, "n">[] = [];
  const blockName = new Map(wiring.blocks.map((b) => [b.id, b.label]));
  const describe = (c: Connection) => `${blockName.get(c.from.block)} ${c.from.pin} → ${blockName.get(c.to.block)} ${c.to.pin}${c.note ? ` (${c.note})` : ""}`;
  const printed = mech.filter((m) => m.printed);

  steps.push({
    title: "Gather parts and tools",
    body: `Lay out every item from the Parts tab (${bom.reduce((s, b) => s + b.qty, 0)} pieces). Check each module powers up on its own before it goes into the build — it's much easier to swap a dead part now.`,
    parts: bom.filter((b) => b.group !== "3D Print").map((b) => `${b.qty}× ${b.name}`),
    tools: ["Soldering iron + solder", "Wire stripper", "Small screwdriver set", "Multimeter", "Hex keys (M3)", ...(printed.length ? ["3D printer (or print service)"] : [])],
  });

  if (printed.length) {
    steps.push({
      title: "Print the custom parts",
      body: `Export the STL files from the Mech tab and print ${printed.length} part${printed.length > 1 ? "s" : ""} in PLA (PETG for anything outdoors or near water). Use 0.2 mm layers, 3 walls and 25 % infill; load-bearing links benefit from 40 %. Orient flat faces down to avoid supports.`,
      parts: printed.map((p) => p.name),
      tools: ["3D printer", "Flush cutters", "Deburring tool"],
    });
  }

  const buck = insts.find((i) => i.item.id === "buck-lm2596");
  if (buck) {
    steps.push({
      title: "Set the buck converter voltage",
      body: "Connect the main supply to the LM2596 input only. With a multimeter on OUT+/OUT-, turn the brass trim screw until the output reads 5.0 V (servo-heavy builds can use 5.5–6.0 V for a separate servo rail). Do this before anything else is connected.",
      parts: [buck.item.name],
      tools: ["Multimeter", "Small flat screwdriver"],
      warning: "Never connect the controller before setting the output — the module ships at an unknown voltage and can destroy a 5 V board.",
    });
  }

  steps.push(...mechanicalSteps(plan, mech));

  steps.push({
    title: `Mount the ${shortName(mcu.item)} and modules`,
    body: `Fix the controller and modules to the electronics tray with M3 screws or standoffs, keeping the USB port reachable for programming. Group power parts on one side and sensors near where they need to sense.`,
    parts: insts.filter((i) => i.item.group !== "Actuator").map((i) => `${i.designator} ${shortName(i.item)}`),
    tools: ["M3 screws", "Standoffs", "Double-sided foam tape"],
  });

  const power = wiring.connections.filter((c) => c.kind === "power" || c.kind === "ground");
  steps.push({
    title: "Wire power and ground",
    body: `Run the power rails first using red for positive and black for ground. Tie every ground together at a single point near the controller.\n\n${power.map((c) => "• " + describe(c)).join("\n")}`,
    parts: ["Red / black hookup wire (22 AWG, 18 AWG for motors)"],
    tools: ["Wire stripper", "Multimeter (continuity)"],
    warning: "Check for shorts between every positive rail and GND with the multimeter before applying power.",
  });

  const drivers = insts.filter((i) => i.item.driverKind);
  for (const d of drivers) {
    const own = wiring.connections.filter((c) => (c.from.block === d.key || c.to.block === d.key) && c.kind !== "ground" && c.kind !== "power");
    if (!own.length) continue;
    steps.push({
      title: `Wire the ${shortName(d.item)} (${d.designator})`,
      body: own.map((c) => "• " + describe(c)).join("\n"),
      parts: [d.item.name, ...insts.filter((i) => i.driver === d).map((i) => `${i.designator} ${shortName(i.item)}`)],
      tools: ["Jumper wires", "Screwdriver for terminal blocks"],
      warning: d.item.driverKind === "stepper-driver" ? "Set the A4988 current limit (Vref ≈ 0.68 V for a 1.7 A motor) before running the motor, and never unplug a motor while powered." : undefined,
    });
  }

  const signalDevices = insts.filter((i) => i !== mcu && !i.item.driverKind && !i.driver && i.item.group !== "Power");
  if (signalDevices.length) {
    const sigs = wiring.connections.filter((c) => c.kind === "signal" && c.from.block === mcu.key && signalDevices.some((d) => d.key === c.to.block));
    steps.push({
      title: "Connect sensors and peripherals",
      body: `Connect each module's signal lines to the controller. I²C devices share the same SDA/SCL pair.\n\n${sigs.map((c) => "• " + describe(c)).join("\n")}`,
      parts: signalDevices.map((d) => `${d.designator} ${shortName(d.item)}`),
      tools: ["Jumper wires"],
      warning: ctrl.logic === "3V3" ? "This controller uses 3.3 V logic: never feed a 5 V signal straight into a GPIO." : undefined,
    });
  }

  steps.push({
    title: "Flash the firmware",
    body: `Open the Code tab and download the sketch. In the Arduino IDE select ${ctrl.catalog.name} (${ctrl.board}), install the libraries listed at the top of the file through the Library Manager, then upload over USB. Open the Serial Monitor at 115200 baud to see live readings.`,
    parts: [ctrl.catalog.name, "USB cable"],
    tools: ["Computer with Arduino IDE 2.x"],
  });

  steps.push({
    title: "Power up, test and calibrate",
    body: [
      "Apply power with actuators disconnected first and confirm each sensor reports sensible values.",
      insts.some((i) => i.item.drivenBy === "pca9685") ? "Centre every servo at 90° before attaching horns so each joint starts at mid-travel." : "",
      insts.some((i) => i.item.id === "soil-moisture") ? "Calibrate the soil sensor: note the reading in dry air and in a glass of water, then set the threshold between them." : "",
      insts.some((i) => i.item.drivenBy === "motor-driver") ? "Lift the wheels off the ground and check every motor spins the right way; swap a motor's leads if not." : "",
      insts.some((i) => i.item.drivenBy === "stepper-driver") ? "Home each axis against its limit switch and measure steps/mm with a ruler before cutting." : "",
      "Then reconnect actuators one at a time.",
    ]
      .filter(Boolean)
      .join(" "),
    parts: [],
    tools: ["Multimeter", "Serial Monitor"],
    warning: warnings[0],
  });

  steps.push({
    title: "Close up and tidy",
    body: "Bundle cables with zip ties, add strain relief where wires leave the enclosure and fit the cover. Label the power input with its voltage.",
    parts: ["Zip ties", "Cable glands"],
    tools: ["Flush cutters"],
  });

  return steps.map((s, i) => ({ ...s, n: i + 1 }));
}

function mechanicalSteps(plan: Plan, mech: MechPart[]): Omit<AssemblyStep, "n">[] {
  const names = (pred: (m: MechPart) => boolean) => mech.filter(pred).map((m) => m.name);
  switch (plan.archetype) {
    case "robotic-arm":
      return [
        {
          title: "Build the base and turntable",
          body: "Mount the base servo inside the base housing with its spline facing up, then press the turntable onto the servo horn and secure with the horn screw. Check it turns freely through 180°.",
          parts: names((m) => /Base|Turntable/.test(m.name)),
          tools: ["M3 screws", "Servo horn screws"],
        },
        {
          title: "Assemble the arm links",
          body: "Bolt the shoulder bracket to the turntable, fit the shoulder servo, then attach the upper arm, elbow bracket and forearm in order. Centre each servo at 90° before fixing its horn.",
          parts: names((m) => /Shoulder|Upper|Elbow|Fore|Wrist/.test(m.name)),
          tools: ["M3 screws + nuts", "Hex key"],
          warning: "Keep fingers clear of the joints once servos are powered — MG996Rs are strong enough to pinch.",
        },
        {
          title: "Fit the gripper",
          body: "Attach the gripper palm to the wrist, install the gripper servo and link both fingers so they close symmetrically.",
          parts: names((m) => /Gripper/.test(m.name)),
          tools: ["M2/M3 screws"],
        },
      ];
    case "rover":
      return [
        {
          title: "Assemble the chassis",
          body: "Mount the gear motors under the lower deck with M3 screws, press the wheels on, then fit the four standoffs and the upper deck.",
          parts: names((m) => /Deck|Standoff|Wheel|Caster/.test(m.name)),
          tools: ["M3 screws", "Screwdriver"],
        },
      ];
    case "weather-station":
      return [
        {
          title: "Raise the mast and shield",
          body: "Push the mast into the ground spike adapter, stack the radiation-shield plates with spacers and mount them on the arm so the climate sensor sits in shade with free airflow.",
          parts: names((m) => /Mast|Spike|Shield/.test(m.name)),
          tools: ["M3 threaded rod", "Spacers"],
        },
        {
          title: "Mount the enclosure and outdoor sensors",
          body: "Clamp the IP65 enclosure to the mast at chest height, fit the rain-sensor arm angled ~20° so water runs off, and fix the anemometer at the very top.",
          parts: names((m) => /Enclosure|Rain|Anemometer|Solar|Clamp/.test(m.name)),
          tools: ["Hose clamps", "Silicone sealant"],
          warning: "Route every cable through a gland with a drip loop below it so water can't follow the wire into the box.",
        },
      ];
    case "cnc":
      return [
        {
          title: "Build the frame",
          body: "Square the four base extrusions with corner brackets (measure both diagonals — they must match), bolt on the gantry uprights and beam, then fit the spoilboard.",
          parts: names((m) => /Extrusion|Upright|Beam|Spoilboard/.test(m.name)),
          tools: ["Hex keys", "Engineer's square", "T-nuts"],
        },
        {
          title: "Install motion system",
          body: "Fit the stepper mounts, couple each lead screw to its motor with a flexible coupler, and attach the Z carriage and spindle.",
          parts: names((m) => /Screw|Mount|Carriage|Spindle/.test(m.name)),
          tools: ["Hex keys", "Couplers"],
        },
      ];
    case "plant-care":
      return [
        {
          title: "Prepare the planter and reservoir",
          body: "Drop the pump into the reservoir, run the silicone tube to the drip ring on the pot and push the soil probe in up to its line.",
          parts: names((m) => /Pot|Reservoir|Tube|Drip/.test(m.name)),
          tools: ["Scissors"],
          warning: "Keep all electronics above the water line and seal the soil probe's top edge with nail varnish or hot glue.",
        },
      ];
    default:
      return [
        {
          title: "Prepare the enclosure",
          body: "Clean up the printed tray and shell, drill or cut openings for sensors, buttons and the power lead, and press in heat-set inserts if you use them.",
          parts: names((m) => /Tray|Shell|Case|Strap/.test(m.name)),
          tools: ["Drill", "Heat-set insert tip"],
        },
      ];
  }
}
