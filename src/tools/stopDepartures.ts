import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server"
import { gql } from "graphql-request";
import { gqlClient, formatDeparture } from "../graphqlClient.js";

const inputSchema = z.object({
  stopId: z
    .string()
    .optional()
    .describe('HSL GTFS stop ID, e.g. "HSL:1140447". Provide this OR stopName.'),
  stopName: z
    .string()
    .optional()
    .describe('Human-readable stop name, e.g. "Kamppi". Provide this OR stopId.'),
  numberOfDepartures: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe("How many upcoming departures to return."),
});

type StopSearchResult = {
  stops: Array<{ gtfsId: string; name: string; code: string | null; vehicleMode: string | null }>;
};

const STOP_SEARCH = gql`
  query StopSearch($name: String!) {
    stops(name: $name) {
      gtfsId
      name
      code
      vehicleMode
    }
  }
`;

type DeparturesResult = {
  stop: {
    name: string;
    code: string | null;
    vehicleMode: string | null;
    stoptimesWithoutPatterns: Array<{
      serviceDay: number;
      scheduledDeparture: number;
      realtimeDeparture: number;
      departureDelay: number;
      realtime: boolean;
      realtimeState: string;
      headsign: string | null;
      trip: { route: { shortName: string | null } };
    }>;
  } | null;
};

const DEPARTURES = gql`
  query Departures($id: String!, $n: Int!) {
    stop(id: $id) {
      name
      code
      vehicleMode
      stoptimesWithoutPatterns(numberOfDepartures: $n) {
        serviceDay
        scheduledDeparture
        realtimeDeparture
        departureDelay
        realtime
        realtimeState
        headsign
        trip {
          route {
            shortName
          }
        }
      }
    }
  }
`;

export function registerStopDepartures(server: McpServer): void {
  server.registerTool(
    "stop_departures",
    {
      title: "Next departures from a stop",
      description:
        "Get the next departures from a Helsinki public-transport stop, including real-time delays. " +
        "Accepts either a stop name (e.g. 'Kamppi', looked up internally) or an HSL stop ID " +
        "(e.g. 'HSL:1140447'). If the name matches multiple stops, returns the candidate list " +
        "so the caller can pick one.",
      inputSchema,
    },
    async ({ stopId, stopName, numberOfDepartures }) => {
      if (!stopId && !stopName) {
        return {
          isError: true,
          content: [{ type: "text", text: "Provide either stopId or stopName." }],
        };
      }

      let resolvedId = stopId;

      if (!resolvedId && stopName) {
        const search = await gqlClient.request<StopSearchResult>(STOP_SEARCH, {
          name: stopName,
        });
        const matches = search.stops.slice(0, 5);
        if (matches.length === 0) {
          return {
            content: [{ type: "text", text: `No stops matched "${stopName}".` }],
          };
        }
        if (matches.length > 1) {
          const list = matches
            .map(
              (s, i) =>
                `${i + 1}. ${s.name}${s.code ? ` (code ${s.code})` : ""} — id=${s.gtfsId} mode=${s.vehicleMode ?? "?"}`,
            )
            .join("\n");
          return {
            content: [
              {
                type: "text",
                text:
                  `Multiple stops matched "${stopName}". Ask the user which one, then call again with stopId:\n${list}`,
              },
            ],
          };
        }
        resolvedId = matches[0].gtfsId;
      }

      const data = await gqlClient.request<DeparturesResult>(DEPARTURES, {
        id: resolvedId,
        n: numberOfDepartures,
      });

      if (!data.stop) {
        return {
          content: [{ type: "text", text: `No stop found with id "${resolvedId}".` }],
        };
      }

      if (data.stop.stoptimesWithoutPatterns.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `${data.stop.name} (${resolvedId}): no upcoming departures.`,
            },
          ],
        };
      }

      const header =
        `${data.stop.name}${data.stop.code ? ` (${data.stop.code})` : ""} — ${resolvedId}` +
        (data.stop.vehicleMode ? ` [${data.stop.vehicleMode}]` : "");

      const rows = data.stop.stoptimesWithoutPatterns.map((st) => {
        const { localHelsinki, relative } = formatDeparture(st.serviceDay, st.realtimeDeparture);
        const route = st.trip.route.shortName ?? "?";
        const headsign = st.headsign ?? "";
        const delayNote =
          st.realtime && st.departureDelay !== 0
            ? ` (${st.departureDelay > 0 ? "+" : ""}${Math.round(st.departureDelay / 60)} min vs schedule)`
            : st.realtime
              ? " (on time)"
              : " (scheduled)";
        return `${localHelsinki}  ${relative.padEnd(11)}  ${route.padEnd(4)}  ${headsign}${delayNote}`;
      });

      return {
        content: [{ type: "text", text: `${header}\n\n${rows.join("\n")}` }],
      };
    },
  );
}
