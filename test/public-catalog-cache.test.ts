import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import {
  DEFAULT_API_CACHE_CONTROL,
  PUBLIC_CATALOG_CACHE_CONTROL,
  PUBLIC_CATALOG_CACHE_TAG,
  PUBLIC_CATALOG_STALE_CACHE_CONTROL,
  PUBLIC_CONFIG_CACHE_CONTROL,
  PUBLIC_CONFIG_CACHE_TAG,
  PUBLIC_DETAIL_CACHE_CONTROL,
  PUBLIC_DETAIL_CACHE_TAG,
  purgePublicCatalogCache,
  isPublicCourseListCacheableRequest,
  matchPublicCatalogCache,
  publicCatalogCacheKey,
  putPublicCatalogCache,
  setPublicCatalogCacheHeaders,
  shouldPutPublicCatalogCache,
  shouldUsePublicCatalogCacheApi,
} from "../src/lib/public-catalog-cache";
import { refreshPublicListPrecomputes } from "../src/public-list-precompute";

const origin = "https://example.com";

const isPublicCatalogCache = (response: Response) => {
  expect(response.headers.get("Cache-Control")).toBe(PUBLIC_CATALOG_CACHE_CONTROL);
  expect(response.headers.get("Cache-Tag")).toBe(PUBLIC_CATALOG_CACHE_TAG);
};

const isNotPublicCatalogCache = (response: Response) => {
  expect(response.headers.get("Cache-Control")).toBe(DEFAULT_API_CACHE_CONTROL);
  expect(response.headers.get("Cache-Tag")).not.toBe(PUBLIC_CATALOG_CACHE_TAG);
};

const isScopedPublicCache = (
  response: Response,
  control: string,
  tag: string,
) => {
  expect(response.headers.get("Cache-Control")).toBe(control);
  expect(response.headers.get("Cache-Tag")).toBe(tag);
};

describe("public catalog cache headers", () => {
  it.each([
    "/api/courses",
    "/api/teachers",
    "/api/courses/options",
    "/api/courses/departments",
  ])("marks %s as a public catalog cache entry", async (path) => {
    const response = await SELF.fetch(`${origin}${path}`);
    expect(response.status).toBe(200);
    isPublicCatalogCache(response);
  });

  it("short-caches anonymous /api/config", async () => {
    const response = await SELF.fetch(`${origin}/api/config`);
    expect(response.status).toBe(200);
    isScopedPublicCache(response, PUBLIC_CONFIG_CACHE_CONTROL, PUBLIC_CONFIG_CACHE_TAG);
    expect(await response.json()).toMatchObject({ showScheduleNav: false });
  });

  it("shows schedule nav on a loopback Worker host", async () => {
    const response = await SELF.fetch("http://127.0.0.1:8787/api/config");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ showScheduleNav: true });
  });

  it("keeps admin routes uncached", async () => {
    const response = await SELF.fetch(`${origin}/api/admin/session`);
    expect(response.status).toBe(401);
    isNotPublicCatalogCache(response);
  });

  it("publicly caches anonymous course detail", async () => {
    const response = await SELF.fetch(`${origin}/api/courses/1`);
    expect(response.status).toBe(200);
    isScopedPublicCache(response, PUBLIC_DETAIL_CACHE_CONTROL, PUBLIC_DETAIL_CACHE_TAG);
  });

  it("caches a plain course list even with the guest voter marker", async () => {
    const response = await SELF.fetch(`${origin}/api/courses?pageSize=1`, {
      headers: { Cookie: "jufexk_voter=abc" },
    });
    expect(response.status).toBe(200);
    isPublicCatalogCache(response);
    const body = await response.json<Record<string, unknown>>();
    expect(JSON.stringify(body)).not.toContain("viewer_");
    expect(JSON.stringify(body)).not.toContain("admin");
  });

  it("caches relation lists with the guest voter marker", async () => {
    const response = await SELF.fetch(`${origin}/api/courses?view=relations&pageSize=1`, {
      headers: { Cookie: "jufexk_voter=abc" },
    });
    expect(response.status).toBe(200);
    isPublicCatalogCache(response);
    const body = await response.json<Record<string, unknown>>();
    expect(JSON.stringify(body)).not.toContain("viewer_");
  });

  it.each([
    "jufexk_voter=abc",
    "jufexk_user_session=abc",
    "jufexk_admin=abc",
    "jufexk_ehall_session=abc",
  ])("keeps course detail no-store with credential cookie %s", async (cookie) => {
    const response = await SELF.fetch(`${origin}/api/courses/1`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    isNotPublicCatalogCache(response);
  });

  it("publicly caches anonymous course reviews but not voter requests", async () => {
    const anonymous = await SELF.fetch(`${origin}/api/courses/1/reviews?teacherId=1&sort=recognized`);
    expect(anonymous.status).toBe(200);
    isScopedPublicCache(anonymous, PUBLIC_DETAIL_CACHE_CONTROL, PUBLIC_DETAIL_CACHE_TAG);
    const personalized = await SELF.fetch(`${origin}/api/courses/1/reviews?teacherId=1&sort=recognized`, {
      headers: { Cookie: "jufexk_voter=abc" },
    });
    expect(personalized.status).toBe(200);
    isNotPublicCatalogCache(personalized);
  });

  it("caches latest public reviews with the guest voter marker", async () => {
    const response = await SELF.fetch(`${origin}/api/reviews/latest?pageSize=1`, {
      headers: { Cookie: "jufexk_voter=abc" },
    });
    expect(response.status).toBe(200);
    isPublicCatalogCache(response);
    expect(JSON.stringify(await response.json())).not.toContain("viewer_");
  });

  it("caches latest public reviews with anonymous voter and csrf markers", async () => {
    const response = await SELF.fetch(`${origin}/api/reviews/latest?pageSize=1`, {
      headers: { Cookie: "jufexk_voter=abc; jufexk_user_csrf=csrf" },
    });
    expect(response.status).toBe(200);
    isPublicCatalogCache(response);
  });
});

describe("public catalog cache helpers", () => {
  it("keeps list s-maxage at 3600 and detail/config at 60", () => {
    expect(PUBLIC_CATALOG_CACHE_CONTROL).toBe(
      "public, max-age=0, s-maxage=3600, stale-while-revalidate=300",
    );
    expect(PUBLIC_DETAIL_CACHE_CONTROL).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
    );
    expect(PUBLIC_CONFIG_CACHE_CONTROL).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
    );
    expect(PUBLIC_CATALOG_STALE_CACHE_CONTROL).toBe("no-store");
  });

  it("sets the public catalog Cache-Control and Cache-Tag", () => {
    const headers = new Map<string, string>();
    setPublicCatalogCacheHeaders({
      header: (name, value) => headers.set(name, value),
    });
    expect(headers.get("Cache-Control")).toBe(PUBLIC_CATALOG_CACHE_CONTROL);
    expect(headers.get("Cache-Tag")).toBe(PUBLIC_CATALOG_CACHE_TAG);
  });

  it("does not share-cache a list response read from a dirty projection", () => {
    const headers = new Map<string, string>();
    setPublicCatalogCacheHeaders(
      { header: (name, value) => headers.set(name, value) },
      "list",
      true,
    );
    expect(headers.get("Cache-Control")).toBe(PUBLIC_CATALOG_STALE_CACHE_CONTROL);
    expect(headers.get("Cache-Tag")).toBe(PUBLIC_CATALOG_CACHE_TAG);
    setPublicCatalogCacheHeaders(
      { header: (name, value) => headers.set(name, value) },
      "detail",
      true,
    );
    expect(headers.get("Cache-Control")).toBe(PUBLIC_DETAIL_CACHE_CONTROL);
    expect(shouldPutPublicCatalogCache(10, true)).toBe(false);
    expect(shouldPutPublicCatalogCache(10, false)).toBe(true);
    expect(shouldPutPublicCatalogCache(2000, false)).toBe(false);
  });

  it("allows only the voter marker for anonymous course-list caching", () => {
    const request = (cookie?: string) => ({
      req: { header: (name: string) => name === "Cookie" ? cookie : undefined },
    });
    expect(isPublicCourseListCacheableRequest(request("jufexk_voter=abc"))).toBe(true);
    expect(isPublicCourseListCacheableRequest(request("jufexk_voter=abc; jufexk_user_session=abc"))).toBe(false);
  });

  it("purges the public-catalog tag when the runtime supports it", async () => {
    const purge = vi.fn().mockResolvedValue(undefined);
    await purgePublicCatalogCache({
      executionCtx: { cache: { purge } },
    });
    expect(purge).toHaveBeenCalledWith({ tags: [PUBLIC_CATALOG_CACHE_TAG] });
  });

  it("swallows purge failures so writes can still succeed", async () => {
    await expect(
      purgePublicCatalogCache({
        executionCtx: {
          cache: {
            purge: () => {
              throw new Error("cache purge unavailable");
            },
          },
        },
      }),
    ).resolves.toBeUndefined();
    await expect(purgePublicCatalogCache({})).resolves.toBeUndefined();
  });

  it("matches a URL-only Cache API key even if the browser sent cookies", async () => {
    const store = new Map<string, Response>();
    const cache = {
      match: async (request: RequestInfo | URL) =>
        store.get(new Request(request).url),
      put: async (request: RequestInfo | URL, response: Response) => {
        store.set(new Request(request).url, response);
      },
    };
    const url = "https://example.com/api/courses?view=relations&page=1";
    await putPublicCatalogCache(
      url,
      new Response('{"total":1}', {
        headers: { "Cache-Control": PUBLIC_CATALOG_CACHE_CONTROL },
      }),
      cache,
    );
    const hit = await matchPublicCatalogCache(url, cache);
    expect(await hit?.text()).toBe('{"total":1}');
    expect(shouldUsePublicCatalogCacheApi({ ORDINARY_USER_TEST_AUTH_SECRET: "x" })).toBe(
      false,
    );
    expect(shouldUsePublicCatalogCacheApi({})).toBe(true);
  });
});

describe("public list cache when the published projection is dirty", () => {
  const productionEnv = new Proxy(env, {
    get(target, property, receiver) {
      if (property === "ORDINARY_USER_TEST_AUTH_SECRET") return undefined;
      return Reflect.get(target, property, receiver);
    },
  });

  async function fetchList(url: string) {
    const tasks: Promise<unknown>[] = [];
    const response = await app.fetch(
      new Request(url),
      productionEnv,
      {
        waitUntil(promise: Promise<unknown>) {
          tasks.push(promise);
        },
        passThroughOnException() {},
      } as ExecutionContext,
    );
    return {
      response,
      done: () => Promise.all(tasks),
    };
  }

  async function deleteCached(url: string) {
    await (caches as CacheStorage & { default: Cache }).default.delete(
      publicCatalogCacheKey(url),
    );
  }

  it("stores a clean list response for s-maxage=3600 and skips a stale one", async () => {
    const freshUrl = `${origin}/api/courses?pageSize=1&q=issue915-fresh`;
    const staleUrl = `${origin}/api/courses?pageSize=1&q=issue915-stale`;
    await refreshPublicListPrecomputes(env.DB);
    try {
      const fresh = await fetchList(freshUrl);
      expect(fresh.response.status).toBe(200);
      expect(fresh.response.headers.get("Cache-Control")).toBe(
        PUBLIC_CATALOG_CACHE_CONTROL,
      );
      expect(fresh.response.headers.get("Cache-Tag")).toBe(PUBLIC_CATALOG_CACHE_TAG);
      await fresh.done();
      const stored = await matchPublicCatalogCache(freshUrl);
      expect(stored?.headers.get("Cache-Control")).toBe(PUBLIC_CATALOG_CACHE_CONTROL);
      expect(await stored?.json()).toEqual(await fresh.response.clone().json());

      await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1 AND published_generation>=0`,
      ).run();
      const stale = await fetchList(staleUrl);
      expect(stale.response.status).toBe(200);
      expect(stale.response.headers.get("Cache-Control")).toBe(
        PUBLIC_CATALOG_STALE_CACHE_CONTROL,
      );
      expect(stale.response.headers.get("Cache-Tag")).toBe(PUBLIC_CATALOG_CACHE_TAG);
      await stale.done();
      expect(await matchPublicCatalogCache(staleUrl)).toBeUndefined();
    } finally {
      await deleteCached(freshUrl);
      await deleteCached(staleUrl);
      await env.DB.prepare(
        `UPDATE public_precompute_state
         SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
         WHERE id=1`,
      ).run();
      await refreshPublicListPrecomputes(env.DB);
    }
  });
});
