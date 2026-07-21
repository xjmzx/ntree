import type { MirrorPair, ScanRow } from "./tauri";

/** Split a full track path relative to the library root into
 *  [artist, release/album, track filename]. Mirrors the Python splitter
 *  in flac_library_browser.py. */
export function splitPath(fp: string, root: string): [string, string, string] {
  let rel = fp;
  if (root && rel.startsWith(root)) rel = rel.slice(root.length);
  rel = rel.replace(/^\/+/, "");
  const parts = rel.split("/");
  if (parts.length >= 3) {
    return [parts[0], parts.slice(1, -1).join("/"), parts[parts.length - 1]];
  }
  if (parts.length === 2) return [parts[0], "(no album)", parts[1]];
  return ["(unknown)", "(no album)", parts[0] ?? rel];
}

/** Distinct (artist, release) pairs across a set of scan rows. */
export function uniquePairs(rows: ScanRow[], libRoot: string): MirrorPair[] {
  const seen = new Set<string>();
  const pairs: MirrorPair[] = [];
  for (const r of rows) {
    const [artist, release] = splitPath(r.path, libRoot);
    const key = `${artist}//${release}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ artist, release });
  }
  return pairs;
}

/**
 * Compute the "source signature" for one source track — the relative
 * path under `srcRoot` with the file extension stripped. Matches the
 * format `scan_sample_dest` returns for already-sampled clips, so a
 * frontend lookup is `set.has(sourceSignature(row.path, libRoot))`.
 */
export function sourceSignature(srcPath: string, srcRoot: string): string {
  const sr = srcRoot.replace(/\/+$/, "");
  const stripExt = (n: string) => {
    const i = n.lastIndexOf(".");
    return i < 0 ? n : n.substring(0, i);
  };
  if (sr && srcPath.startsWith(sr + "/")) {
    const rel = srcPath.substring(sr.length + 1);
    const parts = rel.split("/");
    const base = parts.pop() || "sample";
    const baseNoExt = stripExt(base);
    return parts.length ? `${parts.join("/")}/${baseNoExt}` : baseNoExt;
  }
  const base = srcPath.split("/").pop() || "sample";
  return stripExt(base);
}

/**
 * Compute the sample output path for one source track.
 * `<srcRoot>/Artist/Album/track.flac` → `<destRoot>/Artist/Album/track.10s.flac`.
 * Falls back to a flat basename under destRoot for paths outside srcRoot
 * (shouldn't happen with scan results, but defensive).
 */
export function sampleDestPath(
  srcPath: string,
  srcRoot: string,
  destRoot: string,
  durationSecs: number,
): string {
  const sr = srcRoot.replace(/\/+$/, "");
  const dr = destRoot.replace(/\/+$/, "");
  const stripExt = (n: string) => {
    const i = n.lastIndexOf(".");
    return i < 0 ? n : n.substring(0, i);
  };
  const suffix = `.${durationSecs}s.flac`;
  if (sr && srcPath.startsWith(sr + "/")) {
    const rel = srcPath.substring(sr.length + 1);
    const parts = rel.split("/");
    const base = parts.pop() || "sample";
    const subDir = parts.join("/");
    const baseOut = stripExt(base) + suffix;
    return subDir ? `${dr}/${subDir}/${baseOut}` : `${dr}/${baseOut}`;
  }
  const base = srcPath.split("/").pop() || "sample";
  return `${dr}/${stripExt(base) + suffix}`;
}

/**
 * From a clip signature (relpath with the `.<dur>s.flac` suffix stripped, as
 * `scanSampleDest` returns) build a Compress item: the FLAC clip under
 * `flacRoot` and its web-optimised Opus counterpart under `opusRoot`, mirroring
 * the tree. `<flacRoot>/Artist/Album/track.10s.flac`
 * → `<opusRoot>/Artist/Album/track.10s.opus`.
 */
export function clipCompressItem(
  sig: string,
  flacRoot: string,
  opusRoot: string,
  durationSecs: number,
): { src: string; dest: string } {
  const fr = flacRoot.replace(/\/+$/, "");
  const or = opusRoot.replace(/\/+$/, "");
  return {
    src: `${fr}/${sig}.${durationSecs}s.flac`,
    dest: `${or}/${sig}.${durationSecs}s.opus`,
  };
}
