/**
 * src/http.ts — network entry point for mcp-hsl.
 *
 * Stateful Streamable HTTP + Legacy SSE transport.
 * Home Assistant's MCP client requires a stateful session: it expects an `mcp-session-id`
 * header back from initialize, and uses GET /mcp for the server->client SSE stream
 * and DELETE /mcp to tear down.
 *
 * Serves:
 *   Streamable HTTP (Stateful) -> POST /mcp or POST / (init/requests), GET /mcp or GET / (stream), DELETE /mcp or DELETE / (close)
 *   SSE Transport (Legacy)    -> GET /sse + POST /messages?sessionId=...
 *   Health check              -> GET /healthz
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import {
  WebStandardStreamableHTTPServerTransport,
  isInitializeRequest,
  isJSONRPCRequest,
  isJSONRPCNotification,
  isJSONRPCResponse,
  validateOriginHeader,
  localhostAllowedOrigins,
  type Transport,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { buildServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? "0.0.0.0";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 50);
const SESSION_IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_TIMEOUT_MS ?? 30 * 60 * 1000); // 30 mins

if (!process.env.DIGITRANSIT_SUBSCRIPTION_KEY) {
  console.error("DIGITRANSIT_SUBSCRIPTION_KEY is not set — exiting.");
  process.exit(1);
}

const app = express();

// ------------------------------------------------ DNS Rebinding & Origin Protection --

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}

/**
 * `validateOriginHeader` matches bare hostnames, but `ALLOWED_ORIGINS` reads like a
 * list of origins — so accept both spellings: `https://ha.example.com`,
 * `ha.example.com` and `ha.example.com:8123` all resolve to the same hostname.
 */
function toOriginHostname(entry: string): string {
  for (const candidate of [entry, `http://${entry}`]) {
    try {
      const { hostname } = new URL(candidate);
      if (hostname) return hostname;
    } catch {}
  }
  return entry.toLowerCase();
}

/**
 * Hostnames from `ALLOWED_ORIGINS`, or `undefined` when it is unset. Localhost is
 * always included: configuring a remote origin should not lock out MCP Inspector
 * and other local tooling.
 */
function configuredOriginHostnames(): string[] | undefined {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return undefined;

  const configured = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(toOriginHostname);

  return [...new Set([...configured, ...localhostAllowedOrigins()])];
}

function isAllowedOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true; // Non-browser clients (e.g. Home Assistant httpx client)

  if (process.env.ALLOWED_ORIGINS === "*") return true;

  const configured = configuredOriginHostnames();
  if (configured) {
    return validateOriginHeader(originHeader, configured).ok;
  }

  return validateOriginHeader(originHeader, localhostAllowedOrigins()).ok;
}

app.use((req, res, next) => {
  const originHeader = req.headers.origin as string | undefined;

  if (!originHeader) {
    return next();
  }

  if (!isAllowedOrigin(originHeader)) {
    res.status(403).json(jsonRpcError(-32000, "Forbidden: Origin not allowed"));
    return;
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Origin", originHeader);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, mcp-session-id, mcp-protocol-version",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "mcp-session-id, mcp-protocol-version, content-type",
  );

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Parsed after the origin check so rejected requests never reach the body parser.
app.use(express.json({ limit: "1mb" }));

// ------------------------------------------------ Web Standard Bridge Helpers --

function toWebRequest(req: Request): globalThis.Request {
  const protocol = req.protocol || "http";
  const host = req.get("host") || "localhost";
  const url = new URL(req.originalUrl || req.url, `${protocol}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  // Ensure an Accept header exists so clients that omit Accept or send */* don't get 406
  if (!headers.has("accept") || headers.get("accept") === "*/*") {
    headers.set("accept", "application/json, text/event-stream");
  }

  const init: RequestInit = {
    method: req.method,
    headers,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.body && typeof req.body === "object") {
      init.body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : JSON.stringify(req.body);
    } else if (typeof req.body === "string") {
      init.body = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      init.body = new Uint8Array(req.body);
    }
  }

  return new globalThis.Request(url.toString(), init);
}

async function sendWebResponse(
  webRes: globalThis.Response,
  res: Response,
  touch?: () => void,
): Promise<void> {
  res.status(webRes.status);
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  const isEventStream = webRes.headers.get("content-type")?.includes("text/event-stream");
  if (isEventStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    // Send an immediate SSE comment frame to prime the stream and confirm wire readiness
    res.write(": connected\n\n");
  } else {
    res.flushHeaders?.();
  }

  if (!webRes.body) {
    res.end();
    return;
  }

  const reader = webRes.body.getReader();
  const onClientClose = () => {
    void reader.cancel();
  };
  res.on("close", onClientClose);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      touch?.();
      res.write(Buffer.from(value));
    }
  } catch (err) {
    if (!res.writableEnded) {
      console.error("Error streaming response:", err);
    }
  } finally {
    res.off("close", onClientClose);
    if (!res.writableEnded) {
      res.end();
    }
  }
}

// ------------------------------------------------ Session Tracking & Idle Eviction --

interface StreamableSessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  lastActive: number;
  activeStreams: number;
}

interface SseSessionEntry {
  server: ReturnType<typeof buildServer>;
  transport: SseServerTransport;
  res: Response;
  lastActive: number;
}

const streamableTransports = new Map<string, StreamableSessionEntry>();
const sseSessions = new Map<string, SseSessionEntry>();

// Periodic sweep to evict abandoned sessions
const idleSweepInterval = setInterval(() => {
  const now = Date.now();

  for (const [sid, entry] of streamableTransports.entries()) {
    // Exempt sessions with active streams (e.g. GET /mcp long-lived SSE stream from HA)
    if (entry.activeStreams > 0) {
      continue;
    }
    if (now - entry.lastActive > SESSION_IDLE_TIMEOUT_MS) {
      console.error(`Evicting abandoned Streamable HTTP session: ${sid}`);
      void entry.transport.close();
      streamableTransports.delete(sid);
    }
  }

  for (const [sid, entry] of sseSessions.entries()) {
    if (entry.res.writableEnded || entry.res.closed) {
      void entry.transport.close();
      void entry.server.close();
      sseSessions.delete(sid);
      continue;
    }
    // If keepalive was not refreshed or connection died unclosed
    if (now - entry.lastActive > SESSION_IDLE_TIMEOUT_MS) {
      console.error(`Evicting abandoned SSE session: ${sid}`);
      void entry.transport.close();
      void entry.server.close();
      sseSessions.delete(sid);
    }
  }
}, 60_000);
idleSweepInterval.unref();

// ---------------------------------------------------- Health Check --

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    streamableSessions: streamableTransports.size,
    sseSessions: sseSessions.size,
    maxSessions: MAX_SESSIONS,
  });
});

// --------------------------------------------------------- Streamable HTTP --

async function handleStreamablePost(req: Request, res: Response) {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId) {
      const entry = streamableTransports.get(sessionId);
      if (!entry) {
        res.status(404).json(jsonRpcError(-32001, "Session not found"));
        return;
      }
      entry.lastActive = Date.now();

      const webRequest = toWebRequest(req);
      const webResponse = await entry.transport.handleRequest(webRequest, {
        parsedBody: req.body,
      });
      await sendWebResponse(webResponse, res, () => {
        entry.lastActive = Date.now();
      });
      return;
    }

    if (isInitializeRequest(req.body)) {
      if (streamableTransports.size >= MAX_SESSIONS) {
        res.status(503).json(jsonRpcError(-32000, "Server session limit reached"));
        return;
      }

      const newTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          streamableTransports.set(sid, {
            transport: newTransport,
            lastActive: Date.now(),
            activeStreams: 0,
          });
          console.error(`Streamable HTTP session opened: ${sid}`);
        },
        onsessionclosed: (sid: string) => {
          streamableTransports.delete(sid);
          console.error(`Streamable HTTP session closed: ${sid}`);
        },
      });

      newTransport.onclose = () => {
        if (newTransport.sessionId) {
          streamableTransports.delete(newTransport.sessionId);
        }
      };

      const server = buildServer();
      try {
        await server.connect(newTransport);

        const webRequest = toWebRequest(req);
        const webResponse = await newTransport.handleRequest(webRequest, {
          parsedBody: req.body,
        });

        const sid = newTransport.sessionId;
        const createdEntry = sid ? streamableTransports.get(sid) : undefined;
        await sendWebResponse(webResponse, res, () => {
          if (createdEntry) createdEntry.lastActive = Date.now();
        });
      } catch (err) {
        void newTransport.close();
        void server.close();
        if (newTransport.sessionId) {
          streamableTransports.delete(newTransport.sessionId);
        }
        throw err;
      }
      return;
    }

    res.status(400).json(
      jsonRpcError(-32000, "Bad Request: missing mcp-session-id and not an initialize request"),
    );
  } catch (err) {
    console.error("POST /mcp failed:", err);
    if (!res.headersSent) {
      res.status(500).json(jsonRpcError(-32603, "Internal server error"));
    }
  }
}

async function sessionScopedStreamableRequest(req: Request, res: Response) {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId) {
      res.status(400).json(jsonRpcError(-32000, "Bad Request: missing mcp-session-id"));
      return;
    }

    // 404 (not 400) for an unrecognised id: the spec makes it the signal that lets a
    // client tell "session expired, re-initialize" apart from "malformed request".
    const entry = streamableTransports.get(sessionId);
    if (!entry) {
      res.status(404).json(jsonRpcError(-32001, "Session not found"));
      return;
    }

    entry.lastActive = Date.now();

    if (req.method === "GET") {
      entry.activeStreams++;
      res.on("close", () => {
        entry.activeStreams = Math.max(0, entry.activeStreams - 1);
        entry.lastActive = Date.now();
      });
    }

    const webRequest = toWebRequest(req);
    const webResponse = await entry.transport.handleRequest(webRequest);
    await sendWebResponse(webResponse, res, () => {
      entry.lastActive = Date.now();
    });
  } catch (err) {
    console.error(`${req.method} /mcp failed:`, err);
    if (!res.headersSent) {
      res.status(500).json(jsonRpcError(-32603, "Internal server error"));
    }
  }
}

// Support both /mcp and / base paths
app.post(["/mcp", "/"], handleStreamablePost);
app.get(["/mcp", "/"], sessionScopedStreamableRequest);
app.delete(["/mcp", "/"], sessionScopedStreamableRequest);

// ------------------------------------------------------------------- SSE ----

// If a client attempts Streamable HTTP POST against the /sse endpoint, return 405 Method Not Allowed
// so clients (like Home Assistant) immediately fall back to the SSE transport.
app.post("/sse", (_req: Request, res: Response) => {
  res.status(405).setHeader("Allow", "GET").send("Method Not Allowed: Use GET for SSE transport");
});

class SseServerTransport implements Transport {
  sessionId: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private res: Response;
  private closed = false;

  constructor(sessionId: string, res: Response) {
    this.sessionId = sessionId;
    this.res = res;
  }

  async start(): Promise<void> {
    this.res.write(`event: endpoint\ndata: /messages?sessionId=${this.sessionId}\n\n`);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return;
    this.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
    if (!this.res.writableEnded) {
      this.res.end();
    }
  }

  handlePostMessage(message: JSONRPCMessage): void {
    if (this.closed) throw new Error("Transport is closed");
    this.onmessage?.(message);
  }
}

app.get("/sse", async (_req: Request, res: Response) => {
  if (sseSessions.size >= MAX_SESSIONS) {
    res.status(503).json(jsonRpcError(-32000, "Server session limit reached"));
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const sessionId = randomUUID();
  const transport = new SseServerTransport(sessionId, res);
  const server = buildServer();

  sseSessions.set(sessionId, { server, transport, res, lastActive: Date.now() });

  const keepAliveInterval = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": keepalive\n\n");
      const entry = sseSessions.get(sessionId);
      if (entry) entry.lastActive = Date.now();
    }
  }, 15000);

  res.on("close", () => {
    clearInterval(keepAliveInterval);
    sseSessions.delete(sessionId);
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
  } catch (err) {
    console.error("SSE connect failed:", err);
    clearInterval(keepAliveInterval);
    sseSessions.delete(sessionId);
    void transport.close();
    void server.close();
    if (!res.writableEnded) {
      res.end();
    }
  }
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId ?? req.headers["mcp-session-id"] ?? "");
  const session = sseSessions.get(sessionId);

  if (!session) {
    res.status(404).json(jsonRpcError(-32001, "Unknown or expired sessionId"));
    return;
  }

  // Validate JSON-RPC payload structure (requests, notifications, and responses)
  const body = req.body;
  if (!isJSONRPCRequest(body) && !isJSONRPCNotification(body) && !isJSONRPCResponse(body)) {
    res.status(400).json(jsonRpcError(-32600, "Invalid JSON-RPC message"));
    return;
  }

  session.lastActive = Date.now();

  try {
    session.transport.handlePostMessage(body);
    res.status(202).end();
  } catch (err) {
    console.error("Error processing SSE post message:", err);
    res.status(500).json(jsonRpcError(-32603, "Failed to process message"));
  }
});

// -------------------------------------------------------- Fallback Handlers --

app.use((_req: Request, res: Response) => {
  res.status(404).json(jsonRpcError(-32601, "Not Found"));
});

// Keeps malformed input and unexpected throws on the JSON-RPC error shape rather than
// falling through to Express' default HTML error page (which leaks a stack trace
// outside production).
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  // Body parser rejections (malformed JSON, payload over the limit) carry an HTTP status.
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const parseError = err instanceof SyntaxError;
    res
      .status(status)
      .json(jsonRpcError(parseError ? -32700 : -32600, parseError ? "Parse error" : "Bad Request"));
    return;
  }

  console.error("Unhandled request error:", err);
  res.status(500).json(jsonRpcError(-32603, "Internal server error"));
});

// ----------------------------------------------------------------- Listen ---

const httpServer = app.listen(PORT, HOST, () => {
  console.error(`mcp-hsl listening on http://${HOST}:${PORT}`);
  console.error(`  health check:    GET    /healthz`);
  console.error(`  streamable http: POST   /mcp or /   (initialize / requests)`);
  console.error(`                   GET    /mcp or /   (server stream)`);
  console.error(`                   DELETE /mcp or /   (terminate)`);
  console.error(`  sse transport:   GET    /sse        +  POST /messages?sessionId=...`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(idleSweepInterval);
    for (const entry of streamableTransports.values()) {
      void entry.transport.close();
    }
    for (const session of sseSessions.values()) {
      void session.transport.close();
      void session.server.close();
    }
    httpServer.close(() => process.exit(0));
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Promise Rejection:", reason);
});
