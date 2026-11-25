const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;
const MAX_BASE64_LENGTH = 2_200_000;
const REQUEST_TIMEOUT_MS = 25_000;

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 700;

// Modelo principal (cámbialo con la variable ANTHROPIC_MODEL en Vercel).
// Si falla con 404 se prueba el siguiente de la lista.
const DEFAULT_MODELS = ["claude-sonnet-5-5", "claude-haiku-5-5"];

const SUPPORTED_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp"];

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
  const payload = { reqId, step, timestamp: new Date().toISOString(), ...details };
  if (level === "error") console.error("[/api/scan]", JSON.stringify(payload));
  else console.log("[/api/scan]", JSON.stringify(payload));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Extrae el JSON aunque venga con ```json o con texto alrededor.
function parseJsonSafely(rawText) {
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("No se encontró JSON en la respuesta");
  }
}

function extractText(data) {
  if (!Array.isArray(data?.content)) return "";
  return data.content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function callClaude({ model, apiKey, system, userContent, signal }) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: userContent }]
    })
  });

  const rawBody = await response.text().catch(() => "");
  let data = {};
  let invalidJson = false;
  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch {
      invalidJson = true;
    }
  }
  return { response, data, rawBody, invalidJson };
}

const SYSTEM_PROMPT = `Eres un tasador experto en cartas coleccionables. Analizas la foto de una carta y respondes SOLO con un JSON válido, sin texto adicional ni bloques de código, con estas claves exactas:
- player (string: jugador o personaje)
- set (string: colección/marca)
- year (string: año de edición, vacío si no se ve)
- num (string: número de carta, vacío si no se ve)
- sport (string: exactamente uno de: NFL, NBA, Pokémon, Fútbol, Otra)
- cond (string: exactamente uno de: Mint, Near Mint, Excelente, Jugada)
- price_low (número en euros: estimación baja de carta suelta sin graduar)
- price_high (número en euros: estimación alta de carta suelta sin graduar)
- note (string: breve detalle clave de valor, en español)
Reglas: lee el texto impreso de la carta (nombre, marca, año, número) y no inventes datos que no se vean; si algo no es legible, deja la cadena vacía. price_low debe ser menor o igual que price_high. Los precios son estimaciones orientativas. Si la imagen no es una carta coleccionable devuelve {"error":"no es una carta"}.`;

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

  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) {
    logDiag(reqId, "error", "missing_api_key");
    return res.status(503).json({
      error: "Servicio no disponible: falta configurar ANTHROPIC_API_KEY en el servidor.",
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
    let mimeType = mimeMatch ? mimeMatch[1].toLowerCase() : "image/jpeg";
    if (mimeType === "image/jpg") mimeType = "image/jpeg";
    if (!SUPPORTED_MIME.includes(mimeType)) {
      logDiag(reqId, "warn", "unsupported_mime", { mimeType });
      return res.status(400).json({ error: "Formato de imagen no soportado. Usa JPG, PNG, WEBP o GIF." });
    }

    const userContent = [
      {
        type: "image",
        source: { type: "base64", media_type: mimeType, data: base64Data }
      },
      { type: "text", text: "Analiza esta carta y devuelve solo el JSON." }
    ];

    const envModel = (process.env.ANTHROPIC_MODEL || "").trim();
    const models = [...new Set([envModel, ...DEFAULT_MODELS].filter(Boolean))];

    logDiag(reqId, "info", "request_validated", {
      mimeType,
      base64Chars: base64Data.length,
      modelCandidates: models
    });

    let result = null;
    let usedModel = null;
    let lastNetworkError = null;

    for (const model of models) {
      let attempt = 0;
      while (attempt < 2) {
        attempt += 1;
        try {
          result = await callClaude({
            model,
            apiKey,
            system: SYSTEM_PROMPT,
            userContent,
            signal: controller.signal
          });
          usedModel = model;
          lastNetworkError = null;
        } catch (fetchErr) {
          const isTimeout = fetchErr?.name === "AbortError";
          lastNetworkError = { isTimeout, message: fetchErr?.message || "Network error" };
          logDiag(reqId, "error", isTimeout ? "claude_timeout" : "claude_network_error", {
            model,
            message: lastNetworkError.message
          });
          result = null;
          if (isTimeout) break;
          if (attempt < 2) await sleep(600);
          continue;
        }

        const status = result.response.status;
        // Reintento una vez si el servicio está saturado o falla temporalmente
        if ((status === 429 || status === 529 || status >= 500) && attempt < 2) {
          logDiag(reqId, "warn", "claude_retry", { model, status });
          await sleep(800);
          continue;
        }
        break;
      }

      if (lastNetworkError?.isTimeout) break;
      if (!result) continue;

      // Modelo inexistente o sin acceso: probamos el siguiente
      if (result.response.status === 404) {
        logDiag(reqId, "warn", "model_not_found", {
          model: usedModel,
          upstreamMessage: String(result.data?.error?.message || "").slice(0, 200)
        });
        continue;
      }
      break;
    }

    if (!result) {
      return res.status(502).json({
        error: lastNetworkError?.isTimeout
          ? "Tiempo de espera agotado al conectar con el servicio de IA."
          : "Error de conexión con el servicio de IA.",
        status: 502
      });
    }

    if (result.invalidJson) {
      logDiag(reqId, "error", "claude_invalid_json_body", {
        model: usedModel,
        httpStatus: result.response.status,
        bodyPreview: result.rawBody.slice(0, 200)
      });
      return res.status(502).json({ error: "Respuesta no válida del servicio de IA.", status: 502 });
    }

    if (!result.response.ok) {
      const upstreamStatus = result.response.status;
      const upstreamMessage = result.data?.error?.message || "Error consultando la IA";
      const statusToReturn = upstreamStatus >= 500 || upstreamStatus === 529 ? 502 : upstreamStatus;

      logDiag(reqId, "error", "claude_http_error", {
        model: usedModel,
        upstreamStatus,
        errorType: result.data?.error?.type || null,
        returnedStatus: statusToReturn,
        upstreamMessage: String(upstreamMessage).slice(0, 300)
      });

      let friendly = upstreamMessage;
      if (upstreamStatus === 401) friendly = "Clave de API no válida. Revisa ANTHROPIC_API_KEY en Vercel.";
      if (upstreamStatus === 404) friendly = "Ningún modelo de Claude disponible para esta clave. Revisa ANTHROPIC_MODEL.";
      if (upstreamStatus === 400 && /credit balance/i.test(String(upstreamMessage))) {
        friendly = "La cuenta de Anthropic no tiene saldo. Añade crédito en la consola de Anthropic.";
      }

      return res.status(statusToReturn).json({ error: friendly, status: statusToReturn });
    }

    const text = extractText(result.data);
    if (!text) {
      logDiag(reqId, "error", "claude_empty_output", {
        model: usedModel,
        stopReason: result.data?.stop_reason || null
      });
      return res.status(502).json({ error: "El servicio de IA devolvió una respuesta vacía.", status: 502 });
    }

    let parsed;
    try {
      parsed = parseJsonSafely(text);
    } catch (parseErr) {
      logDiag(reqId, "error", "model_json_parse_error", {
        model: usedModel,
        message: parseErr?.message || "JSON parse error",
        textPreview: text.slice(0, 200)
      });
      return res.status(502).json({
        error: "No se pudo interpretar la valoración devuelta por la IA.",
        status: 502
      });
    }

    if (parsed && !parsed.error) {
      const low = Number(parsed.price_low);
      const high = Number(parsed.price_high);
      if (Number.isFinite(low) && Number.isFinite(high) && low > high) {
        parsed.price_low = high;
        parsed.price_high = low;
      }
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
      model: usedModel,
      hasErrorField: Boolean(parsed?.error),
      player: parsed?.player || null
    });

    return res.status(200).json(parsed);
  } catch (error) {
    logDiag(reqId, "error", "unhandled_exception", { message: error?.message || "Unknown error" });
    return res.status(500).json({ error: "Error interno procesando la imagen.", status: 500 });
  } finally {
    clearTimeout(timeoutId);
  }
}
