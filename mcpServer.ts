/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { trace } from './utils/logger.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { searchPlacesReal, lookupWeather, computeRoutes } from './services/groundingLiteService.js';
import { getPlaceDetailsReal as _getPlaceDetailsReal, getElevationForLocations } from './services/complementaryServices.js';
import { Place, WeatherData, GoogleDate, RouteData, TravelMode, FailedToolResponse, LatLng } from './types.js';
import axios from 'axios';

async function fetchTools() {
  const response = await axios.post('https://mapstools.googleapis.com/mcp', {
    method: 'tools/list',
    jsonrpc: '2.0',
    id: 0,
  }, {
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
    },
  });
  return response.data.result.tools;
}

// Define the expected structure of the response for the tool
// This now includes the pre-written summary from the Places API.
interface SearchPlacesToolResponse {
  places?: Place[];
  summary?: string;
  error?: string;
  message?: string;
  failure?: FailedToolResponse;
}

// New response type for weather tool
interface LookupWeatherToolResponse {
  weather?: WeatherData;
  error?: string;
  failure?: FailedToolResponse;
}

// New response type for routes tool
interface ComputeRoutesToolResponse {
    route?: RouteData;
    error?: string;
    message?: string; // Added for non-error, non-route responses
    failure?: FailedToolResponse;
}
// New response type for elevation tool
interface GetElevationToolResponse {
    results?: { elevation: number; location: LatLng; resolution: number }[];
    error?: string;
    failure?: FailedToolResponse;
}


export async function startMcpServer(transport: Transport): Promise<void> {
  const server = new McpServer({
    name: 'GroundingLiteMcpService',
    version: '1.0.0',
  });

  const tools = await fetchTools();
  trace(`[MCP Server] Fetched tools: ${JSON.stringify(tools, null, 2)}`);

  const searchPlacesParamsShape = {
      text_query: z.string().describe("The text query to search for places (e.g., 'Spicy Vegetarian Food in Sydney, Australia', 'parks near Eiffel Tower')."),
      placeIndex: z.number().optional().describe("The starting index for place references in the summary."),
  };

  const toolHandlers: any = {
    search_places: {
      schema: searchPlacesParamsShape,
      handler: async (args: { text_query: string, placeIndex?: number }): Promise<{ content: { type: 'text', text: string }[] }> => {
        const { text_query, placeIndex } = args;
        trace(`[MCP Server] Received call to 'search-places-mcp' with query: "${text_query}"`);
        trace(`[MCP Server] Args: ${JSON.stringify(args, null, 2)}`);

        const toolResult = await searchPlacesReal(text_query, undefined, placeIndex);

        let responsePayload: SearchPlacesToolResponse;

        if (toolResult.status && toolResult.rawBody) {
          console.error(`[MCP Server] MCP API call failed with status ${toolResult.status}`);
          responsePayload = {
            error: `MCP API call failed with status ${toolResult.status}`,
            failure: { status: toolResult.status, rawBody: JSON.stringify(toolResult.rawBody) }
          };
        } else if (toolResult.error) {
          console.error(`[MCP Server] Error from searchPlacesReal: ${toolResult.error}`);
          responsePayload = { error: toolResult.error };
        } else if (toolResult.places || toolResult.summary) {
          trace(`[MCP Server] Success from searchPlacesReal. Places: ${toolResult.places?.length || 0}. Summary received: ${!!toolResult.summary}`);
          responsePayload = { places: toolResult.places, summary: toolResult.summary };
        } else {
          trace(`[MCP Server] No places or summary found by searchPlacesReal for query: "${text_query}"`);
          responsePayload = { message: "No places found for your query." };
        }

        trace(`[MCP Server] Response Payload: ${JSON.stringify(responsePayload, null, 2)}`);
        return { content: [{ type: 'text', text: JSON.stringify({ response: responsePayload }, null, 2) }] };
      }
    },
    compute_routes: {
      schema: {
        origin: z.object({
            address: z.string().optional().describe("A string address (e.g., '1600 Amphitheatre Parkway, Mountain View, CA')."),
            place_id: z.string().optional().describe("A place ID from the Places API (e.g., 'ChIJj61dQgK6j4AR4GeTYWZsKWw')."),
            lat_lng: z.object({
                latitude: z.number().describe("Latitude."),
                longitude: z.number().describe("Longitude.")
            }).optional().describe("Latitude and longitude coordinates.")
        }).refine(data => Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined).length === 1, {
            message: "Exactly one of 'address', 'place_id', or 'lat_lng' must be provided."
        }).describe("The starting point for the route."),
        destination: z.object({
            address: z.string().optional().describe("A string address (e.g., '1600 Amphitheatre Parkway, Mountain View, CA')."),
            place_id: z.string().optional().describe("A place ID from the Places API (e.g., 'ChIJj61dQgK6j4AR4GeTYWZsKWw')."),
            lat_lng: z.object({
                latitude: z.number().describe("Latitude."),
                longitude: z.number().describe("Longitude.")
            }).optional().describe("Latitude and longitude coordinates.")
        }).refine(data => Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined).length === 1, {
            message: "Exactly one of 'address', 'place_id', or 'lat_lng' must be provided."
        }).describe("The ending point for the route."),
        travelMode: z.enum(['DRIVE', 'WALK', 'TWO_WHEELER']).optional().describe("The travel mode. Defaults to DRIVE if not specified. Supported modes: DRIVE, WALK, TWO_WHEELER (for motorcycles/scooters).")
      },
      handler: async (args: {
          origin: { address?: string; place_id?: string; lat_lng?: { latitude: number; longitude: number; } };
          destination: { address?: string; place_id?: string; lat_lng?: { latitude: number; longitude: number; } };
          travelMode?: TravelMode;
      }): Promise<{ content: { type: 'text', text: string }[] }> => {
          const { origin, destination, travelMode } = args;
          trace(`[MCP Server] Received call to 'compute-routes' from: ${JSON.stringify(origin)} to: ${JSON.stringify(destination)} with mode: ${travelMode || 'DRIVE'}`);

          const toolResult = await computeRoutes(origin, destination, travelMode);

          let responsePayload: ComputeRoutesToolResponse;

          if (toolResult.status && toolResult.rawBody) {
            console.error(`[MCP Server] MCP API call failed with status ${toolResult.status}`);
            responsePayload = {
              error: `MCP API call failed with status ${toolResult.status}`,
              failure: { status: toolResult.status, rawBody: JSON.stringify(toolResult.rawBody) }
            };
          } else if (toolResult.error) {
              console.error(`[MCP Server] Error from computeRoutes: ${toolResult.error}`);
              responsePayload = { error: toolResult.error };
          } else if (toolResult.data) {
              trace(`[MCP Server] Success from computeRoutes.`);
              const responseData: RouteData = {
                ...toolResult.data,
                travelMode: toolResult.data.travelMode || travelMode || 'DRIVE' // Default to DRIVE if undefined
              };
              responsePayload = { route: responseData };
          } else {
              responsePayload = { message: "No route data returned, and no specific error was provided." };
          }

          trace(`[MCP Server] Response Payload: ${JSON.stringify(responsePayload, null, 2)}`);
          return { content: [{ type: 'text', text: JSON.stringify({ response: responsePayload }, null, 2) }] };
      }
    },
    lookup_weather: {
      schema: {
        location: z.object({
            address: z.string().optional().describe("Human readable address or a plus code."),
            placeId: z.string().optional().describe("The Place ID associated with the location."),
            latLng: z.object({
                latitude: z.number().describe("The latitude in degrees."),
                longitude: z.number().describe("The longitude in degrees.")
            }).optional().describe("A point specified using geographic coordinates.")
        }).refine(data => Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined).length === 1, {
            message: "Exactly one of 'address', 'placeId', or 'latLng' must be provided in the location object."
        }).describe("The location to get the weather conditions for."),
        unitsSystem: z.enum(['IMPERIAL', 'METRIC']).optional().describe("The unit system for the weather data. Defaults to IMPERIAL (Fahrenheit, miles per hour)."),
        date: z.object({
            year: z.number().int().describe("Year of the date."),
            month: z.number().int().min(1).max(12).describe("Month of the date (1-12)."),
            day: z.number().int().min(1).max(31).describe("Day of the date (1-31).")
        }).optional().describe("The date for the weather information, relative to the location's timezone. If omitted, current weather is returned."),
        hour: z.number().int().min(0).max(23).optional().describe("The hour (0-23) for the weather information, relative to the location's timezone. If omitted, the weather for the current hour is returned."),
      },
      handler: async (args: any): Promise<{ content: { type: 'text', text: string }[] }> => {
        const { location, unitsSystem, date, hour } = args;
        const locationDebug = location?.address || location?.placeId || JSON.stringify(location?.latLng || 'N/A');

        trace(`[MCP Server] Received call to 'lookup-weather' for location: "${locationDebug}" with units: ${unitsSystem || 'IMPERIAL'}, date: ${JSON.stringify(date)}, hour: ${hour}`);

        const toolResult = await lookupWeather(location, unitsSystem, date, hour);

        let responsePayload: LookupWeatherToolResponse;

        if (toolResult.status && toolResult.rawBody) {
          console.error(`[MCP Server] MCP API call failed with status ${toolResult.status}`);
          responsePayload = {
            error: `MCP API call failed with status ${toolResult.status}`,
            failure: { status: toolResult.status, rawBody: JSON.stringify(toolResult.rawBody) }
          };
        } else if (toolResult.error) {
          console.error(`[MCP Server] Error from lookupWeather: ${toolResult.error}`);
          responsePayload = { error: toolResult.error };
        } else if (toolResult.data) {
          trace(`[MCP Server] Success from lookupWeather for location: "${locationDebug}".`);
          responsePayload = { weather: toolResult.data };
        } else {
          responsePayload = { error: "No weather data returned, and no specific error was provided." };
        }

        trace(`[MCP Server] Response Payload: ${JSON.stringify(responsePayload, null, 2)}`);
        return { content: [{ type: 'text', text: JSON.stringify({ response: responsePayload }, null, 2) }] };
      }
    },
    get_elevation: {
      schema: {
        locations: z.array(z.object({
            latitude: z.number().describe("The latitude of the point."),
            longitude: z.number().describe("The longitude of the point.")
        })).describe("An array of latitude/longitude objects for which to retrieve elevation data. Requires at least one location.")
      },
      handler: async (args: { locations: LatLng[] }): Promise<{ content: { type: 'text', text: string }[] }> => {
          const { locations } = args;
          trace(`[MCP Server] Received call to 'get_elevation' for ${locations.length} locations.`);

          const toolResult = await getElevationForLocations(locations);

          let responsePayload: GetElevationToolResponse;

          if (toolResult.status && toolResult.rawBody) {
              console.error(`[MCP Server] Elevation API call failed with status ${toolResult.status}`);
              responsePayload = {
                  error: `Elevation API call failed with status ${toolResult.status}`,
                  failure: { status: toolResult.status, rawBody: JSON.stringify(toolResult.rawBody) }
              };
          } else if (toolResult.error) {
              console.error(`[MCP Server] Error from getElevationForLocations: ${toolResult.error}`);
              responsePayload = { error: toolResult.error };
          } else if (toolResult.results) {
              trace(`[MCP Server] Success from getElevationForLocations. Results: ${toolResult.results.length}`);
              responsePayload = { results: toolResult.results };
          } else {
              responsePayload = { error: "No elevation data returned." };
          }

          trace(`[MCP Server] Response Payload: ${JSON.stringify({ response: responsePayload }, null, 2)}`);
          return { content: [{ type: 'text', text: JSON.stringify({ response: responsePayload }, null, 2) }] };
      }
    }
  };

  for (const tool of tools) {
    const toolImplementation = toolHandlers[tool.name];
    if (toolImplementation) {
      server.tool(
        tool.name,
        tool.description,
        toolImplementation.schema,
        toolImplementation.handler
      );
    }
  }

  try {
    await server.connect(transport);
    trace('[MCP Server] MCP Service connected and running.');
  } catch (error) {
    console.error('[MCP Server] Failed to connect:', error);
    throw error; // Re-throw to allow caller to handle
  }
}