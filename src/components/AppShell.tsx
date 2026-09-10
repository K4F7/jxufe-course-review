import { buttonVariants, Link } from "@heroui/react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import {
  NavLink,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useViewer } from "../hooks/useViewer";
import type { SiteConfig } from "../lib/types";
import type { SiteBanner as SiteBannerValue } from "../site-banner";
import { SiteBanner } from "./SiteBanner";
import { SiteFooter } from "./SiteFooter";
import { DeferredShellCourseSearch } from "./DeferredShellCourseSearch";
import { ThemeToggle } from "./ThemeToggle";

const AccountNavControlLazy = lazy(() =>
  import("./AccountNavControl").then((m) => ({ default: m.AccountNavControl })),
);

function loadDeferredHeroUiStyles(pathname: string) {
  if (pathname === "/" || pathname === "/latest") return;
  void import("../styles/heroui-deferred.css").catch(() => undefined);
}

// Direct visits to non-latest routes should begin loading their component
// styles before React commits the first frame; route transitions use the same
// loader from DefaultShell below.
if (typeof window !== "undefined") {
  loadDeferredHeroUiStyles(window.location.pathname);
}

/**
 * Production shell — USTC 评课社区对齐（Issue #402）：
 * 桌面 xl+：左簇品牌 + Button 课评/课程/导师 · 居中搜索 · 右账号。
 * 窄屏：品牌+账号 / 整行搜索 / 等宽 Tabs（课评/课程；导师外链未适配移动端，不挂）。
 * /profile /account /submit 窄屏不挂浏览 Tabs（个人面，不是逛目录）；品牌仍回 /latest。
 * 排课模拟只在 API `showScheduleNav` 为真时出现。写评价只从课程页「写点评」进入。
 */

const PI_REVIEW_URL = "https://pi-review.com/universities/661";

/** DEV-only: live shell-nav prototype shell (dynamic so production never ships it). */
const PrototypeShellLazy = import.meta.env.DEV
  ? lazy(() =>
      import("../prototype/ShellNavVariants").then((m) => ({
        default: m.PrototypeShell,
      })),
    )
  : null;

/** DEV-only: global-search A/B/C compare (issue #303; not production). */
const GlobalSearchPrototypeLazy = import.meta.env.DEV
  ? lazy(() =>
      import("../prototype/GlobalSearchVariants").then((m) => ({
        default: m.GlobalSearchPrototype,
      })),
    )
  : null;

function useShellNavPrototypeVariant(): "A" | "B" | "C" | null {
  const [params] = useSearchParams();
  return useMemo(() => {
    if (!import.meta.env.DEV) return null;
    if (params.get("module") !== "shell-nav") return null;
    const key = (params.get("variant") || "C").toUpperCase();
    if (key === "A" || key === "B" || key === "C") return key;
    return "C";
  }, [params]);
}

function useGlobalSearchPrototypeVariant(): "A" | "B" | "C" | null {
  const [params] = useSearchParams();
  return useMemo(() => {
    if (!import.meta.env.DEV) return null;
    if (params.get("module") !== "global-search") return null;
    const key = (params.get("variant") || "A").toUpperCase();
    if (key === "A" || key === "B" || key === "C") return key;
    return "A";
  }, [params]);
}

function SkipToMain() {
  return (
    <a
      className="skip-link"
      href="#main-content"
      onClick={(event) => {
        const main = document.getElementById("main-content");
        if (!main) return;
        event.preventDefault();
        main.focus();
      }}
    >
      跳到主内容
    </a>
  );
}

function navSelectedKey(pathname: string): string {
  if (pathname === "/" || pathname === "/latest") return "latest";
  if (pathname === "/schedule" || pathname.startsWith("/schedule/")) {
    return "schedule";
  }
  return "courses";
}

/** Logged-in “me” surfaces: hide 课评/课程 Tabs in the narrow header only. */
function isMeAccountSurface(pathname: string): boolean {
  return (
    pathname === "/profile" ||
    pathname === "/account" ||
    pathname === "/submit"
  );
}

type ShellNavLink = { id: string; to: string; label: string };

function brandClassName(extra = "") {
  return `${buttonVariants({
    size: "sm",
    variant: "ghost",
  })} min-w-0 truncate no-underline ${extra}`.trim();
}

function ShellBrand({ to, siteName, className = "" }: { to: string; siteName: string; className?: string }) {
  return (
    <Link
      className={brandClassName(className)}
      href={to}
      render={(domProps) => (
        <NavLink
          {...(domProps as object)}
          className={
            typeof domProps.className === "string"
              ? domProps.className
              : undefined
          }
          to={to}
        />
      )}
    >
      <span className="min-w-0 truncate">{siteName}</span>
    </Link>
  );
}

function DesktopNavLinks({
  links,
  selectedKey,
  params,
}: {
  links: ShellNavLink[];
  selectedKey: string;
  params: URLSearchParams;
}) {
  return (
    <>
      {links.map((link) => {
        const active = selectedKey === link.id;
        const to = import.meta.env.DEV
          ? withGlobalSearchParams(link.to, params)
          : link.to;
        return (
          <Link
            key={link.id}
            className={`${buttonVariants({
              size: "sm",
              variant: active ? "secondary" : "ghost",
            })} no-underline`}
            href={to}
            render={(domProps) => (
              <NavLink
                {...(domProps as object)}
                className={
                  typeof domProps.className === "string"
                    ? domProps.className
                    : undefined
                }
                to={to}
              />
            )}
          >
            {link.label}
          </Link>
        );
      })}
      <a
        aria-label="导师（新窗口打开）"
        className={buttonVariants({ size: "sm", variant: "ghost" })}
        href={PI_REVIEW_URL}
        target="_blank"
        rel="noreferrer"
      >
        导师
      </a>
    </>
  );
}

/** Narrow-screen primary nav: official equal-width Links.
 * 导师外链未适配移动端，只在桌面 `DesktopNavLinks` 保留。 */
function MobilePrimaryNav({
  links,
  selectedKey,
  params,
}: {
  links: ShellNavLink[];
  selectedKey: string;
  params: URLSearchParams;
}) {
  return (
    <nav aria-label="主导航" className="shell-mobile-nav flex w-full min-w-0">
      {links.map((link) => {
        const active = selectedKey === link.id;
        const to = import.meta.env.DEV
          ? withGlobalSearchParams(link.to, params)
          : link.to;
        return (
          <Link
            key={link.id}
            aria-current={active ? "page" : undefined}
            className={`${buttonVariants({
              size: "sm",
              variant: active ? "secondary" : "ghost",
            })} min-w-0 flex-1 justify-center no-underline`}
            href={to}
            render={(domProps) => (
              <NavLink
                {...(domProps as object)}
                className={
                  typeof domProps.className === "string"
                    ? `${domProps.className} min-w-0 flex-1 justify-center`
                    : "min-w-0 flex-1 justify-center"
                }
                to={to}
              />
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

function GuestLoginLink({
  from,
  loginPath = "/login",
}: {
  from: string;
  loginPath?: string;
}) {
  return (
    <a
      className={`${buttonVariants({ size: "sm", variant: "ghost" })} min-w-12 justify-center no-underline`}
      href={`${loginPath}?from=${encodeURIComponent(from)}`}
    >
      登录
    </a>
  );
}

function ShellAccountControl() {
  const { viewer } = useViewer();
  const location = useLocation();
  const [params] = useSearchParams();
  const from = `${location.pathname}${location.search}`;
  const login = (
    <GuestLoginLink from={from} loginPath={viewer.loginPath} />
  );
  const previewAccount =
    import.meta.env.DEV &&
    params.get("as") !== "guest" &&
    (params.has("preview") ||
      params.get("as") === "user" ||
      params.get("as") === "admin");

  // Production guests get the login link on first paint. The account menu
  // chunk stays lazy so /latest does not pay Dropdown/Dialog cost. DEV
  // preview=filled still mounts AccountNavControl for the notice mocks.
  if (!viewer.authenticated && !previewAccount) return login;

  return <Suspense fallback={login}><AccountNavControlLazy /></Suspense>;
}

function DefaultShell({
  banner,
  bannerLoading,
  config,
  children,
}: {
  banner: SiteBannerValue | null;
  bannerLoading: boolean;
  config: SiteConfig | null;
  children: ReactNode;
}) {
  const location = useLocation();
  const [params] = useSearchParams();

  // Start deferred HeroUI styles before this render commits on route changes.
  // The import is cached, so repeated renders are effectively free.
  loadDeferredHeroUiStyles(location.pathname);

  useEffect(() => {
    loadDeferredHeroUiStyles(location.pathname);
  }, [location.pathname]);

  const isXl = useMediaQuery("(min-width: 80rem)");
  const selectedKey = navSelectedKey(location.pathname);
  const showMobileBrowseTabs = !isMeAccountSurface(location.pathname);
  const globalSearchVariant = useGlobalSearchPrototypeVariant();
  const siteName = config?.siteName || "非官方课评@JUFE";
  const universityName = config?.universityName || "江西财经大学";
  const brandTo = import.meta.env.DEV
    ? withGlobalSearchParams("/latest", params)
    : "/latest";
  const showGlobalSearch =
    Boolean(globalSearchVariant) && Boolean(GlobalSearchPrototypeLazy);

  const showScheduleNav = config?.showScheduleNav === true;
  const links = [
    { id: "latest", to: "/latest", label: "课评" },
    { id: "courses", to: "/courses", label: "课程" },
    ...(showScheduleNav
      ? [{ id: "schedule", to: "/schedule", label: "排课模拟" }]
      : []),
  ];

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-clip">
      <SkipToMain />
      <header className="sticky top-0 z-20 bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-[1520px] px-3 py-2 sm:px-5 xl:px-4 xl:py-2.5">
          {/* 只挂一套顶栏，避免窄屏/桌面各一份账号与搜索进无障碍树。 */}
          {!isXl ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <ShellBrand
                className="max-w-[min(11rem,calc(100%-7rem))]"
                siteName={siteName}
                to={brandTo}
              />
              <div className="flex shrink-0 items-center gap-1">
                <ShellAccountControl />
                <ThemeToggle />
              </div>
            </div>
            <div className="min-w-0">
              {showGlobalSearch &&
              globalSearchVariant &&
              GlobalSearchPrototypeLazy ? (
                <Suspense fallback={null}>
                  <GlobalSearchPrototypeLazy
                    slot="shell"
                    variant={globalSearchVariant}
                  />
                </Suspense>
              ) : (
                <DeferredShellCourseSearch />
              )}
            </div>
            {showMobileBrowseTabs ? (
              <MobilePrimaryNav
                links={links}
                params={params}
                selectedKey={selectedKey}
              />
            ) : null}
          </div>
          ) : (
          <div className="grid grid-cols-[minmax(min-content,1fr)_minmax(12rem,28rem)_minmax(0,1fr)] items-center gap-x-4">
            <div className="flex items-center gap-2">
              <ShellBrand siteName={siteName} to={brandTo} />
              <nav
                aria-label="主导航"
                className="flex min-w-min flex-nowrap items-center gap-1"
              >
                <DesktopNavLinks
                  links={links}
                  params={params}
                  selectedKey={selectedKey}
                />
              </nav>
            </div>
            <div className="min-w-0">
              {showGlobalSearch &&
              globalSearchVariant &&
              GlobalSearchPrototypeLazy ? (
                <Suspense fallback={null}>
                  <GlobalSearchPrototypeLazy
                    slot="shell"
                    variant={globalSearchVariant}
                  />
                </Suspense>
              ) : (
                <DeferredShellCourseSearch />
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              <ShellAccountControl />
              <ThemeToggle />
            </div>
          </div>
          )}
        </div>
      </header>

      <SiteBanner banner={banner} loading={bannerLoading} />

      <main
        className="mx-auto flex w-full max-w-[1520px] flex-1 flex-col px-4 pb-4 pt-8 sm:px-5 sm:pb-16 xl:px-4"
        id="main-content"
        tabIndex={-1}
      >
        {showGlobalSearch &&
        globalSearchVariant &&
        GlobalSearchPrototypeLazy ? (
          <Suspense fallback={null}>
            <GlobalSearchPrototypeLazy
              slot="note"
              variant={globalSearchVariant}
            />
          </Suspense>
        ) : null}
        {children}
      </main>

      {location.pathname === "/latest" || location.pathname === "/" ? null : (
        <SiteFooter siteName={siteName} universityName={universityName} />
      )}
    </div>
  );
}

function withGlobalSearchParams(path: string, params: URLSearchParams) {
  if (params.get("module") !== "global-search") return path;
  const sp = new URLSearchParams();
  sp.set("module", "global-search");
  const variant = params.get("variant");
  if (variant) sp.set("variant", variant);
  return `${path}?${sp.toString()}`;
}

export function AppShell({
  banner,
  bannerLoading = false,
  config,
  children,
}: {
  banner: SiteBannerValue | null;
  bannerLoading?: boolean;
  config: SiteConfig | null;
  children: React.ReactNode;
}) {
  const prototypeVariant = useShellNavPrototypeVariant();

  if (prototypeVariant && PrototypeShellLazy) {
    return (
      <Suspense fallback={<DefaultShell banner={banner} bannerLoading={bannerLoading} config={config}>{children}</DefaultShell>}>
        <PrototypeShellLazy variant={prototypeVariant} config={config}>
          {children}
        </PrototypeShellLazy>
      </Suspense>
    );
  }

  return <DefaultShell banner={banner} bannerLoading={bannerLoading} config={config}>{children}</DefaultShell>;
}
