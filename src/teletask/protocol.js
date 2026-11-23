import {
  ACK,
  COMMAND,
  FUNCTION,
  STX,
  SENSOR_MAX,
  functionNameFromCode
} from "./constants.js";

function checksumFor(frameWithoutChecksum) {
  let sum = 0;
  for (const byte of frameWithoutChecksum) {
    sum = (sum + byte) & 0xff;
  }
  return sum;
}

function encodeFrame(command, parameters = []) {
  const payload = Buffer.from(parameters);
  const frameWithoutChecksum = Buffer.concat([
    Buffer.from([STX, payload.length + 3, command]),
    payload
  ]);
  const checksum = checksumFor(frameWithoutChecksum);
  return Buffer.concat([frameWithoutChecksum, Buffer.from([checksum])]);
}

function readUInt16(buffer, offset) {
  return buffer.readUInt16BE(offset);
}

function readInt16(buffer, offset) {
  return buffer.readInt16BE(offset);
}

function stateKey({ centralUnit, functionCode, number }) {
  return `${centralUnit}:${functionCode}:${number}`;
}

export function parseIncoming(buffer) {
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    const byte = buffer[offset];

    if (byte === ACK) {
      frames.push({ type: "ack" });
      offset += 1;
      continue;
    }

    if (byte !== STX) {
      offset += 1;
      continue;
    }

    if (offset + 2 > buffer.length) break;
    const length = buffer[offset + 1];
    const totalLength = length + 1;

    if (offset + totalLength > buffer.length) break;

    const frame = buffer.subarray(offset, offset + totalLength);
    const withoutChecksum = frame.subarray(0, frame.length - 1);
    const checksum = frame[frame.length - 1];
    const expectedChecksum = checksumFor(withoutChecksum);

    if (checksum !== expectedChecksum) {
      frames.push({
        type: "invalid",
        reason: "checksum",
        frame
      });
      offset += totalLength;
      continue;
    }

    const command = frame[2];
    const parameters = frame.subarray(3, frame.length - 1);
    frames.push({
      type: "frame",
      command,
      parameters,
      raw: frame,
      decoded: decodeFrame(command, parameters)
    });
    offset += totalLength;
  }

  return {
    frames,
    remaining: buffer.subarray(offset)
  };
}

export function encodeKeepAlive() {
  return encodeFrame(COMMAND.KEEP_ALIVE);
}

export function encodeFunctionGet({ centralUnit = 0, functionCode, number }) {
  return encodeFrame(COMMAND.FUNCTION_GET, [
    centralUnit,
    functionCode,
    (number >> 8) & 0xff,
    number & 0xff
  ]);
}

export function encodeFunctionGroupGet({ centralUnit = 0, functionCode, numbers }) {
  const params = [centralUnit, functionCode];
  for (const number of numbers) {
    params.push((number >> 8) & 0xff, number & 0xff);
  }
  return encodeFrame(COMMAND.FUNCTION_GROUP_GET, params);
}

export function encodeFunctionLog({ functionCode, enabled }) {
  return encodeFrame(COMMAND.FUNCTION_LOG, [functionCode, enabled ? 0xff : 0x00]);
}

// Per-device state subscription (2026 spec §4.4, command 0x22). Preferred over the
// function-type-wide FUNCTION_LOG (0x03): it reports on just this one device.
export function encodeFunctionSubscribe({ centralUnit = 0, functionCode, number, enabled = true }) {
  return encodeFrame(COMMAND.FUNCTION_SUBSCRIBE, [
    centralUnit,
    functionCode,
    (number >> 8) & 0xff,
    number & 0xff,
    enabled ? 0xff : 0x00
  ]);
}

// Group subscription (2026 spec §4.4, command 0x23): one enable flag for several
// same-type devices on the same central unit.
export function encodeFunctionGroupSubscribe({ centralUnit = 0, functionCode, numbers, enabled = true }) {
  const params = [centralUnit, functionCode];
  for (const number of numbers) {
    params.push((number >> 8) & 0xff, number & 0xff);
  }
  params.push(enabled ? 0xff : 0x00);
  return encodeFrame(COMMAND.FUNCTION_GROUP_SUBSCRIBE, params);
}

// Convert any binary frame (from the encoders above) into the ASCII command form
// described in the 2026 spec §3.1 — e.g. "s,8,7,1,1,0,5,255;". The central unit still
// replies in binary. STX and the (obsolete) checksum byte are dropped.
export function toAsciiCommand(frame) {
  const body = frame.subarray(1, frame.length - 1);
  return `s,${[...body].join(",")};`;
}

export function encodeFunctionSet({
  centralUnit = 0,
  functionCode,
  number,
  setting,
  data = []
}) {
  return encodeFrame(COMMAND.FUNCTION_SET, [
    centralUnit,
    functionCode,
    (number >> 8) & 0xff,
    number & 0xff,
    setting,
    ...data
  ]);
}

export function encodeAck() {
  return Buffer.from([ACK]);
}

export function sensorRawToTemperature(rawValue) {
  return rawValue / 10 - 273;
}

// 2026 spec §5.9: on PROSOFT-5 / Open-DoIP units, sensor values are an IEEE-754
// 32-bit big-endian float (the first 4 state bytes). The raw float is the measured
// value directly (lux, %RH, W, kWh, volts…); temperatures additionally subtract 273.
export function sensorFloatToValue(bytes, offset = 0) {
  if (!bytes || bytes.length < offset + 4) return null;
  return Buffer.from(bytes).readFloatBE(offset);
}

export function sensorFloatToTemperature(bytes, offset = 0) {
  const value = sensorFloatToValue(bytes, offset);
  return value === null ? null : value - 273;
}

export function temperatureToSensorShort(value) {
  return Math.round((value + 273) * 10);
}

export function presetTemperatureToByte(value) {
  return Math.round((value + 40) * 2);
}

export function standbyTemperatureToByte(delta) {
  return Math.round(delta * 10);
}

export function decodeFrame(command, parameters) {
  switch (command) {
    case COMMAND.EVENT_REPORT:
      return decodeEventReport(parameters);
    default:
      return { command, parameters };
  }
}

export function decodeEventReport(parameters) {
  if (parameters.length < 5) {
    return { kind: "event-report", malformed: true, parameters };
  }

  const centralUnit = parameters[0];
  const functionCode = parameters[1];
  const number = readUInt16(parameters, 2);
  const errorState = parameters[4];
  const state = parameters.subarray(5);

  return {
    kind: "event-report",
    key: stateKey({ centralUnit, functionCode, number }),
    centralUnit,
    functionCode,
    functionName: functionNameFromCode(functionCode),
    number,
    errorState,
    rawState: Buffer.from(state),
    normalized: normalizeState(functionCode, state)
  };
}

export function normalizeState(functionCode, state) {
  switch (functionCode) {
    case FUNCTION.RELAY:
    case FUNCTION.FLAG:
      return {
        kind: functionCode === FUNCTION.RELAY ? "relay" : "flag",
        value: state[0] ?? 0,
        on: (state[0] ?? 0) > 0
      };
    case FUNCTION.DIMMER:
      return {
        kind: "dimmer",
        level: state[0] ?? 0,
        on: (state[0] ?? 0) > 0
      };
    case FUNCTION.MOTOR:
      return normalizeMotorState(state);
    case FUNCTION.SENSOR:
      return normalizeSensorState(state);
    default:
      return {
        kind: "raw",
        bytes: [...state]
      };
  }
}

function normalizeMotorState(state) {
  const direction = state[0] ?? 0;
  const power = state[1] ?? 0;
  const protection = state[2] ?? 0;
  const position = state.length >= 4 ? state[3] : null;

  return {
    kind: "motor",
    direction,
    moving: power > 0,
    power,
    protection,
    position,
    isOpen: position === null ? null : position > 0,
    isClosed: position === null ? null : position === 0
  };
}

function normalizeSensorState(state) {
  const valueRaw = state.length >= 2 ? readUInt16(state, 0) : null;
  const targetRaw = state.length >= 4 ? readUInt16(state, 2) : null;
  const dayRaw = state.length >= 6 ? readUInt16(state, 4) : null;
  const nightRaw = state.length >= 8 ? readUInt16(state, 6) : null;
  const standbyRaw = state.length >= 9 ? state[8] : null;
  const activePreset = state.length >= 10 ? state[9] : null;
  const mode = state.length >= 11 ? state[10] : null;
  const speedMode = state.length >= 12 ? state[11] : null;
  const power = state.length >= 13 ? state[12] : null;
  const frostProtection = state.length >= 14 ? state[13] : null;
  const direction = state.length >= 16 ? state[15] : null;
  const nightCoolRaw = state.length >= 18 ? readUInt16(state, 16) : null;

  return {
    kind: "sensor",
    raw: [...state],
    valueRaw,
    valueCelsius: convertSensorReading(valueRaw),
    targetRaw,
    targetCelsius: convertSensorReading(targetRaw),
    dayRaw,
    dayCelsius: convertSensorReading(dayRaw),
    nightRaw,
    nightCelsius: convertSensorReading(nightRaw),
    standbyRaw,
    standbyCelsiusDelta: standbyRaw === null ? null : standbyRaw / 10,
    activePreset,
    mode,
    speedMode,
    power,
    frostProtection,
    direction,
    nightCoolRaw,
    nightCoolCelsius: convertSensorReading(nightCoolRaw),
    on: power === null ? null : power > 0
  };
}

function convertSensorReading(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  if (rawValue >= SENSOR_MAX) return null;
  return sensorRawToTemperature(rawValue);
}
