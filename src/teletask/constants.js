// Port 55957 is the official TELETASK "DoIP Open Protocol" (TDS15132) control port,
// per the TDS15132 DoIP API spec. It is license-gated: the central unit only accepts
// connections here once a TDS15132 license is active (or during a 3-day trial window).
// See README.md ("Connecting & the TDS15132 license") for the full story.
export const DEFAULT_PORT = 55957;
export const STX = 0x02;
export const ACK = 0x0a;

export const COMMAND = Object.freeze({
  // Subscribe to *all* devices of a function type (legacy; deprecated in the 2026 spec
  // in favour of the per-device FUNCTION_SUBSCRIBE below, but still supported).
  FUNCTION_LOG: 0x03,
  WRITE_DISPLAY_MESSAGE: 0x04,
  FUNCTION_GET: 0x06,
  FUNCTION_SET: 0x07,
  FUNCTION_GROUP_GET: 0x09,
  KEEP_ALIVE: 0x0b,
  EVENT_REPORT: 0x10,
  // Per-device state subscription (2026 spec §4.4): subscribe/unsubscribe to a single
  // device (0x22) or a group of same-type devices (0x23).
  FUNCTION_SUBSCRIBE: 0x22,
  FUNCTION_GROUP_SUBSCRIBE: 0x23,
  // Report sent on a badge access attempt when subscribed to device id 202 (2026 spec §4.6).
  PROXIMITY_REPORT: 0x14
});

// Device type codes. Values confirmed against the TDS15132 DoIP API spec (2026, §5).
export const FUNCTION = Object.freeze({
  RELAY: 1,
  DIMMER: 2,
  PROCESS: 3,
  TIMED_FUNCTION: 5,
  MOTOR: 6,
  LOCAL_MOOD: 8,
  TIMED_MOOD: 9,
  GENERAL_MOOD: 10,
  DIMMER_GROUP: 13,
  REGIME: 14,
  FLAG: 15,
  CLIMATE_CONTROL: 17, // heating/cooling zone with setpoints & modes (spec §5.4)
  SENSOR: 20, // read-only analog sensor: temp / light / humidity / power (spec §5.9)
  PROXIMITY: 202, // badge reader (subscribe for PROXIMITY_REPORT)
  DIGITAL_INPUT: 28,
  AUDIO: 31,
  MOTOR_GROUP: 40,
  RGB_GROUP: 41,
  TW_GROUP: 42,
  TOUCH_PANEL_KEY: 52,
  SERVICE: 53,
  MESSAGE: 54,
  ALARM: 59,
  CONDITION: 60,
  RGB: 217,
  TUNABLE_WHITE: 220
});

export const FUNCTION_NAME = Object.freeze(
  Object.fromEntries(Object.entries(FUNCTION).map(([name, code]) => [code, name]))
);

const FUNCTION_ALIASES = Object.freeze({
  REL: FUNCTION.RELAY,
  FNC_REL: FUNCTION.RELAY,
  DIM: FUNCTION.DIMMER,
  FNC_DIM: FUNCTION.DIMMER,
  MOTORFNC: FUNCTION.MOTOR,
  FNC_MOTORFNC: FUNCTION.MOTOR,
  TPKEY: FUNCTION.TOUCH_PANEL_KEY,
  FNC_TPKEY: FUNCTION.TOUCH_PANEL_KEY,
  LOCMOOD: FUNCTION.LOCAL_MOOD,
  FNC_LOCMOOD: FUNCTION.LOCAL_MOOD,
  TIMEDMOOD: FUNCTION.TIMED_MOOD,
  FNC_TIMEDMOOD: FUNCTION.TIMED_MOOD,
  GENMOOD: FUNCTION.GENERAL_MOOD,
  FNC_GENMOOD: FUNCTION.GENERAL_MOOD,
  PROCES: FUNCTION.PROCESS,
  FNC_PROCES: FUNCTION.PROCESS,
  REGIME: FUNCTION.REGIME,
  FNC_REGIME: FUNCTION.REGIME,
  SENSOR: FUNCTION.SENSOR,
  FNC_SENSOR: FUNCTION.SENSOR,
  AUDIO: FUNCTION.AUDIO,
  FNC_AUDIO: FUNCTION.AUDIO,
  FLAG: FUNCTION.FLAG,
  FNC_FLAG: FUNCTION.FLAG,
  SERVICE: FUNCTION.SERVICE,
  FNC_SERVICE: FUNCTION.SERVICE,
  MESSAGE: FUNCTION.MESSAGE,
  FNC_MESSAGE: FUNCTION.MESSAGE,
  COND: FUNCTION.CONDITION,
  FNC_COND: FUNCTION.CONDITION
});

export const SETTING = Object.freeze({
  OFF: 0,
  ON: 255,
  TOGGLE: 103,
  MOTOR_UP: 1,
  MOTOR_DOWN: 2,
  MOTOR_STOP: 3,
  MOTOR_START_STOP: 6,
  MOTOR_UP_STOP: 7,
  MOTOR_DOWN_STOP: 8,
  MOTOR_GO_TO_POSITION: 11,
  MOTOR_SET_SLAT_POSITION: 12,
  MOTOR_SUN_PROTECTION: 15,
  MOTOR_UP_DOWN: 55, // toggle Up->Stop->Down->Stop->Up…
  RGB_COLOR: 231, // + 3 data bytes R,G,B
  TW_COLOR: 230, // + 2 bytes Kelvin (short) + 1 byte brightness 0-100
  TEMP_UP: 21,
  TEMP_DOWN: 22,
  TEMP_FROST: 24,
  TEMP_NIGHT: 25,
  TEMP_DAY: 26,
  TEMP_SET_NIGHT: 27,
  TEMP_SET_DAY: 29,
  TEMP_MODE: 30,
  TEMP_SPEED: 31,
  TEMP_SET_NIGHT_COOL: 56,
  TEMP_SET_STANDBY: 88,
  TEMP_SPEED_AUTO: 89,
  TEMP_STANDBY: 93,
  TEMP_AUTO: 94,
  TEMP_HEAT: 95,
  TEMP_COOL: 96,
  TEMP_SPEED_LOW: 97,
  TEMP_SPEED_MEDIUM: 98,
  TEMP_SPEED_HIGH: 99,
  TEMP_ON_OFF: 104,
  TEMP_VENT: 105,
  TEMP_STOP: 106,
  TEMP_HEAT_PLUS: 107,
  TEMP_MANUAL_TARGET: 108
});

export const MOTOR_DIRECTION = Object.freeze({
  UNKNOWN: 0,
  UP: 1,
  DOWN: 2
});

export const SENSOR_MAX = 0x3f00;

export const DEFAULT_LOGGED_FUNCTIONS = Object.freeze([
  FUNCTION.RELAY,
  FUNCTION.DIMMER,
  FUNCTION.MOTOR,
  FUNCTION.SENSOR,
  FUNCTION.FLAG
]);

export function functionCodeFromName(value) {
  if (typeof value === "number") return value;
  const normalized = String(value).trim().toUpperCase();
  if (Object.hasOwn(FUNCTION_ALIASES, normalized)) {
    return FUNCTION_ALIASES[normalized];
  }
  if (!Object.hasOwn(FUNCTION, normalized)) {
    throw new Error(`Unknown Teletask function: ${value}`);
  }
  return FUNCTION[normalized];
}

export function functionNameFromCode(code) {
  return FUNCTION_NAME[code] ?? `UNKNOWN_${code}`;
}
