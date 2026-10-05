/**
 * Núcleo: funciones de alto nivel sobre AVSICAPI.
 * Reutilizadas tanto por el servidor MCP como por el CLI.
 */
import { AvisosClient } from "./client.js";
import { ALCOBENDAS, APP_KEY, CLIENT_ID, DEFAULT_DEVICE_TYPE, DEFAULT_JURISDICTION, DEFAULT_JURISDICTION_ELEMENT, DEVICE_ID } from "./config.js";
import type { CreateAvisoFromPhotoInput, CreateAvisoInput, CreateAvisoPayload } from "./types.js";
import { loadPhotoBuffer, parsePhoto, previewToken, saveUpload, downscaleForVision, resolveUpload, type PhotoInfo } from "./photo.js";

/** Login anónimo → devuelve access_token (30 días) y refresh_token. */
export async function loginAnonymous(client: AvisosClient): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  return client.postJson(
    "login-anonymous",
    { client_id: CLIENT_ID, device_id: DEVICE_ID },
    undefined,
    false, // sin bearer
  );
}

/** Aceptar términos legales (obligatorio antes de operar tras el login). */
export async function acceptTerms(client: AvisosClient): Promise<unknown> {
  return client.postJson("accept_terms", {});
}

/** Refresca manualmente el access token usando el refresh token. */
export async function refreshSession(client: AvisosClient): Promise<{ refreshed: boolean; reason?: string }> {
  if (!client.canRefresh()) return { refreshed: false, reason: "No hay refresh token configurado (MADRID_AVISOS_REFRESH_TOKEN)." };
  const ok = await client.refresh();
  return ok ? { refreshed: true } : { refreshed: false, reason: "El servidor rechazó el refresh token (¿caducado o revocado?)." };
}

/** Perfil del usuario autenticado. */
export async function getProfile(client: AvisosClient): Promise<unknown> {
  return client.get("profile");
}

/** Alcobendas exige nombre, apellidos y teléfono del informante: como su web, se toman del perfil. */
async function informantFromProfile(client: AvisosClient, informant: CreateAvisoInput["informant"]) {
  if (!ALCOBENDAS || !client.hasToken()) return informant;
  const p = (await getProfile(client).catch(() => ({}))) as Record<string, string | undefined>;
  return { first_name: p.first_name, last_name: p.last_name, phone: p.phone, email: p.email, ...informant };
}

/** Alcobendas incluye el polígono del término municipal (~1 MB) en location-additional-data. */
function withoutGeometry<T>(res: T): T {
  if (!Array.isArray(res)) return res;
  return res.map((r) => (r?.geometry ? { ...r, geometry: "(omitida)" } : r)) as T;
}

export interface Category {
  id: string;
  visible_name: string;
  service_name: string;
  description?: string;
  keywords?: string;
  mandatory_description?: boolean;
  mandatory_medias?: boolean;
  mandatory_files?: boolean;
  max_upload_medias?: number;
  max_upload_files?: number;
  public?: boolean;
  with_informant?: boolean;
  location_type?: string;
  typology?: { id: string; visible_name?: string };
}

/** Lista de categorías/servicios de una jurisdicción. */
export async function listCategories(
  client: AvisosClient,
  jurisdictionId = DEFAULT_JURISDICTION,
): Promise<Category[]> {
  return client.get<Category[]>("services", { jurisdiction_ids: jurisdictionId, limit: 500 });
}

/** Detalle de un servicio (incluye definición del formulario y flags). */
export async function getCategory(
  client: AvisosClient,
  serviceId: string,
  jurisdictionId = DEFAULT_JURISDICTION,
): Promise<unknown> {
  return client.get(`services/${encodeURIComponent(serviceId)}`, { jurisdiction_id: jurisdictionId });
}

export interface ResolvedLocation {
  validate_position: unknown;
  location_additional_data: unknown;
  duplicates: unknown;
}

export interface ResolvedAddress {
  /** Dirección municipal ("Calle Laurel, 1"). */
  formatted_address: string;
  /** Respuestas pre-rellenadas por el servidor (id de pregunta + valor). */
  answers: Array<{ question: string; value: string }>;
  raw: unknown;
}

/**
 * Geocodificación inversa propia: coords -> dirección municipal + respuestas
 * pre-rellenadas de ubicación. Usa el elemento de Madrid por defecto.
 */
export async function resolveAddress(
  client: AvisosClient,
  lat: number,
  lng: number,
  jurisdictionElementId = DEFAULT_JURISDICTION_ELEMENT,
): Promise<ResolvedAddress> {
  const res = (await client.get("location-additional-data", {
    jurisdiction_element_id: jurisdictionElementId,
    lat,
    lng,
  })) as unknown;
  const parsed = parseAddressResponse(res);
  if (!parsed) throw new Error("El servidor no devolvió dirección para esas coordenadas.");
  return parsed;
}

/** Extrae dirección + respuestas de un location-additional-data (ya descargado o fresco). */
export function parseAddressResponse(res: unknown): ResolvedAddress | null {
  const first = (res as Array<{
    formatted_address?: string;
    data?: Array<{ question?: { id?: string; type?: string }; value?: unknown }>;
  }> | null)?.[0];
  if (!first?.formatted_address) return null;
  const answers: ResolvedAddress["answers"] = [];
  for (const a of first.data ?? []) {
    // Como la app y la web (validateValue): las respuestas en blanco se OMITEN,
    // no se mandan vacías. Mandarlas en blanco hace fallar la validación.
    if (!a?.question?.id || a.value === null || a.value === undefined) continue;
    if (typeof a.value === "string" && a.value.trim() === "") continue;
    answers.push({ question: a.question.id, value: String(a.value) });
  }
  return { formatted_address: first.formatted_address, answers, raw: withoutGeometry([first])[0] };
}

/** Caché del device id por canal (jurisdictions rara vez cambia). */
const deviceCache = new Map<string, string>();

/** Intenta resolver dirección; devuelve null en vez de lanzar (no bloquea el dry-run). */
async function resolveAddressQuiet(
  client: AvisosClient,
  lat: number,
  lng: number,
): Promise<ResolvedAddress | null> {
  try {
    return await resolveAddress(client, lat, lng);
  } catch {
    return null;
  }
}

/** Fusiona respuestas: las aportadas mandan por id; las auto-resueltas rellenan huecos. */
function mergeAnswers(
  auto: Array<{ question: string; value: string }> | undefined,
  provided: Array<{ question: string; value: string | string[] }> | undefined,
): Array<{ question: string; value: string | string[] }> | undefined {
  if (!auto?.length) return provided;
  if (!provided?.length) return auto;
  const seen = new Set(provided.map((a) => a.question));
  return [...provided, ...auto.filter((a) => !seen.has(a.question))];
}

/**
 * Resuelve el device_type (id de origin-device) para un canal buscando en
 * jurisdiction.origin_devices (GET jurisdictions). Prefiere coincidencia exacta
 * de options, si no cualquiera que lo incluya.
 */
export async function resolveDeviceType(
  client: AvisosClient,
  channel = "android",
): Promise<string> {
  const hit = deviceCache.get(channel);
  if (hit) return hit;
  const res = (await client.get("jurisdictions", { app_key: APP_KEY })) as Array<{
    origin_devices?: Array<{ id?: string; options?: string[] }>;
  }>;
  const devs = (Array.isArray(res) ? res : [res]).flatMap((j) => j.origin_devices ?? []);
  const exact = devs.find(
    (d) => d.id && d.options?.length === 1 && d.options[0] === channel,
  );
  const any = devs.find((d) => d.id && d.options?.includes(channel));
  const id = exact?.id ?? any?.id;
  if (!id) throw new Error(`Sin origin-device para el canal ${channel} en jurisdictions.`);
  deviceCache.set(channel, id);
  return id;
}

/**
 * Resuelve una ubicación para un servicio: valida la posición (zonas del servicio),
 * obtiene la dirección + preguntas dinámicas de ubicación y comprueba duplicados.
 * Sin jurisdiction_element_id usa el de la ciudad de Madrid.
 */
export async function resolveLocation(
  client: AvisosClient,
  serviceId: string,
  lat: number,
  lng: number,
  jurisdictionElementId: string = DEFAULT_JURISDICTION_ELEMENT,
): Promise<ResolvedLocation> {
  const [validate_position, location_additional_data, duplicates] = await Promise.all([
    client
      .get(`service/${encodeURIComponent(serviceId)}/validate-position`, {
        lat,
        long: lng,
        jurisdiction_element_id: jurisdictionElementId,
      })
      .catch((e) => ({ error: String(e) })),
    client
      .get("location-additional-data", { jurisdiction_element_id: jurisdictionElementId, lat, lng })
      .catch((e) => ({ error: String(e) })),
    client
      .get("request_duplicate", { service_id: serviceId, lat, lng })
      .catch((e) => ({ error: String(e) })),
  ]);
  return { validate_position, location_additional_data: withoutGeometry(location_additional_data), duplicates };
}

/** Construye el cuerpo JSON del POST requests (rama CityApp) a partir de la entrada. */
export function buildCreatePayload(input: CreateAvisoInput): CreateAvisoPayload {
  const payload: CreateAvisoPayload = {
    jurisdiction_id: input.jurisdiction_id ?? DEFAULT_JURISDICTION,
    service_id: input.service_id,
    public: input.public ?? true,
    // OJO: no es "android": es el id del origin-device del canal (ver resolveDeviceType).
    device_type: input.device_type ?? DEFAULT_DEVICE_TYPE,
  };
  if (input.description) payload.description = input.description;
  if (input.priority) payload.priority = input.priority;
  if (input.lat !== undefined) payload.lat = input.lat;
  if (input.lng !== undefined) payload.long = input.lng; // create usa "long"
  if (input.level !== undefined) payload.level = input.level;
  if (input.address_string) payload.address_string = input.address_string;
  if (input.zones?.length) payload.zones = input.zones;
  if (input.jurisdiction_element) payload.jurisdiction_element = input.jurisdiction_element;
  if (input.situation) payload.situation = input.situation;
  if (input.location_additional_data?.length) {
    payload.location_additional_data = input.location_additional_data.map((a) => ({
      value: a.value,
      question: a.question,
    }));
  }
  if (input.additional_data?.length) {
    payload.additionalData = input.additional_data.map((a) => ({ question: a.question, value: a.value }));
  }
  if (input.informant) Object.assign(payload, input.informant);
  return payload;
}

export interface CreateResult {
  dry_run: boolean;
  payload: CreateAvisoPayload;
  endpoint: string;
  /** Respuesta del servidor si se envió de verdad (confirm=true). */
  response?: unknown;
}

/**
 * Crea un aviso. Por seguridad, por defecto es DRY-RUN: construye el payload y NO lo envía.
 * Solo con input.confirm === true realiza el POST real (crea un aviso real en el Ayuntamiento).
 * Si hay lat/lng, auto-completa address_string y las respuestas de ubicación que falten
 * (las aportadas mandan): el servidor rechaza preguntas ausentes como el calificador.
 */
export async function createAviso(client: AvisosClient, input: CreateAvisoInput): Promise<CreateResult> {
  let { address_string, location_additional_data } = input;
  if (input.lat !== undefined && input.lng !== undefined) {
    const auto = await resolveAddressQuiet(client, input.lat, input.lng);
    address_string ??= auto?.formatted_address;
    location_additional_data = mergeAnswers(auto?.answers, location_additional_data);
  }
  // device_type dinámico (mejor esfuerzo): si falla, el valor por defecto de buildCreatePayload.
  const device_type =
    input.device_type ?? (await resolveDeviceType(client).catch(() => DEFAULT_DEVICE_TYPE));
  const informant = await informantFromProfile(client, input.informant);
  const payload = buildCreatePayload({ ...input, address_string, location_additional_data, device_type, informant });
  const endpoint = "requests";
  if (!input.confirm) {
    return { dry_run: true, payload, endpoint };
  }
  const response = await client.postJson(endpoint, payload, { app_key: APP_KEY });
  return { dry_run: false, payload, endpoint, response };
}

/**
 * Adjunta una foto a un aviso ya creado (multipart contra requests_medias).
 * Dry-run por defecto: solo envía si confirm === true.
 */
export async function attachPhoto(
  client: AvisosClient,
  requestToken: string,
  image: { image_path?: string; image_base64?: string; file_id?: string } | string,
  confirm = false,
  jurisdictionId = DEFAULT_JURISDICTION,
): Promise<{ dry_run: boolean; endpoint: string; saved_image_path: string; response?: unknown }> {
  const endpoint = "requests_medias";
  const input = typeof image === "string" ? { image_path: image } : image;
  // Valida la foto siempre (sin red): falla limpio si falta o el base64 es inválido.
  const buf = await loadPhotoBuffer(input.image_base64, input.image_path, input.file_id);
  if (!confirm) {
    return { dry_run: true, endpoint, saved_image_path: input.image_path ?? "(se guarda en tmp al confirmar)" };
  }
  // file_id/image_path ya están en el servidor; base64 se guarda en tmp.
  const saved_image_path =
    input.image_path ?? (input.file_id ? resolveUpload(input.file_id) : await saveUpload(buf));
  const response = await client.postMultipart(
    endpoint,
    { token: requestToken, type: "image/jpeg" },
    saved_image_path,
    "media",
    { jurisdiction_id: jurisdictionId }, // la app lo manda como query (fg9.java)
  );
  return { dry_run: false, endpoint, saved_image_path, response };
}

/** Detalle de un aviso por id. */
export async function getAviso(client: AvisosClient, id: string): Promise<unknown> {
  return client.get(`requests/${encodeURIComponent(id)}`, { with_observers: false });
}
/** Listado de avisos del usuario (POST requests-list). Sin filtros usa los de la app + own:true. */
export async function listMyAvisos(client: AvisosClient, filters: Record<string, unknown> = {}): Promise<unknown> {
  const body =
    Object.keys(filters).length > 0
      ? filters
      : { jurisdiction_ids: DEFAULT_JURISDICTION, limit: 10, page: 1, own: true };
  return client.postJson("requests-list", body);
}

// ---------------------------------------------------------------------------
// Aviso desde foto (dos fases con confirmación humana obligatoria)
// ---------------------------------------------------------------------------

const HINT_STOPWORDS = new Set(
  "el la los las un una unos unas en de del al y o con por para que se hay son es esta este esto eso esa ese aqui hay muy mas".split(" "),
);

export interface CategorySuggestion {
  id: string;
  visible_name: string;
  score: number;
}

/** Sugiere categorías por coincidencia de palabras del hint contra nombre/descripción/keywords. */
export async function suggestCategories(
  client: AvisosClient,
  hint?: string,
  jurisdictionId = DEFAULT_JURISDICTION,
  limit = 5,
): Promise<CategorySuggestion[]> {
  const cats = await listCategories(client, jurisdictionId);
  if (!hint?.trim()) {
    return cats.slice(0, limit).map((c) => ({ id: c.id, visible_name: c.visible_name, score: 0 }));
  }
  const words = hint
    .toLowerCase()
    .split(/[^a-záéíóúñü0-9]+/u)
    .filter((w) => w.length > 2 && !HINT_STOPWORDS.has(w));
  const scored = cats.map((c) => {
    const name = (c.visible_name ?? "").toLowerCase();
    const svc = (c.service_name ?? "").toLowerCase();
    const desc = `${c.description ?? ""} ${c.keywords ?? ""}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (name.includes(w)) score += 3;
      else if (svc.includes(w)) score += 2;
      else if (desc.includes(w)) score += 1;
    }
    return { id: c.id, visible_name: c.visible_name, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export type FromPhotoResult =
  | {
      phase: "need_category";
      photo: PhotoInfo;
      gps: { lat: number; lng: number; from: "exif" | "manual" };
      saved_image_path: string;
      suggestions: CategorySuggestion[];
      next: string;
    }
  | {
      phase: "preview";
      preview_token: string;
      photo: PhotoInfo;
      gps: { lat: number; lng: number; from: "exif" | "manual" };
      saved_image_path: string;
      category: unknown;
      resolved_location: ResolvedLocation;
      payload: CreateAvisoPayload;
      description_drafted: boolean;
      /** true si address_string/location vienen auto-resueltos (revisar en el preview). */
      address_auto_resolved: boolean;
      /** true si la foto se redujo en el servidor (el modelo solo debe ver esta copia). */
      image_resized: boolean;
      /** Copia reducida (data URL JPEG) para visión del modelo. La original se usa al adjuntar. */
      preview_image_base64: string;
      how_to_confirm: string;
    }
  | {
      phase: "sent";
      payload: CreateAvisoPayload;
      response: unknown;
      saved_image_path: string;
      next: string;
    };

/**
 * Crea un aviso a partir de una foto, en dos fases:
 *  1. preview (confirm=false): extrae GPS EXIF, sugiere/valida categoría, resuelve
 *     ubicación y devuelve el payload + preview_token SIN enviar nada.
 *  2. envío (confirm=true): exige human_confirmed=true (el humano vio el preview
 *     y dijo "sí") + el preview_token exacto. Si cambió cualquier campo del payload,
 *     el token no coincide y hay que repetir el preview. Solo entonces hace el POST.
 */
export async function createAvisoFromPhoto(
  client: AvisosClient,
  input: CreateAvisoFromPhotoInput,
): Promise<FromPhotoResult> {
  // PRIMERA TAREA: cargar y reducir en el servidor. El modelo no procesa los
  // bytes originales: para visión usa solo preview_image_base64.
  const buf = await loadPhotoBuffer(input.image_base64, input.image_path, input.file_id);
  const small = downscaleForVision(buf);
  const photo = parsePhoto(small.resized ? small.buffer : buf);
  // Siempre la ORIGINAL: la ya guardada (file_id/image_path) o copia a tmp (base64).
  const saved_image_path =
    input.image_path ?? (input.file_id ? resolveUpload(input.file_id) : await saveUpload(buf));
  const preview_image_base64 = `data:image/jpeg;base64,${small.buffer.toString("base64")}`;

  const lat = input.lat ?? photo.gps?.lat;
  const lng = input.lng ?? photo.gps?.lng;
  if (lat === undefined || lng === undefined) {
    throw new Error(
      "La foto no trae GPS EXIF (o no es JPEG). Reenvía la original con ubicación o pasa lat/lng manualmente." +
        (photo.exif_warning ? ` Detalle: ${photo.exif_warning}` : ""),
    );
  }
  const gps = { lat, lng, from: (input.lat !== undefined ? "manual" : "exif") as "manual" | "exif" };

  if (!input.service_id) {
    const suggestions = await suggestCategories(
      client,
      input.category_hint ?? input.description,
      input.jurisdiction_id ?? DEFAULT_JURISDICTION,
    );
    return {
      phase: "need_category",
      photo,
      gps,
      saved_image_path,
      suggestions,
      next: "Elige un service_id de suggestions (o list_categories) y repite la llamada con service_id + description. Nada se ha enviado.",
    };
  }

  const jurisdiction = input.jurisdiction_id ?? DEFAULT_JURISDICTION;
  const [category, resolved_location] = await Promise.all([
    getCategory(client, input.service_id, jurisdiction),
    resolveLocation(client, input.service_id, lat, lng, input.jurisdiction_element),
  ]);

  const informant = await informantFromProfile(client, input.informant);
  let description_drafted = false;
  let description = input.description?.trim();
  if (!description) {
    description_drafted = true;
    const when = photo.taken_at ? ` (foto del ${photo.taken_at})` : "";
    const what = input.category_hint?.trim() ? ` ${input.category_hint.trim()}` : "";
    description = `Incidencia reportada con foto${when}.${what} Revisar descripción antes de enviar.`.trim();
  }

  // Dirección + respuestas de ubicación auto-resueltas (el humano las ve en el preview).
  const autoAddress = parseAddressResponse(resolved_location.location_additional_data);
  const address_string = input.address_string ?? autoAddress?.formatted_address;
  const location_additional_data = mergeAnswers(autoAddress?.answers, input.location_additional_data);
  const address_auto_resolved = !input.address_string && !!autoAddress;
  // device_type dinámico (mejor esfuerzo): id del canal android, no el literal "android".
  const device_type =
    input.device_type ?? (await resolveDeviceType(client).catch(() => DEFAULT_DEVICE_TYPE));

  const payload = buildCreatePayload({
    service_id: input.service_id,
    jurisdiction_id: jurisdiction,
    lat,
    lng,
    description,
    public: input.public,
    address_string,
    level: input.level,
    priority: input.priority,
    jurisdiction_element: input.jurisdiction_element,
    situation: input.situation,
    zones: input.zones,
    location_additional_data,
    additional_data: input.additional_data,
    informant,
    device_type,
    confirm: false,
  });
  const token = previewToken(payload);

  if (!input.confirm) {
    return {
      phase: "preview",
      preview_token: token,
      photo,
      gps,
      saved_image_path,
      category,
      resolved_location,
      payload,
      description_drafted,
      address_auto_resolved,
      image_resized: small.resized,
      preview_image_base64,
      how_to_confirm:
        "MUESTRA este preview al humano y espera su 'sí'. Solo entonces repite la llamada con los MISMOS campos + confirm:true + human_confirmed:true + este preview_token. Si cambias cualquier campo, pide un preview nuevo.",
    };
  }

  if (input.human_confirmed !== true) {
    throw new Error(
      "Envío bloqueado: falta la confirmación humana. Muestra el preview al humano y repite con human_confirmed:true + preview_token.",
    );
  }
  if (input.preview_token !== token) {
    throw new Error(
      "preview_token inválido o desactualizado (algún campo cambió desde el preview). Repite el preview y confirma el token nuevo. Nada se ha enviado.",
    );
  }

  const sent = await createAviso(client, {
    service_id: input.service_id,
    jurisdiction_id: jurisdiction,
    lat,
    lng,
    description,
    public: input.public,
    address_string,
    level: input.level,
    priority: input.priority,
    jurisdiction_element: input.jurisdiction_element,
    situation: input.situation,
    zones: input.zones,
    location_additional_data,
    additional_data: input.additional_data,
    informant,
    device_type,
    confirm: true,
  });
  return {
    phase: "sent",
    payload,
    response: sent.response,
    saved_image_path,
    next: `Aviso creado. Para adjuntar la foto: attach_photo con el request token de 'response' y image_path=${saved_image_path} + confirm:true (tras OK humano).`,
  };
}
