import { FUNCTION, functionCodeFromName } from "./constants.js";

const DEFAULT_TYPE_TO_FUNCTION = Object.freeze({
  light: FUNCTION.RELAY,
  switch: FUNCTION.RELAY,
  fan: FUNCTION.RELAY,
  outlet: FUNCTION.RELAY,
  blind: FUNCTION.MOTOR,
  cover: FUNCTION.MOTOR,
  heating: FUNCTION.SENSOR,
  thermostat: FUNCTION.SENSOR,
  sensor: FUNCTION.SENSOR,
  dimmer: FUNCTION.DIMMER
});

export function normalizeDeviceDefinitions(devices = []) {
  const byId = new Map();
  const byAddress = new Map();
  const normalized = devices.map((device) => normalizeDeviceDefinition(device));

  for (const device of normalized) {
    if (byId.has(device.id)) {
      throw new Error(`Duplicate device id "${device.id}"`);
    }
    byId.set(device.id, device);
    byAddress.set(addressKey(device), device);
  }

  return {
    devices: normalized,
    byId,
    byAddress
  };
}

export function normalizeTarget(target) {
  if (!target || typeof target !== "object") {
    throw new Error("A Teletask target object is required");
  }

  const functionCode = resolveFunctionCode(target);
  const centralUnit = target.centralUnit ?? (needsCentralUnit(functionCode) ? 1 : 0);

  if (!Number.isInteger(centralUnit)) {
    throw new Error(`Invalid centralUnit: ${centralUnit}`);
  }

  if (needsCentralUnit(functionCode)) {
    if (centralUnit < 1 || centralUnit > 10) {
      throw new Error(
        `Invalid centralUnit ${centralUnit} for function ${functionCode}; expected 1-10`
      );
    }
  } else if (centralUnit !== 0) {
    throw new Error(
      `Invalid centralUnit ${centralUnit} for function ${functionCode}; expected 0`
    );
  }

  if (!Number.isInteger(target.number) || target.number < 0 || target.number > 0xffff) {
    throw new Error(`Invalid device number: ${target.number}`);
  }

  return {
    ...target,
    centralUnit,
    functionCode,
    number: target.number
  };
}

export function addressKey(target) {
  return `${target.centralUnit}:${target.functionCode}:${target.number}`;
}

function normalizeDeviceDefinition(device) {
  if (!device?.id) {
    throw new Error("Every configured device needs an id");
  }

  const normalized = normalizeTarget({
    ...device,
    functionCode: resolveFunctionCode(device)
  });

  return {
    name: device.name ?? device.id,
    type: device.type ?? inferTypeFromFunction(normalized.functionCode),
    ...normalized
  };
}

function resolveFunctionCode(target) {
  if (target.functionCode !== undefined) {
    return functionCodeFromName(target.functionCode);
  }

  if (target.function !== undefined) {
    return functionCodeFromName(target.function);
  }

  const type = String(target.type ?? "").trim().toLowerCase();
  const code = DEFAULT_TYPE_TO_FUNCTION[type];
  if (!code) {
    throw new Error(`Unable to infer Teletask function from type "${target.type}"`);
  }
  return code;
}

function inferTypeFromFunction(functionCode) {
  switch (functionCode) {
    case FUNCTION.RELAY:
      return "light";
    case FUNCTION.MOTOR:
      return "blind";
    case FUNCTION.SENSOR:
      return "heating";
    case FUNCTION.DIMMER:
      return "dimmer";
    default:
      return "device";
  }
}

function needsCentralUnit(functionCode) {
  return [
    FUNCTION.RELAY,
    FUNCTION.DIMMER,
    FUNCTION.MOTOR,
    FUNCTION.SENSOR,
    FUNCTION.AUDIO
  ].includes(functionCode);
}
