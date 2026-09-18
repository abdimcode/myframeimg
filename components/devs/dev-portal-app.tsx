"use client";

import { useEffect, useRef, useState } from "react";
import { Menu as MenuIcon, X, Sun, Moon, Monitor, Bug, BugOff, Terminal, Radio } from "lucide-react";

import { DevMenu } from "./dev-menu";
import { DevDescription } from "./dev-description";
import { DevApiPanel } from "./dev-api-panel";
import { DevConsole } from "./dev-console";
import { useThemeSync } from "./hooks/use-theme-sync";
import { useLiveBootstrap } from "./hooks/use-live-bootstrap";
import { useDevStore } from "./store/use-dev-store";
import { DevLiveSnapshot } from "./dev-live-snapshot";
import { DOC_VERSION } from "./const";
import type { DevsStatus } from "./types";

export function DevPortalApp() {
  const { theme, setTheme, debugMode, toggleDebug } = useDevStore();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [apiPanelOpen, setApiPanelOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [status, setStatus] = useState<DevsStatus | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const isLargeScreen = useRef(typeof window !== "undefined" ? window.innerWidth >= 1024 : true);

  useThemeSync(rootRef);
  useLiveBootstrap();

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    isLargeScreen.current = mq.matches;
    if (mq.matches) setApiPanelOpen(true);
    const handler = (e: MediaQueryListEvent) => {
      isLargeScreen.current = e.matches;
      setApiPanelOpen(e.matches);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    const load = () => {
      void fetch("/api/devs/status", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.ok) setStatus(data as DevsStatus);
        });
    };
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  const selectedApi = useDevStore((s) => s.selectedApi);
  useEffect(() => {
    if (selectedApi && !isLargeScreen.current) setApiPanelOpen(true);
  }, [selectedApi]);

  return (
    <div ref={rootRef} className="devs-portal h-screen overflow-hidden bg-background text-foreground flex flex-col">
      <header className="h-14 bg-card border-b border-border flex items-center px-4 flex-shrink-0 sticky top-0 z-40">
        <div className="flex items-center gap-1 sm:gap-3 flex-1 min-w-0">
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="lg:hidden p-2 hover:bg-secondary rounded-lg transition-colors flex-shrink-0"
            aria-label="Toggle sidebar"
          >
            {sidebarOpen ? <X size={20} /> : <MenuIcon size={20} />}
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 bg-gradient-to-br from-amber-400 to-orange-500 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
              MF
            </div>
            <span className="text-sm font-semibold truncate">MyFrame Dev</span>
            <span className="text-xs text-muted-foreground hidden lg:inline">v{DOC_VERSION}</span>
          </div>
          {status && (
            <div className="hidden md:flex items-center gap-3 ml-4 text-[11px] text-muted-foreground border-l border-border pl-4">
              <span className="flex items-center gap-1">
                <Radio size={12} className={status.mqtt?.connected ? "text-emerald-400" : "text-red-400"} />
                MQTT {status.mqtt?.connected ? "up" : "down"}
              </span>
              <span>{status.connectedClients ?? 0} online</span>
              <span>{status.registeredFrames ?? 0} frames</span>
              <span>{status.messagesPerMin ?? 0} msg/min</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 sm:gap-2 ml-auto flex-shrink-0">
          <button
            type="button"
            onClick={() => setApiPanelOpen(!apiPanelOpen)}
            className={`lg:hidden flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              apiPanelOpen ? "bg-primary/15 text-primary" : "text-foreground bg-secondary hover:bg-border"
            }`}
            aria-label="Toggle API panel"
          >
            <Terminal size={15} />
            API
          </button>
          <button
            type="button"
            onClick={toggleDebug}
            className={`p-2 rounded-lg transition-colors ${
              debugMode
                ? "bg-amber-500/15 text-amber-400 hover:bg-amber-500/25"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary"
            }`}
            aria-label="Toggle debug console"
            title={debugMode ? "Disable debug console" : "Enable debug console"}
          >
            {debugMode ? <Bug size={18} /> : <BugOff size={18} />}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setThemeMenuOpen((o) => !o)}
              className="p-2 hover:bg-secondary rounded-lg transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Theme"
            >
              {theme === "light" && <Sun size={18} />}
              {theme === "dark" && <Moon size={18} />}
              {theme === "system" && <Monitor size={18} />}
            </button>
            {themeMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" aria-hidden onClick={() => setThemeMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 py-1 w-36 bg-popover border border-border rounded-lg shadow-lg z-50">
                  {(["light", "dark", "system"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        setTheme(t);
                        setThemeMenuOpen(false);
                      }}
                      className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 ${
                        theme === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                      }`}
                    >
                      {t === "light" && <Sun size={16} />}
                      {t === "dark" && <Moon size={16} />}
                      {t === "system" && <Monitor size={16} />}
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden min-h-0">
        {sidebarOpen && <div className="fixed inset-0 bg-black/30 z-20 lg:hidden" onClick={() => setSidebarOpen(false)} />}
        <aside
          className={[
            "fixed lg:relative inset-y-0 left-0 z-30 top-14 lg:top-0",
            "w-64 lg:w-56 xl:w-64",
            "bg-card border-r border-border overflow-y-auto flex-shrink-0",
            "transition-transform duration-200 ease-in-out",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
            "lg:translate-x-0",
          ].join(" ")}
        >
          <DevMenu />
        </aside>

        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Upper dashboard (quick guide + live snapshot): confined to the top
              half and independently scrollable so the console below always
              keeps ~48vh. */}
          <div className="flex-1 min-h-0 overflow-y-auto max-h-[52vh]">
            <DevLiveSnapshot />
            <DevDescription />
          </div>
          {debugMode && (
            <div className="flex-shrink-0 h-[48vh] min-h-[320px] border-t-2 border-[#3b2a1d]">
              <DevConsole />
            </div>
          )}
        </div>

        {apiPanelOpen && <div className="fixed inset-0 bg-black/20 z-20 lg:hidden" onClick={() => setApiPanelOpen(false)} />}
        <aside
          className={[
            "fixed bottom-0 left-0 right-0 z-30 lg:static lg:top-auto",
            "max-h-[70vh] lg:max-h-none",
            "bg-card border-t lg:border-t-0 lg:border-l border-border",
            "overflow-y-auto flex-shrink-0",
            "rounded-t-2xl lg:rounded-none shadow-2xl lg:shadow-none",
            "transition-transform duration-200 ease-in-out",
            apiPanelOpen ? "translate-y-0" : "translate-y-full",
            "lg:translate-y-0",
            "lg:w-80 xl:w-96",
          ].join(" ")}
        >
          <div className="relative flex items-center justify-between px-4 py-3 border-b border-border lg:hidden">
            <div className="w-8 h-1 rounded-full bg-border mx-auto absolute left-1/2 -translate-x-1/2 top-2" />
            <span className="text-sm font-semibold">API Panel</span>
            <button type="button" onClick={() => setApiPanelOpen(false)} className="p-1 hover:bg-secondary rounded transition-colors">
              <X size={18} />
            </button>
          </div>
          <DevApiPanel />
        </aside>
      </div>
    </div>
  );
}
