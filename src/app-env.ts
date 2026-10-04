type RuntimeSecret = string | { get(): Promise<string> };
type TestableSecretBinding =
  | "IP_HASH_SECRET"
  | "TURNSTILE_SECRET"
  | "CAMPUS_IDENTITY_SECRET"
  | "CAS_CHALLENGE_SECRET"
  | "EHALL_SESSION_SECRET";

// Production bindings come from `wrangler types`; the overrides allow Miniflare
// tests to inject plain strings in place of Secrets Store bindings.
export type Bindings = Omit<
  Cloudflare.Env,
  TestableSecretBinding | "AI_SUMMARY_QUEUE"
> & {
  AI_SUMMARY_QUEUE?: { send(message: unknown): Promise<unknown> };
  IP_HASH_SECRET: RuntimeSecret;
  TURNSTILE_SECRET?: RuntimeSecret;
  ORDINARY_USER_TEST_AUTH_SECRET?: string;
  CAMPUS_IDENTITY_SECRET?: RuntimeSecret;
  MAIL_DELIVERY_URL?: string;
  MAIL_FROM?: string;
  MAIL_DELIVERY_TOKEN?: RuntimeSecret;
  REVIEW_AUTHOR_LOOKUP_TO?: RuntimeSecret;
  CAS_CHALLENGE_SECRET?: RuntimeSecret;
  EHALL_SESSION_SECRET?: RuntimeSecret;
  OPENAI_BASE_URL?: string;
  OPENAI_API_KEY?: RuntimeSecret;
  OPENAI_MODEL?: string;
  PUBLIC_SURFACE?: string;
  ALLOW_DEV_LOGIN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  BI_ANALYTICS_READ_TOKEN?: RuntimeSecret;
  BI?: { writeDataPoint(event: AnalyticsEngineDataPoint): void };
};
export type Vars = {
  adminSession?: string;
  adminSessionId?: string;
  adminCsrf?: string;
  adminSource?: "student";
  publicCatalogCacheChanged?: boolean;
  publicCatalogCacheScopes?: Array<"list" | "detail" | "config">;
  /** This read returned the previous published projection while a refresh runs. */
  publicCatalogProjectionStale?: boolean;
  serverTiming?: Record<string, number>;
};

export type AppEnv = { Bindings: Bindings; Variables: Vars };
