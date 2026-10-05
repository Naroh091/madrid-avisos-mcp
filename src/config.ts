/**
 * Configuración de la API de Avisos de Madrid (AVSICAPI).
 *
 * Valores extraídos por ingeniería inversa de la app "Madrid Móvil"
 * (es.madrid.SGRSAMVANDCIU v03.01.089) y verificados con captura de tráfico real.
 *
 * El backend NO usa pinning sobre servpub.madrid.es y acepta llamadas
 * programáticas con un bearer token (Akamai solo protege el flujo de login web).
 */

/**
 * Alcobendas usa la misma plataforma (Mejora Tu Ciudad). Con MADRID_AVISOS_CITY=alcobendas
 * solo cambian servidor, credenciales de la app "Alcobendas" (v6.0.364) y jurisdicción,
 * verificados contra GET jurisdictions?app_key=11. Las variables definidas mandan.
 */
export const ALCOBENDAS = process.env.MADRID_AVISOS_CITY === "alcobendas";
if (ALCOBENDAS) {
  const defaults: Record<string, string> = {
    MADRID_AVISOS_BASE_URL: "https://api.mejoratuciudad.org/",
    MADRID_AVISOS_APP_KEY: "11",
    MADRID_AVISOS_CLIENT_ID: "1y63ibwr2xlw8kwkg0g48swokkoosk4cggws08s4cg4ws08ogk",
    MADRID_AVISOS_APP_VERSION: "6.0.364",
    MADRID_AVISOS_JURISDICTION: "org.alcobendas",
    MADRID_AVISOS_JURISDICTION_ELEMENT: "5c9b55579650e67d42985e80",
    MADRID_AVISOS_DEVICE_TYPE: "60c09cdccdf34808168b4573",
  };
  for (const [k, v] of Object.entries(defaults)) process.env[k] ??= v;
}

/** Web donde iniciar sesión y copiar la clave `token` del almacenamiento local. */
export const LOGIN_URL = ALCOBENDAS ? "https://mapa.mejoratuciudad.org/org.alcobendas" : "https://avisos.madrid.es";

export const BASE_URL =
  process.env.MADRID_AVISOS_BASE_URL ?? "https://servpub.madrid.es/AVSICAPI/";

/** app_key de Madrid Móvil (viaja como cabecera X-APP-KEY y, en algunos endpoints, como query). */
export const APP_KEY = process.env.MADRID_AVISOS_APP_KEY ?? "1";

/** client_id OAuth de la app (cabecera X-CLIENT-ID y cuerpo de login). */
export const CLIENT_ID =
  process.env.MADRID_AVISOS_CLIENT_ID ??
  "54yxcchv0b48gck4804s84cw8ckck8c0k40sk00440g0o08scc";

export const APP_VERSION = process.env.MADRID_AVISOS_APP_VERSION ?? "03.01.089";

/** Jurisdicción por defecto (Madrid). Requiere usuario registrado (only_registered_users=true). */
export const DEFAULT_JURISDICTION = process.env.MADRID_AVISOS_JURISDICTION ?? "es.madrid";

/**
 * Elemento de jurisdicción por defecto: la ciudad de Madrid (is_main=true).
 * Necesario para validate-position y location-additional-data (dirección).
 */
export const DEFAULT_JURISDICTION_ELEMENT =
  process.env.MADRID_AVISOS_JURISDICTION_ELEMENT ?? "5e5a3f17179796a7cbb93934";

/**
 * device_type por defecto: NO es "android", es el id del origin-device del canal
 * android (la app lo resuelve de jurisdiction.origin_devices por options).
 * Verificado en vivo contra GET jurisdictions.
 */
export const DEFAULT_DEVICE_TYPE =
  process.env.MADRID_AVISOS_DEVICE_TYPE ?? "5922cfc84e4ea823178b4569";

export const DEFAULT_LANGUAGE = process.env.MADRID_AVISOS_LANGUAGE ?? "es";

/**
 * Bearer token de un usuario registrado. Necesario para crear avisos en Madrid.
 * Se obtiene iniciando sesión en https://avisos.madrid.es (el login está tras Akamai,
 * así que no se automatiza aquí) y copiando el token del almacenamiento del navegador,
 * o mediante login-anonymous para operaciones que lo permitan.
 */
export const TOKEN = process.env.MADRID_AVISOS_TOKEN ?? "";

/**
 * Refresh token. Si se provee, el cliente refresca el access token automáticamente
 * ante un 401 (POST oauth/v2/token con grant_type=refresh_token).
 */
export const REFRESH_TOKEN = process.env.MADRID_AVISOS_REFRESH_TOKEN ?? "";

/**
 * Ruta opcional a un JSON donde leer/guardar los tokens. Si se define, al arrancar
 * carga los tokens de ahí (sobre las variables de entorno) y persiste los refrescados
 * (el refresh_token puede rotar en cada refresco).
 */
export const TOKEN_STORE = process.env.MADRID_AVISOS_TOKEN_STORE ?? "";

/** device_id usado en login-anonymous y me/device. */
export const DEVICE_ID = process.env.MADRID_AVISOS_DEVICE_ID ?? "mcp-madrid-avisos";
