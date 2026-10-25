/* =====================================================================
 *  API REST - Control y monitoreo del robot (EAI441, Opción 2)
 *
 *  Quién la usa:
 *    - La PÁGINA (GitHub Pages)  -> /api/distancia, /api/comando, /api/modo
 *    - El ARDUINO UNO R4 WiFi    -> /api/device/sync  (cada ~1 s)
 *
 *  Variables de entorno (en Render / Azure, NO en el código):
 *    API_KEY         clave compartida. Obligatoria en producción.
 *                    La página la manda en  x-functions-key
 *                    El Arduino la manda en X-API-Key
 *    ALLOWED_ORIGIN  origen de la página, SIN ruta y SIN "/" final:
 *                    https://TU-USUARIO.github.io
 *                    (varios separados por coma; vacío o "*" = cualquiera, solo para pruebas)
 *    PORT            lo define la plataforma
 * ===================================================================== */
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const ORIGINS = (process.env.ALLOWED_ORIGIN || "*")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))   // quita "/" final: el navegador nunca la envía
  .filter(Boolean);

const EN_PRODUCCION =
  process.env.NODE_ENV === "production" || process.env.RENDER || process.env.WEBSITE_SITE_NAME;
if (EN_PRODUCCION && !API_KEY) {
  console.error("ERROR: falta la variable de entorno API_KEY. Sin ella la API quedaría abierta a todo Internet.");
  process.exit(1);
}

const DEVICE_TIMEOUT_MS = 8000; // sin sync en 8 s => dispositivo desconectado (el Arduino puede tardar ~4 s en reconectar)
const DIST_MAX_CM = 1000;

// Traducción página <-> dispositivo (cada lado conserva sus propias palabras)
const ACCION_A_CMD = { izquierda: "left", derecha: "right", detener: "stop" };
const CMD_A_ACCION = { left: "izquierda", right: "derecha", stop: "detener" };
const MODO_A_DEV = { manual: "manual", automatico: "auto" };
const DEV_A_MODO = { manual: "manual", auto: "automatico" };

const app = express();
app.disable("x-powered-by");
app.use(
  cors({
    origin: ORIGINS.includes("*") ? true : ORIGINS,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-functions-key", "x-api-key"],
    maxAge: 600,
  })
);
app.use(express.json({ limit: "1kb" }));

/* ----------------------- Estado en memoria --------------------------- */
const state = {
  distance: null,   // cm, lo reporta el Arduino
  motor: "stop",    // estado REAL del motor ("left" | "right" | "stop"), lo reporta el Arduino
  mode: "manual",   // "manual" | "auto"
  command: "stop",  // último comando manual pedido desde la página
  lastSeen: 0,      // última vez que el Arduino habló con la API
};
const online = () => Date.now() - state.lastSeen < DEVICE_TIMEOUT_MS;

// Lo que ve la página
const vistaPagina = () => ({
  distancia: online() ? state.distance : null,
  modo: DEV_A_MODO[state.mode],
  motor: online() ? CMD_A_ACCION[state.motor] : "detener",
  conectado: online(),
});

/* ----------------------- Autenticación ------------------------------- */
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest();
function auth(req, res, next) {
  if (!API_KEY) return next(); // solo llega aquí en local
  const enviada = req.get("x-api-key") || req.get("x-functions-key") || "";
  if (crypto.timingSafeEqual(hash(enviada), hash(API_KEY))) return next();
  console.warn("401 " + req.method + " " + req.path);
  res.status(401).json({ error: "No autorizado" });
}

/* ----------------------- Endpoints ----------------------------------- */
// Sin clave: para comprobar que el servidor vive (y mantenerlo despierto con un ping)
app.get("/", (req, res) => res.json({ ok: true }));
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---- PÁGINA ----

// GET -> { distancia, modo }
app.get("/api/distancia", auth, (req, res) => res.json(vistaPagina()));

// POST { accion: "izquierda" | "derecha" | "detener" }
app.post("/api/comando", auth, (req, res) => {
  const cmd = ACCION_A_CMD[(req.body || {}).accion];
  if (!cmd) return res.status(400).json({ error: "accion invalida" });
  // En automático solo vale DETENER (parada de emergencia); la página luego pide volver a manual
  if (state.mode === "auto" && cmd !== "stop") {
    return res.status(409).json({ error: "Modo automatico activo" });
  }
  state.command = cmd;
  console.log("comando: " + cmd);
  res.json(vistaPagina());
});

// POST { modo: "manual" | "automatico" }
app.post("/api/modo", auth, (req, res) => {
  const modo = MODO_A_DEV[(req.body || {}).modo];
  if (!modo) return res.status(400).json({ error: "modo invalido" });
  state.mode = modo;
  state.command = "stop"; // cualquier cambio de modo deja el comando en "stop" (el sketch cuenta con esto)
  console.log("modo: " + modo);
  res.json(vistaPagina());
});

// ---- ARDUINO ----

// POST { distance: número >= 0, motor: "left"|"right"|"stop" } -> { mode, command }
// OJO: el sketch lee la respuesta en un buffer de 128 bytes; no agregues campos largos.
app.post("/api/device/sync", auth, (req, res) => {
  const { distance, motor } = req.body || {};
  const distOk =
    distance === null ||
    (typeof distance === "number" && Number.isFinite(distance) && distance >= 0 && distance <= DIST_MAX_CM);
  if (!distOk || !CMD_A_ACCION[motor]) {
    return res.status(400).json({ error: "datos invalidos" });
  }
  state.distance = distance;
  state.motor = motor;
  state.lastSeen = Date.now();
  res.json({ mode: state.mode, command: state.command });
});

/* ----------------------- Errores ------------------------------------- */
app.use((req, res) => res.status(404).json({ error: "Ruta no encontrada" }));
app.use((err, req, res, next) => {
  // JSON mal formado, cuerpo demasiado grande, etc. Respuesta corta y en JSON.
  res.status(err.status || 500).json({ error: "peticion invalida" });
});

app.listen(PORT, () => {
  console.log("API escuchando en puerto " + PORT);
  if (!API_KEY) console.warn("AVISO: sin API_KEY (solo aceptable en pruebas locales)");
  if (ORIGINS.includes("*")) console.warn("AVISO: CORS abierto a cualquier origen (solo pruebas)");
});
