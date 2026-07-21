import type { SVGProps } from "react";
import { cn } from "../lib/cn";

/**
 * The suite's "leaf" glyph — a simple almond blade + midrib, drawn in the
 * lucide idiom (24×24, currentColor stroke, round caps, stroke-width 2). Used
 * for affordance / brand marks (the clip filter toggle, per-scope sample
 * buttons, the Sample panel header). Quantity is shown with LeafDots.
 */
export function LeafIcon({
  size = 24,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* blade — pointed almond (tip top, stem base bottom) */}
      <path d="M12 21C6 16 6 9 12 4C18 9 18 16 12 21Z" />
      {/* midrib */}
      <path d="M12 20V5" />
    </svg>
  );
}

/**
 * Leaf-dots — the suite's diagrammatic quantity glyph (shared with ndisc /
 * ndisc.smpl). A leaf is a track; each track is one flat, muted neutral dot
 * (`--c-medium` — green in the colour themes, grey in mono, mirroring ndisc),
 * and the dots stack into a compact cluster (wrap at 5 per row) so the count
 * itself is the picture — leaves piling on a branch. Renders nothing for 0.
 * Capped at `max` (default 99); the exact figure stays in the hover title.
 */
// Optimal column count for `n` dots within `maxCols`: single row up to the
// smaller of 5 / maxCols, then the fewest rows that fit, columns balanced
// (6→2×3, 8→2×4, 7→4+3). Low maxCols = taller/narrower; high = shorter/wider.
function dotCols(n: number, maxCols: number): number {
  if (n <= Math.min(5, maxCols)) return n;
  const rows = Math.ceil(n / maxCols);
  return Math.ceil(n / rows);
}

export function LeafDots({
  n,
  total,
  max = 99,
  unit = "track",
  maxCols = 5,
  maxRows,
  className,
}: {
  /** Present count (solid `--c-medium` dots). */
  n: number | null | undefined;
  /** Expected total — extra (missing) slots render at 25%. */
  total?: number | null;
  max?: number;
  unit?: string;
  /** Max dots per row — lower = taller/narrower, higher = shorter/wider. */
  maxCols?: number;
  /** When set, the grid is capped at this many rows; a larger count collapses
   *  to a solid `--c-medium` tile with the total centred (matches ndisc). */
  maxRows?: number;
  className?: string;
}) {
  const present = Math.min(Math.max(n ?? 0, 0), max);
  const expected = total != null ? Math.min(Math.max(total, 0), max) : present;
  const shown = Math.max(present, expected);
  if (shown <= 0) return null;
  const missing = Math.max(expected - present, 0);
  const cols = dotCols(shown, maxCols);
  const title =
    total != null
      ? `${present} of ${total} ${unit}${total === 1 ? "" : "s"}${
          missing > 0 ? ` · ${missing} missing` : " · complete"
        }`
      : `${present}${present >= max ? "+" : ""} ${unit}${present === 1 ? "" : "s"}`;

  // Past the row cap, collapse the grid to one solid `--c-medium` tile carrying
  // the total, centred (same as ndisc's large-count treatment).
  if (maxRows != null && Math.ceil(shown / cols) > maxRows) {
    return (
      <CountBadge
        value={shown}
        atMax={shown >= max}
        title={title}
        className={className}
        shapeClassName="rounded-[3px]"
        colorClassName="bg-medium/70 text-bg"
      />
    );
  }

  return (
    <span
      // Fill right-to-left so a ragged/incomplete row's gap lands on the LEFT
      // (the short single-leaf column sits nearest the release title) and the
      // full multi-row columns build outward to the right.
      className={cn("inline-grid gap-[2px] w-max", className)}
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        direction: "rtl",
      }}
      title={title}
      aria-label={title}
    >
      {Array.from({ length: shown }, (_, i) => (
        <span
          key={i}
          className={cn(
            "w-1 h-1 rounded-full",
            i < present ? "bg-medium/70" : "bg-medium/25",
          )}
        />
      ))}
    </span>
  );
}

/**
 * A count rendered as a number centred on a single solid fixed-size shape —
 * the suite's "one mark for a quantity" glyph (shared with ndisc). Flavour via
 * className props: tracks collapse onto a neutral (`--c-medium`) rounded tile;
 * the release count is a `--c-medium` circle. Shape encodes role (square tile =
 * tracks, circle = child-count); the mark is grey in mono, green in colour.
 */
export function CountBadge({
  value,
  atMax = false,
  title,
  shapeClassName = "rounded-full",
  colorClassName,
  size = 21,
  className,
}: {
  value: number;
  atMax?: boolean;
  title: string;
  shapeClassName?: string;
  colorClassName?: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-grid place-items-center font-bold leading-none tabular-nums",
        shapeClassName,
        colorClassName,
        className,
      )}
      style={{ width: size, height: size, fontSize: value >= 100 ? 8 : 10 }}
      title={title}
      aria-label={title}
    >
      {value}
      {atMax ? "+" : ""}
    </span>
  );
}

/**
 * Release count — the artist-level counterpart to LeafDots, now in the shared
 * suite language: a neutral (`--c-medium`) numbered circle (the same CountBadge
 * glyph ndisc uses for its per-release disc count). The circle = "count of this
 * node's children" (releases here, discs in ndisc); the square tile / dots =
 * tracks. Shape encodes the role; the mark is grey in mono / green in colour —
 * so tree and ndisc read as one visual language (both on `--c-medium`).
 */
export function ReleaseTree({
  n,
  max = 99,
  className,
}: {
  n: number | null | undefined;
  max?: number;
  className?: string;
}) {
  const raw = Math.max(n ?? 0, 0);
  const count = Math.min(raw, max);
  if (count <= 0) return null;
  const title = `${raw}${raw >= max ? "+" : ""} release${raw === 1 ? "" : "s"}`;
  return (
    <CountBadge
      value={count}
      atMax={raw >= max}
      title={title}
      shapeClassName="rounded-full"
      colorClassName="bg-medium/70 text-bg"
      className={className}
    />
  );
}

/**
 * A small scatter of dots in varied hues and sizes — the suite's dot
 * vocabulary used as a decorative glyph (not a count). It marks "Radio": a
 * handful of samples out on the wire. The mixed hues (present `--c-medium` /
 * published mauve / unknown muted) and sizes read as a spread of leaves rather
 * than a
 * single mark — the dot-cluster successor to the old dot-tree/forest motifs.
 */
export function DotCluster({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-[2px]", className)}
      aria-hidden="true"
    >
      <span className="w-1 h-1 rounded-full bg-medium/70" />
      <span className="w-1.5 h-1.5 rounded-full bg-mauve/70" />
      <span className="w-[3px] h-[3px] rounded-full bg-muted/60" />
      <span className="w-1 h-1 rounded-full bg-medium/45" />
    </span>
  );
}
