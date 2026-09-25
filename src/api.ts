
import axios, { isAxiosError } from 'axios';
import type { AxiosInstance, AxiosResponse } from 'axios';
import type {
  ApiError,
  AuthResponse,
  JsonBody,
  QueryParams,
  TaigaErrorBody,
  TaigaProject,
  TaigaTaxonomyItem,
  TaigaUser,
} from './types.js';

export const DEFAULT_API_URL = 'https://api.taiga.io/api/v1';
const REQUEST_TIMEOUT_MS = 30_000;

let warnedInsecureHttp = false;

export function apiBaseUrl(): string {
  const url = process.env.TAIGA_API_URL || DEFAULT_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid TAIGA_API_URL: "${url}" is not a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    const isLoopback = parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '::1'
      || parsed.hostname === '[::1]';
    if (!isLoopback && !warnedInsecureHttp) {
      warnedInsecureHttp = true;
      console.error(`WARNING: TAIGA_API_URL "${url}" uses unencrypted HTTP to a non-loopback host. Passwords and bearer tokens will be transmitted in cleartext.`);
    }
  }
  return url;
}

let token: string | null = null;
let tokenExpiresAt = 0;
let client: AxiosInstance | null = null;

export function isConfigured(): boolean {
  return Boolean(process.env.TAIGA_USERNAME && process.env.TAIGA_PASSWORD);
}
function isErrorBodyObject(body: TaigaErrorBody | undefined): body is Exclude<TaigaErrorBody, string> {
  return body !== undefined && Object(body) === body;
}


function apiError(error: Error, action: string): ApiError {
  let status: number | undefined;
  let body: TaigaErrorBody | undefined;
  let detail = error.message;
  if (isAxiosError<TaigaErrorBody>(error)) {
    status = error.response?.status;
    body = error.response?.data;
  }
  if (isErrorBodyObject(body)) {
    detail = body._error_message
      || Object.entries(body)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('; ');
  } else if (body) {
    detail = body;
  }
  return Object.assign(new Error(`${action} failed${status ? ` (HTTP ${status})` : ''}: ${detail}`), {
    status,
    detail: body,
  });
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  try {
    const { data } = await axios.post<AuthResponse>(`${apiBaseUrl()}/auth`, { type: 'normal', username, password }, { timeout: REQUEST_TIMEOUT_MS });
    token = data.auth_token;
    tokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
    return data;
  } catch (error) {
    token = null;
    const err = error instanceof Error ? error : new Error(String(error));
    throw apiError(err, 'Authentication');
  }
}

async function getToken(): Promise<string> {
  if (token && Date.now() < tokenExpiresAt) return token;
  if (!isConfigured()) {
    throw new Error('Taiga credentials missing: set TAIGA_USERNAME and TAIGA_PASSWORD, or call the authenticate tool.');
  }
  await login(process.env.TAIGA_USERNAME ?? '', process.env.TAIGA_PASSWORD ?? '');
  if (!token) {
    throw new Error('Failed to acquire Taiga token');
  }
  return token;
}

function getClient(): AxiosInstance {
  if (client) return client;
  client = axios.create({
    baseURL: apiBaseUrl(),
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'x-disable-pagination': 'true' },
  });
  client.interceptors.request.use(async (config) => {
    config.headers.Authorization = `Bearer ${await getToken()}`;
    return config;
  });
  return client;
}

const MAX_THROTTLE_WAIT_MS = 5000;

function retryAfterMs(response?: AxiosResponse): number | null {
  const header = response?.headers?.['retry-after'];
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const when = Date.parse(String(header));
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export interface RequestOptions {
  params?: QueryParams;
  data?: JsonBody | FormData;
  headers?: Record<string, string>;
  responseType?: 'json' | 'arraybuffer';
}

export async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const config = { method, url: path, ...options };
  let throttleRetries = 2;
  for (;;) {
    try {
      return (await getClient().request<T>(config)).data;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const status = isAxiosError(err) ? err.response?.status : undefined;

      if (status === 401 && token) {
        token = null;
        try {
          return (await getClient().request<T>(config)).data;
        } catch (retryError) {
          const retryErr = retryError instanceof Error ? retryError : new Error(String(retryError));
          throw apiError(retryErr, `${method} ${path}`);
        }
      }

      if (status === 429 && throttleRetries > 0) {
        const wait = isAxiosError(err) ? retryAfterMs(err.response) ?? 1000 : 1000;
        if (wait > MAX_THROTTLE_WAIT_MS) {
          throw Object.assign(
            new Error(`${method} ${path} was rate limited; retry in ${Math.ceil(wait / 1000)}s`),
            { status, detail: isAxiosError<TaigaErrorBody>(err) ? err.response?.data : undefined },
          );
        }
        throttleRetries -= 1;
        await sleep(wait);
        continue;
      }

      throw apiError(err, `${method} ${path}`);
    }
  }
}

export const get = <T>(path: string, params?: QueryParams): Promise<T> => request<T>('GET', path, { params });
export const post = <T>(path: string, data?: JsonBody): Promise<T> => request<T>('POST', path, { data });
export const patch = <T>(path: string, data?: JsonBody): Promise<T> => request<T>('PATCH', path, { data });
export const del = <T>(path: string, params?: QueryParams): Promise<T> => request<T>('DELETE', path, { params });

type CachedValue = TaigaProject | TaigaUser | TaigaTaxonomyItem[] | TaigaUser[];

interface CachedResponse {
  expires: number;
  value: CachedValue;
}

const METADATA_TTL_MS = 60_000;
const metadata = new Map<string, CachedResponse>();

export async function getMetadata<T>(path: string, params?: QueryParams): Promise<T> {
  const key = `${path} ${JSON.stringify(params ?? {})}`;
  const hit = metadata.get(key);
  let value: CachedValue;
  if (hit && hit.expires > Date.now()) {
    value = hit.value;
  } else {
    const now = Date.now();
    for (const [k, entry] of metadata.entries()) {
      if (entry.expires <= now) {
        metadata.delete(k);
      }
    }
    value = await get<CachedValue>(path, params);
    metadata.set(key, { value, expires: Date.now() + METADATA_TTL_MS });
  }
  return value as T;
}

export function clearMetadata(): void {
  metadata.clear();
}
