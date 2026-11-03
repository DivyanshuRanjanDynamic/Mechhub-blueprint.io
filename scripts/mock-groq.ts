// A stand-in for api.groq.com used by `npm run e2e:mock-groq`. It speaks the OpenAI-compatible
// chat-completions protocol the Groq SDK uses and deliberately misbehaves the way small open
// models do (prose instead of JSON, string numbers, an invented part id) so the e2e run proves
// the Groq backend's normalisation and retry logic, without needing a real GROQ_API_KEY.
import http from "node:http";

type Msg = { role: string; content: string };

const basePlan = {
  title: "Balcony Weather Station",
  summary: "A battery-friendly ESP32 weather station that reads temperature, humidity and pressure, detects rain and shows readings on a small OLED.",
  tags: ["weather", "iot", "outdoor"],
  archetype: "weather-station",
  controller: "esp32-devkit",
  power: "battery",
  budget: "100",
  modules: [
    { catalogId: "bme280", qty: "1", role: "Climate sensing" },
    { catalogId: "rain-sensor", qty: 1, role: "Rain detection" },
    { catalogId: "oled-128x64", qty: 1, role: "Readout" },
    { catalogId: "rain-gauge-x9000", qty: 1, role: "Invented part the backend must drop" },
  ],
  customParts: [],
  notes: [],
};

export function startMockGroq(port: number): Promise<{ close: () => void; calls: () => number }> {
  let calls = 0;
  let designCalls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/openai/v1/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      calls++;
      const { messages, model } = JSON.parse(body) as { messages: Msg[]; model: string };
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      const isRetry = messages.length > 2;
      let content: string;
      if (user.includes("clarifying questions")) {
        content = JSON.stringify({
          reply: "Nice project! A few questions so the parts fit your balcony:",
          questions: [
            { id: "goal", text: "What matters most?", options: ["See readings on a display", "Rain alerts", "Log data to the cloud"] },
            { id: "budget", text: "Budget?", options: ["Under $40", "$40–$100", "No limit"] },
            { id: "controller", text: "Microcontroller?", options: ["ESP32 (Wi-Fi)", "Arduino Uno", "You choose"] },
            { id: "power", text: "Power?", options: ["USB", "Battery", "Solar"] },
          ],
        });
      } else {
        designCalls++;
        if (designCalls === 1 && !isRetry) {
          content = "Sure! Here is a great design for your weather station: it uses an ESP32..."; // not JSON → forces a retry
        } else {
          const current = user.match(/Current plan \(JSON\):\n([\s\S]*?)\n\nLatest user request/);
          const request = user.match(/Latest user request: "([^"]*)"/)?.[1] ?? "";
          const plan = current ? JSON.parse(current[1]) : structuredClone(basePlan);
          let reply = "Here's a compact balcony weather station built around an ESP32.";
          if (/buzzer|beep|alarm/i.test(request)) {
            plan.modules.push({ catalogId: "buzzer", qty: 1, role: "Rain alert" });
            reply = "Added an active buzzer that sounds when rain is detected.";
          }
          if (/cheap/i.test(request)) {
            plan.modules = plan.modules.map((m: { catalogId: string }) => (m.catalogId === "bme280" ? { ...m, catalogId: "dht22" } : m));
            reply = "Swapped the BME280 for a cheaper DHT22 (you lose the pressure reading).";
          }
          content = JSON.stringify({ reply, plan });
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `mock-${calls}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      );
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ close: () => server.close(), calls: () => calls })));
}
