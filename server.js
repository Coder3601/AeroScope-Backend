import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json());

// Public military endpoint for reliable data density
const AIRPLANES_LIVE_URL = 'https://api.airplanes.live/v2/mil';

const routeCache = new Map();
const ROUTE_CACHE_TTL = 1000 * 60 * 30;

async function fetchFlightRoute(callsign) {
  if (!callsign || callsign === 'N/A') return { origin: 'N/A', destination: 'N/A' };
  const clean = callsign.trim().toUpperCase();

  if (routeCache.has(clean)) {
    const cached = routeCache.get(clean);
    if (Date.now() - cached.timestamp < ROUTE_CACHE_TTL) return cached.data;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(`https://opensky-network.org/api/routes?callsign=${clean}`, {
      headers: { 'User-Agent': 'CesiumTracker/1.0', 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      const routeInfo = {
        origin: data.route && data.route[0] ? data.route[0] : 'N/A',
        destination: data.route && data.route.length > 1 ? data.route[data.route.length - 1] : 'N/A',
      };
      routeCache.set(clean, { timestamp: Date.now(), data: routeInfo });
      return routeInfo;
    }
  } catch (err) {
    // Fail gracefully on route timeout/error
  }

  const fallback = { origin: 'N/A', destination: 'N/A' };
  routeCache.set(clean, { timestamp: Date.now(), data: fallback });
  return fallback;
}

app.get('/api/flights', async (req, res) => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(AIRPLANES_LIVE_URL, {
      headers: {
        'User-Agent': 'CesiumTracker/1.0',
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Airplanes.live API HTTP ${response.status}`);
    }

    const data = await response.json();
    const raw = Array.isArray(data.ac) ? data.ac : [];

    const validPlanes = raw
      .filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number')
      .slice(0, 80);

    const flights = await Promise.all(
      validPlanes.map(async (plane) => {
        const callsign = plane.flight ? plane.flight.trim() : 'N/A';
        const route = await fetchFlightRoute(callsign);

        const altFt = typeof plane.alt_baro === 'number' ? plane.alt_baro : plane.alt_geom || 0;

        return {
          id: plane.hex || Math.random().toString(36).substring(2, 9),
          callsign: callsign,
          aircraftModel: plane.t || 'UNK',
          registration: plane.r || 'N/A',
          route: route,
          location: {
            latitude: plane.lat,
            longitude: plane.lon,
            altitudeMeters: altFt * 0.3048,
            altitudeFeet: altFt,
          },
          vector: {
            heading: plane.track || 0,
            groundSpeedKnots: plane.gs || 0,
          },
        };
      })
    );

    return res.status(200).json({ success: true, count: flights.length, flights });
  } catch (error) {
    console.error('Handled API Error:', error.message);
    // Return empty dataset gracefully rather than throwing HTTP 500
    return res.status(200).json({ success: false, error: error.message, count: 0, flights: [] });
  }
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
