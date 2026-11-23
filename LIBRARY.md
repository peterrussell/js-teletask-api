# Teletask Node Library

This package now exposes a local-network Teletask DoIP client for central units that support the documented socket protocol on port `55957`.

## Design goals

- simple high-level API for lights, blinds, and heating
- stable device ids so a future Homebridge plugin can map accessories once
- raw protocol access still available when we need deeper coverage later
- normalized state events and cached state for accessory updates

## Install shape

The package entry point is:

```js
import { TeletaskClient } from "js-teletask-api";
```

## Quick start

```js
import { TeletaskClient } from "js-teletask-api";

const teletask = new TeletaskClient({
  host: "192.168.1.56", // your central unit's LAN IP
  port: 55957,
  devices: [
    { id: "living-room-light", type: "light", centralUnit: 1, number: 23, name: "Living Room Light" },
    { id: "kitchen-blind", type: "blind", centralUnit: 1, number: 9, name: "Kitchen Blind" },
    { id: "hall-heating", type: "heating", centralUnit: 1, number: 4, name: "Hall Heating" }
  ]
});

teletask.on("stateChanged", (state) => {
  console.log(state.deviceId, state.normalized);
});

await teletask.connect();
await teletask.refreshDevices();

await teletask.light("living-room-light").on();
await teletask.blind("kitchen-blind").down();
await teletask.heating("hall-heating").setMode("heat");
await teletask.heating("hall-heating").setTargetTemperature(21.5);
```

## Device definitions

Each configured device should have:

- `id`: stable identifier for future Homebridge accessory mapping
- `type`: `light`, `dimmer`, `blind`, `cover`, `heating`, `thermostat`, or `sensor`
- `centralUnit`: Teletask central unit number
- `number`: Teletask function number
- `name`: optional friendly name

You can also provide `function` or `functionCode` explicitly if you want raw protocol control.

## Main API

Top-level methods:

- `await client.connect()`
- `await client.disconnect()`
- `await client.getState(deviceIdOrTarget)`
- `await client.refreshDevices([deviceIds])`
- `client.getCachedState(deviceIdOrTarget)`
- `client.listDevices()`

Typed handles:

- `client.light(id).on()`
- `client.light(id).off()`
- `client.light(id).setBrightness(0..100)`
- `client.blind(id).up()`
- `client.blind(id).down()`
- `client.blind(id).stop()`
- `client.blind(id).setPosition(0..100)`
- `client.heating(id).on()`
- `client.heating(id).off()`
- `client.heating(id).setMode("auto" | "heat" | "cool" | "vent" | "stop" | "heatPlus")`
- `client.heating(id).setPreset("day" | "night" | "standby" | "frost")`
- `client.heating(id).setTargetTemperature(number)`
- `client.heating(id).setPresetTemperature("day" | "night" | "standby" | "nightCool", number)`

Raw helpers are exported too:

- `encodeFunctionSet`
- `encodeFunctionGet`
- `encodeFunctionGroupGet`
- `parseIncoming`
- protocol constants like `FUNCTION`, `SETTING`, and `COMMAND`

## Events

The client emits:

- `connected`
- `disconnected`
- `ack`
- `stateChanged`
- `state`
- `raw`
- `warning`
- `error`

`stateChanged` payloads contain:

```js
{
  key: "1:1:23",
  deviceId: "living-room-light",
  deviceName: "Living Room Light",
  deviceType: "light",
  centralUnit: 1,
  functionCode: 1,
  functionName: "RELAY",
  number: 23,
  normalized: {
    kind: "relay",
    on: true,
    value: 255
  }
}
```

## Homebridge considerations

The current API is intentionally accessory-friendly:

- stable `device.id` values are ready to become Homebridge accessory UUID seeds
- `refreshDevices()` supports startup state hydration
- `stateChanged` emits normalized values suitable for characteristic updates
- the client still exposes raw function codes and raw frames for unsupported Teletask features

## Current limits

- discovery is not implemented yet; devices are configured explicitly
- some sensor payloads are normalized with a temperature-zone bias because the vendor documentation is strongest there
- motor status decoding is best-effort; control commands are fully implemented, but model-specific event details may still need refinement on real hardware
