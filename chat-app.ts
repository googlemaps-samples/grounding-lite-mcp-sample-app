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

import { trace } from './utils/logger.ts';
declare const google: any;
declare const gtag: any;
import { isSameLatLng, getWeatherMarkerIcon, calculateTiltOffsetLat } from './utils/mapUtils.ts';
import { cleanPlaceName, formatPlaceNameForLabel, truncateLabel, decodeHTMLEntities } from './utils/placeUtils.ts';
import { geocodeAddress, fetchElevationApi } from './services/apiClientService.ts';
import { getRepoStarCount } from './services/githubService.ts';
import { LitElement, html, PropertyValues } from 'lit';
import { customElement, state, query, queryAll as _queryAll } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { directive, Directive, PartInfo, PartType } from 'lit/directive.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { WeatherDisplay } from './components/weather-display';
import { RouteDisplay as _RouteDisplay } from './components/route-display';
import {
  ChatMessage,
  ApiKeysState,
  Place,
  WeatherData,
  RouteData,
  LatLng,
  RouteWaypoint,
  FailedToolResponse as _FailedToolResponse,
  ToolExchange
} from './types';
import { Client as _McpClient } from "@modelcontextprotocol/sdk/client";
import { Part, FunctionResponse, Content } from '@google/genai';
import { marked } from 'marked';

// Import Lit components (which define their own custom elements)
import './components/loading-spinner';
import './components/weather-display';
import './components/route-display';
import './components/source-card';

// --- Constants and Utility Functions from App.tsx ---

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const generateId = () => `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

// Interface for unified map state
interface MapDisplayData {
  places: Place[] | null;
  route: RouteData | null;
  weather: WeatherData | null;
  mapFocus?: 'places' | 'route' | 'weather' | 'default';
}

declare global {
  interface Window {
    google: any;
    initMapApis?: () => void; // Combined callback for all Maps APIs
  }
  interface HTMLElementTagNameMap {
    'gmp-map-3d': any;
    'gmp-marker-3d-interactive': any;
    'gmp-marker-3d': any;
    'gmp-pin-element': any;
    'gmp-polyline-3d': any;
  }
}

// --- Main Lit Component ---

class OnConnectedDirective extends Directive {
  constructor(partInfo: PartInfo) {
    super(partInfo);
    if (partInfo.type !== PartType.ELEMENT) {
      throw new Error('onConnected directive must be used on an element.');
    }
  }

  render(_callback: (el: Element) => void) {
    // Not used in this directive
  }

  update(part: any, [callback]: [(el: Element) => void]) {
    callback(part.element);
    return this.render(callback);
  }
}

const onConnected = directive(OnConnectedDirective);

@customElement('chat-app')
export class ChatApp extends LitElement {
  // State properties (replaces React's useState)
  @state()
  private userInput: string = '';

  @state()
  private chatHistory: ChatMessage[] = [];

  @state()
  private isLoading: boolean = false;

  @state()
  private apiKeysState: ApiKeysState = {
    geminiApiKeySet: false,
    placesApiKeySet: true,
    googleMapsApiKey: false,
    googleMapsApiLoaded: false,
    errorMessage: null,
  };

  @state()
  private mapApiReady: boolean = false;

  @state()
  private mapDisplayData: MapDisplayData = {
    places: null,
    route: null,
    weather: null,
  };
  @state()
  private placeIdToIndexMap: Map<string, number> = new Map();


  @state()
  private selectedPlaceIdForDetails: string | null = null;

  @state()
  private lastSelectedPlace: Place | null = null;

  @state()
  private isAwaitingRouteOrigin: boolean = false;

  @state()
  private pendingRouteDestination: { address: string, placeId?: string } | null = null;

  @state()
  private isChatExpanded: boolean = window.innerWidth >= 640; // sm breakpoint

  @state()
  private isToggleVisible: boolean = false;

  @state()
  private isRawResponseModalOpen: boolean = false;

  @state()
  private rawResponseModalContent: ToolExchange[] = []; // Now stores ToolExchange array

  @state()
  private modelName: string | null = null; // Store the model name

  @state()
  private lastUserMessageContent: string | null = null; // Store the last user message for retry functionality

  @state()
  private githubStarCount: number | null = null;

  private isInitialized: boolean = false;
  private pinCreationQueue: (() => void)[] = [];


  // Refs (replaces React's useRef for DOM elements)
  @query('#chat-container')
  private chatContainerRef!: HTMLDivElement;


  @query('#chat-overlay')
  private chatOverlayRef!: HTMLDivElement;

  @query('#map-3d')
  private mapRef!: HTMLElement; // Reference to gmp-map-3d element


  // Internal state for imperative map objects (mostly removed for declarative 3D map)
  private infoWindowRef: any | null = null; // Still needed for weather marker popup
  private currentAiMessageIdRef: string | null = null;
  private quickAnswerTimeoutRef: number | null = null;

  // Imperative Maps API classes/enums
  private PinElement: any | null = null;
  private Marker3DInteractiveElement: any | null = null;
  private AltitudeMode: any | null = null;
  private Marker3D: any | null = null;
  private Polyline3D: any | null = null;

  // State for caching place names fetched via PlacesService
  @state()
  private placeNamesCache: Map<string, string> = new Map();

  // State for drag-to-resize functionality
  private isDragging: boolean = false;
  private initialTouchY: number = 0;
  private initialChatHeight: number = 0;
  private hasMoved: boolean = false;


  // New state for 3D Map Camera
  @state()
  private mapCenter: string = '46.603354, 1.888334'; // lat, lng (Centered on France)
  @state()
  private mapRange: number = 12000000; // Default to 12000km view (meters)
  @state()
  private mapTilt: number = 30;
  @state()
  private mapHeading: number = 0;

  private quickAnswers: string[] = [
    "What are the best beaches near Santa Monica?",
    "What is the driving route from Los Angeles to San Diego?",
    "What is the weather like in San Francisco today?",
    "Find me a highly-rated coffee shop in Palo Alto, CA.",
    "I want to go from San Jose to Yosemite National Park tomorrow. How to sleep there? what is the best route and what is the weather forecast?",
  ];

  private getDynamicQuickAnswers(): string[] {
    const { places, route, weather } = this.mapDisplayData;
    const answers: string[] = [];

    // Prioritize the last selected place for contextual actions
    const contextualPlace = this.lastSelectedPlace || (places && places.length > 0 ? places[0] : null);

    if (contextualPlace) {
      // Contextual prompts for Places
      const _placeName = 'this location';

      answers.push(`Show me the route to this place`);
      answers.push(`What is the weather at this place?`);
      answers.push(`Find hotels near this place`);
      if (places && places.length > 1) {
        answers.push(`Compare the places found`);
      }
    } else if (route) {
      // Contextual prompts for Routes
      answers.push(`Find hotels near the destination`);
      answers.push(`What is the weather at the destination?`);
    } else if (weather) {
      // Contextual prompts for Weather
      const locationName = weather.returnedLocation?.address ?? 'this location';
      answers.push(`Find restaurants near ${locationName}`);
      answers.push(`Plan a route from here`);
    }

    // Fallback/General suggestions if no specific data is present
    if (answers.length === 0) {
      answers.push("Plan a route (e.g., SF to LA)");
      answers.push("Search for restaurants or hotels");
      answers.push("Check the weather in a specific city");
    }

    // Ensure we return a maximum of 3 recommendations
    return answers.slice(0, 3);
  }

  private async handleQuickAnswerClick(answer: string) {
    // Set userInput immediately for display
    this.userInput = answer;

    // 1. Handle Route Request
    if (answer.startsWith('Show me the route to') && this.lastSelectedPlace) {
      const placeName = cleanPlaceName(this.lastSelectedPlace.displayName) || this.lastSelectedPlace.formattedAddress || 'the selected location';
      this.userInput = `Show me the route to ${placeName}`;
      this.handleSendMessage();
      return;
    }

    // 2. Handle Weather Query for Place
    if (answer.startsWith('What is the weather at this place') && (this.lastSelectedPlace || (this.mapDisplayData.places && this.mapDisplayData.places.length > 0))) {
      const place = this.lastSelectedPlace || this.mapDisplayData.places![0];
      const resolvedAddress = place.formattedAddress || cleanPlaceName(place.displayName);
      if (resolvedAddress) {
        this.userInput = `What is the weather in ${resolvedAddress}?`;
      }
    }

    // 3. Handle Weather Query for Route Destination
    if (answer.startsWith('What is the weather at the destination') && this.mapDisplayData.route?.destination) {
      const dest = this.mapDisplayData.route.destination;
      const destName = dest.name || (dest.place_id ? this.placeNamesCache.get(dest.place_id) : undefined) || dest.address;
      if (destName) {
        this.userInput = `What is the weather in ${destName}?`;
      }
    }

    // 4. Handle Hotel queries
    if (answer.startsWith('Find hotels near the destination') && this.mapDisplayData.route?.destination) {
      const dest = this.mapDisplayData.route.destination;
      const destName = dest.name || (dest.place_id ? this.placeNamesCache.get(dest.place_id) : undefined) || dest.address;
      if (destName) {
        this.userInput = `Find hotels near ${destName}`;
      }
    }

    if (answer.startsWith('Find hotels near this place') && (this.lastSelectedPlace || (this.mapDisplayData.places && this.mapDisplayData.places.length > 0))) {
      const place = this.lastSelectedPlace || this.mapDisplayData.places![0];
      const placeName = cleanPlaceName(place.displayName) || place.formattedAddress || 'this location';
      this.userInput = `Find hotels near ${placeName}`;
    }

    // 5. Handle Weather-based quick answers
    if (answer.startsWith('Find restaurants near') && this.mapDisplayData.weather?.returnedLocation?.address) {
      const loc = this.mapDisplayData.weather.returnedLocation.address;
      this.userInput = `Find restaurants near ${loc}`;
    }

    if (answer.startsWith('Plan a route from here') && this.mapDisplayData.weather?.returnedLocation?.address) {
      const loc = this.mapDisplayData.weather.returnedLocation.address;
      this.userInput = `Plan a route from ${loc}`;
    }

    this.handleSendMessage();
  }

  private handleQuickAnswerMouseOver(e: Event) {
    const target = e.currentTarget as HTMLElement;
    if (this.quickAnswerTimeoutRef) {
      clearTimeout(this.quickAnswerTimeoutRef);
    }
    this.quickAnswerTimeoutRef = setTimeout(() => {
      target.classList.add('expanded');
    }, 400) as unknown as number;
  }

  private handleQuickAnswerMouseOut(e: Event) {
    const target = e.currentTarget as HTMLElement;
    if (this.quickAnswerTimeoutRef) {
      clearTimeout(this.quickAnswerTimeoutRef);
      this.quickAnswerTimeoutRef = null;
    }
    target.classList.remove('expanded');
  }


  private handlePlaceClick(place: Place) {
    this.lastSelectedPlace = place;
    this.selectedPlaceIdForDetails = place.id;
    this._fetchPlaceDetails(place.id);
    this.scrollToBottom();
  }
  private handleMarkerClick(placeId: string) {
    // Locate the place in the currently displayed map data to set lastSelectedPlace for quick answers
    const place = this.mapDisplayData.places?.find(p => p.id === placeId);

    if (place) {
      this.lastSelectedPlace = place;
    } else {
      // Fallback: If place is not in the list (e.g., a route waypoint not from a search), clear last selected place.
      this.lastSelectedPlace = null;
    }

    this.selectedPlaceIdForDetails = placeId;
    this._fetchPlaceDetails(placeId);
    this.scrollToBottom();
  }


  // Use light DOM for Tailwind compatibility
  protected createRenderRoot() {
    return this;
  }

  // --- Lifecycle Methods (replaces React's useEffect) ---

  // Runs once after the component is first rendered to the DOM (replaces useEffect with empty dependency array for initialization)
  firstUpdated() {
    this.initializeApis();
    this.initializeChat();
    this.setupLinkTracker();
    this.scrollToBottom(); // Ensure input field is visible on mobile load
    if (this.mapRef) {
      (this.mapRef as any).internalUsageAttributionIds = ['gmp_devsite_groundinglitesampleapp_v1.0.0'];
    }
  }

  private setupLinkTracker() {
    this.chatContainerRef.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.id === 'gmp-activate-link') {
        gtag('event', 'gmp_activate_link_click', {
          'event_category': 'gmp_activation',
          'event_label': 'Activate GMP Link Click'
        });
      } else if (target.id === 'gmp-docs-link') {
        gtag('event', 'gmp_documentation_link_click', {
          'event_category': 'gmp_documentation',
          'event_label': 'GMP Documentation Link Click'
        });
      }
    });
  }


  // Runs after every update (replaces useEffect with dependencies)
  updated(changedProperties: PropertyValues) {
    // Scroll to bottom when chatHistory changes
    if (changedProperties.has('chatHistory')) {
      this.scrollToBottom();
      this.updateToggleVisibility();
    }


    // Check if map API is ready and initialize imperative objects if needed

    // Update Map camera, markers, routes, and weather when mapDisplayData changes
    if (changedProperties.has('mapDisplayData') && this.mapApiReady) {
      this.updateMapCamera();
      const placesToFetch: Place[] = [...(this.mapDisplayData.places || [])];
      if (this.mapDisplayData.route?.origin?.place_id) {
        placesToFetch.push({ id: this.mapDisplayData.route.origin.place_id, formattedAddress: this.mapDisplayData.route.origin.name || this.mapDisplayData.route.origin.address });
      }
      if (this.mapDisplayData.route?.destination?.place_id) {
        placesToFetch.push({ id: this.mapDisplayData.route.destination.place_id, formattedAddress: this.mapDisplayData.route.destination.name || this.mapDisplayData.route.destination.address });
      }
      this.fetchPlaceDetailsForMarkers(placesToFetch);
      // Only update markers imperatively if objects are initialized
    }

    // Update marker styles when selectedPlaceIdForDetails changes
    // The Place Details Widget is now rendered declaratively in the chat container.
  }

  // --- Initialization Logic ---

  private async initializeApis() {
    if ((customElements.get('gmp-map-3d'))) {
      this.mapApiReady = true;
      return;
    }
    if (document.getElementById('google-maps-script')) return;

    // DO NOT LINT
    // Dynamic loader script provided by Google Maps Platform documentation
    const dynamicLoaderScript = `
        (g=>{var h,a,k,p="The Google Maps JavaScript API",c="google",l="importLibrary",q="__ib__",m=document,b=window;b=b[c]||(b[c]={});var d=b.maps||(b.maps={}),r=new Set,e=new URLSearchParams,u=()=>h||(h=new Promise(async(f,n)=>{await (a=m.createElement("script"));e.set("libraries",[...r]+"");for(k in g)e.set(k.replace(/[A-Z]/g,t=>"_"+t[0].toLowerCase()),g[k]);e.set("callback",c+".maps."+q);a.src=\`https://maps.\${c}apis.com/maps/api/js?\`+e;d[q]=f;a.onerror=()=>h=n(Error(p+" could not load."));a.nonce=m.querySelector("script[nonce]")?.nonce||"";m.head.append(a)}));d[l]?console.warn(p+" only loads once.Ignoring:",g):d[l]=(f,...n)=>r.add(f)&&u().then(()=>d[l](f,...n))})({
            key: "${GOOGLE_MAPS_API_KEY}",
            v: "weekly",
            solutionChannel: "gmp_devsite_groundinglitesampleapp_v1.0.0"
        });
    `;
    // DO NOT LINT

    const script = document.createElement('script');
    script.id = 'google-maps-dynamic-loader';
    script.textContent = dynamicLoaderScript;
    document.head.appendChild(script);

    const _libraries = [
      'marker',
      'places',
      'routes',
      'maps3d',
      'geometry'
    ];

    // The dynamic loader defines google.maps.importLibrary globally, which we now use.
    try {
      // Load libraries sequentially or in parallel using await
      const [marker, maps3d, placesLib, _routesLib, _geometryLib] = await Promise.all([
        google.maps.importLibrary('marker'),
        google.maps.importLibrary('maps3d'),
        google.maps.importLibrary('places'),
        google.maps.importLibrary('routes'),
        google.maps.importLibrary('geometry'),
      ]);

      const { _PlaceDetailsElement } = placesLib;

      // Store references to Maps API classes for imperative use
      // Final confirmed mapping: PinElement from marker, 3D markers from maps3d
      this.PinElement = marker.PinElement;
      // Process any queued pin creation requests now that PinElement is available
      this.pinCreationQueue.forEach(callback => callback());
      this.pinCreationQueue = [];

      this.Marker3DInteractiveElement = maps3d.Marker3DInteractiveElement;
      this.Marker3D = maps3d.Marker3D;
      this.AltitudeMode = maps3d.AltitudeMode;
      this.Polyline3D = maps3d.Polyline3D;

      // Check for custom elements after libraries are loaded.
      // Use a short delay to ensure custom elements are registered after library import.
      setTimeout(() => {
        if (customElements.get('gmp-map-3d')) {
          this.mapApiReady = true;
        } else {
          this.apiKeysState = { ...this.apiKeysState, errorMessage: (this.apiKeysState.errorMessage || "") + " Failed to load Google Maps 3D map library." };
        }

        if (customElements.get('gmp-place-details-compact')) {
        } else {
          this.apiKeysState = { ...this.apiKeysState, errorMessage: (this.apiKeysState.errorMessage || "") + " Failed to initialize Place Details widget." };
        }

        if (this.apiKeysState.googleMapsApiKey) {
          this.apiKeysState = { ...this.apiKeysState, googleMapsApiLoaded: true };
        }
      }, 100); // 100ms delay for custom element registration

    } catch (error: any) {
      this.apiKeysState = { ...this.apiKeysState, errorMessage: (this.apiKeysState.errorMessage || "") + " Critical error: Could not load Google Maps services: " + error.message };
    }
  }

  private async fetchGitHubStars() {
    if (window.self !== window.top) {
      // Don't fetch stars if in an iframe
      return;
    }
    this.githubStarCount = await getRepoStarCount('googlemaps-samples/grounding-lite-mcp-sample-app');
  }

  private getIntroMessageText(warning?: string): string {
    const warningHtml = warning ? `<div class="p-3 mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs">⚠️ ${warning}</div>\n\n` : '';
    const modelDisplay = this.modelName ? `<div class="text-xs text-gray-400 mt-2 text-right">Powered by ${this.modelName}</div>` : '';
    const githubButton = `
              <a href="https://github.com/googlemaps-samples/grounding-lite-mcp-sample-app" target="_blank" style="display: inline-flex; align-items: center; vertical-align: middle;">
                <img src="/images/github-icon.svg" alt="GitHub Icon" style="height: 1.2em; margin-right: 0.3em;"> GitHub Code ${this.githubStarCount !== null ? ` - Star &nbsp;<span>${this.githubStarCount}</span>` : ''}
              </a>`;
    const buttonContainer = `
              <div style="text-align: right; margin-top: 1em; font-size: 0.8em;">
                <a href="https://console.cloud.google.com/marketplace/product/google/mapstools.googleapis.com" target="_blank">Grounding Lite activate</a> |
                <a href="https://developers.google.com/maps/ai/grounding-lite" target="_blank">documentation</a>
                ${githubButton ? ` | ${githubButton}` : ''}
              </div>
            `;
    return `${warningHtml}Hello! This is a demo travel planning app powered by Gemini and <span style="white-space: nowrap;font-weight:700"><img src="/images/Maps_Grounding_Lite.png" alt="Grounding Lite Icon" style="height: 2em; vertical-align: middle; display: inline-block;">Grounding Lite</span> MCP Service. Here we demonstrate how we can serve Google Maps Platform data as an embedding to any LLM powered application. This functionality enables the creation of diverse applications, such as a Travel Planner, Real Estate Explorer, or City Tour Guide. Try one of the sample prompts to explore!\n${modelDisplay}\n${buttonContainer}`;
  }

  private async initializeChat() {
    await this.fetchGitHubStars();
    let errorMessages: string[] = [];

    // Gemini key (SERVER_API_KEY) is server-only. We assume the backend is correctly configured via dotenv in start.ts.
    const chatOk = true;

    if (!GOOGLE_MAPS_API_KEY) {
      errorMessages.push("Google Maps API key is missing. Map and Place Details features disabled.");
    }

    const currentApiKeysState: ApiKeysState = {
      geminiApiKeySet: chatOk,
      placesApiKeySet: true,
      googleMapsApiKey: !!GOOGLE_MAPS_API_KEY,
      googleMapsApiLoaded: false,
      errorMessage: errorMessages.length > 0 ? errorMessages.join(' ') : null,
    };
    this.apiKeysState = currentApiKeysState;

    if (currentApiKeysState.geminiApiKeySet) {
      this.isLoading = true;
      fetch('/api/init-chat', { method: 'POST' })
        .then(res => res.json())
        .then(({ success, modelName }) => {
          this.modelName = modelName;
          if (success) {
            this.chatHistory = [
              {
                id: generateId(),
                role: 'model',
                parts: [{ text: this.getIntroMessageText() }],
                timestamp: new Date(),
              },
            ];
          } else {
            this.apiKeysState = { ...this.apiKeysState, errorMessage: (this.apiKeysState.errorMessage ? `${this.apiKeysState.errorMessage} Chat init failed.` : "Chat init failed.") };
          }
        })
        .catch(err => {
          this.apiKeysState = { ...this.apiKeysState, errorMessage: `Error init chat: ${err instanceof Error ? err.message : String(err)}` };
        })
        .finally(() => {
          this.isLoading = false;
          this.isInitialized = true;
        });
    }
  }


  // --- Map Update Logic (Migrated from React useEffects) ---

  private async updateMapCamera() {
    if (!this.mapApiReady || !window.google?.maps?.LatLngBounds) {
      return;
    }

    const bounds = new window.google.maps.LatLngBounds();
    let validGeometriesCount = 0;
    let center: LatLng | null = null;
    let forceRange: number | null = null; // New variable to force a specific range

    if (this.mapDisplayData.places && this.mapDisplayData.places.length > 0) {
      this.mapDisplayData.places.forEach((place) => {
        if (place.location && typeof place.location.latitude === 'number' && typeof place.location.longitude === 'number') {
          const position = { lat: place.location.latitude, lng: place.location.longitude };
          bounds.extend(position);
          validGeometriesCount++;
        }
      });
      if (validGeometriesCount > 0) {
        // Explicitly clear any default center assignment if multiple geometries exist
      }
    }

    // Check if a specific place is selected via chat link and override center/range
    if (this.selectedPlaceIdForDetails && this.mapDisplayData.places) {
      const selectedPlace = this.mapDisplayData.places.find(p => p.id === this.selectedPlaceIdForDetails);
      if (selectedPlace?.location) {
        center = selectedPlace.location;
        forceRange = 2000; // Force a close zoom (2km) on the selected place
      }
    }

    if (this.mapDisplayData.weather?.locationCoords) {
      const weatherPosition = { lat: this.mapDisplayData.weather.locationCoords.latitude, lng: this.mapDisplayData.weather.locationCoords.longitude };
      bounds.extend(weatherPosition);
      // Note: Do NOT set center here. Let bounds.getCenter() handle centering, unless a specific place is selected.
    }

    if (this.mapDisplayData.route) {
      const routePath = (this.mapDisplayData.route as any).path;
      if (routePath && routePath.length > 0) {
        // Extend bounds based on the entire polyline path
        routePath.forEach((point: any) => {
          bounds.extend(point);
        });
        // Note: Do NOT set center here. Let bounds.getCenter() handle centering.
      } else {
        // Fallback to origin/destination if path is not available yet
        const origin = this.mapDisplayData.route.origin?.lat_lng;
        const destination = this.mapDisplayData.route.destination?.lat_lng;

        if (origin) {
          bounds.extend({ lat: origin.latitude, lng: origin.longitude });
        }
        if (destination) {
          bounds.extend({ lat: destination.latitude, lng: destination.longitude });
        }
        // If only two points exist (origin/destination) and no path, `bounds.getCenter()` is correct.
      }
    }

    if (!bounds.isEmpty()) {
      const centerLatLng = bounds.getCenter();

      // Calculate range based on bounds (simplified heuristic for 3D map)
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      const distance = window.google.maps.geometry.spherical.computeDistanceBetween(ne, sw);

      // Determine minimum range based on content type
      let minRange = 2000; // Default minimum for multiple points or routes/weather

      // If only one place is found and no route/weather data, use a wider view (100km)
      if (validGeometriesCount === 1 && !this.mapDisplayData.route && !this.mapDisplayData.weather) {
        minRange = 1000; // 1km range for close-up view
      }

      // Set range to be slightly larger than the diagonal distance, minimum determined above
      let calculatedRange = Math.max(minRange, distance * 1.2);

      // Apply forced range if set (e.g., when clicking a single place link)
      if (forceRange !== null) {
        calculatedRange = forceRange;
      }

      // We rely on flyCameraTo to set the range imperatively.
      // We remove the state update for mapRange to prevent declarative attribute reset.
      // this.mapRange = calculatedRange;
      // We will use the calculated values for flyCameraTo
      let cameraAltitude = 19000; // Default camera altitude if elevation fails
      let baseElevation = 0;

      // Use server-side MCP for elevation data
      const elevationResponse = await fetchElevationApi([{
        latitude: centerLatLng.lat(),
        longitude: centerLatLng.lng()
      }]);

      if (elevationResponse?.results && elevationResponse.results.length > 0) {
        baseElevation = elevationResponse.results[0].elevation;
        trace(`[Elevation MCP] Success. Base elevation: ${baseElevation}m. Full response:`, elevationResponse);
      } else {
        // Warnings are already handled inside _fetchElevationMcp if the client is available but failed
        console.warn('[Map Camera] Failed to get elevation data from MCP server. Using default base elevation (0).');
      }

      // Calculate camera altitude: base elevation + offset (offset based on range, min 5000m for high elevation)
      // Use a higher minimum offset to ensure mountains are viewed from a sufficient distance.
      // Determine minimum offset based on base elevation: small for cities, large for mountains.
      // Calculate altitude offset: Use a small offset for low elevation features (like buildings)
      // but ensure a larger offset for high elevation features (like mountains) to capture the whole feature.
      const lowElevationOffset = 200; // 200m offset for buildings/cities

      let altitudeOffset = lowElevationOffset;
      if (baseElevation > 1000) { // If base elevation is high (>1000m)
        altitudeOffset = 5000;
      }


      // Ensure altitude offset is at least 0.1% of the map range, but capped by the calculated offset above.
      const rangeBasedOffset = calculatedRange * 0.001; // 0.1% of range
      altitudeOffset = Math.max(altitudeOffset, rangeBasedOffset);

      cameraAltitude = Math.round(baseElevation + altitudeOffset);
      // Calculate tilt offset using the determined camera altitude and tilt
      const latOffset = calculateTiltOffsetLat(this.mapTilt, cameraAltitude);

      // Determine the final center point for the camera
      const finalCenterLatLng = center ? new window.google.maps.LatLng(center.latitude, center.longitude) : centerLatLng;

      trace("cameraAltitude : " + cameraAltitude)
      // Prepare camera options
      const cameraOptions = {
        center: {
          lat: finalCenterLatLng.lat() - (latOffset * 0.9), // Apply latitude offset to compensate for camera tilt (shifts center south)
          lng: finalCenterLatLng.lng(), //+ 0.05, // Shift west to compensate for chat overlay on the right
          altitude: cameraAltitude,
        },
        heading: this.mapHeading,
        tilt: this.mapTilt,
        range: calculatedRange,
      };


      if (this.mapRef && (this.mapRef as any).flyCameraTo) {
        try {
          await (this.mapRef as any).flyCameraTo({
            endCamera: cameraOptions,
            durationMillis: 1500,
          });
          trace("cameraOptions : " + JSON.stringify(cameraOptions))

          // Update declarative state after imperative call to prevent race condition/override
          this.mapCenter = `${cameraOptions.center.lat.toString()}, ${cameraOptions.center.lng.toString()}`;
        } catch (e) {
          console.error("[Map Camera] flyCameraTo failed:", e);
        }
      } else {
        console.error("[Map Camera] mapRef or flyCameraTo method not available.");
        // Fallback to declarative update (which might ignore altitude)
        this.mapCenter = `${cameraOptions.center.lat.toString()}, ${cameraOptions.center.lng.toString()}`;
        this.mapTilt = cameraOptions.tilt;
        this.mapHeading = cameraOptions.heading;
        this.mapRange = cameraOptions.range;
      }

      // Note: We no longer need the single point logic here as it's handled by the selectedPlaceIdForDetails override.
    }
  }



  /**
   * Fetches place details (specifically name/address) from the server-side API endpoint.
   */
  private async _fetchPlaceNameFromServer(placeId: string): Promise<string | undefined> {
    try {
      const response = await fetch('/api/placeDetails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ placeId }),
      });

      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const data = await response.json();

      const place = data?.place;

      if (place) {
        return place.displayName?.text || place.formattedAddress;
      }
      return undefined;

    } catch (error) {
      console.error(`Server-side fetch for place details (ID: ${placeId}) failed:`, error);
      return undefined;
    }
  }

  private async _fetchPlaceById(placeId: string): Promise<Place | null> {
    try {
      const response = await fetch('/api/placeDetails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ placeId }),
      });

      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const data = await response.json();
      return data?.place || null;

    } catch (error) {
      console.error(`Server-side fetch for place details (ID: ${placeId}) failed:`, error);
      return null;
    }
  }

  private async _fetchPlaceDetails(placeId: string) {
    this.selectedPlaceIdForDetails = placeId;
    let place = this.mapDisplayData.places?.find(p => p.id === placeId) || null;

    if (!place) {
      place = await this._fetchPlaceById(placeId);
    }

    if (place) {
      this.lastSelectedPlace = place;
    }
    this.scrollToBottom();
  }

  private async fetchPlaceDetailsForMarkers(places: Place[] | null) {
    if (!places || places.length === 0) {
      // Clear cache if no places are present
      if (this.placeNamesCache.size > 0) {
        this.placeNamesCache = new Map();
      }
      return;
    }

    const newCache = new Map(this.placeNamesCache);
    const fetchPromises: Promise<void>[] = [];

    for (const place of places) {
      if (!place.id || newCache.has(place.id)) continue;

      const fetchPromise = this._fetchPlaceNameFromServer(place.id)
        .then(placeName => {
          const rawFallbackName = place.formattedAddress || place.displayName?.text || 'Location';
          const fallbackName = formatPlaceNameForLabel(rawFallbackName);

          const nameToCache = placeName ? formatPlaceNameForLabel(placeName) : fallbackName;

          newCache.set(place.id!, nameToCache);
        })
        .catch(error => {
          // In case of any error fetching from server, use fallback data
          console.error(`Error fetching place name for marker ${place.id} from server:`, error);
          const rawFallbackName = place.formattedAddress || place.displayName?.text || 'Location';
          const fallbackName = formatPlaceNameForLabel(rawFallbackName);
          newCache.set(place.id!, fallbackName);
        });

      fetchPromises.push(fetchPromise);
    }

    await Promise.all(fetchPromises);

    // Only update state if the cache actually changed
    if (newCache.size !== this.placeNamesCache.size || Array.from(newCache.keys()).some(key => newCache.get(key) !== this.placeNamesCache.get(key))) {
      this.placeNamesCache = newCache;
    }
  }


  // --- Chat Logic ---

  private scrollToBottom() {
    // Use requestAnimationFrame to ensure scrolling happens after the browser has rendered any potential height change
    requestAnimationFrame(() => {
      if (this.chatContainerRef) {
        this.chatContainerRef.scrollTop = this.chatContainerRef.scrollHeight;
      }
    });
  }

  private addOrUpdateMessageInChat(
    id: string,
    role: 'user' | 'model' | 'function',
    parts: Part[],
    isFinal: boolean = true,
    error?: string,
    weatherData?: WeatherData,
    routeData?: RouteData,
    places?: Place[],
    toolExchanges?: ToolExchange[],
    sourceURLs?: string[] // Pass sources explicitly
  ) {
    const existingMsgIndex = this.chatHistory.findIndex(m => m.id === id);

    const messageData: ChatMessage = {
      id,
      role,
      parts,
      timestamp: new Date(),
      isFinal,
      error,
      weatherData,
      routeData,
      places,
      toolExchanges,
      sourceURLs // Store sources in the message
    };


    if (existingMsgIndex > -1) {
      // Update existing message
      this.chatHistory[existingMsgIndex] = messageData;
      this.chatHistory = [...this.chatHistory]; // Trigger update
    } else {
      // Add new message
      this.chatHistory = [...this.chatHistory, messageData];
    }

    // Always scroll to bottom after adding/updating a message
    this.scrollToBottom();
  }

  private async decodePolylineForRoute(routeData: RouteData): Promise<{ path: any[]; resolvedWaypoints?: { origin: LatLng, destination: LatLng } } | undefined> {
    if (!routeData.encodedPolyline) {
      console.warn("[Route] Route data missing encodedPolyline.");
      return undefined;
    }

    if (!window.google?.maps?.geometry?.encoding) {
      console.error("Google Maps geometry library not available for polyline decoding.");
      return undefined;
    }

    try {
      const path = window.google.maps.geometry.encoding.decodePath(routeData.encodedPolyline);
      trace("[Route] Successfully decoded polyline path.");

      // We no longer rely on DirectionsService for resolved waypoints, but keep the structure
      // for compatibility with downstream logic (though locations should be resolved by the MCP response).
      // We can use the locations already attached to routeData if available.
      let resolvedWaypoints: { origin: LatLng, destination: LatLng } | undefined = undefined;

      if (path && path.length > 0) {
        const startPoint = path[0];
        const endPoint = path[path.length - 1];

        // Use existing lat_lng if available, otherwise fallback to path start/end
        // Note: path points are google.maps.LatLng objects, need to convert to LatLng interface
        const startLatLng = { latitude: startPoint.lat(), longitude: startPoint.lng() };
        const endLatLng = { latitude: endPoint.lat(), longitude: endPoint.lng() };

        resolvedWaypoints = {
          origin: routeData.origin?.lat_lng || startLatLng,
          destination: routeData.destination?.lat_lng || endLatLng,
        };
      }

      return { path, resolvedWaypoints };
    } catch (e) {
      console.error("[Route] Failed to decode polyline:", e);
      return undefined;
    }
  }

  private async resolveWaypointLocation(waypoint: RouteWaypoint, locationBias?: LatLng): Promise<RouteWaypoint> {
    if (waypoint.lat_lng) return waypoint;

    const query = waypoint.address || (waypoint.place_id ? `place_id:${waypoint.place_id}` : undefined);

    if (query) {
      trace(`[Route Marker] Resolving location for query: ${query}`);
      const result = await fetch('/api/searchPlaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, locationBias })
      }).then(res => res.json());
      if (result.places && result.places.length > 0) {
        const resolvedPlace = result.places[0];
        const location = resolvedPlace.location;
        if (location) {
          trace(`[Route Marker] Successfully resolved location for ${query}.`);
          // Update waypoint with resolved lat_lng and place_id if available
          const address = resolvedPlace.displayName?.text || resolvedPlace.formattedAddress;
          return {
            ...waypoint,
            lat_lng: location,
            address,
            ...(resolvedPlace.id && { place_id: resolvedPlace.id })
          };
        }
      }
      trace(`[Route Marker] Failed to resolve location for query: ${query}.`);
    }
    return waypoint;
  }

  private async processAiResponse(currentUserMessageText: string, retryAttempt = 0): Promise<void> {
    this.isLoading = true;
    if (retryAttempt === 0 || !this.currentAiMessageIdRef) {
      this.currentAiMessageIdRef = generateId();
      this.addOrUpdateMessageInChat(this.currentAiMessageIdRef, 'model', [{ text: "Connecting to agent..." }], false);
    } else {
      this.addOrUpdateMessageInChat(this.currentAiMessageIdRef, 'model', [{ text: "High demand detected, retrying automatically...\nPlease wait." }], false);
    }

    const MAX_AUTO_RETRIES = 2;
    let streamError: string | null = null;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: currentUserMessageText }),
      });

      if (!response.body) {
        throw new Error("Response body is null");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processStream = async () => {
        const { done, value } = await reader.read();
        if (done) {
          if (!streamError) {
            this.isLoading = false;
            this.currentAiMessageIdRef = null;
          }
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || ''; // Keep the last partial line

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonString = line.substring(6);
            try {
              const data = JSON.parse(jsonString);
              if (data.status) {
                if (this.currentAiMessageIdRef) {
                  this.addOrUpdateMessageInChat(this.currentAiMessageIdRef, 'model', [{ text: data.status }], false);
                }
              } else if (data.result) {
                const { response, turnContent, toolExchanges: exchangesFromService, sessionRefreshWarning } = data.result;
                const toolExchanges = exchangesFromService;

                if (sessionRefreshWarning) {
                  this.isLoading = false;
                  this.currentAiMessageIdRef = null;
                  this.mapDisplayData = { places: null, weather: null, route: null };
                  this.lastSelectedPlace = null;
                  this.chatHistory = [
                    {
                      id: generateId(),
                      role: 'model',
                      parts: [{ text: sessionRefreshWarning }],
                      timestamp: new Date(),
                    },
                    {
                      id: generateId(),
                      role: 'model',
                      parts: [{ text: this.getIntroMessageText() }],
                      timestamp: new Date(),
                    }
                  ];
                  return;
                }

                let finalAccumulatedText = response.text ?? '';
                const placesThisTurn: Place[] = [];
                let localWeatherData: WeatherData | null = null;
                let localRouteData: RouteData | null = null;

                if (turnContent) {
                  turnContent.forEach((contentItem: Content) => {
                    contentItem.parts?.forEach((part: Part) => {
                      if (part.functionResponse) {
                        const fr = part.functionResponse as FunctionResponse;
                        if (fr.name === 'search_places' || fr.name === 'search-places-mcp') {
                          const rawOutput = fr.response as any;
                          const content = rawOutput?.content;
                          let toolOutput: any = null;
                          if (Array.isArray(content) && content.length > 0 && content[0].type === 'text') {
                            try {
                              toolOutput = JSON.parse(content[0].text);
                            } catch (e) {
                              console.error("Failed to parse search_places response:", e);
                            }
                          }
                          if (toolOutput?.places || toolOutput?.response?.places) {
                            const placesFromTool: Place[] = toolOutput.places || toolOutput.response.places;
                            const validPlaces = placesFromTool.filter(p => p.id && p.location && typeof p.location.latitude === 'number' && typeof p.location.longitude === 'number');
                            placesThisTurn.push(...validPlaces);
                          }
                        } else if (fr.name === 'lookup_weather' || fr.name === 'lookup-weather') {
                          const rawOutput = fr.response as any;
                          const content = rawOutput?.content;
                          let toolOutput: any = null;
                          if (Array.isArray(content) && content.length > 0 && content[0].type === 'text') {
                            try {
                              toolOutput = JSON.parse(content[0].text);
                            } catch (e) {
                              console.error("Failed to parse lookup_weather response:", e);
                            }
                          }
                          // Remote MCP returns weather data directly (e.g. has 'temperature' or 'weatherCondition')
                          // Local wrapper returned { response: { weather: ... } }
                          if (toolOutput?.temperature || toolOutput?.weatherCondition) {
                            localWeatherData = toolOutput;
                          } else if (toolOutput?.weather || toolOutput?.response?.weather) {
                            localWeatherData = toolOutput.weather || toolOutput.response.weather;
                          }
                        } else if (fr.name === 'compute_routes' || fr.name === 'compute-routes') {
                          const rawOutput = fr.response as any;
                          const content = rawOutput?.content;
                          let toolOutput: any = null;
                          if (Array.isArray(content) && content.length > 0 && content[0].type === 'text') {
                            try {
                              toolOutput = JSON.parse(content[0].text);
                            } catch (e) {
                              console.error("Failed to parse compute_routes response:", e);
                            }
                          }
                          // Extract route data from either { response: { route } }, { route }, or { routes: [...] },
                          // preferring the route object that carries distanceMeters and duration.
                          const candidateRoutes = [
                            toolOutput?.response?.route,
                            toolOutput?.route,
                            ...(Array.isArray(toolOutput?.routes) ? toolOutput.routes : []),
                            ...(Array.isArray(toolOutput?.response?.routes) ? toolOutput.response.routes : []),
                          ].filter(Boolean);
                          if (candidateRoutes.length > 0) {
                            localRouteData =
                              candidateRoutes.find(
                                (r: any) => typeof r.distanceMeters === 'number' || Boolean(r.duration)
                              ) || candidateRoutes[0];
                          }
                        }
                      }
                    });
                  });
                }

                let specificToolError: string | undefined = undefined;
                for (const exchange of toolExchanges) {
                  if ((exchange.toolName === 'compute-routes' || exchange.toolName === 'compute_routes') && (exchange.response?.error || exchange.response?.response?.error)) {
                    specificToolError = exchange.response.error || exchange.response.response.error;
                    break;
                  }
                }

                let mapDataGeneratedThisTurn = false;
                const newMapDisplayData: MapDisplayData = {
                  places: null,
                  route: null,
                  weather: null,
                  mapFocus: 'default',
                };

                if (placesThisTurn.length > 0) {
                  newMapDisplayData.places = placesThisTurn;
                  mapDataGeneratedThisTurn = true;
                  newMapDisplayData.mapFocus = 'places';
                  const newPlaceIdToIndexMap = new Map<string, number>();
                  placesThisTurn.forEach((place, index) => {
                    if (place.id) {
                      newPlaceIdToIndexMap.set(place.id, index);
                    }
                  });
                  this.placeIdToIndexMap = newPlaceIdToIndexMap;
                  if (placesThisTurn.length === 1) {
                    this.lastSelectedPlace = placesThisTurn[0];
                  }
                }

                if (localWeatherData) {
                  const weatherData = localWeatherData as WeatherData;
                  let locationToDisplay = weatherData.locationCoords;
                  if (!locationToDisplay && weatherData.returnedLocation?.address) {
                    const geocodedLocation = await geocodeAddress(weatherData.returnedLocation.address);
                    if (geocodedLocation) {
                      locationToDisplay = geocodedLocation;
                    }
                  }
                  if (!locationToDisplay) {
                    locationToDisplay = placesThisTurn.find(p => p.location)?.location;
                  }
                  if (locationToDisplay) {
                    if (!weatherData.locationCoords) {
                      weatherData.locationCoords = locationToDisplay;
                    }
                    newMapDisplayData.weather = weatherData;
                    mapDataGeneratedThisTurn = true;
                    newMapDisplayData.mapFocus = 'weather';
                  }
                }

                if (localRouteData) {
                  const currentRoute = localRouteData;
                  const routeAny = currentRoute as any;
                  let originLocation: LatLng | undefined = undefined;
                  const shouldResolveOrigin = routeAny.origin && (!routeAny.origin.lat_lng || (!routeAny.origin.place_id && routeAny.origin.address));
                  if (shouldResolveOrigin) {
                    routeAny.origin = await this.resolveWaypointLocation(routeAny.origin);
                  }
                  if (routeAny.origin?.lat_lng) {
                    originLocation = routeAny.origin.lat_lng;
                  }
                  if (routeAny.destination?.place_id && !routeAny.destination.lat_lng) {
                    const place = await this._fetchPlaceById(routeAny.destination.place_id);
                    if (place && place.location) {
                      routeAny.destination.lat_lng = place.location;
                      if (!routeAny.destination.address) {
                        routeAny.destination.address = place.displayName?.text || place.formattedAddress;
                      }
                    }
                  }
                  const shouldResolveDestination = routeAny.destination && (!routeAny.destination.lat_lng || (!routeAny.destination.place_id && routeAny.destination.address));
                  if (shouldResolveDestination) {
                    routeAny.destination = await this.resolveWaypointLocation(routeAny.destination, originLocation);
                  }
                  const routeResult = await this.decodePolylineForRoute(currentRoute);
                  if (routeResult) {
                    (currentRoute as any).path = routeResult.path;
                    if (routeResult.resolvedWaypoints) {
                      routeAny.origin = { ...routeAny.origin, lat_lng: routeResult.resolvedWaypoints.origin } as RouteWaypoint;
                      routeAny.destination = { ...routeAny.destination, lat_lng: routeResult.resolvedWaypoints.destination } as RouteWaypoint;
                    }
                  }
                  if (routeAny.origin?.place_id && routeAny.origin.lat_lng) {
                    placesThisTurn.push({ id: routeAny.origin.place_id, location: routeAny.origin.lat_lng, formattedAddress: routeAny.origin.address } as Place);
                  }
                  if (routeAny.destination?.place_id && routeAny.destination.lat_lng) {
                    placesThisTurn.push({ id: routeAny.destination.place_id, location: routeAny.destination.lat_lng, formattedAddress: routeAny.destination.address } as Place);
                  }
                  newMapDisplayData.route = currentRoute;
                  mapDataGeneratedThisTurn = true;
                  newMapDisplayData.mapFocus = 'route';
                }

                if (mapDataGeneratedThisTurn) {
                  this.mapDisplayData = newMapDisplayData;
                }

                if (finalAccumulatedText.trim() === '') {
                  if (specificToolError) {
                    finalAccumulatedText = `I couldn't generate a specific response because the route computation failed: ${specificToolError}`;
                  }
                }

                let sources: string[] | undefined;
                if (exchangesFromService && exchangesFromService.length > 0) {
                  sources = this.extractSourceUrls(exchangesFromService);
                }

                this.addOrUpdateMessageInChat(this.currentAiMessageIdRef!, 'model', [{ text: finalAccumulatedText }], true, undefined, localWeatherData ?? undefined, localRouteData ?? undefined, placesThisTurn.length > 0 ? placesThisTurn : undefined, exchangesFromService, sources);

              } else if (data.error) {
                streamError = data.error;
              }
            } catch (e) {
              console.error("Failed to parse SSE chunk:", e);
            }
          }
        }
        await processStream();
      };

      await processStream();

      if (streamError) {
        if (retryAttempt < MAX_AUTO_RETRIES) {
          console.warn(`[Auto-Retry] Stream returned error (${streamError}), retrying automatically (${retryAttempt + 1}/${MAX_AUTO_RETRIES})...`);
          await new Promise(resolve => setTimeout(resolve, 800 * (retryAttempt + 1)));
          return await this.processAiResponse(currentUserMessageText, retryAttempt + 1);
        }
        this.addOrUpdateMessageInChat(this.currentAiMessageIdRef!, 'model', [{ text: `**Error:** ${streamError}` }], true, streamError);
        this.isLoading = false;
        this.currentAiMessageIdRef = null;
      }

    } catch (e) {
      if (retryAttempt < MAX_AUTO_RETRIES) {
        console.warn(`[Auto-Retry] Request failed, retrying automatically (${retryAttempt + 1}/${MAX_AUTO_RETRIES})...`, e);
        await new Promise(resolve => setTimeout(resolve, 800 * (retryAttempt + 1)));
        return await this.processAiResponse(currentUserMessageText, retryAttempt + 1);
      }
      const errorMessage = e instanceof Error ? e.message : "An error occurred with the AI.";
      this.addOrUpdateMessageInChat(this.currentAiMessageIdRef!, 'model', [{ text: `**Error:** ${errorMessage}` }], true, errorMessage);
      this.isLoading = false;
      this.currentAiMessageIdRef = null;
    }
  }

  private handleRetry() {
    if (this.isLoading || !this.lastUserMessageContent) return;

    const lastMessageIndex = this.chatHistory.length - 1;
    const lastMessage = this.chatHistory[lastMessageIndex];

    // 1. Check if the last message is a model error message
    if (lastMessage && lastMessage.role === 'model' && lastMessage.error) {
      // 2. Remove the failed model message and the preceding user message
      // The user message is always the second to last message in a failed turn.
      if (this.chatHistory.length >= 2) {
        this.chatHistory = this.chatHistory.slice(0, lastMessageIndex - 1);
      } else {
        // Should not happen if lastUserMessageContent is set, but handle defensively
        this.chatHistory = [];
      }

      // 3. Resend the stored message
      let messageToResend = this.lastUserMessageContent;

      // Sanitize: If messageToResend looks like HTML, try to extract text content or strip tags
      if (/<[a-z][\s\S]*>/i.test(messageToResend)) {
        console.warn('[Retry] Detected HTML in lastUserMessageContent, stripping tags...', messageToResend);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = messageToResend;
        messageToResend = tempDiv.textContent || tempDiv.innerText || '';
        if (!messageToResend.trim()) {
          // Fallback if stripping results in empty string (e.g. only images/tags)
          messageToResend = this.lastUserMessageContent; // Send as is? Or fail?
          console.error('[Retry] Stripping HTML resulted in empty string. Sending original (risky).');
        }
      }

      // Keep lastUserMessageContent set so the Retry button remains visible if the retry fails.

      // We must simulate the user sending the message again, which means calling handleSendMessage
      // with the content set in userInput, but since we are calling processAiResponse directly,
      // we need to manually add the user message back to history first.
      this.addOrUpdateMessageInChat(generateId(), 'user', [{ text: messageToResend }]);
      this.processAiResponse(messageToResend);
    }
  }

  private handleSendMessage(e?: Event) {
    e?.preventDefault();
    const currentInput = this.userInput.trim();
    const areAllKeysConfigured = this.apiKeysState.geminiApiKeySet && GOOGLE_MAPS_API_KEY;

    if (!currentInput || this.isLoading || !areAllKeysConfigured) return;

    let messageToSend = currentInput;
    this.lastUserMessageContent = currentInput; // Store the original user input for potential retry

    // --- Step 2: Handle Origin Input (if awaiting) ---
    if (this.isAwaitingRouteOrigin && this.pendingRouteDestination) {
      const destination = this.pendingRouteDestination;
      const origin = currentInput;
      const destinationAddress = destination.address;

      messageToSend = `Show me the route from "${origin}" to "${destinationAddress}". The destination's place ID is "${destination.placeId}".`;

      this.isAwaitingRouteOrigin = false;
      this.pendingRouteDestination = null;
      this.lastSelectedPlace = null;

      this.addOrUpdateMessageInChat(generateId(), 'user', [{ text: currentInput }]);
      this.userInput = '';
      this.selectedPlaceIdForDetails = null;

      this.processAiResponse(messageToSend);
      return;
    }

    const routeKeywords = ['route to', 'directions to', 'show me the route to', 'go there', 'take me there'];
    const isRouteRequest = routeKeywords.some(keyword => currentInput.toLowerCase().includes(keyword));

    if (isRouteRequest && this.lastSelectedPlace) {
      const destination = this.lastSelectedPlace;
      const destinationName = destination.displayName?.text || destination.formattedAddress || 'the selected location';

      this.isAwaitingRouteOrigin = true;
      this.pendingRouteDestination = {
        address: destination.formattedAddress || destinationName,
        placeId: destination.id
      };

      this.addOrUpdateMessageInChat(generateId(), 'user', [{ text: currentInput }]);
      this.userInput = '';
      this.selectedPlaceIdForDetails = null;

      this.addOrUpdateMessageInChat(generateId(), 'model', [{ text: `Please provide your starting point to get to the selected location.` }]);
      return;
    } else if (this.lastSelectedPlace) {
      const placeName = this.lastSelectedPlace.displayName?.text || `place with ID ${this.lastSelectedPlace.id}`;
      messageToSend = `${currentInput} (near ${placeName})`;
    }

    this.addOrUpdateMessageInChat(generateId(), 'user', [{ text: currentInput }]);
    this.userInput = '';
    this.selectedPlaceIdForDetails = null;
    this.processAiResponse(messageToSend);
    this.lastSelectedPlace = null; // Clear the context after it's been used
    this.lastSelectedPlace = null; // Clear the context after it's been used
  }


  private handleClosePlaceDetails() {
    this.selectedPlaceIdForDetails = null;
  }


  private toggleChatExpansion() {
    this.isChatExpanded = !this.isChatExpanded;
  }

  private updateToggleVisibility() {
    this.isToggleVisible = true; // Always show the toggle button.
  }


  private handleShowRawResponse(exchanges: ToolExchange[]) {
    this.rawResponseModalContent = exchanges;
    this.isRawResponseModalOpen = true;
  }

  private handleCloseRawResponseModal() {
    this.isRawResponseModalOpen = false;
    this.rawResponseModalContent = [];
  }

  private async handleMapClick(e: any) { // e is a GmpClickEvent
    const placeId = e.placeId;
    if (placeId) {
      // Prevent default POI info window/popover
      if (e.preventDefault) {
        e.preventDefault();
      }
      await this._fetchPlaceDetails(placeId);
    }
  }

  private handleSourceExpanded(e: CustomEvent) {
    if (e.detail?.isExpanded) {
      // Use requestAnimationFrame to ensure the scroll happens after the browser has rendered the height change
      requestAnimationFrame(() => this.scrollToBottom());
    }
  }

  private handleChatContainerClick(e: Event) {
    const target = e.target as HTMLElement;
    // Check if the click is on a place-result link (which includes numbered list items)
    const placeLink = target.closest('a.place-result-link');

    // Debugging logs
    console.log('[ChatContainer] Click detected', { target, placeLink });

    if (placeLink) {
      e.preventDefault();
      const placeId = placeLink.getAttribute('data-place-id');
      console.log('[ChatContainer] Link clicked with placeId:', placeId);

      if (placeId) {
        const place = this.mapDisplayData.places?.find(p => p.id === placeId);
        if (place) {
          console.log('[ChatContainer] Found place, triggering handlePlaceClick', place.displayName?.text);
          this.handlePlaceClick(place);
        } else {
          console.warn('[ChatContainer] Place not found in mapDisplayData for ID:', placeId);
          // Fallback: If place not in mapDisplayData (e.g. from history), try to fetch details or just set ID?
          // For now, let's at least try to set the ID so it opens.
          this.selectedPlaceIdForDetails = placeId;
          this._fetchPlaceDetails(placeId);
          this.scrollToBottom();
        }
      }
    }

    // Ensure scroll to bottom happens on any click inside the chat container,
    // especially if it's a link that triggers a state change.
    this.scrollToBottom();
  }

  private renderPart(part: Part, index: number, message: ChatMessage) {
    if (part.text) {
      const messagePlaces = message.places;
      const _routeDestinationPlaceId = message.routeData?.destination?.place_id;

      // Use AI index directly for lookup, ensuring it starts from 0 for the places array.
      // NOTE: aiIndex is the raw index number found in the text (e.g., 0, 1, 2...).


      // Strategy: Use the index provided by the AI in the text [N] to look up the Nth place in the messagePlaces array.
      // This enforces the CRITICAL rule defined in strategies.md Part 1.

      const decodedText = decodeHTMLEntities(part.text);
      let processedHtml: string;

      // First, determine if the content is primarily Markdown or pre-formatted HTML.
      if (/<[a-z][\s\S]*>/i.test(decodedText)) {
        // If it contains HTML tags, trust it as-is.
        processedHtml = decodedText;
      } else {
        // Otherwise, parse it as Markdown.
        processedHtml = marked.parse(decodedText) as string;
      }

      // Second, on the resulting HTML string, perform the replacement to create clickable links.
      const finalHtml = processedHtml.replace(
        /\[(\d+)\]/g,
        (match, p1) => { // p1 is the AI's index number
          const placeIndex = parseInt(p1, 10);
          if (messagePlaces && placeIndex >= 0 && placeIndex < messagePlaces.length) {
            const placeId = messagePlaces[placeIndex].id;
            if (placeId) {
              return `<a href="#" class="place-result-link place-index-link" data-place-id="${placeId}">${match}</a>`;
            }
          }
          return match;
        }
      );

      return html`<div class="chat-message-content">${unsafeHTML(finalHtml)}</div>`;
    }
    return html`<span class="text-xs italic">[Unsupported part type]</span>`;
  }


  private handlePlaceMarkerClick(e: Event, place: Place) {
    e.stopPropagation(); // Prevent event from bubbling up to the map's general click handler
    trace(`[GMP Click] Marker clicked for place ID: ${place.id}`);
    if (place.id) {
      this.selectedPlaceIdForDetails = place.id;
      this.lastSelectedPlace = place; // Store the selected place for routing context
      this.scrollToBottom(); // Scroll to bottom when place details open
      // Removed explicit mapRange = 2000 to prevent aggressive zoom on marker click.
    }
    this.requestUpdate();
  }

  // --- Map Rendering Helpers ---


  private renderWeatherMarker(data: MapDisplayData['weather']) {
    if (!data || !data.locationCoords) return '';

    // Check for overlap with Places
    // If a place marker exists at the same location, hide the weather marker
    if (this.mapDisplayData.places && this.mapDisplayData.places.length > 0) {
      const hasPlaceOverlap = this.mapDisplayData.places.some(place =>
        place.location && isSameLatLng(place.location, data.locationCoords)
      );
      if (hasPlaceOverlap) {
        return '';
      }
    }

    const position = `${data.locationCoords.latitude}, ${data.locationCoords.longitude}, 50`; // Add 50m altitude for extrusion
    const iconSvg = getWeatherMarkerIcon(data.weatherCondition?.type);
    const title = `Weather: ${data.weatherCondition?.description?.text || 'Click for details'}`;

    // Use marker3d-interactive-element for weather markers
    return html`
      <gmp-marker-3d
        position=${position}
        clickable="true"
        title=${title}
        label=${data.returnedLocation?.address || 'Weather Location'}
        collision-behavior="REQUIRED_AND_HIDES_OPTIONAL"
        .altitudeMode=${this.AltitudeMode.RELATIVE_TO_MESH}
        extruded="true"
        draws-when-occluded="true"
        z-index="1000"
        @click=${(e: Event) => this.handleWeatherMarkerClick(e, data)}
        ${onConnected((el: Element) => this.createAndAppendPin(el as HTMLElement, '', false, '#8E3AF0', '#FFFFFF', 'darkgrey', iconSvg))}
      >
      </gmp-marker-3d>
    `;
  }

  private renderRouteMarkers(routeData: RouteData) {
    const markers = [];

    if (routeData.origin?.lat_lng) {
      const originName = routeData.origin.name || (routeData.origin.place_id ? this.placeNamesCache.get(routeData.origin.place_id) : undefined) || routeData.origin.address || 'Origin';
      const formattedOriginName = formatPlaceNameForLabel(originName);
      markers.push(html`
        <gmp-marker-3d-interactive
          position=${`${routeData.origin.lat_lng.latitude}, ${routeData.origin.lat_lng.longitude}, 50`}
          title=${`Origin: ${originName}`}
          z-index="1000"
          clickable="true"
          collision-behavior="REQUIRED_AND_HIDES_OPTIONAL"
          draws-when-occluded="true"
          .altitudeMode=${this.AltitudeMode.RELATIVE_TO_MESH}
          extruded="true"
          label=${truncateLabel(formattedOriginName)}
          @gmp-click=${(e: any) => {
            if (e.preventDefault) e.preventDefault();
            e.stopPropagation();
            const placeId = routeData.origin?.place_id;
            if (placeId) {
              this.handleMarkerClick(placeId);
            }
          }}
          ${onConnected((el: Element) => this.createAndAppendPin(el as HTMLElement, 'A', false, '#00b40fff', '#ccffcc', '#007300ff'))}
        >
        </gmp-marker-3d-interactive>
      `);
    }

    if (routeData.destination?.lat_lng) {
      const destinationName = routeData.destination.name || (routeData.destination.place_id ? this.placeNamesCache.get(routeData.destination.place_id) : undefined) || routeData.destination.address || 'Destination';
      const formattedDestinationName = formatPlaceNameForLabel(destinationName);
      trace(`[Route Marker] Destination location found: ${routeData.destination.lat_lng.latitude}, ${routeData.destination.lat_lng.longitude}`);
      markers.push(html`
        <gmp-marker-3d-interactive
          position=${`${routeData.destination.lat_lng.latitude}, ${routeData.destination.lat_lng.longitude}, 50`}
          title=${`Destination: ${destinationName}`}
          z-index="1000"
          clickable="true"
          collision-behavior="REQUIRED_AND_HIDES_OPTIONAL"
          draws-when-occluded="true"
          .altitudeMode=${this.AltitudeMode.RELATIVE_TO_MESH}
          extruded="true"
          label=${truncateLabel(formattedDestinationName)}
          @gmp-click=${(e: any) => {
            if (e.preventDefault) e.preventDefault();
            e.stopPropagation();
            const placeId = routeData.destination?.place_id;
            if (placeId) {
              this.handleMarkerClick(placeId);
            }
          }}
          ${onConnected((el: Element) => this.createAndAppendPin(el as HTMLElement, 'B', false, '#FF0000', '#FFFFFF', 'white'))}
        >
        </gmp-marker-3d-interactive>
      `);
    }

    return markers;
  }

  private handleWeatherMarkerClick(e: Event, data: MapDisplayData['weather']) {
    if (!data) return;

    // Close existing InfoWindow if open
    if (this.infoWindowRef) {
      this.infoWindowRef.close();
      this.infoWindowRef = null;
    }

    // Find the marker element that was clicked
    const markerElement = (e.target as HTMLElement).closest('gmp-marker-3d');
    if (!markerElement) return;

    const infoWindowContent = document.createElement('div');
    const weatherDisplayEl = document.createElement('weather-display') as WeatherDisplay;
    weatherDisplayEl.weather = data;
    infoWindowContent.appendChild(weatherDisplayEl);

    // The InfoWindow needs to be created imperatively and attached to the map element
    // Since we don't have a mapRef, we need to find the gmp-map-3d element
    const mapElement = this.shadowRoot?.querySelector('gmp-map-3d') || document.getElementById('map-3d');

    if (mapElement && window.google && window.google.maps) {
      const infoWindow = new window.google.maps.InfoWindow({
        content: infoWindowContent,
        ariaLabel: `Weather at ${data.returnedLocation?.address || 'selected location'}`,
      });

      // Open the InfoWindow anchored to the marker element
      infoWindow.open({ anchor: markerElement as any, map: mapElement as any });
      this.infoWindowRef = infoWindow;
    }

  } // Closing handleWeatherMarkerClick

  private createAndAppendPin(element: HTMLElement, label: string, isSelected: boolean, defaultColor: string, borderColor: string = '#FFFFFF', glyphColor: string = 'white', customContentHtml?: string) {

    if (!this.PinElement) {
      // PinElement is not yet loaded. Queue the creation attempt.
      this.pinCreationQueue.push(() => this.createAndAppendPin(element, label, isSelected, defaultColor, borderColor, glyphColor, customContentHtml));
      return;
    }

    const backgroundColor = defaultColor;
    const scale = 1.0;

    const pinElement = new this.PinElement({
      glyphText: label,
      background: backgroundColor,
      borderColor: borderColor,
      glyphColor: glyphColor,
      scale: scale,
    });

    // Ensure the PinElement does not capture clicks, allowing them to pass to the gmp-marker-3d element
    pinElement.element.style.pointerEvents = 'none';
    // Center the text within the pin element
    pinElement.element.style.textAlign = 'center';
    pinElement.element.style.fontFamily = 'Roboto, sans-serif';

    if (customContentHtml) {
      // If custom content (like an SVG icon) is provided, inject it directly into the pin element's DOM
      // and adjust styling to ensure it's visible and centered.
      pinElement.element.innerHTML = customContentHtml;
      // Ensure the pin element itself is styled for the icon (e.g., size)
      pinElement.element.style.width = '40px';
      pinElement.element.style.height = '40px';
      pinElement.element.style.display = 'flex';
      pinElement.element.style.alignItems = 'center';
      pinElement.element.style.justifyContent = 'center';
      pinElement.element.style.color = glyphColor;
    }

    // Append the PinElement instance (JS object) to the gmp-marker-3d element,
    // as shown in the working example, which correctly applies customization.
    // The custom element handles appending the JS object instance.
    element.replaceChildren(pinElement);
  }


  private renderPlaceMarkers(places: Place[] | null) {
    if (!places) return '';
    return html`
      ${repeat(places, (place: Place) => place.id, (place: Place, index: number) => {
        if (!place.location) return '';

        // Check for overlap with Route or Weather markers (Keep this logic)
        const { route } = this.mapDisplayData;
        const placeLocation = place.location;

        // Check Route Origin/Destination overlap
        if (route) {
          if (isSameLatLng(placeLocation, route.origin?.lat_lng) || isSameLatLng(placeLocation, route.destination?.lat_lng)) {
            return '';
          }
        }

        const isSelected = place.id === this.selectedPlaceIdForDetails;
        const indexLabel = String(this.placeIdToIndexMap.get(place.id) ?? index + 1); // Use 1-based index for display
        const cachedName = place.id && this.placeNamesCache.get(place.id);
        const displayNameText = typeof place.displayName === 'object' ? place.displayName?.text : (typeof place.displayName === 'string' ? place.displayName : undefined);
        const rawPlaceName = cachedName || displayNameText || place.formattedAddress || place.place || `Place ${indexLabel}`;

        const backgroundColor = isSelected ? '#0069a6' : '#00a2ff';
        const borderColor = isSelected ? '#004f7a' : '#0069a6';

        return html`
          <gmp-marker-3d-interactive
            position=${`${place.location.latitude},${place.location.longitude}, 50`}
            title=${`${rawPlaceName} [${indexLabel}] Click for place details`}
            label=${formatPlaceNameForLabel(rawPlaceName)}
            collision-behavior=${this.shouldPlacesBeOptional() ? "OPTIONAL_AND_HIDES_LOWER_PRIORITY" : "REQUIRED_AND_HIDES_OPTIONAL"}
            .altitudeMode=${this.AltitudeMode.RELATIVE_TO_MESH}
            extruded="true"
            draws-when-occluded="true"
            z-index=${isSelected ? 999 : 100 + index}
            @gmp-click=${(e: any) => {
            if (e.preventDefault) e.preventDefault();
            e.stopPropagation();
            this.handleMarkerClick(place.id);
          }}
            ${onConnected((el: Element) => this.createAndAppendPin(el as HTMLElement, indexLabel, isSelected, backgroundColor, borderColor, '#FFFFFF'))}
          >
          </gmp-marker-3d-interactive>
        `;
      })}
    `;
  }
  private renderRoutePolyline(routeData: RouteData) {
    if (!(routeData as any).path) return '';

    // Use gmp-polyline-3d for routes, passing the decoded path array
    return html`
      <gmp-polyline-3d
        .path=${(routeData as any).path}
        stroke-color="#00BFFF"
        stroke-width="4"
        altitude-mode="CLAMP_TO_GROUND"
        extruded="true"
        draws-occluded-segments="true"
      ></gmp-polyline-3d>
    `;
  }






  private _getParsedToolOutput(response: any): any | null {
    if (response && Array.isArray(response.content) && response.content.length > 0 && response.content[0].type === 'text') {
      try {
        return JSON.parse(response.content[0].text);
      } catch (_e) {
        return response;
      }
    }
    return response || null;
  }

  private getPrettyPrintedResponse(response: any): string {
    let parsedOutput = this._getParsedToolOutput(response);
    if (parsedOutput) {
      // Check if the response is for a route and clean it.
      // Check if the response is for a route and clean it.
      // Handle both single route and routes array, and nested structures
      if (parsedOutput) {
        const cleanedOutput = JSON.parse(JSON.stringify(parsedOutput));

        const cleanRoute = (route: any) => {
          if (route) {
            if (route.encodedPolyline) delete route.encodedPolyline;
            if (route.polyline) {
              if (route.polyline.encodedPolyline) delete route.polyline.encodedPolyline;
              if (Object.keys(route.polyline).length === 0) delete route.polyline;
            }
          }
        };

        if (cleanedOutput.routes && Array.isArray(cleanedOutput.routes)) {
          cleanedOutput.routes.forEach(cleanRoute);
        } else if (cleanedOutput.route) {
          cleanRoute(cleanedOutput.route);
        } else if (cleanedOutput.response && cleanedOutput.response.route) {
          cleanRoute(cleanedOutput.response.route);
        } else if (cleanedOutput.response && cleanedOutput.response.routes && Array.isArray(cleanedOutput.response.routes)) {
          cleanedOutput.response.routes.forEach(cleanRoute);
        }

        parsedOutput = cleanedOutput;
      }
      return JSON.stringify(parsedOutput, null, 2);
    }
    if (response && Array.isArray(response.content) && response.content.length > 0 && response.content[0].type === 'text') {
      return response.content[0].text; // Fallback to raw text if it exists but wasn't JSON
    }
    // Default pretty print if structure is unexpected
    return JSON.stringify(response, null, 2);
  }

  private getPrettyPrintedRequest(exchange: ToolExchange): string {
    if ((exchange.toolName === 'search-places-mcp' || exchange.toolName === 'search_places') && exchange.request.query) {
      // Rename 'query' to 'text_query' for display as requested
      const displayRequest = { ...exchange.request, text_query: exchange.request.query };
      delete displayRequest.query;
      return JSON.stringify(displayRequest, null, 2);
    }
    return JSON.stringify(exchange.request, null, 2);
  }


  private shouldRenderWeatherMarker(): boolean {
    if (!this.mapDisplayData.weather) {
      return false; // No weather data to display
    }

    // Check the last message for tool usage
    const lastMessage = this.chatHistory[this.chatHistory.length - 1];

    if (lastMessage && lastMessage.toolExchanges) {
      const toolNames = new Set(lastMessage.toolExchanges.map(tx => tx.toolName));

      const isWeatherToolUsed = toolNames.has('lookup-weather') || toolNames.has('lookup_weather');
      const isPlacesOrRoutesToolUsed = toolNames.has('search-places-mcp') || toolNames.has('search_places') || toolNames.has('compute-routes') || toolNames.has('compute_routes');

      // Hide the weather marker if it's a multi-tool response (Places/Routes + Weather)
      if (isWeatherToolUsed && isPlacesOrRoutesToolUsed) {
        return false;
      }
    }

    return true; // Render if only weather, or no tool info, or data is present
  }
  private shouldPlacesBeOptional(): boolean {
    const lastMessage = this.chatHistory[this.chatHistory.length - 1];

    if (lastMessage && lastMessage.toolExchanges) {
      const toolNames = new Set(lastMessage.toolExchanges.map(tx => tx.toolName));

      const isPlacesToolUsed = toolNames.has('search-places-mcp') || toolNames.has('search_places');
      const isRoutesToolUsed = toolNames.has('compute-routes') || toolNames.has('compute_routes');

      // Make places optional if both routes and places tools were used
      if (isPlacesToolUsed && isRoutesToolUsed) {
        return true;
      }
    }

    return false;
  }
  /**
   * Checks if the Google Maps Platform attribution should be displayed for a model message.
   */
  private shouldShowMapsAttribution(msg: ChatMessage): boolean {
    if (msg.role !== 'model' || !msg.toolExchanges || msg.toolExchanges.length === 0) {
      return false;
    }
    return msg.toolExchanges.some(exchange =>
      exchange.toolName === 'compute-routes' ||
      exchange.toolName === 'compute_routes' ||
      exchange.toolName === 'lookup-weather' ||
      exchange.toolName === 'lookup_weather' ||
      exchange.toolName === 'search_places' ||
      exchange.toolName === 'search-places-mcp'
    );
  }

  private syncPlaceDetailsWidget(container: HTMLElement, placeResourceName: string) {
    container.dataset.placeResource = placeResourceName;

    // Wait until Maps JS registers <gmp-place-details-compact> so its constructor
    // executes before any child elements (<gmp-place-all-content>) are attached.
    if (!customElements.get('gmp-place-details-compact')) {
      if (!container.dataset.waitingForUpgrade) {
        container.dataset.waitingForUpgrade = 'true';
        customElements.whenDefined('gmp-place-details-compact').then(() => {
          delete container.dataset.waitingForUpgrade;
          const targetPlace = container.dataset.placeResource;
          if (container.isConnected && targetPlace) {
            this.syncPlaceDetailsWidget(container, targetPlace);
          }
        });
      }
      return;
    }

    const existingCompact = container.querySelector('gmp-place-details-compact') as HTMLElement | null;
    if (container.dataset.mountedPlace === placeResourceName && existingCompact) {
      return;
    }

    container.dataset.selectedAt = String(Date.now());
    let requestEl = existingCompact?.querySelector('gmp-place-details-place-request') as any;

    if (!existingCompact || !requestEl) {
      container.replaceChildren();
      const compact = document.createElement('gmp-place-details-compact');
      compact.setAttribute('orientation', 'horizontal');

      requestEl = document.createElement('gmp-place-details-place-request') as any;
      requestEl.place = placeResourceName;

      const allContent = document.createElement('gmp-place-all-content');
      compact.append(requestEl, allContent);
      container.appendChild(compact);

      let lastHeight = 0;
      const resizeObserver = new ResizeObserver((entries) => {
        const height = entries[0]?.contentRect.height ?? 0;
        if (height > lastHeight && Date.now() - Number(container.dataset.selectedAt || 0) < 3000) {
          this.scrollToBottom();
        }
        lastHeight = height;
      });
      resizeObserver.observe(compact);
    } else {
      requestEl.place = placeResourceName;
    }

    container.dataset.mountedPlace = placeResourceName;
    this.scrollToBottom();
  }

  private renderPlaceDetailsWidget() {
    if (!this.selectedPlaceIdForDetails) {
      return '';
    }

    const placeResourceName = `places/${this.selectedPlaceIdForDetails}`;

    // Render as a model message at the end of the chat container.
    // Note: <gmp-place-details-compact> is mounted imperatively via syncPlaceDetailsWidget
    // because cloning <gmp-place-details-compact><gmp-place-all-content> from a Lit <template>
    // upgrades PlaceDetailsCompactElement with <gmp-place-all-content> already attached before
    // its preset dictionary is initialized after super() in Maps JS weekly.
    return html`
        <div class="flex justify-start pointer-events-auto flex-shrink-0">
            <div
              class="max-w-full sm:max-w-[90%] w-full p-3 shadow bg-[#FFFFFF] text-[#1A1C1E] rounded-t-2xl rounded-r-2xl rounded-bl-lg"
              ${onConnected((el: Element) => this.syncPlaceDetailsWidget(el as HTMLElement, placeResourceName))}
            ></div>
        </div>
    `;
  }

  // --- Render Method (replaces React's return JSX) ---

  render() {
    const areAllKeysConfigured = this.apiKeysState.geminiApiKeySet && GOOGLE_MAPS_API_KEY;

    return html`
      <style>
        #chat-container::-webkit-scrollbar {
          display: none;
        }
        #chat-container {
          -ms-overflow-style: none;  /* IE and Edge */
          scrollbar-width: none;  /* Firefox */
        }

        .pb-safe {
            padding-bottom: 40px;
            padding-bottom: calc(40px + env(safe-area-inset-bottom));
        }
      </style>

      <div class="w-full h-full bg-[#FCFCFF] text-[#1A1C1E] selection:bg-[#0095ffff] selection:text-[#001F2A]">
        <div id="places-service-dummy" style="display: none;"></div>
        <div class="w-full h-full relative overflow-hidden">

          <!-- Map Container (100% width/height) -->
          <div class="absolute inset-0 w-full h-full">
            <gmp-map-3d
              id="map-3d"
              mode="hybrid"
              default-ui-hidden="true"
              center=${this.mapCenter}
              tilt=${this.mapTilt}
              heading=${this.mapHeading}
              range=${this.mapRange}
              map-id="749ac551edae0fb44cf73ee1"
              internal-usage-attribution-ids="gmp_devsite_groundinglitesampleapp_v1.0.0"
              class="absolute inset-0 w-full h-full"
              aria-label="3D Map of found locations"
              @gmp-click=${this.handleMapClick}
            >
              ${this.mapDisplayData.route ? this.renderRoutePolyline(this.mapDisplayData.route) : ''}
              ${this.mapDisplayData.places ? this.renderPlaceMarkers(this.mapDisplayData.places) : ''}
              ${this.mapDisplayData.route ? this.renderRouteMarkers(this.mapDisplayData.route) : ''}
              ${this.shouldRenderWeatherMarker() ? this.renderWeatherMarker(this.mapDisplayData.weather) : ''}
            </gmp-map-3d>
          </div>

          <!-- Chat Overlay (fixed width, positioned right) -->
          <div id="chat-overlay" class="absolute bottom-0 right-0 w-full sm:w-1/2 xl:w-2/5 flex flex-col z-20 pointer-events-none chat-overlay-height ${this.isChatExpanded ? 'chat-overlay-expanded' : ''}">

            <!-- Mobile Chat Toggle Button -->
            ${this.isToggleVisible ? html`
            <button
              @click=${this.toggleChatExpansion}
              class="absolute top-0 right-0 p-1 z-30 pointer-events-auto text-[#1A1C1E] bg-[#FCFCFF] rounded-tl-lg rounded-bl-lg shadow-md"
              aria-label=${this.isChatExpanded ? 'Minimize chat' : 'Expand chat'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 transition-transform duration-300 ${this.isChatExpanded ? 'rotate-180' : 'rotate-0'}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
              </svg>
            </button>
            ` : ''}
            </button>
           <!-- <header class="text-center p-4 sm:p-6 border-b border-[#DFE3E8] flex-shrink-0">
              <h1 class="text-3xl sm:text-4xl font-bold text-[#006780]">
                <strong>M</strong>aps<strong>C</strong>onvo<strong>P</strong>al Assistant
              </h1>
              <p class="text-[#42474E] text-xs sm:text-sm mt-1">Your conversational guide, with interactive maps!</p>
            </header> -->

            ${this.apiKeysState.errorMessage ? html`
              <div class="p-3 bg-[#F9DEDC] text-[#410E0B] text-sm text-center flex-shrink-0">
                <p class="font-semibold">Configuration Error:</p>
                <p>${this.apiKeysState.errorMessage}</p>
              </div>
            ` : ''}

            <!-- Removed background from chat-container -->
            <div id="chat-container" @click=${this.handleChatContainerClick} class="flex-grow mx-4 pt-4 pb-1 sm:mx-6 sm:pt-6 sm:pb-1 space-y-4 overflow-y-auto scroll-smooth flex flex-col pointer-events-auto rounded-t-2xl">
              <div class="flex-grow"></div>
              ${repeat(this.chatHistory, (msg: ChatMessage) => msg.id, (msg: ChatMessage) => html`
                <div class="flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} pointer-events-auto">
                  <div class="max-w-full sm:max-w-[90%] p-3 shadow ${msg.role === 'user' ? 'bg-[#0095ffff] text-white rounded-t-2xl rounded-l-2xl rounded-br-lg' :
                  'bg-[#FFFFFF] text-[#1A1C1E] rounded-t-2xl rounded-r-2xl rounded-bl-lg'
      }">
                    ${msg.weatherData ? html`<weather-display .weather=${msg.weatherData}></weather-display>` : ''}
                    <!-- TODO: Add a placeholder at the end of the response -->
                    ${msg.routeData ? html`<route-display .route=${msg.routeData}></route-display>` : ''}
                    ${msg.parts && msg.parts.length > 0 ? this.renderPart(msg.parts[0], 0, msg) : ''}
                    ${msg.error && !msg.parts[0]?.text?.includes(msg.error) ? html`
                        <p class="text-red-700 text-xs mt-1 font-semibold chat-message-content">Error: ${msg.error}</p>
                    ` : ''}

                    ${msg.role === 'model' && msg.sourceURLs && msg.sourceURLs.length > 0 ? html`
                        <div class="ml-5 mt-4">
                            <sources-container .urls=${msg.sourceURLs} @sources-expanded=${this.handleSourceExpanded}></sources-container>
                        </div>
                    `: ''}

                    <!-- New footer: Logo | MCP Button | Time -->
                    <!-- New footer: MCP Button | Attribution | Time -->
                    <div class="flex justify-between items-center mt-2 w-full">
                        <!-- Left Block: MCP Button, Attribution, and Retry Button (to match image/order) -->
                        <div class="flex items-center gap-2">
                            ${msg.role === 'model' && msg.toolExchanges && msg.toolExchanges.length > 0 ? html`
                                <button
                                    @click=${() => this.handleShowRawResponse(msg.toolExchanges!)}
                                    class="text-xs px-2 py-0.5 rounded border border-[#74777F] text-[#44474E] bg-[#FFFFFF] hover:bg-[#F3F4F6] transition-colors shadow-sm"
                                >
                                    MCP response
                                </button>
                            ` : ''}

                            ${this.shouldShowMapsAttribution(msg) ? html`
                                <span class="GMP-attribution text-s text-[#42474E] opacity-70">Google Maps</span>
                            ` : ''}

                            ${msg.role === 'model' && msg.error && this.lastUserMessageContent ? html`
                                <button
                                    @click=${this.handleRetry}
                                    class="text-xs px-2 py-0.5 rounded bg-[#B3261E] text-white hover:bg-[#8C1C16] transition-colors shadow-sm"
                                >
                                    Retry
                                </button>
                            ` : ''}
                        </div>

                        <!-- Right Block: Timestamp -->
                        <p class="text-xs opacity-70 sm:block chat-timestamp ${msg.role === 'user' ? 'text-white' : msg.error ? 'text-[#410E0B]' : 'text-[#42474E]'}">
                            ${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                    </div>
                  </div>
                </div>
              `)}

              ${this.isLoading && !this.currentAiMessageIdRef ? html`
                <div class="flex justify-center p-4"> <loading-spinner></loading-spinner> </div>
              ` : ''}

              <!-- Place Details Widget (New Location) -->
              ${this.renderPlaceDetailsWidget()}
            </div>

            <!-- Input area container: restored to flex flow for correct height calculation -->
            <div class="px-4 sm:p-6 flex-shrink-0 pointer-events-auto pb-safe">
              <div class="overflow-x-auto px-4 -mx-4 sm:p-0 sm:m-0 sm:flex sm:flex-col sm:gap-1 quick-answers-mobile-layout">
                <div class="flex gap-1 w-max sm:w-full sm:block py-0.5 sm:py-0">
                ${(this.chatHistory.length <= 1 || (this.chatHistory.length <= 3 && this.chatHistory[0]?.parts[0]?.text?.includes('Session Refreshed')) ? this.quickAnswers : this.getDynamicQuickAnswers()).map(answer => html`
                  <button
                    @click=${() => this.handleQuickAnswerClick(answer)}
                    @mouseover=${this.handleQuickAnswerMouseOver}
                    @mouseout=${this.handleQuickAnswerMouseOut}
                    @touchstart=${this.handleQuickAnswerMouseOver}
                    @touchend=${this.handleQuickAnswerMouseOut}
                    @touchcancel=${this.handleQuickAnswerMouseOut}
                    @contextmenu=${(e: Event) => e.preventDefault()}
                    class="quick-answer-button text-xs px-3 py-1.5 rounded-full text-white bg-[rgb(200,87,249)] hover:bg-[rgb(180,70,230)] active:bg-[rgb(180,70,230)] transition-colors duration-150 shadow max-w-full flex-shrink-0 whitespace-nowrap sm:self-start sm:truncate sm:mb-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    ?disabled=${this.isLoading}
                  >
                    ${answer}
                  </button>
                `)}
                </div>
              </div>
              <form @submit=${this.handleSendMessage}>
                <div class="flex items-center">
                  <input
                    type="text"
                    .value=${this.userInput}
                    @input=${(e: Event) => this.userInput = (e.target as HTMLInputElement).value}
                    placeholder=${this.isAwaitingRouteOrigin ? "Enter your starting point (origin)" : (areAllKeysConfigured ? "Enter a location search" : "API keys must be configured.")}
                    class="flex-grow p-3 text-sm text-[#1A1C1E] bg-[#F0F2F5] rounded-l-full focus:outline-none disabled:opacity-50 shadow"
                    ?disabled=${this.isLoading || !areAllKeysConfigured}
                    aria-label="User input"
                  />

                  <button
                    type="submit"
                    class="bg-[#006780] text-white p-[10px] rounded-r-full hover:bg-[#004F63] active:bg-[#42474E] focus:outline-none focus:ring-2 focus:ring-[#006780] disabled:bg-[#A0A5AA] disabled:cursor-not-allowed shadow"
                    ?disabled=${this.isLoading || !this.userInput.trim() || !areAllKeysConfigured}
                    aria-label="Send message"
                  >
                      ${this.isLoading ? html`<loading-spinner class="h-6 w-6 text-white"></loading-spinner>` : html`
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" /></svg>
                      `}
                  </button>
                </div>
              </form>
            </div>
          </div>

        </div> <!-- Close Main Wrapper (line 924) -->

        </div>
      </div>

      <!-- Raw Response Modal Overlay -->
      ${this.isRawResponseModalOpen ? html`
        <div class="fixed inset-0 flex items-center justify-center z-50 p-4 pointer-events-auto bg-white bg-opacity-80 backdrop-blur-sm" @click=${this.handleCloseRawResponseModal}>
          <div class="bg-white rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col border border-gray-200" @click=${(e: Event) => e.stopPropagation()}>
            <div class="p-4 border-b flex justify-between items-center bg-[#F0F2F5]">
              <h2 class="text-lg font-semibold text-[#1A1C1E]">Grounding Lite Request - Response</h2>
              <button @click=${this.handleCloseRawResponseModal} class="text-gray-500 hover:text-gray-700" aria-label="Close modal">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div class="flex-grow overflow-y-auto p-4 space-y-6">
              ${repeat(this.rawResponseModalContent, (exchange: ToolExchange, index: number) => html`
                <div class="border border-gray-300 rounded-lg p-4 bg-white shadow-sm">
                  <h3 class="text-md font-bold text-[#006780] mb-3">Tool Call ${index + 1}: ${exchange.toolName}</h3>

                  <!-- Request -->
                  <div class="mb-4">
                    <h4 class="text-sm font-semibold text-gray-700 mb-1">Request Arguments:</h4>
                    <pre class="text-xs p-3 bg-gray-100 text-gray-800 rounded whitespace-pre-wrap overflow-x-auto">${this.getPrettyPrintedRequest(exchange)}</pre>
                  </div>

                  <!-- Response -->
                  <div>
                    <h4 class="text-sm font-semibold text-gray-700 mb-1 ${exchange.isFailure ? 'text-red-600' : 'text-green-600'}">
                      Response (${exchange.isFailure ? 'Failure' : 'Success'}):
                    </h4>
                    <pre class="text-xs p-3 ${exchange.isFailure ? 'bg-red-50 text-red-800' : 'bg-gray-800 text-green-400'} rounded whitespace-pre-wrap overflow-x-auto">${this.getPrettyPrintedResponse(exchange.response)}</pre>
                  </div>
                </div>
              `)}
            </div>
          </div>
        </div>
      ` : ''}
    `;
  }
  private extractSourceUrls(toolExchanges: ToolExchange[]): string[] {
    trace('toolExchanges:', toolExchanges);
    const urls = new Set<string>();

    for (const exchange of toolExchanges) {
      const toolOutput = this._getParsedToolOutput(exchange.response) || exchange.response;

      // Check for both wrapped and unwrapped places
      if ((exchange.toolName === 'search_places' || exchange.toolName === 'search-places-mcp') && !exchange.isFailure && (toolOutput?.places || toolOutput?.response?.places)) {
        const places = toolOutput.places || toolOutput.response.places;
        if (Array.isArray(places)) {
          for (const place of places) {
            const placeUrl = place.googleMapsUri ||
              place.googleMapsLinks?.placeUrl ||
              place.googleMapsLinks?.placeUri ||
              place.placeUri ||
              place.placeUrl ||
              (place.id ? `https://www.google.com/maps/place/?q=place_id:${place.id}` : undefined);
            if (placeUrl) {
              urls.add(placeUrl);
            }
          }
        }
      } else if ((exchange.toolName === 'lookup-weather' || exchange.toolName === 'lookup_weather') && !exchange.isFailure) {
        // Per user request, do not add generic Google Maps URL for weather results.
      } else if ((exchange.toolName === 'compute-routes' || exchange.toolName === 'compute_routes') && !exchange.isFailure) {
        // Per user request, do not add generic Google Maps URL for route results.
      }
    }

    const result = Array.from(urls);
    trace('extracted urls:', result);
    return result;
  }
}

