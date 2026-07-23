const express = require("express");

const app = express();

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl";
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000;

let playerCache = null;
let cacheUpdatedAt = 0;
let refreshPromise = null;

/**
 * Downloads and caches Sleeper's NFL player database.
 *
 * Concurrent requests share the same refresh operation so the server
 * does not download the database multiple times simultaneously.
 */
async function getPlayerDatabase() {
  const cacheIsFresh =
    playerCache &&
    Date.now() - cacheUpdatedAt < CACHE_DURATION_MS;

  if (cacheIsFresh) {
    return playerCache;
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    console.log("Downloading Sleeper NFL player database...");

    const response = await fetch(SLEEPER_PLAYERS_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "sleeper-player-lookup/1.0"
      }
    });

    if (!response.ok) {
      throw new Error(
        `Sleeper API returned ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Sleeper returned an unexpected player database format.");
    }

    playerCache = data;
    cacheUpdatedAt = Date.now();

    console.log(
      `Cached ${Object.keys(playerCache).length} Sleeper players.`
    );

    return playerCache;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

/**
 * Returns only the player fields needed by the GPT Action.
 */
function formatPlayer(playerId, player) {
  return {
    player_id: String(playerId),
    full_name:
      player.full_name ||
      [player.first_name, player.last_name].filter(Boolean).join(" ") ||
      null,
    first_name: player.first_name ?? null,
    last_name: player.last_name ?? null,
    team: player.team ?? null,
    position: player.position ?? null,
    fantasy_positions: Array.isArray(player.fantasy_positions)
      ? player.fantasy_positions
      : null,
    status: player.status ?? null,
    active:
      typeof player.active === "boolean" ? player.active : null,
    age:
      Number.isInteger(player.age) ? player.age : null,
    years_exp:
      Number.isInteger(player.years_exp) ? player.years_exp : null,
    number:
      Number.isInteger(player.number) ? player.number : null,
    depth_chart_position: player.depth_chart_position ?? null,
    depth_chart_order:
      Number.isInteger(player.depth_chart_order)
        ? player.depth_chart_order
        : null,
    injury_status: player.injury_status ?? null,
    injury_body_part: player.injury_body_part ?? null,
    injury_notes: player.injury_notes ?? null,
    sport: player.sport ?? null
  };
}

/**
 * Basic status endpoint.
 */
app.get("/", (request, response) => {
  response.json({
    service: "Sleeper Player Lookup API",
    status: "ok",
    endpoints: {
      one_player: "GET /players/{player_id}",
      multiple_players: "POST /players/lookup",
      health: "GET /health"
    }
  });
});

/**
 * Render can use this endpoint to determine whether the app is running.
 */
app.get("/health", (request, response) => {
  response.json({
    status: "ok",
    cache_loaded: Boolean(playerCache),
    cache_updated_at: cacheUpdatedAt
      ? new Date(cacheUpdatedAt).toISOString()
      : null
  });
});

/**
 * Lookup one player.
 *
 * Important: this route appears after /players/lookup so Express does not
 * mistakenly treat "lookup" as a player ID.
 */
app.post("/players/lookup", async (request, response) => {
  try {
    const { player_ids } = request.body || {};

    if (!Array.isArray(player_ids)) {
      return response.status(400).json({
        error: "invalid_request",
        message: "player_ids must be an array of Sleeper player ID strings."
      });
    }

    if (player_ids.length < 1) {
      return response.status(400).json({
        error: "invalid_request",
        message: "Provide at least one player ID."
      });
    }

    if (player_ids.length > 250) {
      return response.status(400).json({
        error: "invalid_request",
        message: "A maximum of 250 player IDs is allowed per request."
      });
    }

    const normalizedIds = [
      ...new Set(
        player_ids
          .map((playerId) => String(playerId).trim())
          .filter(Boolean)
      )
    ];

    if (normalizedIds.length < 1) {
      return response.status(400).json({
        error: "invalid_request",
        message: "No valid player IDs were provided."
      });
    }

    const database = await getPlayerDatabase();
    const players = [];
    const missingIds = [];

    for (const playerId of normalizedIds) {
      const player = database[playerId];

      if (player) {
        players.push(formatPlayer(playerId, player));
      } else {
        missingIds.push(playerId);
      }
    }

    return response.json({
      players,
      missing_ids: missingIds
    });
  } catch (error) {
    console.error(error);

    return response.status(502).json({
      error: "player_database_unavailable",
      message: "The Sleeper player database could not be retrieved."
    });
  }
});

app.get("/players/:player_id", async (request, response) => {
  try {
    const playerId = String(request.params.player_id || "").trim();

    if (!playerId) {
      return response.status(400).json({
        error: "invalid_player_id",
        message: "A Sleeper player ID is required."
      });
    }

    const database = await getPlayerDatabase();
    const player = database[playerId];

    if (!player) {
      return response.status(404).json({
        error: "player_not_found",
        message: `No Sleeper player was found with ID ${playerId}.`
      });
    }

    return response.json(formatPlayer(playerId, player));
  } catch (error) {
    console.error(error);

    return response.status(502).json({
      error: "player_database_unavailable",
      message: "The Sleeper player database could not be retrieved."
    });
  }
});

/**
 * Express error handler for malformed JSON bodies.
 */
app.use((error, request, response, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return response.status(400).json({
      error: "invalid_json",
      message: "The request body is not valid JSON."
    });
  }

  console.error(error);

  return response.status(500).json({
    error: "internal_server_error",
    message: "The server encountered an unexpected error."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sleeper Player Lookup API listening on port ${PORT}.`);
});
