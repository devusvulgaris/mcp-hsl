# mcp-hsl

[![npm version](https://img.shields.io/npm/v/mcp-hsl.svg)](https://www.npmjs.com/package/mcp-hsl)
[![Node.js](https://img.shields.io/node/v/mcp-hsl.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/npm/l/mcp-hsl.svg)](./LICENSE)

MCP server exposing **Greater Helsinki (HSL)** public-transport data from [Digitransit](https://digitransit.fi). Covers Helsinki, Espoo, Vantaa, Kauniainen, Kerava, Kirkkonummi, Sipoo, Siuntio, and Tuusula.

Lets an LLM host (Claude Desktop, Claude Code, Cursor, etc.) answer live-transit questions like *"next tram from Kamppi to Töölö"* or *"plan a trip from Otaniemi to Kallio at 5pm"*.

## Prerequisites

- **Node.js 20.6 or newer** (uses native `--env-file`).
- A free Digitransit subscription key (see below).

## Getting a Digitransit API key

Digitransit publishes HSL data through an Azure API Management portal. The key is free and easy to obtain.

1. Go to <https://portal-api.digitransit.fi/> and click **Sign up** (top rig
ht).
2. Verify your email and sign in.
3. Open **Products** → pick **Digitransit API** (the free tier).
4. Click **Subscribe**, give the subscription a name (e.g. `mcp-hsl`), and confirm.
5. Under **Profile → Subscriptions**, reveal the **Primary key**. That's you
r `DIGITRANSIT_SUBSCRIPTION_KEY`.

The free tier has generous rate limits (see <https://digitransit.fi/en/developers/api-registration/> for current numbers). Keep the key private — treat it like a password.

## Install

`mcp-hsl` is a standard stdio MCP server, so any [MCP-compatible host](https://modelcontextprotocol.io/clients) can use it — Claude Desktop, Claude Code, Cursor, VS Code (GitHub Copilot), Windsurf, Zed, and so on.

### Option A — CLI (fastest, if your host has one)

```sh
# Claude Code
claude mcp add hsl-transit -e DIGITRANSIT_SUBSCRIPTION_KEY=your-key -- npx -y mcp-hsl
```

Other hosts (Cursor, VS Code) offer GUI-driven "Add MCP server" flows in their command palettes — same fields as the JSON below.

### Option B — Config file

Add this entry to your host's MCP config:

```json
{
  "mcpServers": {
    "hsl-transit": {
      "command": "npx",
      "args": ["-y", "mcp-hsl"],
      "env": {
        "DIGITRANSIT_SUBSCRIPTION_KEY": "your-key-here"
      }
    }
  }
}
```

Where to put it:

| Host | Config path | Wrapper key |
|---|---|---|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers` |
| Claude Code | `~/.claude.json` (or use `claude mcp add`) | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) | `mcpServers` |
| VS Code (Copilot) | `.vscode/mcp.json` (project) or user settings | `servers` |

> VS Code uses `"servers"` instead of `"mcpServers"` — otherwise the entry is identical.

Restart the host after editing the config. The server should appear as **Connected** / **Ready**.

## Local development

```sh
git clone <this-repo>
cd mcp-hsl
npm install
cp .env.example .env      # then fill in DIGITRANSIT_SUBSCRIPTION_KEY
npm run build
```

Run against your own build:

```json
{
  "mcpServers": {
    "hsl-transit": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/mcp-hsl/.env",
        "/absolute/path/to/mcp-hsl/build/stdio.js"
      ]
    }
  }
}
```

The server exits immediately with a clear message if `DIGITRANSIT_SUBSCRIPTION_KEY` is missing.

## HTTP / SSE Server & Docker (e.g. Home Assistant)

For long-lived server deployments (like **Home Assistant**, remote agent hosts, or LAN services), `mcp-hsl` provides a stateful network entry point supporting both **Streamable HTTP** (recommended) and legacy **SSE** transports.

### Endpoints

| Endpoint | Methods | Description | Headers / Query Params |
|---|---|---|---|
| `/mcp` | `POST` | **Session Initialization & Requests:**<br>• Omit `mcp-session-id` to initialize a new session (returns `mcp-session-id` header).<br>• Include `mcp-session-id` for subsequent tool calls. | `mcp-session-id: <id>` (for existing sessions)<br>`Accept: application/json, text/event-stream` |
| `/mcp` | `GET` | **Server-to-Client SSE Stream:**<br>Holds open a persistent event stream for the active session. | `mcp-session-id: <id>`<br>`Accept: text/event-stream` |
| `/mcp` | `DELETE` | **Session Teardown:**<br>Terminates the active session and cleans up resources. | `mcp-session-id: <id>` |
| `/sse` | `GET` | **Legacy SSE Transport:**<br>Connects to the event stream and receives endpoint discovery event. | `Accept: text/event-stream` |
| `/messages` | `POST` | **Legacy SSE Message Endpoint:**<br>Delivers JSON-RPC requests to the SSE session. | `sessionId=<id>` (query param or header) |
| `/healthz` | `GET` | **Health & Metrics:**<br>Returns health status and active session counts. | — |

The Streamable HTTP endpoint is also mounted at the root path, so `POST`/`GET`/`DELETE` on `/`
behave exactly like `/mcp`. Clients that assume the server lives at the root of the URL work
without extra configuration.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DIGITRANSIT_SUBSCRIPTION_KEY` | *(Required)* | Free API subscription key from Digitransit |
| `PORT` | `8000` | Port for the HTTP server to listen on |
| `HOST` | `0.0.0.0` | Network host interface binding |
| `MAX_SESSIONS` | `50` | Maximum number of concurrent active sessions |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` (30m) | Idle timeout before evicting abandoned sessions without open streams |
| `ALLOWED_ORIGINS` | localhost + private LAN | Comma-separated allowlist of browser origins (DNS-rebinding protection) |

`ALLOWED_ORIGINS` accepts either full origins or bare hostnames — `https://ha.example.com`,
`ha.example.com` and `ha.example.com:8123` are equivalent, and the port is never significant.
Localhost origins stay allowed whatever you configure, so local tooling such as MCP Inspector
keeps working. Set `ALLOWED_ORIGINS=*` to disable the check entirely.

Left unset, the default also accepts origins on the local network — `.local` / `.home` / `.lan`
hostnames and RFC 1918 addresses — so a Home Assistant instance on the same LAN connects without
configuration. Set `ALLOWED_ORIGINS` explicitly to replace that default with a strict allowlist.

Requests without an `Origin` header are always allowed: the header is a browser mechanism, and
non-browser MCP clients (Home Assistant's included) never send one.

### Running locally with Node

```sh
npm run build
npm run start:http
```

### Running with Docker

Build and run the container:

```sh
docker build -t mcp-hsl .
docker run -d -p 8000:8000 \
  -e DIGITRANSIT_SUBSCRIPTION_KEY="your-key-here" \
  --name mcp-hsl mcp-hsl
```

### Home Assistant Integration

In Home Assistant's MCP configuration:
- For **Streamable HTTP (Recommended)**: set URL to `http://<server-ip>:8000/mcp`
- For **SSE (Legacy)**: set URL to `http://<server-ip>:8000/sse`

## Tools

| Name | Purpose | Key inputs |
|---|---|---|
| `geocode` | Place / address → coordinates | `query`, `limit` |
| `plan_journey` | Route between two places | `origin`, `destination`, optional `modes`, `departureTime` |
| `stop_departures` | Next departures from a stop | `stopId` OR `stopName`, `numberOfDepartures` |

All three call Digitransit's HSL routing API. `plan_journey` geocodes both endpoints internally; `stop_departures` looks up a stop by name if you don't have the HSL ID.

### `plan_journey` modes

Filter transit modes with the `modes` array: `BUS`, `TRAM`, `RAIL`, `SUBWAY`, `FERRY`. Omit to allow any. `departureTime` is an ISO 8601 timestamp with offset (e.g. `2026-08-13T17:00:00+03:00`); defaults to now.

### `stop_departures` name lookup

HSL stop IDs look like `HSL:1140447`. If you pass `stopName` and it matches multiple stops (e.g. Kamppi has several platform IDs), the tool returns the candidate list — the LLM then re-calls with the specific `stopId`.

## Example prompts

- *"Geocode 'Kamppi metro station' in Helsinki."*
- *"When are the next departures from Kamppi?"*
- *"Plan a tram journey from Kamppi to Töölö."*
- *"Get me from Otaniemi to Kallio around 5pm today, no bus."*
- *"Kamppista Töölöön seuraava ratikka?"* 

## Design notes

- **Transport-agnostic core.** `src/server.ts` exposes a `buildServer()` factory that registers tools without touching any transport. To add HTTP later, add a new entry point that calls `buildServer()` and wires it to `StreamableHTTPServerTransport`.
- **Output for LLMs.** Tool results are compact plain-text tables/blocks — enough for the model to reason over without wasting tokens on raw GraphQL responses.
- **Multilingual.** Digitransit returns Finnish and Swedish names side by side; the LLM handles user-facing language.
- **Real-time.** Journey legs and departures include real-time state (`SCHEDULED`, `UPDATED`, `CANCELED`) so the model can distinguish "on time" from "delayed 3 min".

## Attribution

Data © Helsinki Region Transport (HSL) and other producers, provided by [Digitransit](https://digitransit.fi) under [Creative Commons BY 4.0](https://creativecommons.org/licenses/by/4.0/). This project is not affiliated with HSL or Digitransit.

## License

MIT — see [LICENSE](./LICENSE).
