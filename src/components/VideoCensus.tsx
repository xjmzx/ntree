import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2, RefreshCw, Wand2 } from "lucide-react";
import { cn } from "../lib/cn";
import {
  cancelNormalize,
  classifyVideos,
  normalizeVideos,
  onNormalizeProgress,
  type NormalizeProgress,
  type NormalizeReport,
  type VideoBucket,
  type VideoRow,
} from "../lib/tauri";

const BACKUP_KEY = "afqc-tauri.video.backup";
const NEEDS_WORK: VideoBucket[] = ["remux", "audioFix", "transcode"];

/** Suggested backup folder: a sibling of the library root, outside it —
 *  /data/music → /data/music_mv_backups, /home/john/Music → …/Music_mv_backups. */
const defaultBackup = (root: string) =>
  root ? root.replace(/\/+$/, "") + "_mv_backups" : "";

// Part A of the Normalize-videos plan: a read-only census of the library's
// video files, bucketed by what they'd need to become playable mp4 (h264/aac
// faststart). Nothing is modified here — this is "see what you have first".

const BUCKET: Record<
  VideoBucket,
  { label: string; text: string; dot: string; note: string }
> = {
  plays: {
    label: "plays as-is",
    text: "text-ok",
    dot: "bg-ok",
    note: "h264 + aac, mp4/m4v, faststart",
  },
  remux: {
    label: "remux",
    text: "text-digital",
    dot: "bg-digital",
    note: "h264 + playable audio — repackage to faststart mp4 (-c copy)",
  },
  audioFix: {
    label: "audio fix",
    text: "text-warn",
    dot: "bg-warn",
    note: "h264, but the audio needs re-encoding to aac (-c:v copy)",
  },
  transcode: {
    label: "transcode",
    text: "text-mauve",
    dot: "bg-mauve",
    note: "legacy video codec — full libx264/aac encode",
  },
  unknown: {
    label: "unknown",
    text: "text-muted",
    dot: "bg-muted",
    note: "ffprobe failed / no video stream",
  },
};

const ORDER: VideoBucket[] = ["plays", "remux", "audioFix", "transcode", "unknown"];

const GRID =
  "grid-cols-[minmax(0,2fr)_5rem_5rem_3.5rem_3.5rem_6.5rem]";

function relpath(path: string, root: string) {
  if (root && path.startsWith(root)) return path.slice(root.length).replace(/^\/+/, "");
  return path;
}

export function VideoCensus({ root }: { root: string }) {
  const [rows, setRows] = useState<VideoRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!root) return;
    setLoading(true);
    setError(null);
    classifyVideos(root)
      .then(setRows)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [root]);

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<VideoBucket, number> = {
      plays: 0,
      remux: 0,
      audioFix: 0,
      transcode: 0,
      unknown: 0,
    };
    for (const r of rows ?? []) c[r.bucket]++;
    return c;
  }, [rows]);

  const needsWork = rows ? rows.length - counts.plays : 0;

  // --- normalize (Part B) ---
  const [backupRoot, setBackupRoot] = useState(
    () => localStorage.getItem(BACKUP_KEY) ?? "",
  );
  useEffect(() => {
    localStorage.setItem(BACKUP_KEY, backupRoot);
  }, [backupRoot]);
  // Suggest the sibling backup folder once the root is known, if unset.
  useEffect(() => {
    if (!backupRoot && root) setBackupRoot(defaultBackup(root));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // Which needs-work buckets to convert — narrow the scope (e.g. remux only).
  const [selected, setSelected] = useState<Set<VideoBucket>>(
    () => new Set(NEEDS_WORK),
  );
  function toggleBucket(b: VideoBucket) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(b)) n.delete(b);
      else n.add(b);
      return n;
    });
  }

  const [phase, setPhase] = useState<"idle" | "confirm" | "running" | "done">(
    "idle",
  );
  const [progress, setProgress] = useState<NormalizeProgress | null>(null);
  const [report, setReport] = useState<NormalizeReport | null>(null);

  // The files to convert — needs-work buckets, narrowed to the selected scope.
  const workItems = useMemo(
    () =>
      (rows ?? [])
        .filter((r) => NEEDS_WORK.includes(r.bucket) && selected.has(r.bucket))
        .map((r) => ({ path: r.path, bucket: r.bucket })),
    [rows, selected],
  );

  useEffect(() => {
    const un = onNormalizeProgress(setProgress);
    return () => {
      un.then((f) => f());
    };
  }, []);

  async function pickBackup() {
    const picked = await openDialog({
      directory: true,
      defaultPath: backupRoot || undefined,
    });
    if (typeof picked === "string" && picked) setBackupRoot(picked);
  }

  async function runNormalize() {
    setPhase("running");
    setReport(null);
    setProgress(null);
    try {
      const rep = await normalizeVideos(workItems, root, backupRoot);
      setReport(rep);
      setPhase("done");
      load(); // re-probe so converted files re-bucket as "plays"
    } catch (e) {
      setError(String(e));
      setPhase("idle");
    }
  }

  const basename = (p: string) => p.split("/").pop() ?? p;

  return (
    <div className="rounded-xl bg-panel border border-surface/60 shadow-md flex flex-col min-h-0 h-full overflow-hidden">
      {/* Toolbar: title · per-bucket summary · refresh */}
      <div className="flex items-center gap-3 px-4 py-2 shrink-0 border-b border-surface/60 text-xs">
        <span className="text-accent font-medium uppercase tracking-wide shrink-0">
          Video types
        </span>
        {rows && (
          <span className="text-muted shrink-0">
            {rows.length} files · {needsWork} need work
          </span>
        )}
        <div className="flex items-center gap-3 ml-auto">
          {ORDER.map((b) =>
            counts[b] > 0 ? (
              <span
                key={b}
                className="inline-flex items-center gap-1.5"
                title={BUCKET[b].note}
              >
                <span className={cn("w-2 h-2 rounded-full", BUCKET[b].dot)} />
                <span className={BUCKET[b].text}>
                  {counts[b]} {BUCKET[b].label}
                </span>
              </span>
            ) : null,
          )}
          <button
            type="button"
            onClick={load}
            disabled={loading}
            title="Re-probe videos"
            aria-label="Refresh"
            className="p-1 rounded text-muted hover:text-fg hover:bg-surface/40 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
          </button>
        </div>
      </div>

      {/* Column header */}
      <div
        className={cn(
          "grid items-center gap-3 px-4 py-2 shrink-0 border-b border-surface/60",
          "bg-panel text-xs uppercase tracking-wide text-accent font-medium",
          GRID,
        )}
      >
        <span>file</span>
        <span>video</span>
        <span>audio</span>
        <span>cont</span>
        <span>fast</span>
        <span>action</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
        {error ? (
          <div className="px-4 py-6 text-sm text-alert">{error}</div>
        ) : loading && !rows ? (
          <div className="px-4 py-6 text-sm text-muted flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> probing videos…
          </div>
        ) : rows && rows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted">
            No video files under the library root.
          </div>
        ) : (
          (rows ?? []).map((r) => {
            const meta = BUCKET[r.bucket];
            return (
              <div
                key={r.path}
                title={meta.note}
                className={cn(
                  "grid items-center gap-3 px-4 py-1 font-mono text-xs",
                  "border-b border-fg/15 hover:bg-surface/30 transition-colors",
                  GRID,
                )}
              >
                <span className="truncate text-fg/85" title={r.path}>
                  {relpath(r.path, root)}
                </span>
                <span className="truncate text-fg/70">{r.vcodec ?? "—"}</span>
                <span className="truncate text-fg/70">{r.acodec ?? "—"}</span>
                <span className="text-fg/60">{r.container}</span>
                <span className={r.faststart ? "text-ok" : "text-muted/40"}>
                  {r.faststart ? "✓" : "—"}
                </span>
                <span className={cn("inline-flex items-center gap-1.5", meta.text)}>
                  <span className={cn("w-2 h-2 rounded-full shrink-0", meta.dot)} />
                  <span className="truncate">{meta.label}</span>
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* Normalize footer — Part B action / confirm / progress / result. */}
      <div className="shrink-0 border-t border-surface/60 px-4 py-2 text-xs flex items-center gap-3">
        {phase === "running" ? (
          <>
            <Loader2 size={13} className="animate-spin text-digital shrink-0" />
            <span className="text-fg/80 truncate min-w-0">
              {progress
                ? `${progress.done}/${progress.total} · ${basename(progress.path)}`
                : "starting…"}
            </span>
            <button
              type="button"
              onClick={() => cancelNormalize()}
              className="ml-auto px-2 py-1 rounded text-muted hover:text-alert shrink-0"
            >
              Cancel
            </button>
          </>
        ) : phase === "confirm" ? (
          <>
            <span className="text-fg/80 truncate min-w-0">
              Normalize {workItems.length} videos → mp4. Originals moved to{" "}
              <span className="text-mauve">{backupRoot}</span>.
            </span>
            <div className="ml-auto flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setPhase("idle")}
                className="px-2 py-1 rounded text-muted hover:text-fg"
              >
                Back
              </button>
              <button
                type="button"
                onClick={runNormalize}
                className="px-2.5 py-1 rounded-md bg-digital/20 text-digital hover:bg-digital/30"
              >
                Run
              </button>
            </div>
          </>
        ) : phase === "done" && report ? (
          <>
            <span className="text-fg/80">
              <span className="text-ok">✓ {report.converted} converted</span>
              {report.failed > 0 && (
                <span className="text-alert"> · {report.failed} failed</span>
              )}
              {report.timedOut > 0 && (
                <span className="text-alert"> · {report.timedOut} timed out</span>
              )}
              {report.cancelled > 0 && (
                <span className="text-muted"> · {report.cancelled} cancelled</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => {
                setPhase("idle");
                setReport(null);
              }}
              className="ml-auto px-2 py-1 rounded text-muted hover:text-fg shrink-0"
            >
              Dismiss
            </button>
          </>
        ) : (
          <>
            {/* Scope — toggle which needs-work buckets to convert. */}
            <span className="text-muted shrink-0">convert:</span>
            <div className="flex items-center gap-1.5 min-w-0">
              {NEEDS_WORK.filter((b) => counts[b] > 0).map((b) => {
                const on = selected.has(b);
                return (
                  <button
                    key={b}
                    type="button"
                    onClick={() => toggleBucket(b)}
                    title={`${BUCKET[b].note}${on ? "" : " — excluded"}`}
                    aria-pressed={on}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors",
                      on ? "bg-surface text-fg/90" : "bg-surface/40 text-muted/50",
                    )}
                  >
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full",
                        on ? BUCKET[b].dot : "bg-muted/40",
                      )}
                    />
                    {counts[b]} {BUCKET[b].label}
                  </button>
                );
              })}
              {NEEDS_WORK.every((b) => counts[b] === 0) && (
                <span className="text-muted/60">nothing needs converting</span>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={pickBackup}
                title="Where originals are moved (must be outside the library root)"
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-surface/60 hover:bg-surface text-fg/80 min-w-0"
              >
                <FolderOpen size={12} className="shrink-0" />
                <span className="truncate max-w-[260px]">
                  {backupRoot || "choose backup folder…"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPhase("confirm")}
                disabled={workItems.length === 0 || !backupRoot}
                title={
                  workItems.length === 0
                    ? "Select at least one bucket to convert"
                    : !backupRoot
                      ? "Choose a backup folder first"
                      : `Convert ${workItems.length} videos to playable mp4`
                }
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-digital/20 text-digital hover:bg-digital/30 disabled:opacity-40 transition-colors"
              >
                <Wand2 size={12} /> Normalize {workItems.length}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
