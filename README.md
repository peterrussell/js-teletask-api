# js-teletask-api

A small, dependency-free Node.js library for **local control of TELETASK DoIP central
units** over TCP, speaking the official *DoIP Open Protocol* (TDS15132). Switch
relays/lights, dim dimmers, drive motors/blinds, read sensors and climate zones, and
subscribe to live state changes — the same wire protocol the TELETASK commissioning tools
and the TDS15132 SDK use. Everything is local to your network; there is no cloud.

A ready-to-use **Homebridge plugin** built on this library,
[`homebridge-teletask`](https://github.com/peterrussell/homebridge-teletask), bridges your
relays, dimmers, blinds and sensors into Apple HomeKit.

---

## ⚠️ Important: local control requires a TDS15132 licence

This library speaks the correct protocol, but a TELETASK central unit only *serves* the DoIP
Open Protocol once it is licensed for it. Verified byte-for-byte against the official
**TDS15132 DoIP API** spec and confirmed live against a PICOS unit:

- The control channel is **TCP port 55957**. The central unit **drops connections on 55957
  until a `TDS15132` (DoIP Open Protocol) licence is active** (the port opens for a 3-day
  trial after a config download, or permanently once a licence `.act` file is imported in
  PROSOFT).
- Port **55956** is a monitor/keep-alive-only socket: it accepts a connection and ACKs frames
  at the TCP level but **silently discards** real commands (GET/SET/subscribe). Don't use it
  for control.
- Port **55955** is PROSOFT's own SSH commissioning channel — not for third-party use.

So: the library + a `TDS15132` licence = working local control. Without the licence you can
connect but the unit won't act on commands. The licence is bound to the central unit's serial
number and is sold by TELETASK. (On an end-of-life unit, activating it also forces a firmware
upgrade — weigh that before proceeding.)

---

## Install

```bash
npm install js-teletask-api
```

Node.js **18+**. The library has **no required dependencies** (it uses only the Node built-ins
`net` and `events`). [`pino`](https://www.npmjs.com/package/pino) is an optional dependency: if
it's installed you get structured logging, otherwise logging falls back to `console`.

---

## Quick start

```js
import { TeletaskClient } from "js-teletask-api";

const client = new TeletaskClient({
  host: "192.168.1.113",
  port: 55957, // DoIP Open Protocol (default)
  devices: [
    { id: "hall",      type: "light", centralUnit: 1, number: 1, name: "Main Hall" },
    { id: "bedroom",   type: "light", centralUnit: 1, number: 2, name: "Hall Bedroom" },
    { id: "blind-1",   type: "blind", centralUnit: 1, number: 1, name: "Living Blind" },
    { id: "thermo-1",  type: "heating", centralUnit: 1, number: 1, name: "Living Zone" }
  ]
});

client.on("stateChanged", (state) => {
  console.log(state.deviceName ?? state.key, "->", state.normalized);
});

await client.connect(); // connects, starts keep-alive, subscribes to logged functions

await client.light("hall").on();      // turn Main Hall on
await client.light("hall").toggle();  // toggle it
await client.blind("blind-1").setPosition(50);
console.log(await client.getState("hall"));

await client.disconnect();
```

The client sends a keep-alive every ~4 minutes to hold the socket open, parses incoming frames,
and emits events as device state changes arrive.

---

## Configuring devices

Each device is `{ id, type, centralUnit, number, name? }`:

| Field | Meaning |
|-------|---------|
| `id` | your unique handle for the device |
| `type` | `light`, `switch`, `fan`, `outlet`, `dimmer`, `blind`/`cover`, `heating`/`thermostat`/`sensor` |
| `centralUnit` | central unit index (1 = unit "A", 2 = "B"…); use `0` for flags/global |
| `number` | the output/function number from PROSOFT (GUISOFT "Define Output") |
| `name` | friendly name (defaults to `id`) |

`type` chooses the right function code automatically (`light`→RELAY, `dimmer`→DIMMER,
`blind`→MOTOR, `heating`→SENSOR). You can also pass `functionCode`/`function` explicitly to
target any device type. Device numbers come straight from your PROSOFT project.

---

## Client API

Control (each returns the device's refreshed state):

| Method | Description |
|--------|-------------|
| `connect()` / `disconnect()` | open/close the socket; `connect()` auto-subscribes |
| `light(id)` / `blind(id)` / `heating(id)` / `device(id)` | typed device handles |
| `setLightPower(target, on)` / `toggleLight(target)` | relay on/off/toggle |
| `setDimmerLevel(target, 0..100)` | dimmer level |
| `moveBlindUp/Down(target)`, `stopBlind(target)`, `setBlindPosition(target, 0..100)` | motors |
| `setHeatingPower/Mode/Preset/TargetTemperature(...)` | climate (see caveat below) |
| `getState(target)` / `getCachedState(target)` / `refreshDevices([ids])` | read state |

Subscriptions & events:

| Method / Event | Description |
|----------------|-------------|
| `subscribe([functions])` / `unsubscribe([functions])` | subscribe to **all** devices of a type (legacy `FUNCTION_LOG` 0x03) |
| `subscribeDevice(target)` / `unsubscribeDevice(target)` | **per-device** subscription (2026 spec `0x22`) |
| `on("stateChanged", state => …)` | a device's state changed (or a `getState` reply) |
| `on("connected" / "disconnected" / "error" / "raw" / "ack")` | connection/diagnostic events |

`target` can be a configured device `id` (string) or a `{ centralUnit, functionCode, number }`
object, so you can control devices that aren't in the `devices` list.

Device helpers: `TeletaskLightDevice` (`on/off/toggle/setBrightness`),
`TeletaskBlindDevice` (`up/down/stop/setPosition`),
`TeletaskHeatingDevice` (`on/off/setMode/setPreset/setTargetTemperature`).

See **[LIBRARY.md](LIBRARY.md)** for the full API surface, event payloads and device
definitions.

---

## Protocol layer (low-level)

The frame codec is exported for advanced use (`src/teletask/protocol.js`):

```
STX(0x02) | Length | Command | Parameter 1..n | (Checksum — now obsolete)
```

- `Length` includes the STX and Length bytes, excludes the checksum.
- The unit replies with a single `0x0A` ACK when it receives a message; state arrives as
  `EVENT_REPORT` (`0x10`) frames.

Encoders / helpers: `encodeKeepAlive`, `encodeFunctionSet`, `encodeFunctionGet`,
`encodeFunctionGroupGet`, `encodeFunctionLog`, `encodeFunctionSubscribe` (0x22),
`encodeFunctionGroupSubscribe` (0x23), `encodeAck`, `parseIncoming`, `decodeEventReport`,
`toAsciiCommand` (ASCII form `s,8,7,1,1,0,1,255;` per spec §3.1), plus sensor conversions
(`sensorRawToTemperature`, `sensorFloatToValue`, `sensorFloatToTemperature`).

Command & type tables are in `src/teletask/constants.js` (`COMMAND`, `FUNCTION`, `SETTING`),
with values aligned to the TDS15132 DoIP API spec (relay=1, dimmer=2, motor=6,
climate control=17, sensor=20, flag=15, audio=31, RGB=217, tunable white=220, alarm=59, …;
actions ON=255/OFF=0/TOGGLE=103).

---

## Known caveats

- **Sensors / climate have two format generations.** The 2026 Open-Protocol spec encodes sensor
  values as IEEE-754 32-bit big-endian floats (`sensorFloatToValue` / `…ToTemperature`, temp =
  float − 273) and treats heating as *Climate Control* (type `17`). Older firmware used 2-byte
  raw values (`sensorRawToTemperature`, the current `TeletaskHeatingDevice`/`FUNCTION.SENSOR`
  path). Verify the heating/sensor decode against your actual unit before relying on it.
- `SETTING.TEMP_MANUAL_TARGET` and some climate settings differ between protocol generations —
  confirm against your unit.
- Lights, switches, dimmers and blinds (relay/dimmer/motor) are the well-exercised paths.

---

## Licence & scope

MIT. This is an independent, interoperability-focused project and is **not affiliated with or
endorsed by TELETASK**; "TELETASK" and "PROSOFT" are trademarks of their respective owner. The
library is for interoperability with hardware you own. Local control uses TELETASK's licensed
DoIP Open Protocol (TDS15132) — obtain the licence for your own central unit through TELETASK.
