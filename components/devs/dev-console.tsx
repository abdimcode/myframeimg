"use client";

import { useEffect, useRef, useState } from "react";
import { Trash2, Terminal, AlertCircle, Info, CheckCircle, Bug, Copy, ChevronRight } from "lucide-react";

import { useDevStore } from "./store/use-dev-store";

const LEVEL_ICON = {
  info: Info,
  warn: AlertCircle,
  error: AlertCircle,
  debug: Bug,
  success: CheckCircle,
};

// High-contrast level colors (readable on the elevated dark console bg).
const LEVEL_COLOR = {
  info: "text-sky-300",
  warn: "text-amber-300",
  error: "text-red-400",
  debug: "text-slate-300",
  success: "text-emerald-400",
};

function formatLogTime(atMs: number): string {
  const d = new Date(atMs);
  return (
    d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

/** Pretty-print a payload when it is valid JSON, otherwise return it verbatim. */
function prettyDetail(detail: string): string {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

/** Split "[RX] MAC topic · action" into colored parts (best-effort). */
function renderMessage(message: string, level: keyof typeof LEVEL_COLOR) {
  const m = message.match(/^\[(RX|TX)\]\s+(\S+)\s*(.*)$/);
  if (!m) {
    return <span className={LEVEL_COLOR[level] + " flex-1 break-all"}>{message}</span>;
  }
  const [, dir, mac, rest] = m;
  const badge = dir === "RX" ? "text-emerald-400" : "text-cyan-400";
  return (
    <span className="flex-1 break-all">
      <span className={badge + " font-bold"}>[{dir}]</span>{" "}
      <span className="text-amber-300 font-semibold">{mac}</span>
      {rest ? <span className="text-sky-300"> {rest}</span> : null}
    </span>
  );
}

function LogEntryRow({
  entry,
}: {
  entry: {
    id: string;
    timestamp: string;
    level: keyof typeof LEVEL_COLOR;
    message: string;
    detail?: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const Icon = LEVEL_ICON[entry.level];
  const payload = entry.detail ? prettyDetail(entry.detail) : "";

  const copyPayload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="px-1 py-0.5 hover:bg-white/5 rounded">
      <div className="flex items-start gap-2">
        <Icon size={12} className={LEVEL_COLOR[entry.level] + " mt-1 flex-shrink-0"} />
        <span className="text-slate-300 flex-shrink-0">{entry.timestamp}</span>
        {renderMessage(entry.message, entry.level)}
        {entry.detail && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 flex-shrink-0 px-2 py-0.5 rounded border border-[#4a3828] bg-[#26201b] text-amber-400 hover:bg-[#3a2d22] hover:border-amber-500/60 transition-colors text-[11px] font-semibold"
            title={open ? "Hide payload" : "Show payload"}
          >
            <ChevronRight
              size={12}
              className={"transition-transform " + (open ? "rotate-90" : "")}
            />
            Detail
          </button>
        )}
      </div>

      {open && entry.detail && (
        <div className="mt-2 mb-3 w-full box-border rounded-md border border-[#33271d] bg-[#11100f]">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#29201a]">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Payload JSON
            </span>
            <button
              type="button"
              onClick={copyPayload}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[#4a3828] bg-[#261f1a] text-slate-200 hover:bg-[#3a2d22] transition-colors text-[11px]"
              title="Copy this payload"
            >
              <Copy size={12} />
              <span>{copied ? "Copied!" : "Copy"}</span>
            </button>
          </div>
          <pre className="m-0 px-3.5 py-2.5 max-h-[240px] overflow-y-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-6 text-[#fef08a]">
            {payload}
          </pre>
        </div>
      )}
    </div>
  );
}

export function DevConsole() {
  const { consoleEntries, clearConsole, addConsoleEntry } = useDevStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleEntries]);

  useEffect(() => {
    const es = new EventSource("/api/devs/logs/stream");
    es.addEventListener("ready", () => {
      addConsoleEntry({
        id: `sse-ready-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        level: "debug",
        message: "● Live frame log stream connected",
      });
    });
    es.addEventListener("log", (ev) => {
      if (pausedRef.current) return;
      try {
        const entry = JSON.parse((ev as MessageEvent).data) as {
          id: string;
          atMs: number;
          direction: "rx" | "tx";
          mac: string;
          frameName: string | null;
          topic: string;
          action: string | null;
          payload: string;
        };
        addConsoleEntry({
          id: entry.id,
          timestamp: formatLogTime(entry.atMs),
          level: entry.direction === "rx" ? "success" : "info",
          message: `[${entry.direction.toUpperCase()}] ${entry.mac} ${entry.topic}${entry.action ? ` · ${entry.action}` : ""}`,
          detail: entry.payload,
        });
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => {
      addConsoleEntry({
        id: `sse-err-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        level: "warn",
        message: "○ Frame log stream reconnecting…",
      });
    };
    return () => es.close();
  }, [addConsoleEntry]);

  const copyLogs = async () => {
    const text = consoleEntries
      .map((e) => {
        const base = `${e.timestamp} ${e.message}`;
        return e.detail ? `${base}\n    ${e.detail}` : base;
      })
      .join("\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#131110] text-slate-100">
      <div className="flex items-center justify-between px-4 py-2 bg-[#1c1917] border-b border-[#3b2a1d] flex-shrink-0">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
          <Terminal size={14} className="text-emerald-400" />
          Console
          <span className="text-slate-400 font-normal">({consoleEntries.length})</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={copyLogs}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[#444] bg-[#222] text-slate-200 hover:bg-[#2e2a28] transition-colors text-[11px]"
            title="Copy all console logs"
          >
            <Copy size={13} />
            <span>{copied ? "Copied!" : "Copy"}</span>
          </button>
          <button
            type="button"
            onClick={clearConsole}
            className="p-1 hover:bg-[#2e2a28] rounded transition-colors text-slate-300 hover:text-white"
            title="Clear console"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 font-mono text-[13px] leading-6">
        {consoleEntries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs px-4 text-center">
            Execute an API or wait for live MQTT frame traffic
          </div>
        ) : (
          <div className="space-y-0.5">
            {consoleEntries.map((entry) => (
              <LogEntryRow key={entry.id} entry={entry} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  );
}
