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

/** Does this path segment name a disc subfolder — "CD1", "CD 2", "Disc 3",
 *  "Disk1", …? Kept deliberately in step with the suite reference (nsmpl
 *  `is_disc_dir_name`, src-tauri/src/lib.rs) so multi-disc release layouts
 *  collapse identically across ndisc/nplay/ntree/nsmpl. */
export function isDiscDirName(name: string): boolean {
  const n = name.trim().toLowerCase();
  for (const prefix of ["cd", "disc", "disk"]) {
    if (n.startsWith(prefix)) {
      const rest = n.slice(prefix.length).replace(/^[ ._-]+/, "");
      if (/^[0-9]/.test(rest)) return true;
    }
  }
  return false;
}

/** Collapse a multi-disc album path to its release folder: when the album's
 *  last path segment names a disc ("100lbs/CD1" → "100lbs"), drop it so both
 *  discs land under one album node. DISPLAY-only — this must never feed
 *  `splitPath`, `uniquePairs`, `sourceSignature`, `sampleDestPath`, or the
 *  per-track `_album` used to rebuild file paths, all of which stay per-disc. */
export function collapseDiscAlbum(album: string): string {
  const parts = album.split("/");
  if (parts.length >= 2 && isDiscDirName(parts[parts.length - 1])) {
    return parts.slice(0, -1).join("/");
  }
  return album;
}

/**
 * The folder a scanned file sits in, as a relpath under the library root —
 * "" for a file directly in the root. Taken from the path as it is on disk:
 * this is the key the clip tree mirrors, so it is never tidied or re-derived.
 */
export function sourceDirRel(fp: string, root: string): string {
  let rel = root && fp.startsWith(root) ? fp.slice(root.length) : fp;
  rel = rel.replace(/^\/+/, "");
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

/**
 * Distinct source folders across a set of scan rows — what the clip tree has to
 * mirror. NOT `uniquePairs`: that one is for display and counting, and its
 * "(no album)" stand-in and joined middle segments are not folder names.
 */
export function uniqueDirRels(rows: ScanRow[], libRoot: string): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const rel = sourceDirRel(r.path, libRoot);
    if (rel) seen.add(rel);
  }
  return [...seen];
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
 * Where in a track its clip starts, in whole seconds.
 *
 * The usual place is `offsetSecs` in — past the intro. A track too short for
 * that still gets a clip: the window slides back until it fits, ending at the
 * track's end, and a track shorter than a clip is taken whole from 0. Cutting
 * at the fixed offset regardless is what used to produce a one-second clip of a
 * 31-second track and an empty file for a 29-second one.
 *
 * Unknown duration (a report from before durations were scanned, or a file
 * that would not probe) keeps the usual offset; the backend falls back to 0 on
 * its own if that turns out to be past the end.
 */
export function clipStartSecs(
  durationSecs: number | null | undefined,
  offsetSecs: number,
  clipSecs: number,
): number {
  if (!durationSecs || durationSecs <= 0) return offsetSecs;
  if (durationSecs >= offsetSecs + clipSecs) return offsetSecs;
  return Math.max(0, Math.floor(durationSecs - clipSecs));
}

/**
 * The web-optimised copy of a clip: AAC in an MP4 container. Chosen over Opus
 * for reach — it plays in every browser and on Apple devices without a second
 * thought, which is what a discovery clip is for. Must match the backend's
 * WEB_CLIP_EXT; the extension is how both sides find "already compressed".
 */
export const WEB_CLIP_EXT = "m4a";
export const WEB_CLIP_MIME = "audio/mp4";

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
 * `flacRoot` and its web-optimised AAC counterpart under `webRoot`, mirroring
 * the tree. `<flacRoot>/Artist/Album/track.10s.flac`
 * → `<webRoot>/Artist/Album/track.10s.m4a`.
 */
export function clipCompressItem(
  sig: string,
  flacRoot: string,
  webRoot: string,
  durationSecs: number,
): { src: string; dest: string } {
  const fr = flacRoot.replace(/\/+$/, "");
  const or = webRoot.replace(/\/+$/, "");
  return {
    src: `${fr}/${sig}.${durationSecs}s.flac`,
    dest: `${or}/${sig}.${durationSecs}s.${WEB_CLIP_EXT}`,
  };
}
