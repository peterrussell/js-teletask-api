import { EventEmitter, once } from "node:events";
import { TeletaskConnection } from "./connection.js";
import {
  COMMAND,
  DEFAULT_LOGGED_FUNCTIONS,
  DEFAULT_PORT,
  FUNCTION,
  SETTING,
  functionNameFromCode
} from "./constants.js";
import {
  decodeEventReport,
  encodeAck,
  encodeFunctionGet,
  encodeFunctionGroupGet,
  encodeFunctionLog,
  encodeFunctionSet,
  encodeFunctionSubscribe,
  encodeKeepAlive,
  parseIncoming,
  presetTemperatureToByte,
  standbyTemperatureToByte,
  temperatureToSensorShort
} from "./protocol.js";
import { addressKey, normalizeDeviceDefinitions, normalizeTarget } from "./device-registry.js";

export class TeletaskClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = {
      port: DEFAULT_PORT,
      requestTimeoutMs: 4000,
      keepAliveIntervalMs: 240000,
      autoAcknowledge: true,
      ...config
    };
    this.connection = new TeletaskConnection({
      host: this.config.host,
      port: this.config.port
    });
    this.registry = normalizeDeviceDefinitions(this.config.devices ?? []);
    this.pending = new Map();
    this.state = new Map();
    this.buffer = Buffer.alloc(0);
    this.keepAliveTimer = null;
    this.connected = false;
    this._bindConnection();
  }

  async connect() {
    if (this.connected) return this;
    this.connection.connect();
    await once(this.connection, "connect");
    this.connected = true;
    this._startKeepAlive();

    if (this.config.subscribe !== false) {
      await this.subscribe(this.config.loggedFunctions ?? DEFAULT_LOGGED_FUNCTIONS);
    }

    return this;
  }

  async disconnect() {
    this._stopKeepAlive();
    this.connection.close();
    if (this.connected) {
      await once(this.connection, "close");
    }
  }

  isConnected() {
    return this.connected;
  }

  listDevices() {
    return this.registry.devices.map((device) => ({
      ...device,
      state: this.getCachedState(device.id)
    }));
  }

  device(id) {
    const device = this.registry.byId.get(id);
    if (!device) throw new Error(`Unknown device id "${id}"`);

    switch (device.type) {
      case "light":
      case "switch":
      case "dimmer":
        return new TeletaskLightDevice(this, device);
      case "blind":
      case "cover":
        return new TeletaskBlindDevice(this, device);
      case "heating":
      case "thermostat":
      case "sensor":
        return new TeletaskHeatingDevice(this, device);
      default:
        return new TeletaskDevice(this, device);
    }
  }

  light(id) {
    return new TeletaskLightDevice(this, this._deviceById(id, ["light", "switch", "dimmer"]));
  }

  blind(id) {
    return new TeletaskBlindDevice(this, this._deviceById(id, ["blind", "cover"]));
  }

  heating(id) {
    return new TeletaskHeatingDevice(this, this._deviceById(id, ["heating", "thermostat", "sensor"]));
  }

  async subscribe(functions = DEFAULT_LOGGED_FUNCTIONS) {
    for (const functionCode of functions) {
      this._write(encodeFunctionLog({ functionCode, enabled: true }));
    }
  }

  async unsubscribe(functions = DEFAULT_LOGGED_FUNCTIONS) {
    for (const functionCode of functions) {
      this._write(encodeFunctionLog({ functionCode, enabled: false }));
    }
  }

  // Per-device subscription (command 0x22). Preferred over subscribe()/FUNCTION_LOG on
  // PROSOFT-5 units: reports on just this device instead of all of its function type.
  async subscribeDevice(deviceOrTarget, enabled = true) {
    const target = this._resolveKnownTarget(deviceOrTarget);
    this._write(encodeFunctionSubscribe({ ...target, enabled }));
  }

  async unsubscribeDevice(deviceOrTarget) {
    return this.subscribeDevice(deviceOrTarget, false);
  }

  getCachedState(deviceOrTarget) {
    const target = this._resolveKnownTarget(deviceOrTarget, false);
    if (typeof deviceOrTarget === "string") {
      const device = this.registry.byId.get(deviceOrTarget);
      return this.state.get(addressKey(device)) ?? null;
    }
    if (!target) return null;
    return this.state.get(addressKey(target)) ?? null;
  }

  async getState(deviceOrTarget) {
    const target = this._resolveKnownTarget(deviceOrTarget);
    const pending = this._registerPending(target);
    this._write(encodeFunctionGet(target));
    return pending.promise;
  }

  async refreshDevices(deviceIds = null) {
    const devices = deviceIds
      ? deviceIds.map((id) => this._deviceById(id))
      : this.registry.devices;

    const groups = new Map();
    for (const device of devices) {
      const key = `${device.centralUnit}:${device.functionCode}`;
      if (!groups.has(key)) {
        groups.set(key, {
          centralUnit: device.centralUnit,
          functionCode: device.functionCode,
          numbers: []
        });
      }
      groups.get(key).numbers.push(device.number);
    }

    for (const group of groups.values()) {
      for (const number of group.numbers) {
        this._registerPending({
          centralUnit: group.centralUnit,
          functionCode: group.functionCode,
          number
        });
      }
      this._write(encodeFunctionGroupGet(group));
    }

    return Promise.all(devices.map((device) => this._awaitPending(device)));
  }

  async setLightPower(deviceOrTarget, on) {
    const target = this._resolveKnownTarget(deviceOrTarget);
    this._write(
      encodeFunctionSet({
        ...target,
        functionCode: target.functionCode ?? FUNCTION.RELAY,
        setting: on ? SETTING.ON : SETTING.OFF
      })
    );
    return this.getState(target);
  }

  // Toggle a relay/dimmer/flag/mood between ON and OFF (SETTING.TOGGLE = 103).
  async toggleLight(deviceOrTarget) {
    const target = this._resolveKnownTarget(deviceOrTarget);
    this._write(
      encodeFunctionSet({
        ...target,
        functionCode: target.functionCode ?? FUNCTION.RELAY,
        setting: SETTING.TOGGLE
      })
    );
    return this.getState(target);
  }

  async setDimmerLevel(deviceOrTarget, level) {
    const target = this._resolveKnownTarget(deviceOrTarget);
    const boundedLevel = Math.max(0, Math.min(100, Math.round(level)));
    this._write(
      encodeFunctionSet({
        ...target,
        functionCode: FUNCTION.DIMMER,
        setting: boundedLevel
      })
    );
    return this.getState(target);
  }

  async moveBlindUp(deviceOrTarget) {
    return this._setMotor(deviceOrTarget, SETTING.MOTOR_UP);
  }

  async moveBlindDown(deviceOrTarget) {
    return this._setMotor(deviceOrTarget, SETTING.MOTOR_DOWN);
  }

  async stopBlind(deviceOrTarget) {
    return this._setMotor(deviceOrTarget, SETTING.MOTOR_STOP);
  }

  async setBlindPosition(deviceOrTarget, position) {
    const target = this._resolveKnownTarget(deviceOrTarget);
    const boundedPosition = Math.max(0, Math.min(100, Math.round(position)));
    this._write(
      encodeFunctionSet({
        ...target,
        functionCode: FUNCTION.MOTOR,
        setting: SETTING.MOTOR_GO_TO_POSITION,
        data: [boundedPosition]
      })
    );
    return this.getState(target);
  }

  async setHeatingPower(deviceOrTarget, on) {
    return this._setSensor(deviceOrTarget, on ? SETTING.ON : SETTING.OFF);
  }

  async toggleHeatingPower(deviceOrTarget) {
    return this._setSensor(deviceOrTarget, SETTING.TEMP_ON_OFF);
  }

  async setHeatingMode(deviceOrTarget, mode) {
    const setting = {
      auto: SETTING.TEMP_AUTO,
      heat: SETTING.TEMP_HEAT,
      cool: SETTING.TEMP_COOL,
      vent: SETTING.TEMP_VENT,
      stop: SETTING.TEMP_STOP,
      heatPlus: SETTING.TEMP_HEAT_PLUS
    }[mode];

    if (setting === undefined) {
      throw new Error(`Unsupported heating mode "${mode}"`);
    }

    return this._setSensor(deviceOrTarget, setting);
  }

  async setHeatingPreset(deviceOrTarget, preset) {
    const setting = {
      day: SETTING.TEMP_DAY,
      night: SETTING.TEMP_NIGHT,
      standby: SETTING.TEMP_STANDBY,
      frost: SETTING.TEMP_FROST
    }[preset];

    if (setting === undefined) {
      throw new Error(`Unsupported heating preset "${preset}"`);
    }

    return this._setSensor(deviceOrTarget, setting);
  }

  async setHeatingTargetTemperature(deviceOrTarget, temperatureCelsius) {
    const target = this._resolveKnownTarget(deviceOrTarget);
    // The DoIP protocol has no absolute "set target" action (the old TEMP_MANUAL_TARGET
    // guess does not exist and the unit ignores it). Instead set the Day-preset
    // temperature — 1 byte, (°C + 40) * 2 — then activate the Day preset so the zone's
    // target follows it. Verified live against the unit (SENSOR/climate zone).
    this._write(
      encodeFunctionSet({
        ...target,
        functionCode: FUNCTION.SENSOR,
        setting: SETTING.TEMP_SET_DAY,
        data: [presetTemperatureToByte(temperatureCelsius)]
      })
    );
    this._write(
      encodeFunctionSet({
        ...target,
        functionCode: FUNCTION.SENSOR,
        setting: SETTING.TEMP_DAY
      })
    );
    return this.getState(target);
  }

  async setHeatingPresetTemperature(deviceOrTarget, preset, temperatureCelsius) {
    const target = this._resolveKnownTarget(deviceOrTarget);
    const mapping = {
      day: {
        setting: SETTING.TEMP_SET_DAY,
        value: presetTemperatureToByte(temperatureCelsius)
      },
      night: {
        setting: SETTING.TEMP_SET_NIGHT,
        value: presetTemperatureToByte(temperatureCelsius)
      },
      standby: {
        setting: SETTING.TEMP_SET_STANDBY,
        value: standbyTemperatureToByte(temperatureCelsius)
      },
      nightCool: {
        setting: SETTING.TEMP_SET_NIGHT_COOL,
        value: presetTemperatureToByte(temperatureCelsius)
      }
    };

    const command = mapping[preset];
    if (!command) {
      throw new Error(`Unsupported preset temperature "${preset}"`);
    }

    this._write(
      encodeFunctionSet({
        ...target,
        functionCode: FUNCTION.SENSOR,
        setting: command.setting,
        data: [command.value]
      })
    );
    return this.getState(target);
  }

  _bindConnection() {
    this.connection.on("connect", () => {
      this.emit("connected");
    });

    this.connection.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const parsed = parseIncoming(this.buffer);
      this.buffer = parsed.remaining;

      for (const item of parsed.frames) {
        this.emit("raw", item);
        if (item.type === "ack") {
          this.emit("ack");
          continue;
        }
        if (item.type === "invalid") {
          this.emit("warning", item);
          continue;
        }
        if (this.config.autoAcknowledge && item.command === COMMAND.EVENT_REPORT) {
          this._write(encodeAck());
        }
        this._handleDecodedFrame(item.decoded);
      }
    });

    this.connection.on("error", (error) => {
      this.emit("error", error);
    });

    this.connection.on("close", () => {
      this.connected = false;
      this._stopKeepAlive();
      this.emit("disconnected");
    });
  }

  _handleDecodedFrame(frame) {
    if (frame.kind !== "event-report") return;
    const state = this._decorateState(frame);
    this.state.set(frame.key, state);
    this.emit("stateChanged", state);
    this.emit("state", state);
    this._resolvePending(frame.key, state);
  }

  _decorateState(frame) {
    const device = this.registry.byAddress.get(frame.key);
    return {
      key: frame.key,
      deviceId: device?.id ?? null,
      deviceName: device?.name ?? null,
      deviceType: device?.type ?? null,
      centralUnit: frame.centralUnit,
      functionCode: frame.functionCode,
      functionName: frame.functionName ?? functionNameFromCode(frame.functionCode),
      number: frame.number,
      errorState: frame.errorState,
      rawState: frame.rawState,
      normalized: frame.normalized
    };
  }

  _registerPending(target) {
    const key = addressKey(target);
    const existing = this.pending.get(key);
    if (existing) return existing;

    const timeout = setTimeout(() => {
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      pending.reject(new Error(`Timed out waiting for state of ${key}`));
    }, this.config.requestTimeoutMs);

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const pending = { promise, resolve, reject, timeout };
    this.pending.set(key, pending);
    return pending;
  }

  _awaitPending(target) {
    const key = addressKey(target);
    const pending = this.pending.get(key);
    return pending?.promise ?? Promise.resolve(this.state.get(key) ?? null);
  }

  _resolvePending(key, state) {
    const pending = this.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(key);
    pending.resolve(state);
  }

  _startKeepAlive() {
    this._stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.connected) {
        this._write(encodeKeepAlive());
      }
    }, this.config.keepAliveIntervalMs);
  }

  _stopKeepAlive() {
    if (!this.keepAliveTimer) return;
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  _setMotor(deviceOrTarget, setting, data = []) {
    const target = this._resolveKnownTarget(deviceOrTarget);
    this._write(
      encodeFunctionSet({
        ...target,
        functionCode: FUNCTION.MOTOR,
        setting,
        data
      })
    );
    return this.getState(target);
  }

  _setSensor(deviceOrTarget, setting, data = []) {
    const target = this._resolveKnownTarget(deviceOrTarget);
    this._write(
      encodeFunctionSet({
        ...target,
        functionCode: FUNCTION.SENSOR,
        setting,
        data
      })
    );
    return this.getState(target);
  }

  _resolveKnownTarget(deviceOrTarget, strict = true) {
    if (typeof deviceOrTarget === "string") {
      const device = this.registry.byId.get(deviceOrTarget);
      if (!device) throw new Error(`Unknown device id "${deviceOrTarget}"`);
      return device;
    }

    if (!deviceOrTarget) {
      if (strict) throw new Error("A target or device id is required");
      return null;
    }

    return normalizeTarget(deviceOrTarget);
  }

  _deviceById(id, expectedTypes = null) {
    const device = this.registry.byId.get(id);
    if (!device) throw new Error(`Unknown device id "${id}"`);
    if (expectedTypes && !expectedTypes.includes(device.type)) {
      throw new Error(`Device "${id}" is not of expected type: ${expectedTypes.join(", ")}`);
    }
    return device;
  }

  _write(buffer) {
    this.connection.write(buffer);
  }
}

export class TeletaskDevice {
  constructor(client, definition) {
    this.client = client;
    this.definition = definition;
  }

  get id() {
    return this.definition.id;
  }

  get name() {
    return this.definition.name;
  }

  get type() {
    return this.definition.type;
  }

  get address() {
    return {
      centralUnit: this.definition.centralUnit,
      functionCode: this.definition.functionCode,
      number: this.definition.number
    };
  }

  async getState() {
    return this.client.getState(this.definition);
  }

  getCachedState() {
    return this.client.getCachedState(this.definition);
  }
}

export class TeletaskLightDevice extends TeletaskDevice {
  async on() {
    if (this.definition.functionCode === FUNCTION.DIMMER) {
      return this.client.setDimmerLevel(this.definition, 100);
    }
    return this.client.setLightPower(this.definition, true);
  }

  async off() {
    if (this.definition.functionCode === FUNCTION.DIMMER) {
      return this.client.setDimmerLevel(this.definition, 0);
    }
    return this.client.setLightPower(this.definition, false);
  }

  async setBrightness(level) {
    return this.client.setDimmerLevel(this.definition, level);
  }

  async toggle() {
    return this.client.toggleLight(this.definition);
  }
}

export class TeletaskBlindDevice extends TeletaskDevice {
  async up() {
    return this.client.moveBlindUp(this.definition);
  }

  async down() {
    return this.client.moveBlindDown(this.definition);
  }

  async stop() {
    return this.client.stopBlind(this.definition);
  }

  async setPosition(position) {
    return this.client.setBlindPosition(this.definition, position);
  }
}

export class TeletaskHeatingDevice extends TeletaskDevice {
  async on() {
    return this.client.setHeatingPower(this.definition, true);
  }

  async off() {
    return this.client.setHeatingPower(this.definition, false);
  }

  async setMode(mode) {
    return this.client.setHeatingMode(this.definition, mode);
  }

  async setPreset(preset) {
    return this.client.setHeatingPreset(this.definition, preset);
  }

  async setTargetTemperature(temperatureCelsius) {
    return this.client.setHeatingTargetTemperature(this.definition, temperatureCelsius);
  }

  async setPresetTemperature(preset, temperatureCelsius) {
    return this.client.setHeatingPresetTemperature(
      this.definition,
      preset,
      temperatureCelsius
    );
  }
}

export function decodeStateFrame(parameters) {
  return decodeEventReport(parameters);
}
