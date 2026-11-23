export const UnitType = Object.freeze({
  PICOS: "PICOS",
  NANOS: "NANOS",
  MICROS_PLUS: "MICROS_PLUS"
});

// High-level “events” your app/bridge consumes
export const EventType = Object.freeze({
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
  STATE_CHANGED: "STATE_CHANGED",
  RAW_FRAME: "RAW_FRAME"
});