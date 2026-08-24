import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json());

// Primary & Fallback Endpoints
const AIRPLANES_LIVE_URL = 'https://api.airplanes.live/v2/point/37.7749/-122.4194/250';
const OPENSKY_URL = 'https://opensky-network.org/api/states/all';

async function fetchFlightData() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  // Try Airplanes.live first
  try {
    const res = await fetch(AIRPLANES_LIVE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://airplanes.live/'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      const raw = Array.isArray(data.ac) ? data.ac : [];
      return raw.filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number').slice(0, 80).map((p) => {
        const altFt = typeof p.alt_baro === 'number' ? p.alt_baro : p.alt_geom || 0;
        return {
          id: p.hex || Math.random().toString(36).substring(2, 9),
          callsign: p.flight ? p.flight.trim() : 'N/A',
          aircraftModel: p.t || 'UNK',
          registration: p.r || 'N/A',
          route: { origin: 'N/A', destination: 'N/A' },
          location: {
            latitude: p.lat,
            longitude: p.lon,
            altitudeMeters: altFt * 0.3048,
            altitudeFeet: altFt
          },
          vector: { heading: p.track || 0, groundSpeedKnots: p.gs || 0 }
        };
      });
    }
  } catch (e) {
    // Airplanes.live failed or timed out, fallback to OpenSky
  }

  // Fallback: OpenSky Network
  const openSkyController = new AbortController();
  const openSkyTimeout = setTimeout(() => openSkyController.abort(), 5000);
  try {
    const res = await fetch(OPENSKY_URL, { signal: openSkyController.signal });
    clearTimeout(openSkyTimeout);

    if (res.ok) {
      const data = await res.json();
      const states = Array.isArray(data.states) ? data.states : [];
      return states.filter((s) => s[6] !== null && s[5] !== null).slice(0, 80).map((s) => {
        const altMeters = s[7] || s[13] || 0;
        return {
          id: s[0],
          callsign: s[1] ? s[1].trim() : 'N/A',
          aircraftModel: 'UNK',
          registration: 'N/A',
          route: { origin: 'N/A', destination: 'N/A' },
          location: {
            latitude: s[6],
            longitude: s[5],
            altitudeMeters: altMeters,
            altitudeFeet: Math.round(altMeters * 3.28084)
          },
          vector: { heading: s[10] || 0, groundSpeedKnots: Math.round((s[9] || 0) * 1.94384) }
        };
      });
    }
  } catch (e) {
    // OpenSky failed
  }

  return [];
}

app.get('/api/flights', async (req, res) => {
  try {
    const flights = await fetchFlightData();
    return res.status(200).json({ success: true, count: flights.length, flights });
  } catch (error) {
    return res.status(200).json({ success: false, error: error.message, count: 0, flights: [] });
  }
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
