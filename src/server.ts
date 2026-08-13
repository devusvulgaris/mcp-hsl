import { McpServer } from "@modelcontextprotocol/server";
import { registerGeocode } from "./tools/geocode.js";
import { registerStopDepartures } from "./tools/stopDepartures.js";
import { registerPlanJourney } from "./tools/planJourney.js";

export function buildServer(): McpServer {
  const server = new McpServer({
    name: "helsinki-transit",
    version: "0.1.0",
  });

  registerGeocode(server);
  registerStopDepartures(server);
  registerPlanJourney(server);

  return server;
}
