import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function createConsoleLogger() {
  return {
    trace: console.debug.bind(console),
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };
}

let logger = createConsoleLogger();

try {
  const pino = require("pino");
  logger = pino({
    level: process.env.LOG_LEVEL || "info",
    transport: process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined
  });
} catch {
  logger = createConsoleLogger();
}

export const log = logger;
