import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import { Loader2, Pause, Play } from "lucide-react";
import { cn } from "../lib/cn";
import { readAudioBytes } from "../lib/tauri";

// Mirror nsmpl's waveform palette so the two apps' waveforms read alike (parity,
// separate code). Hardcoded like nsmpl's — the wave/progress/cursor are a fixed
// look, not theme tokens.
const WAVE = "#6c7086";
const PROGRESS = "#89b4fa";
const CURSOR = "#cdd6f4";
const REGION_FILL = "rgba(137, 180, 250, 0.18)";

function fmt(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

/**
 * Read-only WaveSurfer waveform of the SELECTED source track — scrub + play +
 * a static marker for the 10s sample region. ntree navigates, it does not edit
 * (no drag-selection), so this is a minimal parity of nsmpl's Player waveform.
 */
export function Waveform({
  path,
  sampleStart,
  sampleEnd,
  onPlayStart,
  pauseWhen,
}: {
  /** Absolute source-track path; null renders nothing. */
  path: string | null;
  /** 10s sample region to mark (seconds); omit when the track isn't sampled. */
  sampleStart?: number;
  sampleEnd?: number;
  /** Fired when playback starts here, so the caller can stop other players. */
  onPlayStart?: () => void;
  /** When it flips true, pause — another player (a row clip) took over. */
  pauseWhen?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path || !containerRef.current) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlaying(false);
    setTime(0);
    setDur(0);

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: WAVE,
      progressColor: PROGRESS,
      cursorColor: CURSOR,
      cursorWidth: 1,
      height: 64,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      plugins: [regions],
    });
    wsRef.current = ws;

    ws.on("ready", () => {
      if (cancelled) return;
      setDur(ws.getDuration());
      setLoading(false);
      if (sampleStart != null && sampleEnd != null) {
        // Clamp to the loaded duration — a short track can't hold a [30s,40s]
        // region; ffmpeg would have taken whatever tail existed.
        const d = ws.getDuration();
        const s = Math.min(sampleStart, d);
        const e = Math.min(sampleEnd, d);
        if (e > s) {
          regions.addRegion({
            start: s,
            end: e,
            color: REGION_FILL,
            drag: false,
            resize: false,
          });
        }
      }
    });
    ws.on("play", () => {
      setPlaying(true);
      onPlayStart?.();
    });
    ws.on("pause", () => setPlaying(false));
    ws.on("finish", () => setPlaying(false));
    ws.on("timeupdate", (t: number) => setTime(t));
    ws.on("error", (e: Error) => {
      if (cancelled) return;
      setError(String(e?.message ?? e));
      setLoading(false);
    });

    readAudioBytes(path)
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([bytes.buffer as ArrayBuffer], {
          type: "audio/flac",
        });
        return ws.loadBlob(blob);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(`read failed: ${String(e)}`);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      ws.destroy();
      if (wsRef.current === ws) wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, sampleStart, sampleEnd]);

  // Pause when a row clip/source takes over (mutual exclusion with the tree).
  useEffect(() => {
    if (pauseWhen) wsRef.current?.pause();
  }, [pauseWhen]);

  if (!path) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => wsRef.current?.playPause()}
          disabled={loading || !!error}
          title={playing ? "Pause" : "Play the full source track"}
          aria-label={playing ? "Pause source track" : "Play source track"}
          className={cn(
            "flex items-center justify-center rounded p-1 shrink-0",
            "hover:text-accent disabled:opacity-50 disabled:cursor-not-allowed",
            playing ? "text-accent" : "text-medium",
          )}
        >
          {loading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : playing ? (
            <Pause size={14} />
          ) : (
            <Play size={14} />
          )}
        </button>
        <span className="text-[10px] font-mono text-muted tabular-nums">
          {fmt(time)} / {fmt(dur)}
        </span>
      </div>
      {/* WaveSurfer mounts here; click / drag on the wave seeks. */}
      <div ref={containerRef} className="w-full" />
      {error && (
        <p className="text-[10px] text-alert font-mono break-all">{error}</p>
      )}
    </div>
  );
}
