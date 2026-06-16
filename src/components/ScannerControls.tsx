import { useEffect, useRef, useState } from "react";
import { FolderOpen, RefreshCw, ScanLine, Square } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Section } from "./Section";
import { cn } from "../lib/cn";
import {
  cancelScan,
  countAudioFiles,
  onScanProgress,
  saveReport,
  scanLibrary,
  type AudioCount,
  type ScanProgress,
  type ScanReport,
} from "../lib/tauri";
import { usePersistedBool } from "../lib/usePersistedString";

const EXPANDED_KEY = "afqc-tauri.scanner.expanded";

// Heuristic for the pre-scan ETA. cpu/2 workers each doing ~ffmpeg
// startup + decode ≈ 1–2 files/sec; tune by observation if it drifts
// from real-world scans.
const FILES_PER_SEC = 8;

type State =
  | { kind: "idle" }
  | { kind: "counting" }
  | { kind: "confirming"; count: AudioCount }
  | { kind: "scanning" };

interface ScannerControlsProps {
  root: string;
  setRoot: (s: string) => void;
  onReport: (r: ScanReport) => void;
  onStatus: (s: { text: string; tone: "muted" | "warn" | "ok" | "alert" }) => void;
  /**
   * Lifts the live scan state up so the shared OperationOutput strip
   * can render the progress. Called whenever progress/cancelling/active
   * change; idle state is `{ active: false, progress: null, cancelling: false }`.
   */
  onScanState?: (s: {
    active: boolean;
    progress: ScanProgress | null;
    cancelling: boolean;
  }) => void;
  /**
   * Last-loaded report so the Scanner can pin the "scan date · file
   * count" line (moved here from the App header).
   */
  report: ScanReport | null;
  /** Render bare (no Section card) — for the merged Source & Destination panel. */
  bare?: boolean;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60} min`;
}

export function ScannerControls({ root, setRoot, onReport, onStatus, onScanState, report, bare = false }: ScannerControlsProps) {
  const [expanded, setExpanded] = usePersistedBool(EXPANDED_KEY, true);
  const open = bare || expanded;
  const [state, setState] = useState<State>({ kind: "idle" });
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);
  // Mirrors `cancelling` for the async closure in startScan — state would
  // be stale across the awaited scanLibrary call.
  const cancelledRef = useRef(false);

  // Ctrl+R triggers the count step (matches the Tk app's shortcut).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "r") {
        e.preventDefault();
        requestScan();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, state.kind]);

  async function browse() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose music library root",
      defaultPath: root || undefined,
    });
    if (typeof picked === "string") setRoot(picked);
  }

  async function requestScan() {
    if (state.kind !== "idle" || !root.trim()) return;
    setState({ kind: "counting" });
    onStatus({ text: "counting files…", tone: "warn" });
    try {
      const count = await countAudioFiles(root.trim());
      if (count.fileCount === 0) {
        setState({ kind: "idle" });
        onStatus({ text: `no audio files under ${root.trim()}`, tone: "alert" });
        return;
      }
      setState({ kind: "confirming", count });
      onStatus({
        text: `${count.fileCount.toLocaleString()} files (${formatBytes(count.totalBytes)}) — confirm to scan`,
        tone: "muted",
      });
    } catch (e) {
      setState({ kind: "idle" });
      onStatus({ text: `count failed: ${e}`, tone: "alert" });
    }
  }

  async function startScan() {
    if (state.kind !== "confirming") return;
    setState({ kind: "scanning" });
    setProgress(null);
    setCancelling(false);
    cancelledRef.current = false;
    onStatus({ text: "starting scan…", tone: "warn" });

    try {
      const unlisten = await onScanProgress((p) => setProgress(p));
      unlistenRef.current = unlisten;
      const report = await scanLibrary(root.trim());
      onReport(report);
      await saveReport(report);
      if (cancelledRef.current) {
        onStatus({
          text: `scan cancelled · ${report.rows.length.toLocaleString()} files scanned`,
          tone: "warn",
        });
      } else {
        onStatus({
          text: `scan complete · ${report.rows.length.toLocaleString()} files`,
          tone: "ok",
        });
      }
    } catch (e) {
      onStatus({ text: `scan failed: ${e}`, tone: "alert" });
    } finally {
      setState({ kind: "idle" });
      setProgress(null);
      setCancelling(false);
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  }

  async function stopScan() {
    if (state.kind !== "scanning" || cancelledRef.current) return;
    cancelledRef.current = true;
    setCancelling(true);
    try {
      await cancelScan();
    } catch (e) {
      // Best-effort — the flag may already be set by the time this runs.
      console.warn("cancel_scan failed", e);
    }
    onStatus({ text: "cancelling… waiting for in-flight files", tone: "muted" });
  }

  function cancelConfirm() {
    setState({ kind: "idle" });
    onStatus({ text: "scan cancelled", tone: "muted" });
  }

  const scanning = state.kind === "scanning";
  const busy = state.kind !== "idle";

  // Emit live scan state to the shared output strip in the parent.
  useEffect(() => {
    onScanState?.({ active: scanning, progress, cancelling });
  }, [scanning, progress, cancelling, onScanState]);

  return (
    <Section
      title="Scanner"
      icon={<ScanLine size={16} />}
      onTitleClick={() => setExpanded(!expanded)}
      flat={bare}
    >
      {/* Pinned line — survives the collapse toggle so a glance at the
          card always answers "what was the last scan?" */}
      {report && (
        <div className="text-xs text-muted font-mono">
          scan: {report.generated.slice(0, 10)} ·{" "}
          {report.rows.length.toLocaleString()} files
        </div>
      )}
      {open && (
        <>
      <div className="flex gap-2">
        <input
          type="text"
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && requestScan()}
          placeholder="/path/to/music"
          disabled={busy}
          title={root}
          className="flex-1 min-w-0 px-3 py-2 rounded-md bg-surface text-fg
                     placeholder:text-muted outline-none border border-transparent
                     focus:border-accent/50 disabled:opacity-50"
          spellCheck={false}
        />
        <button
          onClick={browse}
          disabled={busy}
          className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                     text-fg disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center justify-center"
          title="Browse for folder"
          aria-label="Browse for folder"
        >
          <FolderOpen size={14} />
        </button>
        {scanning ? (
          <button
            onClick={stopScan}
            disabled={cancelling}
            className={cn(
              "px-3 py-2 rounded-md font-semibold",
              "flex items-center justify-center",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "bg-alert/15 text-alert hover:bg-alert hover:text-bg transition-colors",
            )}
            title={cancelling ? "cancelling…" : "Stop scan — in-flight files finish, no new ones start"}
            aria-label={cancelling ? "Cancelling scan" : "Stop scan"}
          >
            <Square size={14} className={cancelling ? "animate-pulse" : ""} />
          </button>
        ) : (
          <button
            onClick={requestScan}
            disabled={busy || !root.trim()}
            className={cn(
              "px-3 py-2 rounded-md font-semibold",
              "flex items-center justify-center",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "bg-accent text-bg hover:opacity-90",
            )}
            title={state.kind === "counting" ? "Counting files…" : "Re-scan (Ctrl+R)"}
            aria-label="Re-scan library"
          >
            <RefreshCw size={14} className={state.kind === "counting" ? "animate-spin" : ""} />
          </button>
        )}
      </div>

      {state.kind === "confirming" && (
        <div className="rounded-md bg-bg/50 px-3 py-2.5 space-y-2 text-xs">
          <div className="text-fg">
            <span className="font-semibold">{state.count.fileCount.toLocaleString()}</span> FLAC ·{" "}
            <span className="font-semibold">{formatBytes(state.count.totalBytes)}</span> ·
            est. <span className="font-semibold">~{formatEta(Math.ceil(state.count.fileCount / FILES_PER_SEC))}</span>
            <span className="text-muted"> ({FILES_PER_SEC} files/sec)</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={startScan}
              className="px-3 py-1.5 rounded-md bg-accent text-bg font-semibold hover:opacity-90 text-xs"
            >
              Start scan
            </button>
            <button
              onClick={cancelConfirm}
              className="px-3 py-1.5 rounded-md bg-surface hover:bg-surfaceHover text-fg text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

        </>
      )}
    </Section>
  );
}
