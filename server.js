import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins
app.use(cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const AIRPLANES_LIVE_URL = 'https://api.airplanes.live/v2/point/0/0/0';

const routeCache = new Map();
const ROUTE_CACHE_TTL = 1000 * 60 * 30;

async function fetchFlightRoute(callsign) {
  if (!callsign || callsign === 'N/A') return { origin: null, destination: null };
  const clean = callsign.trim().toUpperCase();

  if (routeCache.has(clean)) {
    const cached = routeCache.get(clean);
    if (Date.now() - cached.timestamp < ROUTE_CACHE_TTL) return cached.data;
  }

  try {
    const response = await fetch(`https://opensky-network.org/api/routes?callsign=${clean}`, {
      headers: { 'User-Agent': 'CesiumFlightTrackerBackend/1.0', 'Accept': 'application/json' }
    });
    if (response.ok) {
      const data = await response.json();
      const routeInfo = {
        origin: data.route ? data.route[0] : null,
        destination: data.route && data.route.length > 1 ? data.route[data.route.length - 1] : null
      };
      routeCache.set(clean, { timestamp: Date.now(), data: routeInfo });
      return routeInfo;
    }
  } catch (err) {
    console.warn(`Route fetch failed for ${clean}:`, err.message);
  }

  const fallback = { origin: null, destination: null };
  routeCache.set(clean, { timestamp: Date.now(), data: fallback });
  return fallback;
}

app.get('/api/flights', async (req, res) => {
  try {
    const response = await fetch(AIRPLANES_LIVE_URL, {
      headers: { 'User-Agent': 'CesiumFlightTrackerBackend/1.0', 'Accept': 'application/json' }
    });

    if (!response.ok) throw new Error(`Airplanes.live API HTTP ${response.status}`);

    const data = await response.json();
    const raw = data.ac || [];

    const activePlanes = raw
      .filter((p) => p.lat !== undefined && p.lon !== undefined)
      .slice(0, 80);

    const enriched = await Promise.all(
      activePlanes.map(async (plane) => {
        const callsign = plane.flight ? plane.flight.trim() : 'N/A';
        const route = await fetchFlightRoute(callsign);
        const altFt = plane.alt_baro !== 'ground' ? (plane.alt_baro || plane.alt_geom || 0) : 0;

        return {
          id: plane.hex,
          callsign: callsign,
          aircraftModel: plane.t || 'UNK',
          registration: plane.r || 'N/A',
          route: {
            origin: route.origin || 'N/A',
            destination: route.destination || 'N/A'
          },
          location: {
            latitude: plane.lat,
            longitude: plane.lon,
            altitudeMeters: altFt * 0.3048,
            altitudeFeet: altFt
          },
          vector: {
            heading: plane.track || 0,
            groundSpeedKnots: plane.gs || 0
          }
        };
      })
    );

    res.status(200).json({ success: true, count: enriched.length, flights: enriched });
  } catch (error) {
    console.error('API Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
