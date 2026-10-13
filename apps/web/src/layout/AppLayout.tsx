// Adapted from mishkatik/infra-billing AppLayout.tsx and SidebarParts.tsx.
import { version } from "../../../../package.json";
import { useState, useRef, type ReactNode, type RefObject } from "react";
import {
  IconLayoutSidebar,
  IconSearch,
  IconSun,
  IconMoon,
  IconLock,
  IconLogout,
} from "@tabler/icons-react";
import { RwpPromo } from "../components/rwp-promo";
import { Brand } from "../components/brand";
import { NavigationDrawer } from "../components/navigation-drawer";
import { Button } from "../components/ui/button";
import { PageChromeProvider, usePageChrome } from "./pageChrome";
import { cn } from "../lib/utils";

export function NavItem({
  active,
  icon,
  label,
  ariaLabel,
  count,
  onClick,
}: {
  active?: boolean;
  icon: ReactNode;
  label: string;
  ariaLabel?: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-active={active}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "nav-item h-8 gap-2.5 rounded-lg px-2.5 text-sm text-foreground hover:bg-background hover:text-foreground focus-visible:bg-background focus-visible:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-slate",
      )}
    >
      {icon}
      <span>{label}</span>
      {count != null && <small>{count}</small>}
    </button>
  );
}
export function NavGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="nav-section">
      <div className="h-7 px-2 text-[13px] font-normal text-ink-2">{title}</div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}
function HeaderBar({
  vaultName,
  openNav,
  controls,
}: {
  vaultName: string;
  openNav: ReactNode;
  controls: ReactNode;
}) {
  const { setTitle, setControls, setActions } = usePageChrome();
  return (
    <header className="topbar sticky top-0 z-20 flex min-h-16 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 bg-background px-4 py-3 sm:px-8 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {openNav}
        <Brand compact className="mobile-brand" />
        <nav
          aria-label="Текущий раздел"
          className="flex min-w-0 items-center gap-2 text-sm"
        >
          <span className="hidden truncate text-ink-2 sm:inline">
            {vaultName}
          </span>
          <span aria-hidden className="hidden text-ink-3 sm:inline">
            /
          </span>
          <span ref={setTitle} className="flex min-w-0" />
        </nav>
      </div>
      <div
        ref={setControls}
        className="order-last flex basis-full items-center overflow-x-auto empty:hidden lg:order-none lg:col-start-2 lg:basis-auto"
      />
      <div className="flex shrink-0 items-center gap-1.5 lg:col-start-3 lg:justify-self-end">
        {controls}
        <div
          ref={setActions}
          className="flex items-center gap-1.5 empty:hidden"
        />
      </div>
    </header>
  );
}
export function AppLayout({
  children,
  navigation,
  vaultName,
  displayName,
  role,
  theme,
  onTheme,
  onLock,
  onLogout,
  logoutDisabled,
  onOpenSearch,
}: {
  children: ReactNode;
  navigation: (close: () => void) => ReactNode;
  vaultName: string;
  displayName: string;
  role: string;
  theme: string;
  onTheme: () => void;
  onLock: () => void;
  onLogout: () => void;
  logoutDisabled: boolean;
  onOpenSearch: () => void;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <PageChromeProvider>
      <div className="app-shell">
        <NavigationDrawer
          open={navOpen}
          onOpenChange={setNavOpen}
          trigger={trigger}
        >
          <div className="sidebar-header">
            <div className="flex items-center justify-between gap-2">
              <Brand />
              <span className="text-xs text-ink-2">v{version}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setNavOpen(false);
                onOpenSearch();
              }}
              className="sidebar-search flex h-8 w-full items-center gap-2 rounded-md bg-background px-2.5 text-left text-[13px] text-ink-2 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <IconSearch
                aria-hidden
                stroke={1.5}
                className="size-4 shrink-0"
              />
              <span className="flex-1 truncate">Поиск…</span>
              <kbd>Ctrl K</kbd>
            </button>
          </div>
          <nav className="sidebar-content" aria-label="Навигация хранилища">
            {navigation(() => setNavOpen(false))}
          </nav>
          <div className="sidebar-footer">
            <RwpPromo />
            <div className="flex items-center gap-1 border-t border-hairline pt-4">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
                onClick={onTheme}
              >
                {theme === "dark" ? (
                  <IconSun stroke={1.5} />
                ) : (
                  <IconMoon stroke={1.5} />
                )}
              </Button>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                aria-label="Заблокировать"
                onClick={onLock}
              >
                <IconLock stroke={1.5} />
                <span>Заблокировать</span>
              </Button>
            </div>
            <div className="user-menu flex items-center justify-between gap-2 px-1">
              <div className="flex min-w-0 items-center gap-3">
                <span aria-hidden className="avatar">
                  {displayName.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0 leading-tight">
                  <p className="truncate text-sm">{displayName}</p>
                  <p className="truncate text-xs text-ink-2">
                    {role === "owner" ? "Владелец" : "Администратор"}
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Выйти из аккаунта"
                disabled={logoutDisabled}
                onClick={onLogout}
              >
                <IconLogout stroke={1.5} />
              </Button>
            </div>
          </div>
        </NavigationDrawer>
        <main className="main-area">
          <HeaderBar
            vaultName={vaultName}
            controls={
              <>
                <Button
                  className="mobile-header-control"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
                  onClick={onTheme}
                >
                  {theme === "dark" ? (
                    <IconSun stroke={1.5} />
                  ) : (
                    <IconMoon stroke={1.5} />
                  )}
                </Button>
                <Button
                  className="mobile-header-control"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Заблокировать"
                  onClick={onLock}
                >
                  <IconLock stroke={1.5} />
                </Button>
              </>
            }
            openNav={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Открыть навигацию"
                aria-expanded={navOpen}
                aria-controls="vault-navigation"
                ref={trigger}
                className="mobile-menu -ml-1"
                onClick={() => setNavOpen(!navOpen)}
              >
                <IconLayoutSidebar stroke={1.5} />
              </Button>
            }
          />
          <div className="page-content flex-1 px-4 pt-2 pb-8 sm:px-8">
            {children}
          </div>
        </main>
      </div>
    </PageChromeProvider>
  );
}
