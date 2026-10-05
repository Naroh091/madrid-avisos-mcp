/**
 * Cliente HTTP de bajo nivel para AVSICAPI.
 * Añade las cabeceras de la app y el bearer token, expone GET/POST/multipart y
 * refresca el token automáticamente ante un 401 (POST oauth/v2/token).
 */
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  APP_KEY,
  APP_VERSION,
  BASE_URL,
  CLIENT_ID,
  DEFAULT_LANGUAGE,
  LOGIN_URL,
  REFRESH_TOKEN,
  TOKEN,
  TOKEN_STORE,
} from "./config.js";

export class AvisosApiError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: unknown,
  ) {
    super(`AVSICAPI ${status} en ${url}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "AvisosApiError";
  }
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  /** epoch ms en que se obtuvo, para estimar caducidad. */
  obtained_at?: number;
}

export interface ClientOptions {
  token?: string;
  refreshToken?: string;
  /** Ruta de fichero JSON donde leer/guardar los tokens (sobrescribe env al arrancar). */
  tokenStore?: string;
}

function baseHeaders(token: string | undefined, auth: boolean): Record<string, string> {
  const h: Record<string, string> = {
    "X-CLIENT-ID": CLIENT_ID,
    "X-APP-KEY": APP_KEY,
    "X-APP-VERSION": APP_VERSION,
    "Accept-Language": DEFAULT_LANGUAGE,
  };
  if (auth && token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

function buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(path.replace(/^\//, ""), BASE_URL);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export class AvisosClient {
  private accessToken: string | undefined;
  private refreshTokenValue: string | undefined;
  private tokenStore: string | undefined;
  private refreshing: Promise<boolean> | null = null;

  constructor(opts: ClientOptions = {}) {
    this.tokenStore = opts.tokenStore ?? TOKEN_STORE ?? undefined;
    // Prioridad: opciones explícitas > fichero de store > variables de entorno.
    let stored: TokenSet | undefined;
    if (this.tokenStore) {
      try {
        stored = JSON.parse(readFileSync(this.tokenStore, "utf8")) as TokenSet;
      } catch {
        /* store aún no existe: se creará al primer refresh */
      }
    }
    this.accessToken = opts.token ?? stored?.access_token ?? TOKEN ?? undefined;
    this.refreshTokenValue = opts.refreshToken ?? stored?.refresh_token ?? REFRESH_TOKEN ?? undefined;
  }

  hasToken(): boolean {
    return Boolean(this.accessToken);
  }
  canRefresh(): boolean {
    return Boolean(this.refreshTokenValue);
  }

  private async persist(tokens: TokenSet): Promise<void> {
    if (!this.tokenStore) return;
    try {
      await writeFile(this.tokenStore, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error("[madrid-avisos] No se pudo guardar el token store:", String(e));
    }
  }

  /** Refresca el access token con el refresh token (POST oauth/v2/token, sin bearer). */
  async refresh(): Promise<boolean> {
    if (!this.refreshTokenValue) return false;
    // single-flight: si ya hay un refresh en curso, reutilízalo.
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const url = buildUrl("oauth/v2/token");
      const res = await fetch(url, {
        method: "POST",
        headers: { ...baseHeaders(undefined, false), "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: this.refreshTokenValue,
          client_id: CLIENT_ID,
        }),
      });
      const body = (await parseBody(res)) as TokenSet;
      if (!res.ok || !body?.access_token) {
        console.error("[madrid-avisos] Refresh de token falló:", res.status, JSON.stringify(body));
        return false;
      }
      this.accessToken = body.access_token;
      if (body.refresh_token) this.refreshTokenValue = body.refresh_token; // el refresh token puede rotar
      await this.persist({ ...body, obtained_at: Date.now() });
      return true;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  /** Ejecuta una petición; ante 401 intenta refrescar una vez y reintenta. */
  private async request(makeReq: () => Promise<Response>, url: string): Promise<unknown> {
    let res = await makeReq();
    if (res.status === 401) {
      const refreshed = this.canRefresh() && (await this.refresh());
      if (refreshed) {
        res = await makeReq();
      } else if (res.status === 401) {
        // Sin refresh token (o refresco fallido): mensaje accionable para la opción "re-pegar token".
        const hint = this.canRefresh()
          ? "El refresh token fue rechazado (¿caducado/revocado?). Obtén una sesión nueva."
          : `El access token ha caducado o no es válido. Inicia sesión en ${LOGIN_URL} y actualiza MADRID_AVISOS_TOKEN con el token nuevo.`;
        throw new AvisosApiError(401, url, hint);
      }
    }
    const body = await parseBody(res);
    if (!res.ok) throw new AvisosApiError(res.status, url, body);
    return body;
  }

  async get<T = unknown>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    auth = true,
  ): Promise<T> {
    const url = buildUrl(path, query);
    return this.request(() => fetch(url, { method: "GET", headers: baseHeaders(this.accessToken, auth) }), url) as Promise<T>;
  }

  async postJson<T = unknown>(
    path: string,
    payload: unknown,
    query?: Record<string, string | number | boolean | undefined>,
    auth = true,
  ): Promise<T> {
    const url = buildUrl(path, query);
    return this.request(
      () =>
        fetch(url, {
          method: "POST",
          headers: { ...baseHeaders(this.accessToken, auth), "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify(payload),
        }),
      url,
    ) as Promise<T>;
  }

  async postMultipart<T = unknown>(
    path: string,
    fields: Record<string, string>,
    filePath: string,
    fileField = "media",
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = buildUrl(path, query);
    const data = await readFile(filePath);
    const make = () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      form.set(fileField, new Blob([data], { type: "image/jpeg" }), basename(filePath));
      return fetch(url, { method: "POST", headers: baseHeaders(this.accessToken, true), body: form });
    };
    return this.request(make, url) as Promise<T>;
  }
}
