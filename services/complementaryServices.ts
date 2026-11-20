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

import { trace } from '../utils/logger.js';
import type { Place, RouteData as _RouteData, LatLng } from '../types.js';

// --- COMPLEMENTARY/STANDALONE API CALLS ---

export const callRoutesApiV2 = async (
  params: Record<string, any>,
): Promise<{ data?: any, error?: string, status?: number, rawBody?: any }> => {
  try {
    const ROUTES_API_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
    // Request distance, duration, encoded polyline, and steps
    const fieldMask = 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.steps';

    const serverApiKey = process.env.SERVER_API_KEY;
    if (!serverApiKey) {
      return { error: 'SERVER_API_KEY is not set for Routes API calls.' };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': serverApiKey,
      'X-Goog-FieldMask': fieldMask,
    };

    trace(`[Routes API] Calling ${ROUTES_API_ENDPOINT}`);

    const response = await fetch(ROUTES_API_ENDPOINT, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(params),
    });

    const rawBodyText = await response.text();
    let data: any;
    try {
      data = JSON.parse(rawBodyText);
    } catch (_e) {
      // If response is not JSON, use raw text
      data = rawBodyText;
    }

    if (!response.ok) {
      console.error(`[Routes API] Call failed with status ${response.status}. Raw body:`, data);
      const errorMessage = data.error?.message || `Routes API call failed with status ${response.status}.`;
      return { error: errorMessage, status: response.status, rawBody: data };
    }

    // Success response structure: { routes: [ { distanceMeters, duration, polyline: { encodedPolyline } } ] }
    return { data: data };

  } catch (error) {
    if (error instanceof Error) {
      return { error: `Failed to compute routes: ${error.message}` };
    }
    return { error: "Failed to compute routes due to an unknown error." };
  }
};


export const getPlaceDetailsReal = async (placeId: string): Promise<{ place?: Place, error?: string, status?: number, rawBody?: any }> => {
  try {
    // Places API V1 is called directly for rich details.
    const PLACES_API_V1_ENDPOINT = `https://places.googleapis.com/v1/places/${placeId}`;

    // Use a field mask to request the necessary details (id, location, displayName, formattedAddress)
    const fieldMask = [
      'id', 'location', 'displayName', 'formattedAddress',
      'editorialSummary', 'internationalPhoneNumber', 'photos',
      'currentOpeningHours', 'priceLevel', 'rating', 'userRatingCount', 'websiteUri'
    ].join(',');

    const serverApiKey = process.env.SERVER_API_KEY;
    if (!serverApiKey) {
      return { error: 'SERVER_API_KEY is not set for Places API V1 calls.' };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': serverApiKey,
      'X-Goog-FieldMask': fieldMask,
    };

    trace(`[Places API V1] Calling GET ${PLACES_API_V1_ENDPOINT} with FieldMask: ${fieldMask}`);

    const response = await fetch(PLACES_API_V1_ENDPOINT, {
      method: 'GET',
      headers: headers,
    });

    const rawBodyText = await response.text();
    let data: any;
    try {
      data = JSON.parse(rawBodyText);
    } catch (_e) {
      data = rawBodyText;
    }

    if (!response.ok) {
      console.error(`[Places API V1] Call failed with status ${response.status}. Raw body:`, data);
      const errorMessage = data.error?.message || `Places API V1 call failed with status ${response.status}.`;
      return { error: errorMessage, status: response.status, rawBody: data };
    }

    // Success response structure is the Place object itself
    const place: Place = data as Place;

    if (place && place.id) {
      return { place: place };
    }

    return { error: "Place details not found or invalid response structure." };

  } catch (error) {
    if (error instanceof Error) {
      return { error: `Failed to get place details: ${error.message}` };
    }
    return { error: "Failed to get place details due to an unknown error." };
  }
};


export const getElevationForLocations = async (
  locations: LatLng[]
): Promise<{ results?: any, error?: string, status?: number, rawBody?: any }> => {

  const serverApiKey = process.env.SERVER_API_KEY;
  if (!serverApiKey) {
    return { error: "SERVER_API_KEY is not set for Elevation API calls." };
  }

  try {
    const locationsString = locations.map(loc => `${loc.latitude},${loc.longitude}`).join('|');
    const ELEVATION_API_ENDPOINT = `https://maps.googleapis.com/maps/api/elevation/json?locations=${locationsString}&key=${serverApiKey}`;

    trace(`[Elevation API] Calling GET https://maps.googleapis.com/maps/api/elevation/json?locations=${locationsString}`);

    const response = await fetch(ELEVATION_API_ENDPOINT);

    const rawBodyText = await response.text();
    let data: any;
    try {
      data = JSON.parse(rawBodyText);
    } catch (_e) {
      data = rawBodyText;
    }

    if (!response.ok || data.status !== 'OK') {
      console.error(`[Elevation API] Call failed with status ${response.status}. API status: ${data.status}. Raw body:`, data);
      const errorMessage = data.error_message || `Elevation API call failed with status ${response.status}.`;
      return { error: errorMessage, status: response.status, rawBody: data };
    }

    // Success response structure: { results: [ { elevation, location, resolution } ], status: 'OK' }
    return { results: data.results };

  } catch (error) {
    if (error instanceof Error) {
      return { error: `Failed to fetch elevation: ${error.message}` };
    }
    return { error: "Failed to fetch elevation due to an unknown error." };
  }
};

export const findPlaceByLatLng = async (latLng: LatLng): Promise<{ place?: Place, error?: string }> => {
  try {
    const PLACES_API_SEARCH_NEARBY = 'https://places.googleapis.com/v1/places:searchNearby';
    const serverApiKey = process.env.SERVER_API_KEY;
    if (!serverApiKey) {
      return { error: 'SERVER_API_KEY not set' };
    }

    const requestBody = {
      locationRestriction: {
        circle: {
          center: {
            latitude: latLng.latitude,
            longitude: latLng.longitude
          },
          radius: 50.0 // Search within 50 meters
        }
      },
      maxResultCount: 1
    };

    const fieldMask = 'places.id,places.displayName,places.formattedAddress,places.location';

    trace(`[Places API V1] Calling searchNearby for ${latLng.latitude},${latLng.longitude}`);

    const response = await fetch(PLACES_API_SEARCH_NEARBY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': serverApiKey,
        'X-Goog-FieldMask': fieldMask
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[Places API] searchNearby failed:', data);
      return { error: data.error?.message || 'Unknown error' };
    }

    if (data.places && data.places.length > 0) {
      return { place: data.places[0] as Place };
    }

    return { error: 'No place found at this location' };

  } catch (e: any) {
    console.error('[Places API] findPlaceByLatLng exception:', e);
    return { error: e.message };
  }
};