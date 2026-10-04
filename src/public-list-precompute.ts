import { rebuildPublicListProjection } from "./public-list-projection-plan";

const publicListMutationRoutes: ReadonlyArray<readonly [string, RegExp]> = [
  ["POST", /^\/api\/admin\/catalog-relation-additions$/],
  ["POST", /^\/api\/admin\/import\/relations$/],
  ["POST", /^\/api\/admin\/import\/course-plan-attributes$/],
  ["POST", /^\/api\/admin\/historical-review-v5-imports$/],
  ["POST", /^\/api\/admin\/offerings$/],
  ["DELETE", /^\/api\/admin\/offerings\/[^/]+$/],
  ["POST", /^\/api\/admin\/courses$/],
  ["DELETE", /^\/api\/admin\/courses\/[^/]+$/],
  ["POST", /^\/api\/admin\/teachers$/],
  ["POST", /^\/api\/admin\/cta-sync$/],
  ["DELETE", /^\/api\/admin\/teachers\/[^/]+$/],
  ["PUT", /^\/api\/admin\/courses\/[^/]+\/teachers$/],
  ["POST", /^\/api\/admin\/catalog-baseline\/uploads\/[^/]+\/publish$/],
  ["POST", /^\/api\/admin\/pe-specialization-queue\/dispositions$/],
  ["PATCH", /^\/api\/admin\/pe-specialization-queue\/dispositions$/],
  ["POST", /^\/api\/admin\/pe-specialization-queue\/closeout$/],
];

export function shouldRefreshPublicListPrecomputes(method: string, path: string) {
  const normalizedMethod = method.toUpperCase();
  return publicListMutationRoutes.some(
    ([routeMethod, routePath]) =>
      normalizedMethod === routeMethod && routePath.test(path),
  );
}

const REFRESH_ATTEMPTS = 2;
const REFRESH_ACQUIRE_ATTEMPTS = 5;
const REFRESH_LEASE_SECONDS = 60;
const REFRESH_LEASE_POLL_MS = 100;
export const PUBLIC_PROJECTION_MAX_STALE_SECONDS = 300;
const publicPrecomputeRefreshes = new WeakMap<D1Database, Promise<void>>();

class PublicPrecomputeLeaseLostError extends Error {}

type PublicPrecomputeState = {
  dirty: number;
  generation: number;
  published_generation: number;
  published_at: number;
  refresh_token: string | null;
  refresh_lease_until: number | null;
};

const publicPrecomputeState = (db: D1Database) =>
  db
    .prepare(
      `SELECT dirty,generation,published_generation,published_at,
         refresh_token,refresh_lease_until
       FROM public_precompute_state WHERE id=1`,
    )
    .first<PublicPrecomputeState>();

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitForPublicPrecomputeLease(db: D1Database) {
  while (true) {
    const state = await publicPrecomputeState(db);
    if (!state?.dirty) return "clean" as const;
    if (
      !state.refresh_token ||
      (state.refresh_lease_until ?? 0) <= Math.floor(Date.now() / 1000)
    )
      return "retry" as const;
    await pause(REFRESH_LEASE_POLL_MS);
  }
}

async function renewPublicPrecomputeLease(
  db: D1Database,
  generation: number,
  token: string,
) {
  const renewed = await db
    .prepare(
      `UPDATE public_precompute_state
       SET refresh_lease_until=unixepoch()+?
       WHERE id=1
         AND dirty=1
         AND generation=?
         AND refresh_token=?
         AND refresh_lease_until>unixepoch()
       RETURNING id`,
    )
    .bind(REFRESH_LEASE_SECONDS, generation, token)
    .run();
  if (!renewed.results.length)
    throw new PublicPrecomputeLeaseLostError("公开目录预计算刷新租约已失效");
}

async function acquirePublicPrecomputeLease(db: D1Database) {
  for (let attempt = 0; attempt < REFRESH_ACQUIRE_ATTEMPTS; attempt += 1) {
    const token = crypto.randomUUID();
    const acquired = await db
      .prepare(
        `UPDATE public_precompute_state
         SET refresh_token=?,refresh_lease_until=unixepoch()+?
         WHERE id=1
           AND dirty=1
           AND (
             refresh_token IS NULL OR
             refresh_lease_until IS NULL OR
             refresh_lease_until<=unixepoch()
           )
         RETURNING generation`,
      )
      .bind(token, REFRESH_LEASE_SECONDS)
      .run<{ generation: number }>();
    const lease = acquired.results[0];
    if (lease)
      return { generation: Number(lease.generation) || 0, token } as const;

    const outcome = await waitForPublicPrecomputeLease(db);
    if (outcome === "clean") return null;
  }
  throw new Error("公开目录预计算刷新租约获取失败");
}

async function refreshPublicListPrecomputesAttempt(
  db: D1Database,
  attempt: number,
): Promise<void> {
  let state = await publicPrecomputeState(db);
  if (!state) {
    await db
      .prepare(
        `INSERT INTO public_precompute_state(id,dirty,generation)
         VALUES(1,1,0) ON CONFLICT(id) DO NOTHING`,
      )
      .run();
    state = await publicPrecomputeState(db);
  }
  if (!state?.dirty) return;

  const lease = await acquirePublicPrecomputeLease(db);
  if (!lease) return;
  const { generation, token } = lease;
  try {
    await rebuildPublicListProjection({
      db,
      generation,
      token,
      renewLease: () => renewPublicPrecomputeLease(db, generation, token),
    });
    const published = await db
      .prepare(
        `UPDATE public_precompute_state
         SET dirty=0,
             published_generation=?,
             published_at=unixepoch(),
             refresh_token=NULL,
             refresh_lease_until=NULL
         WHERE id=1
           AND dirty=1
           AND generation=?
           AND refresh_token=?
           AND refresh_lease_until>unixepoch()
         RETURNING id`,
      )
      .bind(generation, generation, token)
      .run();
    if (published.results.length) return;

    const current = await publicPrecomputeState(db);
    if (!current?.dirty) return;
    if (current.refresh_token && current.refresh_token !== token) {
      const outcome = await waitForPublicPrecomputeLease(db);
      if (outcome === "clean") return;
    }
    if (attempt + 1 >= REFRESH_ATTEMPTS)
      throw new Error("公开目录源数据在刷新期间持续变化或刷新租约失效");
    return refreshPublicListPrecomputesAttempt(db, attempt + 1);
  } catch (error) {
    try {
      await db
        .prepare(
          `UPDATE public_precompute_state
           SET dirty=1,refresh_token=NULL,refresh_lease_until=NULL
           WHERE id=1 AND generation=? AND refresh_token=?`,
        )
        .bind(generation, token)
        .run();
    } catch {
      // Preserve the refresh failure; a later dirty read will retry the rebuild.
    }
    if (error instanceof PublicPrecomputeLeaseLostError) {
      const current = await publicPrecomputeState(db);
      if (!current?.dirty) return;
      if (current.refresh_token && current.refresh_token !== token) {
        const outcome = await waitForPublicPrecomputeLease(db);
        if (outcome === "clean") return;
      }
      if (attempt + 1 < REFRESH_ATTEMPTS)
        return refreshPublicListPrecomputesAttempt(db, attempt + 1);
    }
    throw error;
  }
}

export function isMissingPublicSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (table|column|index)|no query solution/i.test(message);
}

/** True once migration 0061's teacher review projection has been published. */
export async function ensureTeacherReviewCountProjection(
  db: D1Database,
): Promise<boolean> {
  let ready = 0;
  try {
    const row = await db
      .prepare(
        `SELECT teacher_review_counts_ready ready
         FROM public_precompute_state WHERE id=1`,
      )
      .first<{ ready: number }>();
    if (!row) return false;
    ready = Number(row.ready) || 0;
  } catch (error) {
    if (isMissingPublicSchemaError(error)) return false;
    throw error;
  }
  if (ready === 1) return true;
  try {
    await db
      .prepare(
        `UPDATE public_precompute_state
         SET dirty=1
         WHERE id=1 AND teacher_review_counts_ready=0`,
      )
      .run();
    await refreshPublicListPrecomputes(db);
  } catch (error) {
    if (isMissingPublicSchemaError(error)) return false;
    throw error;
  }
  try {
    const row = await db
      .prepare(
        `SELECT teacher_review_counts_ready ready
         FROM public_precompute_state WHERE id=1`,
      )
      .first<{ ready: number }>();
    return Number(row?.ready) === 1;
  } catch (error) {
    if (isMissingPublicSchemaError(error)) return false;
    throw error;
  }
}

export async function refreshPublicListPrecomputes(db: D1Database) {
  const existing = publicPrecomputeRefreshes.get(db);
  if (existing) return existing;

  const refresh = refreshPublicListPrecomputesAttempt(db, 0);
  publicPrecomputeRefreshes.set(db, refresh);
  try {
    await refresh;
  } finally {
    if (publicPrecomputeRefreshes.get(db) === refresh)
      publicPrecomputeRefreshes.delete(db);
  }
}

export type PublicPrecomputeReadMode = "blocking" | "stale";

export type PublicPrecomputeReadOptions = {
  mode?: PublicPrecomputeReadMode;
  waitUntil?: (promise: Promise<void>) => void;
  recordTiming?: (name: string, durationMs: number) => void;
  /** Called only when this read returns the previous published projection. */
  onStaleProjection?: () => void;
};

function schedulePublicPrecomputeRefresh(
  db: D1Database,
  waitUntil?: (promise: Promise<void>) => void,
) {
  const refresh = refreshPublicListPrecomputes(db).catch((error) => {
    console.error(
      JSON.stringify({
        event: "public_precompute_refresh_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  });
  if (waitUntil) {
    waitUntil(refresh);
    return;
  }
  return refresh;
}

export async function ensurePublicListPrecomputes(
  db: D1Database,
  options: PublicPrecomputeReadOptions = {},
) {
  const started = performance.now();
  try {
    const state = await db
      .prepare("SELECT dirty FROM public_precompute_state WHERE id=1")
      .first<{ dirty: number }>();
    if (!state) return refreshPublicListPrecomputes(db);
    if (!state.dirty) return;
    if (options.mode === "stale") {
      const published = await db
        .prepare(
          `SELECT published_generation,published_at
           FROM public_precompute_state WHERE id=1`,
        )
        .first<{ published_generation: number; published_at: number }>();
      const age = Math.floor(Date.now() / 1000) - Number(published?.published_at || 0);
      if (
        Number(published?.published_generation) >= 0 &&
        age >= 0 &&
        age <= PUBLIC_PROJECTION_MAX_STALE_SECONDS
      ) {
        const scheduled = schedulePublicPrecomputeRefresh(db, options.waitUntil);
        if (scheduled) {
          await scheduled;
          return;
        }
        options.onStaleProjection?.();
        return;
      }
    }
    await refreshPublicListPrecomputes(db);
  } finally {
    options.recordTiming?.("precompute", performance.now() - started);
  }
}
