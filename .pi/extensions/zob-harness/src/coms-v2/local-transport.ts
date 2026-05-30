import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import { safeFileStem } from "../utils/paths.js";
import { buildZobLiveErrorEnvelope, parseZobLiveEnvelopeLine, validateZobLiveEnvelope, type ZobLiveEnvelope } from "./envelope.js";

export interface ZobLocalTransportServer {
  endpoint: string;
  close(): Promise<void>;
}

export interface ZobLocalTransportOptions {
  timeoutMs?: number;
  maxLineBytes?: number;
}

export type ZobLocalEnvelopeHandler = (envelope: ZobLiveEnvelope) => Promise<ZobLiveEnvelope> | ZobLiveEnvelope;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_LINE_BYTES = 256 * 1024;

export function makeZobLocalEndpoint(sessionId: string): string {
  return join(tmpdir(), "zob-coms-v2", `${safeFileStem(sessionId)}.sock`);
}

function safeUnlinkSocket(endpoint: string): void {
  if (!endpoint.endsWith(".sock") || !existsSync(endpoint)) return;
  unlinkSync(endpoint);
}

function boundedTimeout(value: number | undefined): number {
  return Math.max(25, Math.min(30_000, Math.floor(value ?? DEFAULT_TIMEOUT_MS)));
}

function boundedMaxLineBytes(value: number | undefined): number {
  return Math.max(1024, Math.min(1024 * 1024, Math.floor(value ?? DEFAULT_MAX_LINE_BYTES)));
}

async function writeEnvelope(socket: Socket, envelope: ZobLiveEnvelope): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(`${JSON.stringify(envelope)}\n`, "utf8", (error) => error ? reject(error) : resolve());
  });
}

export async function bindZobLocalEndpoint(endpoint: string, handler: ZobLocalEnvelopeHandler, options: ZobLocalTransportOptions = {}): Promise<ZobLocalTransportServer> {
  mkdirSync(dirname(endpoint), { recursive: true });
  safeUnlinkSocket(endpoint);
  const maxLineBytes = boundedMaxLineBytes(options.maxLineBytes);
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) {
        await writeEnvelope(socket, buildZobLiveErrorEnvelope({}, "max line bytes exceeded", "max_line_bytes"));
        socket.end();
        return;
      }
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      const parsed = parseZobLiveEnvelopeLine(line);
      if (!parsed.envelope) {
        await writeEnvelope(socket, buildZobLiveErrorEnvelope({}, parsed.errors.join("; "), "invalid_envelope"));
        socket.end();
        return;
      }
      try {
        const response = await handler(parsed.envelope);
        const responseErrors = validateZobLiveEnvelope(response);
        await writeEnvelope(socket, responseErrors.length === 0 ? response : buildZobLiveErrorEnvelope(parsed.envelope, responseErrors.join("; "), "invalid_response"));
      } catch (error) {
        await writeEnvelope(socket, buildZobLiveErrorEnvelope(parsed.envelope, error instanceof Error ? error.message : String(error), "handler_error"));
      } finally {
        socket.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    endpoint,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      safeUnlinkSocket(endpoint);
    },
  };
}

export async function sendZobLocalEnvelope(endpoint: string, envelope: ZobLiveEnvelope, options: ZobLocalTransportOptions = {}): Promise<ZobLiveEnvelope> {
  const requestErrors = validateZobLiveEnvelope(envelope);
  if (requestErrors.length > 0) throw new Error(requestErrors.join("; "));
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const maxLineBytes = boundedMaxLineBytes(options.maxLineBytes);
  return await new Promise<ZobLiveEnvelope>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`ZOB local transport timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (fn: () => void): void => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      fn();
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(envelope)}\n`, "utf8");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) {
        finish(() => reject(new Error("ZOB local transport response exceeded max line bytes")));
        socket.destroy();
        return;
      }
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const parsed = parseZobLiveEnvelopeLine(buffer.slice(0, newlineIndex).trim());
      finish(() => parsed.envelope ? resolve(parsed.envelope) : reject(new Error(parsed.errors.join("; "))));
      socket.end();
    });
    socket.on("error", (error) => finish(() => reject(error)));
  });
}

export async function pingZobLocalEndpoint(endpoint: string, msgId = `ping-${Date.now()}`): Promise<ZobLiveEnvelope> {
  return sendZobLocalEnvelope(endpoint, {
    schema: "zob.live-envelope.v1",
    type: "ping",
    msgId,
    hops: 0,
    timestamp: new Date().toISOString(),
    bodyStored: false,
  });
}

export { safeUnlinkSocket as pruneZobLocalEndpoint };
