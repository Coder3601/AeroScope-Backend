import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: '*',
    methods: ['GET'],
  })
);

app.use(express.json());

// Airplanes.live endpoint for world traffic or local area bounds
const AIRPLANES_LIVE_URL = 'https://api.airplanes.live/v2/point/0/0/0';

// In-memory cache for flight routes to reduce redundant external route requests
const routeCache = new Map();
const ROUTE_CACHE_TTL = 1000 * 60 * 30; // 30 minutes cache duration

/**
 * Helper: Fetches route metadata (origin & destination) for a given callsign/flight number.
 * Uses OpenSky's public route endpoint (or can be swapped for FlightAware/AeroDataBox).
 */
async function fetchFlightRoute(callsign) {
  if (!callsign || callsign === 'N/A') {
    return { origin: null, destination: null };
  }

  const cleanCallsign = callsign.trim().toUpperCase();

  // Return cached route if available and fresh
  if (routeCache.has(cleanCallsign)) {
    const cached = routeCache.get(cleanCallsign);
    if (Date.now() - cached.timestamp < ROUTE_CACHE_TTL) {
      return cached.data;
    }
  }

  try {
    // OpenSky Network public route lookup endpoint
    const response = await fetch(
      `https://opensky-network.org/api/routes?callsign=${cleanCallsign}`,
      {
        headers: {
          'User-Agent': 'CesiumFlightTrackerBackend/1.0',
          'Accept': 'application/json',
        },
      }
    );

    if (response.ok) {
      const routeData = await response.json();
      const routeInfo = {
        origin: routeData.route ? routeData.route[0] : null, // ICAO airport code (e.g., "KJFK")
        destination:
          routeData.route && routeData.route.length > 1
            ? routeData.route[routeData.route.length - 1]
            : null, // ICAO airport code (e.g., "EGLL")
      };

      // Save to cache
      routeCache.set(cleanCallsign, {
        timestamp: Date.now(),
        data: routeInfo,
      });

      return routeInfo;
    }
  } catch (err) {
    console.warn(`Failed to retrieve route for callsign ${cleanCallsign}:`, err.message);
  }

  // Fallback if lookup fails or returns 404
  const fallbackRoute = { origin: null, destination: null };
  routeCache.set(cleanCallsign, { timestamp: Date.now(), data: fallbackRoute });
  return fallbackRoute;
}

/**
 * Main Flight Endpoint: Combines tracking telemetry with aggregated route information
 */
app.get('/api/flights', async (req, res) => {
  try {
    // 1. Fetch telemetry from Airplanes.live
    const response = await fetch(AIRPLANES_LIVE_URL, {
      headers: {
        'User-Agent': 'CesiumFlightTrackerBackend/1.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Airplanes.live API responded with status ${response.status}`);
    }

    const data = await response.json();
    const rawAircraftArray = data.ac || [];

    // Filter valid positions and take a batch (limiting slice size to manage external call limits if unauthenticated)
    const activePlanes = rawAircraftArray
      .filter((plane) => plane.lat !== undefined && plane.lon !== undefined)
      .slice(0, 100); 

    // 2. Fetch routes in parallel for all active callsigns
    const enrichedFlights = await Promise.all(
      activePlanes.map(async (plane) => {
        const callsign = plane.flight ? plane.flight.trim() : 'N/A';

        // Fetch route metadata
        const route = await fetchFlightRoute(callsign);

        const altitudeFeet =
          plane.alt_baro !== 'ground' ? plane.alt_baro || plane.alt_geom || 0 : 0;
        const altitudeMeters = altitudeFeet * 0.3048;

        return {
          id: plane.hex,
          callsign: callsign,
          aircraftModel: plane.t || 'Unknown Model',
          registration: plane.r || 'N/A',
          squawk: plane.squawk || 'N/A',
          // Route metadata merged from secondary source
          route: {
            origin: route.origin || 'Unknown',
            destination: route.destination || 'Unknown',
          },
          location: {
            latitude: plane.lat,
            longitude: plane.lon,
            altitudeMeters: altitudeMeters,
            altitudeFeet: altitudeFeet,
          },
          vector: {
            heading: plane.track || 0,
            groundSpeedKnots: plane.gs || 0,
            verticalRateFpm: plane.baro_rate || plane.geom_rate || 0,
          },
          lastSeen: plane.seen || 0,
        };
      })
    );

    res.status(200).json({
      success: true,
      count: enrichedFlights.length,
      timestamp: new Date().toISOString(),
      flights: enrichedFlights,
    });
  } catch (error) {
    console.error('Error in flight backend API:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to aggregate flight tracking and route data',
      details: error.message,
    });
  }
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
