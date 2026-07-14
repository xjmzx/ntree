import { LineChart } from "lucide-react";
import { Section } from "./Section";
import { cn } from "../lib/cn";
import type { ScanRow, Verdict } from "../lib/tauri";

// The five scan verdicts, in bar order, with their suite colours (matching the
// header verdict bar + LibraryTree). Lossless ← ok green; Probably-lossy ←
// alert; Uncertain ← warn; Lossy ← mauve; Unknown ← muted.
const VERDICT_META: { key: Verdict; label: string; bar: string; text: string }[] = [
  { key: "LOSSLESS", label: "Lossless", bar: "bg-ok", text: "text-ok" },
  { key: "PROBABLY-LOSSY", label: "Probably lossy", bar: "bg-alert", text: "text-alert" },
  { key: "UNCERTAIN", label: "Uncertain", bar: "bg-warn", text: "text-warn" },
  { key: "LOSSY", label: "Lossy", bar: "bg-mauve", text: "text-mauve" },
  { key: "UNKNOWN", label: "Unknown", bar: "bg-muted", text: "text-muted" },
];

interface StatsViewProps {
  counts: Record<Verdict, number>;
  /** Every scanned row — the source of the technical breakdowns below. */
  rows: ScanRow[];
}

/** Lossy codecs have no bit depth; lossless ones have no meaningful bitrate
 *  target. Which sections are worth showing depends on which side a file is. */
const LOSSY_CODECS = new Set([
  "mp3", "aac", "vorbis", "opus", "wmav2", "wmav1", "ac3", "eac3", "mp2",
  "musepack", "atrac3", "cook", "ra_144", "ra_288", "amr_nb", "amr_wb",
]);

/** Group rows by a key, drop the misses, and sort by count descending. */
function tally<T extends string | number>(
  rows: ScanRow[],
  key: (r: ScanRow) => T | null | undefined,
): { label: string; n: number }[] {
  const m = new Map<T, number>();
  for (const r of rows) {
    const k = key(r);
    if (k === null || k === undefined || k === "") continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([k, n]) => ({ label: String(k), n }))
    .sort((a, b) => b.n - a.n);
}

/** Lossy bitrate buckets. 320 gets its own row — it is a meaningful ceiling,
 *  not just "high"; and everything under 128 is worth seeing on its own. */
function bitrateBucket(bps: number): string {
  const k = Math.round(bps / 1000);
  if (k < 128) return `under 128 kbps`;
  if (k < 192) return `128–191 kbps`;
  if (k < 256) return `192–255 kbps`;
  if (k < 320) return `256–319 kbps`;
  if (k <= 321) return `320 kbps`;
  return `over 320 kbps`;
}

// Placeholder stats page — the lossy-vs-lossless picture from the scan's
// spectral verdicts. Borrows ndisc's StatsView chrome (Section cards, digital
// tone). More breakdowns (by artist, over time, vs format label) to come.
export function StatsView({ counts, rows }: StatsViewProps) {
  const total = VERDICT_META.reduce((s, v) => s + counts[v.key], 0);
  const pct = (n: number) => (total ? (100 * n) / total : 0);
  const fmtPct = (n: number) => `${pct(n).toFixed(pct(n) < 10 ? 1 : 0)}%`;

  // Headline lossless / lossy / uncertain rollup. Probably-lossy folds into
  // lossy (a "lossless" file that's actually a transcode); uncertain + unknown
  // are the can't-tell bucket.
  const lossless = counts.LOSSLESS;
  const lossy = counts.LOSSY + counts["PROBABLY-LOSSY"];
  const unsure = counts.UNCERTAIN + counts.UNKNOWN;

  // The technical picture. `codec` is null on reports written before the
  // scanner captured it, so an old report shows the verdicts but no detail —
  // say so rather than render five empty sections.
  const audio = rows.filter((r) => r.info !== "video");
  const detailed = audio.filter((r) => r.codec != null);
  const hasDetail = detailed.length > 0;

  const codecs = tally(detailed, (r) => r.codec);
  const rates = tally(detailed, (r) =>
    r.sr ? `${(r.sr / 1000).toFixed(r.sr % 1000 === 0 ? 0 : 1)} kHz` : null,
  );
  const depths = tally(detailed, (r) =>
    r.bitDepth ? `${r.bitDepth}-bit` : null,
  );
  const chans = tally(detailed, (r) =>
    r.channels === 1 ? "mono" : r.channels === 2 ? "stereo"
      : r.channels ? `${r.channels} ch` : null,
  );
  const lossyRows = detailed.filter(
    (r) => r.codec && LOSSY_CODECS.has(r.codec),
  );
  const bitrates = tally(lossyRows, (r) =>
    r.bitRate ? bitrateBucket(r.bitRate) : null,
  );

  return (
    <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-4">
      <Section
        title="Library quality"
        icon={<LineChart size={16} />}
        className="border-digital/30"
        contentClassName="flex flex-col gap-4"
      >
        {total === 0 ? (
          <p className="text-xs text-muted">
            No scan data yet — run a scan to see the lossy / lossless breakdown.
          </p>
        ) : (
          <>
            {/* Headline rollup — lossless vs lossy vs uncertain. */}
            <div className="grid grid-cols-3 gap-3">
              <Headline label="Lossless" n={lossless} pct={fmtPct(lossless)} cls="text-ok" />
              <Headline label="Lossy" n={lossy} pct={fmtPct(lossy)} cls="text-mauve" />
              <Headline label="Uncertain" n={unsure} pct={fmtPct(unsure)} cls="text-warn" />
            </div>

            {/* Full five-verdict stacked bar. */}
            <div className="h-3 rounded-sm overflow-hidden bg-bg/60 flex">
              {VERDICT_META.map((v) =>
                counts[v.key] > 0 ? (
                  <div
                    key={v.key}
                    className={cn("h-full", v.bar)}
                    style={{ width: `${pct(counts[v.key])}%` }}
                    title={`${v.label} ${counts[v.key].toLocaleString()}`}
                  />
                ) : null,
              )}
            </div>

            {/* Legend with exact counts + percentages. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5 text-xs">
              {VERDICT_META.map((v) => (
                <div key={v.key} className="flex items-center gap-2">
                  <span className={cn("w-2.5 h-2.5 rounded-sm shrink-0", v.bar)} />
                  <span className="flex-1 text-fg/80">{v.label}</span>
                  <span className="font-mono tabular-nums text-fg/90">
                    {counts[v.key].toLocaleString()}
                  </span>
                  <span className="font-mono tabular-nums text-muted w-12 text-right">
                    {fmtPct(counts[v.key])}
                  </span>
                </div>
              ))}
              <div className="flex items-center gap-2 sm:col-span-2 border-t border-surface/50 pt-1.5 mt-0.5">
                <span className="w-2.5 h-2.5 shrink-0" />
                <span className="flex-1 text-muted uppercase tracking-wide text-[10px]">
                  total tracks scanned
                </span>
                <span className="font-mono tabular-nums text-fg/90">
                  {total.toLocaleString()}
                </span>
                <span className="w-12" />
              </div>
            </div>
          </>
        )}
      </Section>

      {total > 0 && !hasDetail && (
        <Section
          title="What the library is made of"
          icon={<LineChart size={16} />}
          contentClassName="flex flex-col gap-2"
        >
          <p className="text-xs text-muted leading-relaxed">
            This report predates the scanner capturing codec detail. The
            verdicts above are still valid — <strong className="text-fg/80">rescan</strong>{" "}
            to fill in codecs, sample rates, bit depths and bitrates.
          </p>
        </Section>
      )}

      {hasDetail && (
        <>
          <Section
            title="What the library is made of"
            icon={<LineChart size={16} />}
            contentClassName="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-4"
          >
            <Breakdown title="Codec" items={codecs} total={detailed.length} bar="bg-digital" />
            <Breakdown title="Sample rate" items={rates} total={detailed.length} bar="bg-accent" />
            <Breakdown
              title="Bit depth"
              items={depths}
              total={detailed.length}
              bar="bg-ok"
              note="Lossless only — a lossy codec has no bit depth."
            />
            <Breakdown title="Channels" items={chans} total={detailed.length} bar="bg-mauve" />
          </Section>

          {bitrates.length > 0 && (
            <Section
              title="Lossy bitrate"
              icon={<LineChart size={16} />}
              contentClassName="flex flex-col gap-2"
            >
              <Breakdown
                items={bitrates}
                total={lossyRows.length}
                bar="bg-mauve"
                note={`Across the ${lossyRows.length.toLocaleString()} natively-lossy files. Bitrate is the honest measure here — a 320 kbps MP3 and a 96 kbps one are both "LOSSY", and that verdict alone cannot tell them apart.`}
              />
            </Section>
          )}
        </>
      )}

      <p className="text-[11px] text-muted/70 px-1 leading-relaxed">
        The verdicts come from spectral analysis of the actual audio — a deeper
        read than the format-label lossless/lossy that ndisc and glmps infer
        from the codec name, so a “FLAC” that’s really a transcode lands in
        “probably lossy” here. The breakdowns below it come from the file
        headers, and describe what the library is rather than judge it.
      </p>
    </div>
  );
}

function Headline({
  label,
  n,
  pct,
  cls,
}: {
  label: string;
  n: number;
  pct: string;
  cls: string;
}) {
  return (
    <div className="rounded-lg bg-bg/40 px-3 py-2 flex flex-col gap-0.5">
      <span className={cn("text-2xl font-bold tabular-nums leading-none", cls)}>
        {n.toLocaleString()}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-muted">
        {label} · {pct}
      </span>
    </div>
  );
}

/** One labelled distribution: bar, count, percent. Rows sorted by count. */
function Breakdown({
  title,
  items,
  total,
  bar,
  note,
}: {
  title?: string;
  items: { label: string; n: number }[];
  total: number;
  bar: string;
  note?: string;
}) {
  if (items.length === 0) {
    return (
      <div>
        {title && (
          <h3 className="text-[10px] uppercase tracking-wide text-muted mb-1.5">
            {title}
          </h3>
        )}
        <p className="text-xs text-muted/70">none</p>
      </div>
    );
  }
  const pct = (n: number) => (total ? (100 * n) / total : 0);
  return (
    <div>
      {title && (
        <h3 className="text-[10px] uppercase tracking-wide text-muted mb-1.5">
          {title}
        </h3>
      )}
      <div className="flex flex-col gap-1">
        {items.map((it) => (
          <div key={it.label} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 truncate text-fg/80" title={it.label}>
              {it.label}
            </span>
            {/* The bar is the point — a table of numbers hides the shape. */}
            <span className="flex-1 h-1.5 rounded-sm bg-bg/60 overflow-hidden min-w-0">
              <span
                className={cn("block h-full", bar)}
                style={{ width: `${Math.max(pct(it.n), 0.5)}%` }}
              />
            </span>
            <span className="font-mono tabular-nums text-fg/90 w-14 text-right">
              {it.n.toLocaleString()}
            </span>
            <span className="font-mono tabular-nums text-muted w-12 text-right">
              {pct(it.n).toFixed(pct(it.n) < 10 ? 1 : 0)}%
            </span>
          </div>
        ))}
      </div>
      {note && (
        <p className="mt-1.5 text-[11px] text-muted/70 leading-relaxed">{note}</p>
      )}
    </div>
  );
}
