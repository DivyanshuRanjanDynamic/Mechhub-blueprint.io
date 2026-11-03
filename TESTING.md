# Testing MechHub Blueprint like a real user

## Automated runs

| Command | What it proves | Needs |
| --- | --- | --- |
| `npm test` | The engine builds a consistent blueprint for 9 kinds of project on all 4 boards (no unassigned or duplicate pins, no dangling wires, firmware present) | nothing |
| `npm run e2e:mock-groq` | The full user journey through the **Groq** backend, using a local mock of `api.groq.com`. The mock answers with prose first, string numbers and a made-up part ID, to prove the retry and clean-up work | nothing |
| `npm run e2e -- --provider offline` | The full user journey with the offline planner. Content checks are strict here | nothing |
| `npm run e2e -- --provider groq` | The full user journey against the **real Groq API** | `GROQ_API_KEY` |
| `npm run e2e -- --provider claude` | The same journey against Claude | `ANTHROPIC_API_KEY` (billed) |
| `npm run e2e -- --url http://localhost:8787` | Runs the journey against a server that is already running | a running server |

Each e2e run starts its own server on port 8899 with an empty, temporary data folder. It writes the files a user would download to `test-output/<provider>/`: `bom.csv`, `firmware.ino`, `model.step` and `blueprint.json`.

Some checks are **structural**: every part has a buy link, every wire connects to a real component, no pin is used twice, and the STEP file is well-formed. A failed structural check always fails the run. Other checks are about **content**, such as "it picked a rain sensor". With an AI planner these only produce a warning, because the model may reasonably choose different parts. With the offline planner they fail the run.

## The scripted user journey

**User:** Aarav, a first-time maker who has never wired a microcontroller.

| # | The user does | The app should |
| --- | --- | --- |
| 0 | Opens the app | Show which planner is active in the header (`Groq planner · openai/gpt-oss-120b`, `Claude planner · …` or `Offline planner`) |
| 1 | Types *"I want a smart weather station for my balcony that shows the temperature on a small screen and tells me when it starts raining"* with **Ask me clarifying questions first** switched on | Open a project and ask 2–4 multiple-choice questions, covering at least budget and microcontroller |
| 2 | Picks *display readings*, **$40–$100**, **ESP32**, **Battery**, and types *"It will be mounted on a balcony railing outside, about 5 m from my Wi-Fi router."* | Produce v1, about 20–25 parts for roughly $75–100: ESP32, a temperature sensor (BME280 or DHT22), a rain sensor, an OLED, a 2S battery and a buck converter |
| 3 | Opens **Parts** | Show Electrical and Mechanical groups with subtotals, Amazon/AliExpress/DigiKey links on every bought part, and costed 3D-print lines |
| 4 | Opens **Wiring** and clicks the ESP32 | Show I²C devices sharing GPIO21/22 and analog sensors on the ADC1 pins (GPIO34–39). Everything not connected to the clicked block fades out |
| 5 | Opens **3D CAD**, drags **Explode**, clicks the enclosure | Show the mast, radiation shield, enclosure and sensors. The selected part shows its size and material, with a "Download this part (STL)" button |
| 6 | Clicks **STL**, **STEP** and **GLB** | Download `smart-weather-station.stl/.step/.glb`. The STEP file opens in FreeCAD as separate solids |
| 7 | Types *"Add a buzzer so it beeps when rain starts"* | Update to v2. The buzzer appears in Parts, is wired to a free GPIO, and is driven in the Code tab |
| 8 | Clicks the **Make it cheaper** chip | Update to v3 at the same cost or less (for example, BME280 swapped for DHT22), and explain what was traded away |
| 9 | Opens **Guide** and ticks steps | Show ordered steps (set the buck voltage first, wire power, then sensors, flash, test). Progress is kept after a reload |
| 10 | Opens **Code** → **Download .ino** | Give an Arduino sketch with a pin map that matches the Wiring tab and a list of the required libraries |
| 11 | Goes back to **Projects** | Show the project card with its part count, cost and stars |

## More prompts to try by hand

| Prompt | Clarifying answers | Look for |
| --- | --- | --- |
| "Robotic arm that sorts LEGO bricks by colour" | $100–$250, Arduino Uno, Wall adapter | PCA9685 added automatically, a 12 V supply and LM2596, a stall-current warning, a 5-joint arm in 3D |
| "Obstacle-avoiding rover with GPS" | $40–$100, Arduino Uno, Battery | TB6612 for 4 motors, GPS on SoftwareSerial, A0 used as a digital pin when the Uno runs out of pins |
| "Mini CNC machine for engraving wood" | No limit, Arduino Uno | 3 × A4988 sharing one EN pin, a 12/24 V supply, a frame made of extrusions, a Vref warning in the Guide |
| "Self-watering plant pot" | Under $40, USB | Pump switched by a relay, soil-threshold logic in the firmware, reservoir and pot in 3D |
| "Motion-triggered security camera" | ESP32, USB | PIR, ESP32-CAM on UART, buzzer driven by the PIR |

## Using Groq for real

1. Create a key at <https://console.groq.com/keys>.
2. Copy `.env.example` to `.env` and set `GROQ_API_KEY=gsk_...`. If an Anthropic key is also present, set `MECHHUB_PROVIDER=groq` so Groq is used.
3. Run `npm run dev`. The header should read **Groq planner · openai/gpt-oss-120b**.
4. Run `npm run e2e -- --provider groq` and check the output for `blueprint was planned by groq`.

To change the model, set `GROQ_MODEL`, for example `llama-3.3-70b-versatile` or `moonshotai/kimi-k2-instruct-0905`. If Groq returns an error, or invalid JSON twice in a row, the server logs `[groq] design failed, using offline planner`. The user still gets a blueprint, but its `engine` is `offline`.
