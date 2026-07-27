import type {
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  ModelStreamEnvelope,
} from "@adaptive-agent/gateway-protocol";
import {
  validateRpcRequest,
} from "@adaptive-agent/gateway-protocol";
import type { GatewayAuthenticator, GatewayPrincipal } from "./auth";
import { GatewayError, gatewayError } from "./errors";
import type { GatewayService } from "./gateway-service";
import type { GatewayLogger } from "./logger";

const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_MAX_CONNECTIONS = 1_000;
const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 32;
const DEFAULT_MAX_BACKPRESSURE_BYTES = 1_048_576;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

interface GatewaySocketData {
  connectionId: string;
  principal: GatewayPrincipal;
  initialized: boolean;
  initializing: boolean;
  pendingRequestIds: Set<string>;
  queuedFrames: string[];
  queuedBytes: number;
  backpressured: boolean;
  lastActivityAt: number;
  closed: boolean;
}

export interface GatewayServerOptions {
  authenticator: GatewayAuthenticator;
  service: GatewayService;
  logger?: GatewayLogger;
  hostname?: string;
  port?: number;
  tls?: Bun.TLSOptions;
  maxFrameBytes?: number;
  maxConnections?: number;
  maxInFlightRequests?: number;
  maxBackpressureBytes?: number;
  idleTimeoutMs?: number;
}

export interface GatewayServer {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
  stop(options?: { gracePeriodMs?: number }): Promise<void>;
}

function requestIdKey(id: string | number): string {
  return `${typeof id}:${id}`;
}

function failure(id: string | number | null, error: JsonRpcError): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error,
  };
}

function publicFailure(
  id: string | number | null,
  error: unknown,
): JsonRpcErrorResponse {
  return failure(id, gatewayError(error).toJsonRpc(crypto.randomUUID()));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return normalized;
}

export function startGatewayServer(options: GatewayServerOptions): GatewayServer {
  const maxFrameBytes = normalizePositiveInteger(
    options.maxFrameBytes,
    DEFAULT_MAX_FRAME_BYTES,
    "maxFrameBytes",
  );
  const maxConnections = normalizePositiveInteger(
    options.maxConnections,
    DEFAULT_MAX_CONNECTIONS,
    "maxConnections",
  );
  const maxInFlightRequests = normalizePositiveInteger(
    options.maxInFlightRequests,
    DEFAULT_MAX_IN_FLIGHT_REQUESTS,
    "maxInFlightRequests",
  );
  const maxBackpressureBytes = normalizePositiveInteger(
    options.maxBackpressureBytes,
    DEFAULT_MAX_BACKPRESSURE_BYTES,
    "maxBackpressureBytes",
  );
  const idleTimeoutMs = normalizePositiveInteger(
    options.idleTimeoutMs,
    DEFAULT_IDLE_TIMEOUT_MS,
    "idleTimeoutMs",
  );

  const sockets = new Set<Bun.ServerWebSocket<GatewaySocketData>>();
  let acceptingConnections = true;
  let connectionSlots = 0;
  const log: GatewayLogger['log'] = (level, event, fields) => {
    try {
      options.logger?.log(level, event, fields);
    } catch {
      // Logging must not alter authentication or transport behavior.
    }
  };

  const closeSocket = (
    ws: Bun.ServerWebSocket<GatewaySocketData>,
    code: number,
    reason: string,
  ): void => {
    if (ws.data.closed) {
      return;
    }
    ws.data.closed = true;
    ws.close(code, reason);
  };

  const sendFrame = (
    ws: Bun.ServerWebSocket<GatewaySocketData>,
    payload: JsonRpcResponse<unknown> | JsonRpcNotification<string, unknown>,
  ): void => {
    if (ws.data.closed) {
      return;
    }

    const frame = JSON.stringify(payload);
    const frameBytes = byteLength(frame);

    if (ws.data.backpressured || ws.data.queuedFrames.length > 0) {
      if (
        ws.getBufferedAmount() + ws.data.queuedBytes + frameBytes >
        maxBackpressureBytes
      ) {
        closeSocket(ws, 1013, "backpressure limit exceeded");
        return;
      }
      ws.data.queuedFrames.push(frame);
      ws.data.queuedBytes += frameBytes;
      return;
    }

    const sent = ws.send(frame, false);
    if (sent > 0) {
      return;
    }
    if (sent === 0) {
      closeSocket(ws, 1011, "connection unavailable");
      return;
    }
    ws.data.backpressured = true;
  };

  const flushFrames = (ws: Bun.ServerWebSocket<GatewaySocketData>): void => {
    ws.data.backpressured = false;
    while (!ws.data.closed && ws.data.queuedFrames.length > 0) {
      const frame = ws.data.queuedFrames[0]!;
      const frameBytes = byteLength(frame);
      if (ws.getBufferedAmount() + frameBytes > maxBackpressureBytes) {
        closeSocket(ws, 1013, "backpressure limit exceeded");
        return;
      }
      const sent = ws.send(frame, false);
      if (sent === 0) {
        closeSocket(ws, 1011, "connection unavailable");
        return;
      }
      ws.data.queuedFrames.shift();
      ws.data.queuedBytes -= frameBytes;
      if (sent < 0) {
        ws.data.backpressured = true;
        return;
      }
    }
  };

  const handleRequest = async (
    ws: Bun.ServerWebSocket<GatewaySocketData>,
    request: JsonRpcRequest,
  ): Promise<void> => {
    const key = requestIdKey(request.id);
    if (ws.data.pendingRequestIds.has(key)) {
      sendFrame(
        ws,
        publicFailure(
          request.id,
          new GatewayError("invalid_params"),
        ),
      );
      return;
    }
    if (ws.data.pendingRequestIds.size >= maxInFlightRequests) {
      sendFrame(
        ws,
        publicFailure(
          request.id,
          new GatewayError("rate_limited"),
        ),
      );
      return;
    }

    ws.data.pendingRequestIds.add(key);
    try {
      if (request.method !== "initialize" && !ws.data.initialized) {
        throw new GatewayError("forbidden");
      }
      if (
        request.method === "initialize" &&
        (ws.data.initialized || ws.data.initializing)
      ) {
        throw new GatewayError("invalid_params");
      }
      if (request.method === "initialize") {
        ws.data.initializing = true;
      }

      const result = await options.service.handle(
        ws.data.principal,
        request.method,
        request.params,
        {
          traceId: crypto.randomUUID(),
          notify: (envelope: ModelStreamEnvelope) => sendFrame(ws, {
            jsonrpc: "2.0",
            method: "model/stream",
            params: envelope,
          }),
        },
      );
      if (request.method === "initialize") {
        ws.data.initialized = true;
      }
      sendFrame(ws, { jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      sendFrame(ws, publicFailure(request.id, error));
    } finally {
      if (request.method === "initialize") {
        ws.data.initializing = false;
      }
      ws.data.pendingRequestIds.delete(key);
    }
  };

  const server = Bun.serve<GatewaySocketData>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    tls: options.tls,
    maxRequestBodySize: maxFrameBytes,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname !== "/rpc" || url.search) {
        return new Response("Not Found", { status: 404 });
      }
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      }
      if (!acceptingConnections) {
        return new Response("Service Unavailable", { status: 503 });
      }
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Upgrade Required", { status: 426 });
      }
      if (connectionSlots >= maxConnections) {
        return new Response("Service Unavailable", { status: 503 });
      }
      connectionSlots += 1;

      let principal: GatewayPrincipal;
      try {
        principal = await options.authenticator(request.headers.get("authorization"));
      } catch (error) {
        connectionSlots -= 1;
        log("warn", "authentication.rejected", {
          errorType: error instanceof GatewayError ? error.gatewayCode : "unauthorized",
        });
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer" },
        });
      }
      if (!acceptingConnections) {
        connectionSlots -= 1;
        return new Response("Service Unavailable", { status: 503 });
      }

      const connectionId = crypto.randomUUID();
      let upgraded: boolean;
      try {
        upgraded = bunServer.upgrade(request, {
          data: {
            connectionId,
            principal,
            initialized: false,
            initializing: false,
            pendingRequestIds: new Set(),
            queuedFrames: [],
            queuedBytes: 0,
            backpressured: false,
            lastActivityAt: Date.now(),
            closed: false,
          },
        });
      } catch (error) {
        connectionSlots -= 1;
        throw error;
      }
      if (!upgraded) {
        connectionSlots -= 1;
        return new Response("WebSocket upgrade required", { status: 400 });
      }
      return undefined;
    },
    websocket: {
      maxPayloadLength: maxFrameBytes,
      backpressureLimit: maxBackpressureBytes,
      closeOnBackpressureLimit: true,
      open(ws) {
        sockets.add(ws);
        log("info", "websocket.opened", {
          connectionId: ws.data.connectionId,
          accountId: ws.data.principal.accountId,
          tenantId: ws.data.principal.tenantId,
        });
      },
      message(ws, message) {
        ws.data.lastActivityAt = Date.now();
        if (typeof message !== "string") {
          closeSocket(ws, 1003, "binary frames are not supported");
          return;
        }
        if (byteLength(message) > maxFrameBytes) {
          closeSocket(ws, 1009, "frame exceeds maximum size");
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(message);
        } catch {
          sendFrame(
            ws,
            failure(null, { code: -32700, message: "Parse error" }),
          );
          return;
        }
        if (Array.isArray(parsed)) {
          sendFrame(
            ws,
            failure(
              null,
              { code: -32600, message: "Invalid Request" },
            ),
          );
          return;
        }
        let request: JsonRpcRequest;
        try {
          request = validateRpcRequest(parsed);
        } catch {
          sendFrame(
            ws,
            failure(null, { code: -32600, message: "Invalid Request" }),
          );
          return;
        }

        void handleRequest(ws, request);
      },
      drain(ws) {
        ws.data.lastActivityAt = Date.now();
        flushFrames(ws);
      },
      close(ws, code) {
        ws.data.closed = true;
        sockets.delete(ws);
        connectionSlots = Math.max(0, connectionSlots - 1);
        log("info", "websocket.closed", {
          connectionId: ws.data.connectionId,
          accountId: ws.data.principal.accountId,
          tenantId: ws.data.principal.tenantId,
          status: String(code),
        });
      },
    },
  });

  const idleTimer = setInterval(
    () => {
      const idleBefore = Date.now() - idleTimeoutMs;
      for (const socket of sockets) {
        if (
          socket.data.pendingRequestIds.size === 0 &&
          socket.data.lastActivityAt <= idleBefore
        ) {
          closeSocket(socket, 1001, "idle timeout");
        }
      }
    },
    Math.min(Math.max(Math.floor(idleTimeoutMs / 2), 25), 1_000),
  );
  idleTimer.unref();

  return {
    hostname: server.hostname ?? options.hostname ?? "127.0.0.1",
    port: server.port ?? options.port ?? 0,
    url: `${options.tls ? "wss" : "ws"}://${server.hostname}:${server.port}/rpc`,
    async stop(stopOptions = {}) {
      acceptingConnections = false;
      clearInterval(idleTimer);
      void server.stop(false).catch(() => undefined);

      const gracePeriodMs = stopOptions.gracePeriodMs ?? 5_000;
      const deadline = Date.now() + Math.max(0, gracePeriodMs);
      while (
        Date.now() < deadline &&
        ([...sockets].some((socket) => socket.data.pendingRequestIds.size > 0) ||
          options.service.activeCallCount() > 0)
      ) {
        await Bun.sleep(10);
      }

      for (const socket of sockets) {
        closeSocket(socket, 1001, "server shutting down");
      }
      try {
        await options.service.close();
      } finally {
        await server.stop(true);
      }
    },
  };
}
