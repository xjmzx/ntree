import type { MirrorResult, SampleProgress, ScanProgress } from "../lib/tauri";

/**
 * Shared output strip rendered below the three operation panels
 * (Scanner | Mirror tree | Destination). At most one of the three is
 * active at a time; this component picks whichever has live state.
 * Renders null when idle so the layout slot collapses.
 */
export interface MirrorState {
  kind: "idle" | "running" | "done" | "err";
  result?: MirrorResult;
  error?: string;
}

interface ScanState {
  /** True from "counting…" through "scanning" — anything that has live progress to show. */
  active: boolean;
  progress: ScanProgress | null;
  cancelling: boolean;
}

interface Props {
  scan: ScanState;
  mirror: MirrorState;
  sampling: SampleProgress | null;
  samplingCancelling: boolean;
}

function ProgressStrip({
  label,
  pct,
  line,
}: {
  label: string;
  pct: number;
  line: string;
}) {
  return (
    <div className="space-y-1.5">
      {/* The streaming line is the one thing here you actually read while an op
          runs — muted is the label tone, too dim for live output. */}
      <div className="text-xs text-fg/75 font-mono flex items-center gap-2 min-w-0">
        <span className="text-accent uppercase tracking-wide text-[10px] shrink-0">
          {label}
        </span>
        <span className="truncate flex-1 min-w-0">{line}</span>
        <span className="tabular-nums text-fg shrink-0">{pct}%</span>
      </div>
      <div className="h-px bg-muted/40" />
      <div className="h-0.5 rounded-full bg-bg/60 overflow-hidden">
        <div
          className="h-full bg-accent transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function OperationOutput({
  scan,
  mirror,
  sampling,
  samplingCancelling,
}: Props) {
  // Priority order: live scan > live sample > mirror running > last mirror
  // result / error. The first three are mutually exclusive in practice.
  if (scan.active) {
    const total = Math.max(1, scan.progress?.total ?? 1);
    const done = scan.progress?.done ?? 0;
    const pct = Math.round((100 * done) / total);
    const line = scan.progress
      ? `${done.toLocaleString()} / ${scan.progress.total.toLocaleString()} · ${scan.progress.path}${scan.cancelling ? "  · cancelling" : ""}`
      : "discovering files…";
    return (
      <div className="rounded-lg bg-panel/40 border border-surface/40 px-4 py-2">
        <ProgressStrip label="scanning" pct={pct} line={line} />
      </div>
    );
  }
  if (sampling) {
    const total = Math.max(1, sampling.total);
    const pct = Math.round((100 * sampling.done) / total);
    const line = sampling.total > 0
      ? `${sampling.done.toLocaleString()} / ${sampling.total.toLocaleString()} · ${sampling.path || "preparing…"}${samplingCancelling ? "  · cancelling" : ""}`
      : "preparing…";
    return (
      <div className="rounded-lg bg-panel/40 border border-surface/40 px-4 py-2">
        <ProgressStrip label="sampling" pct={pct} line={line} />
      </div>
    );
  }
  if (mirror.kind === "running") {
    return (
      <div className="rounded-lg bg-panel/40 border border-surface/40 px-4 py-2 text-xs text-fg/75 font-mono">
        <span className="text-accent uppercase tracking-wide text-[10px] mr-2">
          mirror
        </span>
        creating folders…
      </div>
    );
  }
  if (mirror.kind === "done" && mirror.result) {
    const r = mirror.result;
    return (
      <div className="rounded-lg bg-panel/40 border border-surface/40 px-4 py-2 text-xs space-y-1">
        <div className="flex items-center gap-3">
          <span className="text-accent uppercase tracking-wide text-[10px]">
            mirror
          </span>
          <span className="text-ok">created {r.created}</span>
          <span className="text-muted">skipped {r.skipped}</span>
          {r.errors.length > 0 && (
            <span className="text-alert">{r.errors.length} errors</span>
          )}
        </div>
        {r.errors.length > 0 && (
          <pre className="text-[10px] text-alert font-mono whitespace-pre-wrap max-h-32 overflow-auto">
            {r.errors.slice(0, 20).join("\n")}
            {r.errors.length > 20 && `\n…and ${r.errors.length - 20} more`}
          </pre>
        )}
      </div>
    );
  }
  if (mirror.kind === "err" && mirror.error) {
    return (
      <div className="rounded-lg bg-panel/40 border border-alert/40 px-4 py-2 text-xs text-alert font-mono break-all whitespace-pre-wrap">
        <span className="uppercase tracking-wide text-[10px] mr-2">mirror</span>
        {mirror.error}
      </div>
    );
  }
  return null;
}
