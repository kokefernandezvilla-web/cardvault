const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;
const MAX_BASE64_LENGTH = 2_200_000;

const ipHits = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = ipHits.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  ipHits.set(ip, entry);
  return entry.count <= MAX_REQUESTS_PER_WINDOW;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const clientIp =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: "Demasiadas solicitudes. Inténtalo en un minuto." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en Vercel" });
  }

  try {
    const { image } = req.body || {};
    if (!image || typeof image !== "string" || !image.includes(",")) {
      return res.status(400).json({ error: "Imagen no válida" });
    }
    if (image.length > MAX_BASE64_LENGTH) {
      return res.status(413).json({ error: "La imagen excede el tamaño máximo permitido" });
    }

    const [header, base64Data] = image.split(",");
    const mimeMatch = header.match(/data:(image\/[a-zA-Z0-9.+-]+);base64/);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";

    const prompt = `Eres un tasador experto en cartas coleccionables. Analiza la foto y responde SOLO con un JSON válido con estas claves exactas:
- player (string: jugador o personaje)
- set (string: colección/marca)
- year (string: año de edición, vacío si no se ve)
- num (string: número de carta, vacío si no se ve)
- sport (string: exactamente uno de: NFL, NBA, Pokémon, Fútbol, Otra)
- cond (string: exactamente uno de: Mint, Near Mint, Excelente, Jugada)
- price_low (número en euros: estimación baja carta suelta sin graduar)
- price_high (número en euros: estimación alta carta suelta sin graduar)
- note (string: breve detalle clave de valor en español)
Si no es una carta coleccionable devuelve {"error":"no es una carta"}.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mimeType, data: base64Data } }
              ]
            }
          ],
          generationConfig: {
            response_mime_type: "application/json"
          }
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "Error consultando la IA gratuita",
        status: response.status
      });
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(500).json({ error: "Respuesta vacía de la IA" });
    }

    const parsed = JSON.parse(text);
    if (parsed && !parsed.error) {
      parsed.sources = [
        {
          label: "IA CardVault",
          player: parsed.player,
          set: parsed.set,
          price_low: parsed.price_low,
          price_high: parsed.price_high
        }
      ];
    }

    return res.status(200).json(parsed);
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Error interno procesando la imagen"
    });
  }
}
