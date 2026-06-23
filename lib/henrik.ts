// lib/henrik.ts — server-only
import "dotenv/config";

const BASE = "https://api.henrikdev.xyz/valorant";
const KEY = () => {
  const k = process.env.VAL_API_KEY;
  if (!k) throw new Error("VAL_API_KEY is not set");
  return k;
};

// Basic tier = 30 req/min. Throttle ~2.2s between calls to stay safe.
let last = 0;
async function throttle() {
  const wait = 2200 - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

const MAX_RETRIES = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Transient: rate limits (429) and any server-side 5xx. Patch-day HenrikDev
// outages surface as bursts of 500s, so retrying rides them out instead of
// failing the whole scheduled sync on a single bad response.
const retryable = (status: number) => status === 429 || status >= 500;

async function get<T>(path: string, attempt = 0): Promise<T> {
  await throttle();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { headers: { Authorization: KEY() } });
  } catch (e) {
    // Network-level failure (DNS, reset, timeout) — also worth retrying.
    if (attempt < MAX_RETRIES) {
      const waitMs = 5000 * (attempt + 1);
      console.warn(
        `HenrikDev ${path} -> network error (${(e as Error).message}), retrying in ${Math.round(waitMs / 1000)}s (retry ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(waitMs);
      return get<T>(path, attempt + 1);
    }
    throw e;
  }
  // Transient HTTP status: respect Retry-After when present, else back off linearly.
  if (retryable(res.status) && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : 5000 * (attempt + 1);
    console.warn(
      `HenrikDev ${path} -> ${res.status}, backing off ${Math.round(waitMs / 1000)}s (retry ${attempt + 1}/${MAX_RETRIES})`,
    );
    await sleep(waitMs);
    return get<T>(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`HenrikDev ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const henrik = {
  account: (name: string, tag: string) =>
    get<any>(`/v2/account/${name}/${tag}`),
  mmr: (r: string, p: string, name: string, tag: string) =>
    get<any>(`/v3/mmr/${r}/${p}/${name}/${tag}`),
  mmrHistory: (r: string, p: string, name: string, tag: string) =>
    get<any>(`/v2/mmr-history/${r}/${p}/${name}/${tag}`),
  storedCompetitive: (r: string, name: string, tag: string, size = 200) =>
    get<any>(
      `/v1/stored-matches/${r}/${name}/${tag}?mode=competitive&size=${size}`,
    ),
  matchById: (r: string, id: string) => get<any>(`/v4/match/${r}/${id}`),
};
