const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;
const MAX_BASE64_LENGTH = 2_200_000;
const REQUEST_TIMEOUT_MS = 25_000;

// Modelo configurable desde Vercel (variable GEMINI_MODEL). Si no existe, usa gemini-2.0-flash.
const MODEL_ID = process.env.GEMINI_MODEL || "gemini-2.0-flash";

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

function logDiag(reqId, level, step, details = {}) {
  const safePayload = {
    reqId,
    step,
    timestamp: new Date().toISOString(),
    ...details
  };
  if (level === "error") {
    console.error("[/api/scan]", JSON.stringify(safePayload));
  } else {
    console.log("[/api/scan]", JSON.stringify(safePayload));
  }
}

function extractModelText(data) {
  // Formato standard generateContent
  const candidateText = data?.candidates?.[0]?.content?.parts
    ?.map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim();
  if (candidateText) return candidateText;

  // Formato Interactions API / outputs alternativos si aplica
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (Array.isArray(data?.outputs)) {
    const outText = data.outputs
      .flatMap((o) => (Array.isArray(o?.content) ? o.content : [o]))
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
      .join("")
      .trim();
    if (outText) return outText;
  }

  return "";
}

function parseJsonSafely(rawText) {
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

export default async function handler(req, res) {
  const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  if (req.method !== "POST") {
    logDiag(reqId, "warn", "method_not_allowed", { method: req.method });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const clientIp =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!checkRateLimit(clientIp)) {
    logDiag(reqId, "warn", "rate_limited");
    return res.status(429).json({ error: "Demasiadas solicitudes. Inténtalo en un minuto." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
    logDiag(reqId, "error", "missing_api_key");
    return res.status(503).json({
      error: "Servicio temporalmente no disponible: falta configurar GEMINI_API_KEY en el servidor.",
      status: 503
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const { image } = req.body || {};
    if (!image || typeof image !== "string" || !image.includes(",")) {
      logDiag(reqId, "warn", "invalid_image_payload");
      return res.status(400).json({ error: "Imagen no válida" });
    }
    if (image.length > MAX_BASE64_LENGTH) {
      logDiag(reqId, "warn", "image_too_large", { length: image.length });
      return res.status(413).json({ error: "La imagen excede el tamaño máximo permitido" });
    }

    const [header, base64Data] = image.split(",");
    if (!base64Data) {
      logDiag(reqId, "warn", "empty_base64_data");
      return res.status(400).json({ error: "Datos Base64 vacíos" });
    }

    const mimeMatch = header.match(/data:(image\/[a-zA-Z0-9.+-]+);base64/);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";

    logDiag(reqId, "info", "request_validated", {
      model: MODEL_ID,
      mimeType,
      base64Chars: base64Data.length,
      hasKeyConfigured: true
    });

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

    // CORREGIDO: URL limpia (antes tenía formato Markdown pegado por error)
    const endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL_ID)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

    let response;
    try {
      response = await fetch(endpointUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
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
      });
    } catch (fetchErr) {
      const isTimeout = fetchErr?.name === "AbortError";
      logDiag(reqId, "error", isTimeout ? "gemini_timeout" : "gemini_network_error", {
        model: MODEL_ID,
        message: fetchErr?.message || "Network error"
      });
      return res.status(502).json({
        error: isTimeout
          ? "Tiempo de espera agotado al conectar con el servicio de IA."
          : "Error de conexión con el servicio de IA.",
        status: 502
      });
    }

    const rawBody = await response.text().catch(() => "");
    let data = {};
    if (rawBody) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        logDiag(reqId, "error", "gemini_invalid_json_body", {
          httpStatus: response.status,
          bodyPreview: rawBody.slice(0, 200)
        });
        return res.status(502).json({
          error: "Respuesta no válida del servicio de IA.",
          status: 502
        });
      }
    }

    if (!response.ok) {
      const upstreamStatus = response.status;
      const upstreamMessage = data?.error?.message || "Error consultando la IA";
      const statusToReturn = upstreamStatus >= 500 ? 502 : upstreamStatus;

      logDiag(reqId, "error", "gemini_http_error", {
        model: MODEL_ID,
        upstreamStatus,
        returnedStatus: statusToReturn,
        upstreamMessage: String(upstreamMessage).slice(0, 300)
      });

      return res.status(statusToReturn).json({
        error: upstreamMessage,
        status: statusToReturn
      });
    }

    const text = extractModelText(data);
    if (!text) {
      logDiag(reqId, "error", "gemini_empty_output", { model: MODEL_ID });
      return res.status(502).json({
        error: "El servicio de IA devolvió una respuesta vacía.",
        status: 502
      });
    }

    let parsed;
    try {
      parsed = parseJsonSafely(text);
    } catch (parseErr) {
      logDiag(reqId, "error", "model_json_parse_error", {
        model: MODEL_ID,
        message: parseErr?.message || "JSON parse error",
        textPreview: text.slice(0, 200)
      });
      return res.status(502).json({
        error: "No se pudo interpretar la valoración devuelta por la IA.",
        status: 502
      });
    }

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

    logDiag(reqId, "info", "scan_success", {
      model: MODEL_ID,
      hasErrorField: Boolean(parsed?.error),
      player: parsed?.player || null
    });

    return res.status(200).json(parsed);
  } catch (error) {
    logDiag(reqId, "error", "unhandled_exception", {
      message: error?.message || "Unknown error"
    });
    return res.status(500).json({
      error: "Error interno procesando la imagen.",
      status: 500
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
