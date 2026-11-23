import net from "net";
import { EventEmitter } from "events";
import { log } from "../log.js";

export class TeletaskConnection extends EventEmitter {
  constructor({ host, port }) {
    super();
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
  }

  connect() {
    if (this.socket) return;

    this.socket = net.createConnection({ host: this.host, port: this.port });

    this.socket.on("connect", () => {
      log.info({ host: this.host, port: this.port }, "Teletask TCP connected");
      this.emit("connect");
    });

    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.emit("data", chunk);
    });

    this.socket.on("error", (err) => {
      log.error({ err }, "Teletask TCP error");
      this.emit("error", err);
    });

    this.socket.on("close", () => {
      log.warn("Teletask TCP closed");
      this.emit("close");
      this.socket = null;
      this.buffer = Buffer.alloc(0);
    });
  }

  write(buf) {
    if (!this.socket) throw new Error("Not connected");
    this.socket.write(buf);
  }

  close() {
    if (this.socket) this.socket.end();
  }
}