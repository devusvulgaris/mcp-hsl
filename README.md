# mcp-hsl

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

## Quick start (from npm)

```json
// Claude Desktop / Claude Code MCP config
{
  "mcpServers": {
    "helsinki-transit": {
      "command": "npx",
      "args": ["-y", "mcp-hsl"],
      "env": {
        "DIGITRANSIT_SUBSCRIPTION_KEY": "your-key-here"
      }
    }
  }
}
```

Restart the client. The server should appear as **Connected**.

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
    "helsinki-transit": {
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
