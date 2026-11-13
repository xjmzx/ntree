import type { Verdict } from "./tauri";

// The five scan verdicts, in bar order, with their suite colours. One list for
// the header bar and the Library Quality page, so the two always agree.
//
// The order keeps each headline group contiguous: Lossless | Probably lossy +
// Lossy | Uncertain + Unknown. So the three percentages printed under the
// header bar each read as one span of it.
export const VERDICT_META: { key: Verdict; label: string; bar: string; text: string }[] = [
  { key: "LOSSLESS", label: "Lossless", bar: "bg-ok", text: "text-ok" },
  // No red in the bar. Probably lossy is lilac: a suspicion from spectral
  // analysis, not an alarm. Lossy (a lossy codec, e.g. an MP3) is a calm teal:
  // it is a large, expected share of a real library.
  { key: "PROBABLY-LOSSY", label: "Probably lossy", bar: "bg-lossy", text: "text-lossy" },
  { key: "LOSSY", label: "Lossy", bar: "bg-codec", text: "text-codec" },
  { key: "UNCERTAIN", label: "Uncertain", bar: "bg-warn", text: "text-warn" },
  { key: "UNKNOWN", label: "Unknown", bar: "bg-muted", text: "text-muted" },
];

// The headline rollup. Probably-lossy folds into lossy (a "lossless" file
// that's actually a transcode); uncertain + unknown are the can't-tell bucket.
export function verdictRollup(counts: Record<Verdict, number>) {
  const total = VERDICT_META.reduce((s, v) => s + counts[v.key], 0);
  return {
    total,
    lossless: counts.LOSSLESS,
    lossy: counts.LOSSY + counts["PROBABLY-LOSSY"],
    unsure: counts.UNCERTAIN + counts.UNKNOWN,
  };
}

// "78%", "1.4%", "0%": one decimal under 10%, whole numbers above.
export function fmtPct(n: number, total: number): string {
  if (!total) return "0%";
  const p = (100 * n) / total;
  return `${p.toFixed(p < 10 && p > 0 ? 1 : 0)}%`;
}

// The lossy headline group mixes two colours (lilac probably-lossy, teal lossy).
// Its number takes the colour of the larger part, so it matches what most of
// its span of the bar shows.
export function lossyGroupText(counts: Record<Verdict, number>): string {
  return counts.LOSSY >= counts["PROBABLY-LOSSY"] ? "text-codec" : "text-lossy";
}
