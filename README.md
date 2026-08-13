# mcp-helsinki-transit

MCP server exposing Greater Helsinki (HSL) public-transport data from [Digitransit](https://digitransit.fi). Lets an LLM host (Claude Desktop, Claude Code, Cursor, etc.) answer live-transit questions like *"next tram from Kamppi to Töölö"* or *"plan a trip from Otaniemi to Kallio at 5pm"*.

## Prerequisites

- Node.js 20 or newer.
- A free Digitransit API key from <https://digitransit.fi/en/developers/api-registration/>.

## Install

```sh
npm install
npm run build
```

The build output goes to `build/`. The stdio entry point is `build/stdio.js`.

## API key

The server reads the key from `DIGITRANSIT_SUBSCRIPTION_KEY`. It exits immediately with a clear message if the variable is missing.

Local shell:

```sh
export DIGITRANSIT_SUBSCRIPTION_KEY=your-key-here
node build/stdio.js
```

## Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on Windows/Linux:

```json
{
  "mcpServers": {
    "helsinki-transit": {
      "command": "node",
      "args": ["/Users/oleg/Projects/Personal/mcp-helsinki-transit/build/stdio.js"],
      "env": {
        "DIGITRANSIT_SUBSCRIPTION_KEY": "your-key-here"
      }
    }
  }
}
```

Restart Claude Desktop (Cmd+Q, reopen). The server should show as **Connected** in Developer Tools.

## Tools

| Name | Purpose | Key inputs |
|---|---|---|
| `geocode` | Place / address → coordinates | `query`, `limit` |
| `plan_journey` | Route between two places | `origin`, `destination`, optional `modes`, `departureTime` |
| `stop_departures` | Next departures from a stop | `stopId` OR `stopName`, `numberOfDepartures` |

All three call Digitransit's HSL routing API. `plan_journey` geocodes both endpoints internally; `stop_departures` looks up a stop by name if you don't have the HSL ID.

## Example prompts

- *"Geocode 'Kamppi metro station' in Helsinki."*
- *"When are the next departures from Kamppi?"*
- *"Plan a tram journey from Kamppi to Töölö."*
- *"Get me from Otaniemi to Kallio around 5pm today, no bus."*
- *"Kamppista Töölöön seuraava ratikka?"* (Finnish works — the LLM translates)

## Stop ID format

HSL stop IDs look like `HSL:1140447`. You can find them on the HSL journey planner or via the `stop_departures` name-lookup flow — if a name matches multiple stops, the tool returns the candidate IDs so you can pick one.

## Design notes

- **Transport-agnostic core.** `src/server.ts` exposes a `buildServer()` factory that registers tools without touching any transport. To add HTTP later, add a new entry point that calls `buildServer()` and wires it to `StreamableHTTPServerTransport`.
- **Output for LLMs.** Tool results are compact plain-text tables/blocks — enough for the model to reason over without wasting tokens on raw GraphQL responses.
- **Multilingual.** Digitransit returns Finnish and Swedish names side by side; the LLM handles user-facing language.
- **Real-time.** Journey legs and departures include real-time state (`SCHEDULED`, `UPDATED`, `CANCELED`) so the model can distinguish "on time" from "delayed 3 min".
