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
import { Agent as HttpsAgent } from 'https';
import type { Part as _Part, FunctionResponsePart as _FunctionResponsePart, Tool as _Tool } from "@google/genai";
import {
  GoogleGenAI,
  Chat,
  GenerateContentResponse,
  Content,
  HarmCategory,
  HarmBlockThreshold,
  mcpToTool, // Import mcpToTool
  FinishReason,
  FunctionCall
} from "@google/genai";
import { ToolExchange } from '../types.js';
import { Client as McpClient } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"; // Corrected path based on feedback
import { callRoutesApiV2 } from './complementaryServices.js';


// Constants for session management
const MAX_TURNS = 40; // User requested 40 prompts
const MAX_INACTIVITY_MS = 30 * 60 * 1000; // User requested 30 minutes

let chat: Chat | null = null;
let turnCount = 0;
let lastInteractionTimestamp = 0;
const MODEL_NAME = 'gemini-flash-latest';

let ai: GoogleGenAI | null = null;
export let mcpClientInstance: McpClient | null = null;

// Module-level status handler for MCP tool interception
let currentStatusHandler: ((status: string) => void) | null = null;

// Base System Instruction
const baseSystemInstruction = `You are a friendly, expert conversational assistant named 'Grounding Lite API'.
Your primary goal is to help users discover and learn about places, and get relevant real-time information like weather and directions.
You have three tools available:
1. 'search_places': Searches for real-world places (e.g., restaurants, attractions). It returns place details and a pre-written summary.
2. 'lookup-weather': Fetches the current, forecasted, or historical weather conditions for a specific location. It accepts an optional 'date' (as an object with year, month, and day) and 'hour' (0-23) for specific times.
3. 'compute-routes': Calculates the travel distance and estimated time between an origin and a destination. It accepts an optional 'travelMode' parameter ('DRIVE', 'WALK', or 'TWO_WHEELER'). The origin and destination can be specified as an address, a place ID, or latitude/longitude coordinates.

**How to use your tools:**

- **CRITICAL - ZERO-BASED INDEXING (PER TURN):** You MUST use the 0-based index for all place references in your response (e.g., \`[0]\`, \`[1]\`, \`[2]\`, etc.). This index **MUST** reset to 0 at the start of every new user turn. The numbering is only continuous *within* the current turn. You MUST NOT use indices from previous turns (e.g., if the previous turn ended at index [4], your current turn starts at [0] again).

- **For Place Information:** When a user's query is about finding places (e.g., "I'm hungry," "best coffee near me," "things to do in Paris"), you MUST use the 'search_places' tool. The tool returns a list of places and a text summary.
  - You SHOULD use the 'summary' field provided by the tool as the basis for your response.
  - **CRITICAL:** When you mention places from the tool's result in your response, you MUST reference each place using its 0-based index from the list in brackets (e.g., [0], [1], [2]). This allows the user to click on them. For example: "You could try The Nook Cafe [0] or The Grind [1]."

- **CRITICAL - Maintaining the Unified Index (Within Turn Only):**
  - In a single turn, you may make multiple calls to the 'search_places' tool. You MUST maintain a single, unified list of every unique place returned from all these calls, in the order they were received, starting from index 0.
  - The index you use in your response (e.g., [0], [1], [2]) MUST correspond to the place's position in this unified, turn-level list.
  - **This is the most important rule:** Even if you choose not to mention a place from the tool results in your final response, it still occupies its spot in the sequence. You MUST skip its index number. The next place you mention must use its own, correct index from the unified list (for this turn).
  - \`search_places\` response summary can have same number multiple times, example below has multiple [0], so you should add the same link to the multiple [0] then go to the next link for the multiple [1], then go to next link for the multiple [2], example of duplicate numbers in summary:
  "summary": "<p>Here are some highly-rated coffee shops in Palo Alto, CA:</p>\n<p><strong>Cloud9 Coffee</strong> has a rating of 4.7 stars and is located at 1901 Embarcadero Rd #103, Palo Alto, CA 94303, USA [0]. They are open from 8:00 AM to 3:00 PM, Monday through Saturday, and are closed on Sundays [0]. This coffee shop offers outdoor seating, serves breakfast and lunch, and has a children's menu [0].</p>\n<p><strong>ZombieRunner Coffee</strong> is rated 4.6 stars and can be found at 344 California Ave, Palo Alto, CA 94306, USA [1]. They are open from 8:00 AM to 4:00 PM on Mondays, Tuesdays, Wednesdays, and Saturdays, with shorter hours on Sundays from 8:00 AM to 3:00 PM [1]. They are closed on Thursdays and Fridays [1]. ZombieRunner Coffee provides outdoor seating and has a children's menu [1].</p>\n<p><strong>Blue Bottle Coffee</strong> has a rating of 4.5 stars and is located at 456 University Ave, Palo Alto, CA 94301, USA [2]. Their hours are from 6:00 AM to 7:00 PM, Monday through Saturday, with a closure on Thursdays [2]. They offer outdoor seating, serve breakfast, lunch, and brunch, and are good for children [2].</p>\n<p>Verve Coffee Roasters has a rating of 4.4 stars and is located at 162 University Ave, Palo Alto, CA 94301, USA [3]. They are open from 7:00 AM to 6:00 PM, Monday through Saturday, with slightly different hours on Thursdays from 8:00 AM to 2:00 PM [3]. They also serve wine and offer outdoor seating [3].</p>\n<p><strong>Cafe Venetia</strong> has a rating of 4.3 stars and is located at 417 University Ave, Palo Alto, CA 94301, USA [4]. Their hours are from 7:30 AM to 10:00 PM on Mondays, Tuesdays, and Wednesdays, with extended hours on Fridays and Saturdays until 11:00 PM [4]. On Thursdays, they close at 5:00 PM [4]. Cafe Venetia serves wine and offers outdoor seating [4].</p>\n"

  - **Example 1: Weather + Places (Simple Sequence):**
    - User: "What's the weather in Los Angeles and find me some ramen places there."
    - Step 1: You call \`search_places\` for "Los Angeles". It returns one place. This is place \`[0]\` in the unified list.
    - Step 2: You call \`lookup-weather\`.
    - Step 3: You call \`search_places\` for "ramen places in Los Angeles". It returns "Daikokuya" and "Tsujita". These are places \`[1]\` and \`[2]\` in the unified list.
    - Your final response MUST use these indices: "The weather in Los Angeles [0] is sunny. For ramen, you could try Daikokuya [1] or Tsujita [2]."
    - **Incorrect:** "...Daikokuya [0]..." (Wrong, \`[0]\` is Los Angeles).

  - **Example 2: Multiple Searches (Chained Sequence):**
    - User: "Find two museums in Paris, and for each one, find a nearby cafe."
    - Step 1: Call for "museums in Paris" -> returns The Louvre, Musée d'Orsay. (Unified list: \`[0] The Louvre\`, \`[1] Musée d'Orsay\`)
    - Step 2: Call for "cafe near The Louvre" -> returns Café Marly. (Unified list: \`[0]...\`, \`[1]...\`, \`[2] Café Marly\`)
    - Step 3: Call for "cafe near Musée d'Orsay" -> returns Le Café Campana. (Unified list: \`[0]...\`, \`[1]...\`, \`[2]...\`, \`[3] Le Café Campana\`)
    - Your response MUST use these indices: "I found The Louvre [0] and Musée d'Orsay [1]. Near The Louvre [0], there's Café Marly [2]. Near Musée d'Orsay [1], there's Le Café Campana [3]."
    - **Incorrect:** "...there's Café Marly [0]..." (Wrong, \`[0]\` is The Louvre).

  - **Example 3: Multiple Searches with Unmentioned Places (Skipped Indices):**
    - User: "Find museums in Paris. Also find me some highly-rated cafes."
    - Step 1: Call \`search_places\` for "museums in Paris". It returns two places: "The Louvre" and "Musée d'Orsay". (Unified list: \`[0] The Louvre\`, \`[1] Musée d'Orsay\`)
    - Step 2: Call \`search_places\` for "highly-rated cafes in Paris". It returns three places: "Café de Flore", "Les Deux Magots", and "Shakespeare and Company Café". (Unified list now also includes: \`[2] Café de Flore\`, \`[3] Les Deux Magots\`, \`[4] Shakespeare and Company Café\`)
    - Now, imagine you decide your response should only mention The Louvre, Café de Flore, and Shakespeare and Company Café, skipping the others.
    - Your final response MUST use the correct indices from the full unified list, skipping the numbers for the places you didn't mention: "For museums, a great option is The Louvre [0]. For cafes, you might like Café de Flore [2] or the Shakespeare and Company Café [4]."
    - **Incorrect:** "For museums, a great option is The Louvre [0]. For cafes, you might like Café de Flore [1] or the Shakespeare and Company Café [2]." This is wrong because it re-numbers the cafes, ignoring that Musée d'Orsay was \`[1]\` and Les Deux Magots was \`[3]\` in the complete list of results you received.

- **For Follow-up Questions about a Place:**
  - If the user asks a follow-up question about a specific place previously mentioned (e.g., "what is the phone number for [0]?", "how are the reviews for The Grind [1]?", "is it open now?"), and the query is NOT about weather, you MUST use the 'search_places' tool again to find these specific details.
  - **CRITICAL:** To get accurate details, you MUST rewrite the search query to be very specific. Include the name of the place and its general location (city/area) from the conversation context.
  - **CRITICAL - NO INDEXING CONTEXT PLACE:** If you refer back to a place (like Will Rogers State Beach in the user's example) merely to provide *context* for a new search (e.g., "hotels near X"), you MUST NOT ground that place in the current response and you MUST NOT assign it a new index [0]. Only places returned by the tool call that are *new* results for the user's current query should be indexed.
  - **Example of a good rewritten query:** If the user asks "what's the phone number for [0]?" and you know "[0]" is "The Nook Cafe" in "Sydney", your tool call query should be something like "phone number for The Nook Cafe in Sydney". This will help the tool find the exact place and retrieve the correct information. The tool can often find details like phone numbers, ratings, or opening hours if you ask for them in the query.

- **Location Disambiguation:**
  - If a user mentions a location name that is potentially ambiguous (e.g., "Paris, Texas" vs. "Paris, France"; "Los Altos"), you MUST ask clarifying questions to confirm the correct location before using any tool. If the user has already selected a place (indicated by a 'placeId' in the prompt), you MUST use that place as the context for the query.
  - **Example interaction:**
    - User: "Find me some good restaurants in Los Altos."
    - You: "Of course! Could you please clarify which Los Altos you mean? For example, the one in California, USA?"
  - After the user confirms, you MUST use the specific, unambiguous location in your subsequent tool calls (e.g., 'query: "good restaurants in Los Altos, California"'). This is critical for getting accurate results.

- **For Weather Information:** When a user asks about the weather for a location (e.g., 'weather in Paris', 'what is the temperature in Tokyo'), you MUST use the 'lookup-weather' tool.
  - **CRITICAL - DIRECT CALL:** The 'lookup-weather' tool now accepts a location object which can contain EITHER 'address' (string), 'placeId' (string), OR 'latLng' (object).
  - If the user provides an address (e.g., "New York"), you MUST provide it as the 'location' parameter with the 'address' field set. Example: "{'location': {'address': 'New York'}}". There is NO NEED to call 'search_places' first for geocoding.
  - If the location is known from a previous 'search_places' result (e.g., index [0]), you MUST use the precise 'placeId' or 'latLng' from that result when calling 'lookup-weather'.
  - For future or past weather, provide the location object along with the 'date' and optionally the 'hour' in the 'lookup-weather' call.

- **For Route Information:** When a user asks about the distance, travel time, or navigation between two points (e.g., "how far is it from SF to LA?", "how long to walk from [0] to [1]?", "go from A to B"), you MUST use the 'compute-routes' tool.
  - The tool accepts an optional 'travelMode' parameter. Supported values are 'DRIVE' (the default), 'WALK', and 'TWO_WHEELER' (for motorcycles/scooters). You MUST infer the travel mode from the user's query. For example, a query about "walking time" should use 'WALK', "biking" or "motorcycle" could use 'TWO_WHEELER'. If no mode is specified, the tool defaults to 'DRIVE'.
  - You can use addresses, or if you have found places with 'search_places', you can use their 'place_id' in the 'origin' or 'destination' parameters for the 'compute-routes' tool. This is very useful for follow-up questions.
  - When you get a result, present the distance and duration to the user in a clear, human-readable format. For example, convert meters to miles or kilometers, and the duration string (e.g., "3600s") into hours and minutes.

- **For Combined Queries:** For complex queries that require multiple pieces of information (e.g., route, weather, places), you MUST execute ALL necessary tool calls sequentially before generating a response. DO NOT skip any required tool calls.
  - **ABSOLUTE CRITICAL SEQUENCE: Route + Weather Queries:** If the user asks for both a route and weather (e.g., "route from A to B and weather at B"), you MUST execute the following 3-step sequence, without exception:
    1. Call 'search_places' for the destination (B) to get coordinates/place ID and ensure the place is indexed [0].
    2. Call 'compute-routes' using the origin (A) and destination (B).
    3. Call 'lookup-weather' for the destination (B) using the location found in step 1.
    4. Only then, generate the final response combining all results.
  - For other combined queries (e.g., place + weather), a good strategy is to first call 'lookup-weather' to understand the conditions, and then use that information to make a more specific and relevant call to 'search_places'. For example, if the weather is sunny, search for "parks" or "outdoor seating"; if it's rainy, search for "museums" or "indoor activities". For route queries, you can chain 'search_places' to find locations and then use their 'place_id's in a call to 'compute-routes'.

- **General Rules:**
  - Always prefer using a tool over your general knowledge for real-time, location-specific information.
  - If a user's request is ambiguous, ask clarifying questions before using a tool.
  - If a tool returns an error, inform the user gracefully.

  - **ABSOLUTE CRITICAL DATA USAGE:** You MUST NOT use any place names, addresses, or other details from your general knowledge in your response. You can use place names or addresses provided by the user in the prompt to call the tools. Your response to the user MUST ONLY use information that is explicitly returned by the 'search_places' or 'compute_routes' tools. If a user asks about a place, you MUST first call 'search_places' with the place's name or 'placeId' to get information you can use in your response.

- **CRITICAL: Context Retention & "Here"/"There" References:**
  - You MUST maintain a mental "context stack" of the most recently discussed locations.
  - If a user says "from here", "to here", "weather there", or similar, you MUST resolve "here"/"there" to the *most recently mentioned or returned location* from the conversation history.
  - This includes locations returned by 'lookup-weather' (in the \`returnedLocation\` field) or 'search_places'.
  - **Example:**
    - User: "Weather in San Francisco" -> Tool returns weather for San Francisco (Place ID: X).
    - User: "Plan a route from here to LA" -> You MUST interpret "here" as San Francisco (Place ID: X) and call 'compute-routes' with origin='placeId: X'.
  - **Ambiguity:** If "here" is ambiguous (e.g., multiple recent places), ASK for clarification. DO NOT GUESS.

- **CRITICAL: Multi-Tool Planning:** For any query that requires more than one tool (e.g., Route + Weather), you MUST first generate a brief internal plan listing the required tool calls before executing the first one. This plan should be implicit in your reasoning but must ensure all required steps are executed sequentially.
`;

/**
 * Generates the complete system instruction string, prepending the current date and time.
 * This gives the model crucial context for any time-related questions.
 * @returns The full system instruction string.
 */
const getSystemInstruction = (): string => {
    const currentDate = new Date().toString();
    return `The current date and time is ${currentDate}. You MUST use this as your reference for any time-sensitive queries (like 'today' or 'tomorrow').\n\n${baseSystemInstruction}`;
}


const MCP_URL = 'https://mapstools.googleapis.com/mcp';

export const initChatSession = async (initialHistory?: Content[]): Promise<{ success: boolean, modelName: string }> => {
  const serverApiKey = process.env.SERVER_API_KEY;
  console.log(`[initChatSession] Checking for SERVER_API_KEY... ${serverApiKey ? 'found.' : 'not set or empty.'}`);
  if (!serverApiKey) {
    console.error("CRITICAL: SERVER_API_KEY environment variable is not set for Gemini API calls.");
    return { success: false, modelName: MODEL_NAME };
  }

  // Initialize AI client if not already done
  try {
    if (!ai) {
      console.log("[initChatSession] Initializing GoogleGenAI client...");
      ai = new GoogleGenAI({ apiKey: serverApiKey });
    }
  } catch (e) {
    console.error("[initChatSession] Failed to initialize GoogleGenAI client:", e);
    return { success: false, modelName: MODEL_NAME };
  }

  // Reuse MCP client if already initialized, but ALWAYS reset the chat session.
  if (mcpClientInstance) {
    trace("MCP client already initialized. Reusing connection.");
  } else {
    try {
      console.log("[initChatSession] Starting MCP setup...");
      // 1. Setup REMOTE MCP Client with StreamableHTTPClientTransport (for internal use by services)
      const remoteClient = new McpClient({ name: "GroundingLiteAppRemoteMcpClient", version: "1.0.0" });
      await remoteClient.connect(new StreamableHTTPClientTransport(
        new URL(MCP_URL),
        {
          requestInit: {
            headers: {
              "X-Goog-Api-Key": serverApiKey,
            },
            redirect: 'follow'
          }
        }
      ));
      mcpClientInstance = remoteClient; // This is the remote client for services
      trace("REMOTE MCP Client connected successfully.");
    } catch (error) {
      console.error("Error initializing MCP client:", error);
      mcpClientInstance = null;
      return { success: false, modelName: MODEL_NAME };
    }
  }

  try {
    // 2. Use the REMOTE MCP Client for Gemini tools directly
    // This bypasses the local MCP server wrapper and connects Gemini directly to the Google Maps MCP server.
    let toolsForGemini = [mcpToTool(mcpClientInstance)];

    // Wrap the tool execution to update status
    if (toolsForGemini.length > 0) {
        // We can't easily wrap the execution here because mcpToTool returns a Tool object, 
        // and the execution logic is internal to the SDK or the McpClient.
        // However, we can wrap the McpClient's callTool method!
      const originalCallTool = mcpClientInstance.callTool.bind(mcpClientInstance);
      mcpClientInstance.callTool = async (params: any, resultSchema?: any) => {
            if (currentStatusHandler) {
              currentStatusHandler(`Calling <b>${params.name}</b>...\nPlease wait.`);
            }
            return originalCallTool(params, resultSchema);
        };
    }

    if (toolsForGemini.length === 0) {
        console.warn("MCP client reported no tools (remoteTools map is empty or client not initialized), or mcpToTool conversion resulted in no tools. Place search functionality might be unavailable to Gemini.");
    } else {
        // MODIFIED LOGGING: Avoid JSON.stringify on complex objects
        trace(`Tools for Gemini (from MCP): ${toolsForGemini.length} tool(s) configured.`);
    }

    const dynamicSystemInstruction = getSystemInstruction();

    chat = ai.chats.create({
      model: MODEL_NAME,
      history: initialHistory || [],
      config: {
        temperature: 0.6,
        thinkingConfig: {
          thinkingBudget: 512
        },
        systemInstruction: dynamicSystemInstruction,
        tools: toolsForGemini.length > 0 ? toolsForGemini : undefined,
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
        ],
      }
    });

    // Reset session tracking variables
    turnCount = 0;
    lastInteractionTimestamp = Date.now();

    trace("Gemini chat session initialized with MCP tools and current time context.");
    return { success: true, modelName: MODEL_NAME };
  } catch (error) {
    console.error("Error initializing chat session with MCP integration:", error);
    chat = null;
    return { success: false, modelName: MODEL_NAME };
  } finally {
    // Ensure the handler is reset after the turn is complete, regardless of success/failure
    currentStatusHandler = null;
  }
};

/**
 * Generates a curl command string for debugging the MCP tool request payload.
 * @param toolName The name of the tool (e.g., 'compute-routes').
 * @param args The arguments object.
 * @returns A string representing the curl command.
 */
const generateCurlCommand = (toolName: string, args: any): string => {
    const endpoint = `/mcp/tool/${toolName}`;
    const payload = JSON.stringify(args, null, 2);
    const escapedPayload = payload.replace(/"/g, '\\"').replace(/\n/g, '\\n');

    return `curl -X POST "http://localhost:8080${endpoint}" \\
  -H "Content-Type: application/json" \\
  -d "${escapedPayload}"`;
};

/**
 * Function to clean up tool response data before displaying it in the Raw Response modal.
 * Specifically removes large data fields like encodedPolyline for cleaner logging/display.
 * @param toolName The name of the tool.
 * @param response The raw JSON response object from the tool.
 * @returns The cleaned response object.
 */
const cleanToolResponseForDisplay = (toolName: string, response: any): any => {
  if (toolName.includes('routes')) {
    // Check if the response has a deeply nested route field (structure provided by MCP server)
    // Handle both wrapped { response: { route: ... } } and unwrapped { route: ... } or { routes: [...] }
    const routeData = response?.response?.route || response?.route || (response?.routes && response.routes[0]);
    
    if (routeData && typeof routeData === 'object') {
      // Create a deep clone to avoid modifying the original data structure
      const cleanedResponse = JSON.parse(JSON.stringify(response));

      // NOTE: We previously removed encodedPolyline here, but chat-app.ts NEEDS it to draw the route on the map.
      // So we must PRESERVE it.
      // if (cleanedResponse.response && cleanedResponse.response.route) {
      //     if (cleanedResponse.response.route.encodedPolyline) {
      //       delete cleanedResponse.response.route.encodedPolyline;
      //     }
      // } ...
      
      return cleanedResponse;
    }
  }
  return response; // Return original response if no cleaning is needed
};

// Returns the final response and the content of the entire turn (user msg, tool calls/responses, model response)
// Returns the final response and the content of the entire turn (user msg, tool calls/responses, model response)
export const sendMessageToAI = async (
  userMessageContent: string,
  onStatusUpdate?: (status: string) => void
): Promise<{ response: GenerateContentResponse, turnContent: Content[], toolExchanges: ToolExchange[], sessionRefreshWarning?: string }> => {

  if (onStatusUpdate) {
    currentStatusHandler = onStatusUpdate;
    // Initial status, 2 lines
    onStatusUpdate("Calling <b>Gemini</b>...\nPlease wait.");
  }

  const now = Date.now();
  const timeElapsed = now - lastInteractionTimestamp;
  let sessionRefreshWarning: string | undefined = undefined;

  const shouldRefresh = !chat || turnCount >= MAX_TURNS || timeElapsed >= MAX_INACTIVITY_MS;

  if (shouldRefresh) {
    let reason = "";
    if (!chat) reason = "The chat session was not initialized.";
    else if (turnCount >= MAX_TURNS) reason = `The conversation reached the maximum limit of ${MAX_TURNS} prompts.`;
    else if (timeElapsed >= MAX_INACTIVITY_MS) reason = `The conversation timed out after 20 minutes of inactivity.`;

    sessionRefreshWarning = `**Session Refreshed:** ${reason} Your chat history has been cleared.`;
    trace(`[Session Manager] Refreshing chat session. Reason: ${reason}`);

    const initialized = await initChatSession();
    if (!initialized || !chat) {
       console.error("Chat session not initialized and re-initialization failed.");
       throw new Error("Chat session is not available.");
    }
  }
   if (!ai) { // Should be caught by initChatSession, but good to double check
    throw new Error("Gemini API client not initialized.");
  }

  // FIX: Property 'history' is private. Use getHistory() to access the chat history.
  const historyBefore = await chat!.getHistory();
  const historyBeforeLength = historyBefore.length;

  try {
    // Use sendMessage for a single, complete response
    const response = await chat!.sendMessage({ message: userMessageContent });

    // Update status to processing after response (even if tools were used)
    if (onStatusUpdate) {
        // Final processing status, 2 lines
        onStatusUpdate("Processing AI response...\nPreparing final output.");
    }

    // Check if the response was blocked due to safety settings
    if (response.candidates && response.candidates.length > 0 && response.candidates[0].finishReason === 'SAFETY') {
      const safetyMessage = "The response was blocked because it was flagged for safety reasons. This can sometimes happen with general queries. Please try rephrasing your request to be more specific.";

      // Manually construct a response object to send to the UI
      // The SDK's response object has methods (e.g., text()) that are lost when spreading.
      // We must create a new object that conforms to the GenerateContentResponse interface.
      const safeResponse: GenerateContentResponse = {
        ...response,
        candidates: [
          {
            ...(response.candidates[0] || {}), // Guard against undefined candidate
            finishReason: FinishReason.STOP,
            content: {
              parts: [{ text: safetyMessage }],
              role: 'model'
            }
          }
        ],
        // Implement the required properties from the GenerateContentResponse interface
        text: safetyMessage,
        functionCalls: [] as FunctionCall[],
        data: "",
        executableCode: "",
        codeExecutionResult: "",
      };
      // We will still process the original turn content for logging
      const historyAfter = await chat!.getHistory();
      const turnContent = historyAfter.slice(historyBeforeLength);
      return { response: safeResponse, turnContent, toolExchanges: [], sessionRefreshWarning };
    }

    // Update session tracking
    turnCount++;
    lastInteractionTimestamp = Date.now();

    // After the call, the chat's history is updated with the full turn.
    const historyAfter = await chat!.getHistory();
    // We extract the parts that were just added.
    const turnContent = historyAfter.slice(historyBeforeLength);

    // Collect all tool calls and responses into ToolExchange objects
    const toolExchanges: ToolExchange[] = [];
    let placeIndex = 0; // GLOBAL INDEX FOR THIS TURN
    // Use an array to handle multiple tool calls in a single model response
    let pendingToolCalls: { name: string, args: any }[] = [];

    for (const content of turnContent) {
      if (content.parts) {
        for (const part of content.parts) {
          trace(`[MCP] Processing part: ${JSON.stringify(part).substring(0, 200)}...`);
          if ('functionCall' in part && part.functionCall) {
            // Found a tool call request (usually in a 'model' role content)
            const call = {
              name: part.functionCall.name || 'unknown-tool',
              args: part.functionCall.args,
            };
            const curlCommand = generateCurlCommand(call.name, call.args);
            trace(`[MCP] Found function call: ${call.name}`);
            trace(`[MCP] Curl Command Equivalent for Debugging:\n${curlCommand}`);
            pendingToolCalls.push(call);
          } else if ('functionResponse' in part) {
            // Found a tool response (usually in a 'function' role content)
            trace(`[MCP] Found function response. Pending calls: ${pendingToolCalls.length}`);

            // We assume responses are returned in the same order as calls were made (FIFO)
            const call = pendingToolCalls.shift();

            if (call) {
              trace(`[MCP] Matching response to call: ${call.name}`);
              const functionResponse = part.functionResponse;
              if (functionResponse && functionResponse.response) {
                try {
                  // Clean the response for display. This directly modifies the `turnContent` object
                  // because `functionResponse` is a reference to `part.functionResponse`.
                  
                  // COMPATIBILITY NOTE: Remote MCP server returns raw JSON (e.g. { places: ... }).
                  // We do NOT wrap it here because chat-app.ts needs access to the 'content' property of the result.
                  // Instead, we ensure chat-app.ts and cleanToolResponseForDisplay handle both formats.

                  const cleanedResponse = cleanToolResponseForDisplay(call.name, functionResponse.response);
                  functionResponse.response = cleanedResponse;

                  // Now, use the already cleaned response for the `toolExchanges` array.
                  const responseJson = cleanedResponse as any;
                  // Check for failure in both wrapped and unwrapped formats
                  const isFailure = !!(responseJson.failure || (responseJson.response && responseJson.response.failure));
                  const currentPlaceIndex = placeIndex;

                  toolExchanges.push({
                    toolName: call.name,
                    request: call.args,
                    response: responseJson,
                    isFailure: isFailure,
                    placeIndex: currentPlaceIndex,
                  });

                  // Check for both legacy local name and remote tool name, and both formats
                  if ((call.name === 'search-places-mcp' || call.name === 'search_places')) {
                      if (responseJson.places) {
                          placeIndex += responseJson.places.length;
                      } else if (responseJson.response && responseJson.response.places) {
                          placeIndex += responseJson.response.places.length;
                      }
                  } else if (call.name === 'compute_routes') {
                      // Hydrate route data with polyline from Routes API if missing
                      try {
                          trace(`[MCP] Hydrating compute_routes response with polyline...`);
                          
                          // Parse the inner JSON from content[0].text
                          let innerJson: any = null;
                          let textContentPart: any = null;

                          if (responseJson.content && Array.isArray(responseJson.content)) {
                              textContentPart = responseJson.content.find((c: any) => c.type === 'text');
                              if (textContentPart && textContentPart.text) {
                                  try {
                                      innerJson = JSON.parse(textContentPart.text);
                                  } catch (e) {
                                      console.warn("[MCP] Failed to parse inner JSON for hydration:", e);
                                  }
                              }
                          } else {
                              // Fallback if responseJson is already unwrapped (unlikely with current setup but good for safety)
                              innerJson = responseJson;
                          }

                          if (innerJson) {
                              // Transform args for Routes API V2
                              const transformWaypoint = (wp: any) => {
                                  const transformed: Record<string, any> = {};
                                  const placeId = wp.placeId || wp.place_id;
                                  const latLng = wp.latLng || wp.lat_lng;
                                  
                                  if (placeId) {
                                      transformed.placeId = placeId;
                                  } else if (latLng) {
                                      transformed.location = {
                                          latLng: {
                                              latitude: latLng.latitude,
                                              longitude: latLng.longitude
                                          }
                                      };
                                  } else if (wp.address) {
                                      transformed.address = wp.address;
                                  }
                                  return transformed;
                              };

                              const origin = call.args.origin ? transformWaypoint(call.args.origin) : undefined;
                              const destination = call.args.destination ? transformWaypoint(call.args.destination) : undefined;
                              
                              if (origin && destination) {
                                  const routesParams: Record<string, any> = {
                                      origin,
                                      destination,
                                      travelMode: call.args.travelMode || 'DRIVE',
                                      routingPreference: (call.args.travelMode === 'DRIVE' || !call.args.travelMode) ? 'TRAFFIC_AWARE' : undefined,
                                      computeAlternativeRoutes: false,
                                      routeModifiers: { avoidTolls: false, avoidHighways: false, avoidFerries: false },
                                      languageCode: 'en-US',
                                      units: 'METRIC'
                                  };
                                  
                                  const { data: routesData, error: routesError } = await callRoutesApiV2(routesParams);
                                  
                                  trace(`[MCP] Routes API response:`, routesData ? "Success" : "Error", routesError);

                                  if (routesData && routesData.routes && routesData.routes.length > 0) {
                                      const polyline = routesData.routes[0].polyline?.encodedPolyline;
                                      if (polyline) {
                                          trace(`[MCP] Successfully fetched polyline. Length: ${polyline.length}`);
                                          
                                          // Merge into innerJson
                                          if (innerJson.routes && innerJson.routes.length > 0) {
                                              trace(`[MCP] Injecting polyline into innerJson.routes[0]`);
                                              innerJson.routes[0].encodedPolyline = polyline;
                                              innerJson.routes[0].polyline = { encodedPolyline: polyline };
                                              if (!innerJson.routes[0].origin) innerJson.routes[0].origin = call.args.origin;
                                              if (!innerJson.routes[0].destination) innerJson.routes[0].destination = call.args.destination;
                                          } else if (innerJson.route) {
                                              trace(`[MCP] Injecting polyline into innerJson.route`);
                                              innerJson.route.encodedPolyline = polyline;
                                              if (!innerJson.route.origin) innerJson.route.origin = call.args.origin;
                                              if (!innerJson.route.destination) innerJson.route.destination = call.args.destination;
                                          } else {
                                              // If structure is unexpected, try to force it
                                              trace(`[MCP] WARNING: No 'routes' or 'route' field. Creating 'routes' array.`);
                                              innerJson.routes = [{
                                                  encodedPolyline: polyline,
                                                  polyline: { encodedPolyline: polyline },
                                                  origin: call.args.origin,
                                                  destination: call.args.destination
                                              }];
                                          }

                                          // Save back to textContentPart
                                          if (textContentPart) {
                                              textContentPart.text = JSON.stringify(innerJson);
                                              // Also update responseJson if it was unwrapped (reference)
                                          }
                                      } else {
                                          trace(`[MCP] Routes API returned routes but NO polyline.`);
                                      }
                                  } else if (routesError) {
                                      console.error(`[MCP] Failed to hydrate route: ${routesError}`);
                                  }
                              }
                          }
                      } catch (e) {
                          console.error(`[MCP] Error during route hydration:`, e);
                      }
                  }

                } catch (e) {
                  console.warn("Could not parse function response JSON:", e);
                  // If parsing fails, still record the exchange with raw text response
                  toolExchanges.push({
                    toolName: call.name,
                    request: call.args,
                    response: functionResponse.response,
                    isFailure: true, // Treat unparsable response as failure for display
                  });
                }
              }
            } else {
                console.warn("[MCP] Found function response but no pending tool call to pair it with.");
            }
          }
        }
      }
    }

    // --- DEBUG LOGGING ADDED ---
    // --- DEBUG LOGGING ADDED ---
    trace("[sendMessageToAI] Raw response from Gemini:", response);
    trace("[sendMessageToAI] Full turn content added to history:", turnContent);
    if (toolExchanges.length > 0) {
      trace(`[sendMessageToAI] Detected ${toolExchanges.length} tool exchanges.`);
    }
    // --- END DEBUG LOGGING ---

    // Create a serializable response object.
    // The SDK response object might use getters that aren't serialized by JSON.stringify.
    // We explicitly extract the text content.
    let textContent = "";
    try {
        // @ts-ignore: Handle potential getter or method
        textContent = typeof response.text === 'function' ? response.text() : response.text;
    } catch (e) {
        console.warn("Could not extract text from response:", e);
    }

    const serializableResponse = {
        ...response,
        text: textContent || ""
    } as GenerateContentResponse;

    // Update session state
    turnCount++;
    lastInteractionTimestamp = Date.now();

    trace(`[Session Manager] Turn completed. New turnCount: ${turnCount}, Timestamp: ${lastInteractionTimestamp}`);

    return { response: serializableResponse, turnContent, toolExchanges, sessionRefreshWarning };
  } catch (error) {
    console.error("Error sending message to AI:", error);
    if (error instanceof Error) {
        throw new Error(`Gemini API Error: ${error.message}`);
    }
    throw new Error("An unknown error occurred while communicating with the AI.");
  } finally {
    // Ensure the handler is reset after the turn is complete, regardless of success/failure
    currentStatusHandler = null;
  }
};

export const isGeminiClientInitialized = (): boolean => !!ai;
// export { mcpClientInstance }; // Export moved to line 45
