import { cache as workersCache } from "cloudflare:workers";
import {
  EMAIL_LOGIN_COOKIE,
  ORDINARY_USER_ID_HEADER,
  ORDINARY_USER_MAC_HEADER,
} from "../ordinary-user-authentication";
import { EHALL_SESSION_COOKIE } from "../ordinary-user-session";

const PUBLIC_CACHE_CREDENTIAL_COOKIES = [
  "jufexk_voter",
  EMAIL_LOGIN_COOKIE,
  "jufexk_admin",
  "jufexk_csrf",
  "jufexk_user_csrf",
  EHALL_SESSION_COOKIE,
  "TGC",
  "SESSION",
  "CASTGC",
  "JSESSIONID",
] as const;

/**
 * Public catalog list GETs advertise Cache-Control / Cache-Tag for the CDN.
 * Browser requests still send cookies (`jufexk_voter`, `__cf_bm`, …) and the
 * CDN BYPASSes those, so shared list responses also go through Cache API with
 * a URL-only key.
 */

export const PUBLIC_CATALOG_CACHE_CONTROL =
  "public, max-age=0, s-maxage=3600, stale-while-revalidate=300";
/**
 * A dirty published projection is the pre-write snapshot. Do not let the CDN
 * or Cache API store it: s-maxage=3600 would keep that snapshot for an hour,
 * and stale-while-revalidate would keep serving it after the refresh lands.
 */
export const PUBLIC_CATALOG_STALE_CACHE_CONTROL = "no-store";
export const PUBLIC_CATALOG_CACHE_TAG = "public-catalog";
export const PUBLIC_DETAIL_CACHE_TAG = "public-detail";
export const PUBLIC_CONFIG_CACHE_TAG = "public-config";
export const DEFAULT_API_CACHE_CONTROL = "no-store";
export const PUBLIC_DETAIL_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, stale-while-revalidate=300";
export const PUBLIC_CONFIG_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

export type PublicCacheScope = "list" | "detail" | "config";

const cacheScopeValues: Record<PublicCacheScope, { control: string; tag: string }> = {
  list: { control: PUBLIC_CATALOG_CACHE_CONTROL, tag: PUBLIC_CATALOG_CACHE_TAG },
  detail: { control: PUBLIC_DETAIL_CACHE_CONTROL, tag: PUBLIC_DETAIL_CACHE_TAG },
  config: { control: PUBLIC_CONFIG_CACHE_CONTROL, tag: PUBLIC_CONFIG_CACHE_TAG },
};

type HeaderContext = {
  header: (name: string, value: string) => unknown;
};

type CachePurgeContext = {
  executionCtx?: unknown;
};

export function setPublicCatalogCacheHeaders(
  c: HeaderContext,
  scope: PublicCacheScope = "list",
  projectionStale = false,
) {
  const values = cacheScopeValues[scope];
  c.header(
    "Cache-Control",
    scope === "list" && projectionStale
      ? PUBLIC_CATALOG_STALE_CACHE_CONTROL
      : values.control,
  );
  c.header("Cache-Tag", values.tag);
}

/** Shared list responses are stored only when this read did not serve a dirty projection. */
export function shouldPutPublicCatalogCache(
  queryMs: number,
  projectionStale: boolean,
) {
  return queryMs < 2000 && !projectionStale;
}

export async function purgePublicCatalogCache(
  c: CachePurgeContext,
  scopes: readonly PublicCacheScope[] = ["list"],
) {
  const tags = [...new Set(scopes.map((scope) => cacheScopeValues[scope].tag))];
  try {
    // Hono's ExecutionContext type omits Workers Caching; the runtime ctx has it.
    const runtimeCache = (
      c.executionCtx as
        | { cache?: { purge?: (options: { tags: string[] }) => Promise<unknown> | unknown } }
        | undefined
    )?.cache;
    if (runtimeCache?.purge) {
      await runtimeCache.purge({ tags });
      return;
    }
    await workersCache.purge({ tags });
  } catch {
    // Best-effort: a write must still succeed if purge is missing or fails.
  }
}

/**
 * Cache keys ignore cookies in Workers Cache. Only requests without any
 * credential that can alter public payload fields may use shared responses.
 */
function isPublicRequestCacheable(
  c: {
    req: {
      header: (name: string) => string | undefined;
    };
  },
  allowedCookies: readonly string[],
) {
  const blockedCookies = PUBLIC_CACHE_CREDENTIAL_COOKIES.filter(
    (name) => !allowedCookies.includes(name),
  );
  const cookieHeader = c.req.header("Cookie") || "";
  const hasCookie = (name: string) =>
    cookieHeader.split(";").some((part) => part.trim().startsWith(`${name}=`));
  if (blockedCookies.some(hasCookie)) return false;
  if (c.req.header(ORDINARY_USER_ID_HEADER)) return false;
  if (c.req.header(ORDINARY_USER_MAC_HEADER)) return false;
  if (c.req.header("Authorization")) return false;
  if (c.req.header("X-Test-Auth") || c.req.header("X-Test-Authentication"))
    return false;
  return true;
}

export function isPublicCatalogCacheableRequest(c: {
  req: {
    header: (name: string) => string | undefined;
  };
}) {
  return isPublicRequestCacheable(c, []);
}

/**
 * Public course and relation lists never serialize viewer signals, so the
 * anonymous voter marker is safe to ignore for shared caching.
 */
export function isPublicCourseListCacheableRequest(c: {
  req: {
    header: (name: string) => string | undefined;
  };
}) {
  return isPublicRequestCacheable(c, ["jufexk_voter"]);
}

/** The latest public review projection also omits all viewer-specific fields. */
export function isPublicLatestReviewsCacheableRequest(c: {
  req: {
    header: (name: string) => string | undefined;
  };
}) {
  return isPublicRequestCacheable(c, ["jufexk_voter", "jufexk_user_csrf"]);
}

export function shouldUsePublicCatalogCacheApi(env: {
  ORDINARY_USER_TEST_AUTH_SECRET?: string;
}): boolean {
  return !env.ORDINARY_USER_TEST_AUTH_SECRET;
}

export function publicCatalogCacheKey(url: string): Request {
  return new Request(url, { method: "GET" });
}

type PublicCatalogCacheStore = Pick<Cache, "match" | "put">;

function publicCatalogCacheStore(): PublicCatalogCacheStore {
  return (caches as CacheStorage & { default: Cache }).default;
}

export async function matchPublicCatalogCache(
  url: string,
  cache: Pick<Cache, "match"> = publicCatalogCacheStore(),
): Promise<Response | undefined> {
  try {
    return (await cache.match(publicCatalogCacheKey(url))) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function putPublicCatalogCache(
  url: string,
  response: Response,
  cache: Pick<Cache, "put"> = publicCatalogCacheStore(),
): Promise<void> {
  try {
    await cache.put(publicCatalogCacheKey(url), response);
  } catch {
    // Best-effort: origin response is still returned to the client.
  }
}
