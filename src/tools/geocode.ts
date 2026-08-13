import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { geocode } from "../graphqlClient.js";

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Address, place name, or landmark in the Greater Helsinki area (Finnish, Swedish, or English)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe("Maximum number of results to return (1-10)."),
});

export function registerGeocode(server: McpServer): void {
  server.registerTool(
    "geocode",
    {
      title: "Geocode a Helsinki place",
      description:
        "Look up coordinates for an address, place, or landmark in the Greater Helsinki area. " +
        "Returns up to 10 candidates with Finnish and Swedish names, coordinates, and a confidence score. " +
        "Use this before plan_journey when you only have a place name.",
      inputSchema,
    },
    async ({ query, limit }) => {
      const results = await geocode(query, limit);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No matches found for "${query}".` }],
        };
      }
      const text = results
        .map(
          (r, i) =>
            `${i + 1}. ${r.label}` +
            (r.nameSv && r.nameSv !== r.nameFi ? ` (sv: ${r.nameSv})` : "") +
            `\n   lat=${r.lat.toFixed(5)}, lon=${r.lon.toFixed(5)}` +
            `  confidence=${r.confidence.toFixed(2)}  layer=${r.layer}`,
        )
        .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );
}
