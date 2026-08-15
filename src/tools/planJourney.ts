import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { gqlClient, geocode, formatEpochMs, type GeocodeResult } from "../graphqlClient.js";

const TRANSPORT_MODES = ["BUS", "TRAM", "RAIL", "SUBWAY", "FERRY", "WALK"] as const;

const inputSchema = z.object({
  origin: z
    .string()
    .min(1)
    .describe(
      "Origin: place name, address, or landmark in Greater Helsinki (e.g. 'Kamppi', 'Otaniemi'). Geocoded internally.",
    ),
  destination: z
    .string()
    .min(1)
    .describe("Destination: place name, address, or landmark. Geocoded internally."),
  modes: z
    .array(z.enum(TRANSPORT_MODES))
    .optional()
    .describe(
      "Optional filter of allowed transit modes (BUS, TRAM, RAIL, SUBWAY, FERRY). Omit to allow any.",
    ),
  departureTime: z
    .iso.datetime({ offset: true })
    .optional()
    .describe(
      "ISO 8601 timestamp WITH offset, e.g. '2026-08-07T15:00:00+03:00' or '...Z'. Defaults to now.",
    ),
  numItineraries: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe("How many itineraries to return."),
});

type PlanResult = {
  planConnection: {
    edges: Array<{
      node: {
        start: string;
        end: string;
        legs: Array<{
          mode: string;
          duration: number;
          from: { name: string };
          to: { name: string };
          start: { scheduledTime: string };
          end: { scheduledTime: string };
          realtimeState: string | null;
          route: { shortName: string | null } | null;
        }>;
      };
    }>;
  };
};

function pickTop(features: GeocodeResult[], label: string): GeocodeResult {
  if (features.length === 0) throw new Error(`Could not geocode "${label}".`);
  return features[0];
}

function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function buildPlanQuery(opts: {
  oLat: number;
  oLon: number;
  dLat: number;
  dLon: number;
  first: number;
  dt: string;
  modes: string[] | null;
}): string {
  const transitFilter =
    opts.modes && opts.modes.length > 0
      ? `, modes: { transit: { transit: [${opts.modes.map((m) => `{ mode: ${m} }`).join(", ")}] } }`
      : "";
  return `query {
    planConnection(
      origin: { location: { coordinate: { latitude: ${opts.oLat}, longitude: ${opts.oLon} } } }
      destination: { location: { coordinate: { latitude: ${opts.dLat}, longitude: ${opts.dLon} } } }
      first: ${opts.first}
      dateTime: { earliestDeparture: "${opts.dt}" }
      ${transitFilter}
    ) {
      edges {
        node {
          start
          end
          legs {
            mode
            duration
            from { name }
            to { name }
            start { scheduledTime }
            end { scheduledTime }
            realtimeState
            route { shortName }
          }
        }
      }
    }
  }`;
}

export function registerPlanJourney(server: McpServer): void {
  server.registerTool(
    "plan_journey",
    {
      title: "Plan a Helsinki transit journey",
      description:
        "Plan a public-transport journey between two places in Greater Helsinki. " +
        "Accepts place names or addresses; both endpoints are geocoded internally. " +
        "Returns up to 5 itineraries, each with legs, modes, line numbers, and real-time status. " +
        "Departure time defaults to now; provide an ISO 8601 timestamp with offset to plan ahead.",
      inputSchema,
    },
    async ({ origin, destination, modes, departureTime, numItineraries }) => {
      const [oFeatures, dFeatures] = await Promise.all([
        geocode(origin, 3),
        geocode(destination, 3),
      ]);
      const o = pickTop(oFeatures, origin);
      const d = pickTop(dFeatures, destination);

      const warnings: string[] = [];
      if (o.confidence < 0.7) {
        warnings.push(
          `Origin match "${o.label}" is low confidence (${o.confidence.toFixed(2)}). Consider disambiguating.`,
        );
      }
      if (d.confidence < 0.7) {
        warnings.push(
          `Destination match "${d.label}" is low confidence (${d.confidence.toFixed(2)}). Consider disambiguating.`,
        );
      }

      const transitModes = modes
        ? modes.filter((m): m is Exclude<(typeof TRANSPORT_MODES)[number], "WALK"> => m !== "WALK")
        : null;

      const query = buildPlanQuery({
        oLat: o.lat,
        oLon: o.lon,
        dLat: d.lat,
        dLon: d.lon,
        first: numItineraries,
        dt: departureTime ?? new Date().toISOString(),
        modes: transitModes,
      });

      const data = await gqlClient.request<PlanResult>(query);

      const itineraries = data.planConnection.edges;
      if (itineraries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `No itineraries found from "${o.label}" to "${d.label}".` +
                (warnings.length ? "\n\nWarnings:\n" + warnings.join("\n") : ""),
            },
          ],
        };
      }

      const blocks = itineraries.map((edge, i) => {
        const it = edge.node;
        const startMs = new Date(it.start).getTime();
        const endMs = new Date(it.end).getTime();
        const totalMin = Math.round((endMs - startMs) / 60000);
        const startFmt = formatEpochMs(startMs);
        const endFmt = formatEpochMs(endMs);
        const legLines = it.legs.map((leg) => {
          const line = leg.route?.shortName ? ` ${leg.route.shortName}` : "";
          const rt =
            leg.realtimeState && leg.realtimeState !== "SCHEDULED"
              ? ` [${leg.realtimeState.toLowerCase()}]`
              : "";
          return `    ${leg.mode}${line}: ${leg.from.name} → ${leg.to.name} (${fmtDuration(leg.duration)})${rt}`;
        });
        return (
          `Itinerary ${i + 1}: ${startFmt.localHelsinki} → ${endFmt.localHelsinki} (${totalMin} min)\n` +
          legLines.join("\n")
        );
      });

      const header = `From: ${o.label}\nTo:   ${d.label}\n`;
      const warningBlock = warnings.length ? "\nWarnings:\n" + warnings.join("\n") + "\n" : "";
      return {
        content: [{ type: "text", text: `${header}${warningBlock}\n${blocks.join("\n\n")}` }],
      };
    },
  );
}
