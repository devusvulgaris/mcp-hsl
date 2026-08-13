import { GraphQLClient } from "graphql-request";

const KEY = process.env.DIGITRANSIT_SUBSCRIPTION_KEY;
if (!KEY) {
  console.error(
    "FATAL: DIGITRANSIT_SUBSCRIPTION_KEY is not set.\n" +
      "Register a free key at https://digitransit.fi/en/developers/api-registration/",
  );
  process.exit(1);
}

const DIGITRANSIT_HSL_GRAPHQL = "https://api.digitransit.fi/routing/v2/hsl/gtfs/v1";
const DIGITRANSIT_GEOCODE_SEARCH = "https://api.digitransit.fi/geocoding/v1/search";

const AUTH_HEADERS = { "digitransit-subscription-key": KEY };

export const gqlClient = new GraphQLClient(DIGITRANSIT_HSL_GRAPHQL, {
  headers: AUTH_HEADERS,
});

export type GeocodeResult = {
  label: string;
  nameFi: string | null;
  nameSv: string | null;
  lat: number;
  lon: number;
  confidence: number;
  layer: string;
};

type RawPeliasFeature = {
  geometry: { coordinates: [number, number] };
  properties: {
    label: string;
    name?: string;
    "name:fi"?: string;
    "name:sv"?: string;
    confidence?: number;
    layer?: string;
  };
};

export async function geocode(query: string, limit: number): Promise<GeocodeResult[]> {
  const url = new URL(DIGITRANSIT_GEOCODE_SEARCH);
  url.searchParams.set("text", query);
  url.searchParams.set("size", String(limit));
  url.searchParams.set("boundary.country", "FI");

  const res = await fetch(url, { headers: AUTH_HEADERS });
  if (!res.ok) {
    throw new Error(`Geocoding ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { features: RawPeliasFeature[] };
  return body.features.map((f) => ({
    label: f.properties.label,
    nameFi: f.properties["name:fi"] ?? f.properties.name ?? null,
    nameSv: f.properties["name:sv"] ?? null,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    confidence: f.properties.confidence ?? 0,
    layer: f.properties.layer ?? "unknown",
  }));
}

const HELSINKI_TZ = "Europe/Helsinki";

const localFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: HELSINKI_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatEpochMs(epochMs: number): { localHelsinki: string; relative: string } {
  const localHelsinki = localFmt.format(new Date(epochMs)).replace(" ", "T");
  const deltaMin = Math.round((epochMs - Date.now()) / 60000);
  let relative: string;
  if (deltaMin <= 0) relative = "departed / now";
  else if (deltaMin < 60) relative = `in ${deltaMin} min`;
  else relative = `in ${Math.floor(deltaMin / 60)}h ${deltaMin % 60}m`;
  return { localHelsinki, relative };
}

export function formatDeparture(
  serviceDay: number,
  secondsSinceMidnight: number,
): { localHelsinki: string; relative: string; epochMs: number } {
  const epochMs = (serviceDay + secondsSinceMidnight) * 1000;
  return { epochMs, ...formatEpochMs(epochMs) };
}
