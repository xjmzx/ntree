import type { ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import { Section } from "./Section";
import { cn } from "../lib/cn";
import { type ScanRow, type Verdict } from "../lib/tauri";
import { sampleDestPath, splitPath } from "../lib/paths";

const SAMPLE_SECS = 10;

const VERDICT_COLOR: Record<Verdict, string> = {
  LOSSLESS: "text-ok",
  "PROBABLY-LOSSY": "text-alert",
  UNCERTAIN: "text-warn",
  LOSSY: "text-lossy",
  UNKNOWN: "text-muted",
};

interface SampleDetailsProps {
  /** The track selected in the Library, or null for the greyed skeleton. */
  row: ScanRow | null;
  libRoot: string;
  workspaceDest: string;
  hasClip: boolean;
  isPlaying: boolean;
  onPlay: () => void;
  /** Collapse the whole left flank (Sample + Publish together). */
  onCollapse: () => void;
}

// Left-flank top pane — the selected sample's details. When nothing is
// selected it still renders its full field layout, greyed, so the pane keeps
// its shape (field names visible, no data).
export function SampleDetails({
  row,
  libRoot,
  workspaceDest,
  hasClip,
  isPlaying,
  onPlay,
  onCollapse,
}: SampleDetailsProps) {
  const has = !!row;
  const name = row ? row.path.split("/").pop() ?? row.path : "—";

  // from = the source track under the library root; to = the 10s clip under
  // the workspace dest. Both are tree paths we render as triangle breadcrumbs.
  const norm = libRoot.replace(/\/+$/, "");
  const rootName = norm.split("/").pop() || "library";
  const [artist, release, track] = row
    ? splitPath(row.path, libRoot)
    : ["", "", ""];
  const destNorm = workspaceDest.replace(/\/+$/, "");
  const destName = destNorm.split("/").pop() || "clips";
  const clipBase = row
    ? sampleDestPath(row.path, libRoot, workspaceDest, SAMPLE_SECS)
        .split("/")
        .pop() ?? ""
    : "";
  const fromParts = has ? [rootName, artist, release, track] : [];
  const toParts = has ? [destName, artist, release, clipBase] : [];

  return (
    <Section
      title="Sample"
      icon={<span className="inline-block w-2 h-2 rounded-full bg-ok/70" />}
      onTitleClick={onCollapse}
      // No tinted stroke: Library and Radio use Section's default border, and a
      // coloured one here only made this panel read as a different kind of box.
      className="w-full flex-1 min-h-0"
      contentClassName="flex-1 min-h-0 overflow-auto flex flex-col gap-3"
    >
      {!has && (
        <p className="text-[11px] text-muted/70 italic">
          No track selected — pick one in the Library.
        </p>
      )}

      <dl
        className={cn(
          "grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs",
          !has && "opacity-40",
        )}
      >
        <Field label="name" mono value={name} title={name} />
        <Field
          label="verdict"
          mono
          value={row ? row.verdict : "—"}
          valueClass={row ? VERDICT_COLOR[row.verdict] : undefined}
        />
        <Field
          label="peak"
          value={
            row?.peak != null
              ? `${row.peak >= 0 ? "+" : ""}${row.peak.toFixed(1)} dB`
              : "—"
          }
        />
        <Field
          label="rate"
          value={row?.sr ? `${row.sr.toLocaleString()} Hz` : "—"}
        />
      </dl>

      {/* Provenance — source track (from) and clip (to) as triangle
          breadcrumbs through the tree. */}
      <div
        className={cn(
          "flex flex-col gap-1 border-t border-surface/50 pt-2",
          !has && "opacity-40",
        )}
      >
        <div className="text-muted text-[10px] uppercase tracking-wide">source</div>
        <ProvRow
          marker="▲"
          markerClass="text-ok"
          label="from"
          parts={fromParts}
        />
        <ProvRow
          marker="▼"
          markerClass={hasClip ? "text-ok" : "text-muted"}
          label="to"
          parts={toParts}
        />
      </div>

      {/* Clip status + preview. */}
      <div className="flex items-center gap-2 text-xs">
        <span
          className={cn(
            "inline-block w-2 h-2 rounded-full shrink-0",
            hasClip ? "bg-ok/70" : "bg-muted/40",
          )}
        />
        {hasClip ? (
          <button
            type="button"
            onClick={onPlay}
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-1 rounded-md",
              "bg-surface hover:bg-surfaceHover transition-colors",
              isPlaying ? "text-mauve" : "text-ok",
            )}
            title={isPlaying ? "Stop preview" : `Preview ${SAMPLE_SECS}s clip`}
          >
            {isPlaying ? <Pause size={12} /> : <Play size={12} />}
            <span>{isPlaying ? "playing…" : `preview ${SAMPLE_SECS}s clip`}</span>
          </button>
        ) : (
          <span className="text-muted">
            {has ? "no clip — sample it from the Library first" : "no clip"}
          </span>
        )}
      </div>
    </Section>
  );
}

function Field({
  label,
  value,
  mono,
  valueClass,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  valueClass?: string;
  title?: string;
}) {
  return (
    <>
      <dt className="text-muted text-[10px] uppercase tracking-wide">{label}</dt>
      <dd
        className={cn("truncate", mono && "font-mono", valueClass ?? "text-fg/90")}
        title={title}
      >
        {value}
      </dd>
    </>
  );
}

// One provenance row — a direction triangle + label, then the tree path as a
// ▸-separated breadcrumb (last segment emphasised). Wraps in the narrow pane.
function ProvRow({
  marker,
  markerClass,
  label,
  parts,
}: {
  marker: string;
  markerClass: string;
  label: string;
  parts: string[];
}): ReactNode {
  return (
    <div className="flex gap-1.5 text-[11px] font-mono leading-relaxed">
      <span className={cn("shrink-0", markerClass)} aria-hidden="true">
        {marker}
      </span>
      <span className="shrink-0 w-8 text-muted text-[10px] uppercase tracking-wide pt-px">
        {label}
      </span>
      <span className="min-w-0 break-words">
        {parts.length === 0 ? (
          <span className="text-muted/50">—</span>
        ) : (
          parts.map((p, i) => (
            <span key={i}>
              {i > 0 && <span className="text-muted/40 px-0.5">▸</span>}
              <span
                className={i === parts.length - 1 ? "text-fg/90" : "text-muted"}
              >
                {p}
              </span>
            </span>
          ))
        )}
      </span>
    </div>
  );
}
