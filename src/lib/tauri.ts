import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Verdict =
  | "LOSSLESS"
  | "PROBABLY-LOSSY"
  | "UNCERTAIN"
  | "LOSSY"
  | "UNKNOWN";

export const VERDICTS: Verdict[] = [
  "LOSSLESS",
  "PROBABLY-LOSSY",
  "UNCERTAIN",
  "LOSSY",
  "UNKNOWN",
];

export interface ScanRow {
  verdict: Verdict;
  path: string;
  peak: number | null;
  sr: number | null;
  info: string;
}

export interface ScanReport {
  root: string;
  generated: string;
  rows: ScanRow[];
}

export interface ScanProgress {
  done: number;
  total: number;
  path: string;
  verdict: Verdict;
}

export interface AudioCount {
  fileCount: number;
  totalBytes: number;
}

export interface MirrorPair {
  artist: string;
  release: string;
}

export interface MirrorResult {
  created: number;
  skipped: number;
  errors: string[];
}

export async function scanLibrary(
  root: string,
  workers?: number,
): Promise<ScanReport> {
  return invoke<ScanReport>("scan_library", { root, workers: workers ?? null });
}

// --- video classification (verify types for the Normalize-videos plan) ---

export type VideoBucket =
  | "plays"
  | "remux"
  | "audioFix"
  | "transcode"
  | "unknown";

export interface VideoRow {
  path: string;
  vcodec: string | null;
  acodec: string | null;
  container: string;
  faststart: boolean;
  bucket: VideoBucket;
}

/** Read-only census: probe every video under `root` and bucket it (plays /
 *  remux / audioFix / transcode). Nothing is modified. */
export async function classifyVideos(root: string): Promise<VideoRow[]> {
  return invoke<VideoRow[]>("classify_videos", { root });
}

// --- normalize videos (Part B: remux / transcode to playable mp4) ---

export interface NormalizeItem {
  path: string;
  bucket: VideoBucket; // remux | audioFix | transcode
}

export type NormalizeOutcome =
  | "Converted"
  | "Skipped"
  | "Failed"
  | "TimedOut"
  | "Cancelled";

export interface NormalizeProgress {
  done: number;
  total: number;
  path: string;
  bucket: string;
  outcome: NormalizeOutcome;
}

export interface NormalizeReport {
  total: number;
  converted: number;
  skipped: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  errors: string[];
}

/** Convert each item to a playable mp4 in place; the original is moved to a
 *  parallel backup tree (never deleted). Writes files. */
export async function normalizeVideos(
  items: NormalizeItem[],
  root: string,
  backupRoot: string,
): Promise<NormalizeReport> {
  return invoke<NormalizeReport>("normalize_videos", { items, root, backupRoot });
}

export async function cancelNormalize(): Promise<void> {
  return invoke("cancel_normalize");
}

export function onNormalizeProgress(
  cb: (p: NormalizeProgress) => void,
): Promise<UnlistenFn> {
  return listen<NormalizeProgress>("normalize-progress", (e) => cb(e.payload));
}

export async function countAudioFiles(root: string): Promise<AudioCount> {
  return invoke<AudioCount>("count_audio_files", { root });
}

export async function cancelScan(): Promise<void> {
  await invoke("cancel_scan");
}

export async function createMirrorTree(
  dest: string,
  sourceRoot: string,
  pairs: MirrorPair[],
  sudo: boolean,
): Promise<MirrorResult> {
  return invoke<MirrorResult>("create_mirror_tree", {
    dest,
    sourceRoot,
    pairs,
    sudo,
  });
}

export async function loadReport(): Promise<ScanReport | null> {
  return invoke<ScanReport | null>("load_report");
}

export async function saveReport(report: ScanReport): Promise<void> {
  return invoke("save_report", { report });
}

export async function openFolder(path: string): Promise<void> {
  return invoke("open_folder", { path });
}

// --- Mirror-tree folder management -----------------------------------------

/// A leaf folder under the mirror dest. `audioCount === 0` = an empty folder
/// (e.g. a stale sampling leftover) — the obvious deletion candidate.
export interface DestFolder {
  rel: string; // "Artist/Release" relative to dest
  path: string; // absolute
  audioCount: number;
}

export async function listDestFolders(dest: string): Promise<DestFolder[]> {
  return invoke<DestFolder[]>("list_dest_folders", { dest });
}

/// Move a mirror-dest folder to the OS trash (recoverable). Guarded server-side
/// to paths strictly inside `dest`.
export async function trashDestFolder(
  dest: string,
  root: string,
  path: string,
): Promise<void> {
  return invoke("trash_dest_folder", { dest, root, path });
}

/// mkdir a relative folder under the mirror dest; returns its absolute path.
export async function createDestFolder(
  dest: string,
  rel: string,
): Promise<string> {
  return invoke<string>("create_dest_folder", { dest, rel });
}

export async function onScanProgress(
  cb: (p: ScanProgress) => void,
): Promise<UnlistenFn> {
  return listen<ScanProgress>("scan-progress", (event) => cb(event.payload));
}

// ---- sampler -----------------------------------------------------------

export interface SampleItem {
  src: string;
  dest: string;
}

export type SampleOutcome =
  | "Created"
  | "Skipped"
  | "Failed"
  | "TimedOut"
  | "Cancelled";

export interface SampleProgress {
  done: number;
  total: number;
  path: string;
  outcome: SampleOutcome;
}

export interface SampleReport {
  total: number;
  created: number;
  skipped: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  errors: string[];
}

export async function sampleTracks(
  items: SampleItem[],
  durationSecs: number,
  startOffsetSecs: number,
  workers?: number,
): Promise<SampleReport> {
  return invoke<SampleReport>("sample_tracks", {
    items,
    durationSecs,
    startOffsetSecs,
    workers: workers ?? null,
  });
}

export async function cancelSample(): Promise<void> {
  await invoke("cancel_sample");
}

/**
 * Returns "signatures" of already-sampled tracks under the workspace
 * dest. Each signature is the relative path with the `.<dur>s.flac`
 * suffix stripped — pair with `sourceSignature(srcPath, srcRoot)` in
 * lib/paths.ts to look up whether a given source row has a clip on
 * disk. Empty list if dest doesn't exist yet.
 */
export async function scanSampleDest(
  destRoot: string,
  durationSecs: number,
): Promise<string[]> {
  return invoke<string[]>("scan_sample_dest", { destRoot, durationSecs });
}

/**
 * Read raw bytes of a local audio file for playback via a Blob URL.
 * Bypasses asset:// (which throws NotSupportedError on this WebKit2GTK).
 * Returns the bytes as a number[] which the caller wraps in a Uint8Array.
 */
export async function readAudioBytes(path: string): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("read_audio_bytes", { path });
  return new Uint8Array(bytes);
}

// ---- NIP-96 upload + NIP-94 publish ----

export const DEFAULT_NIP96_ENDPOINT =
  "https://nostr.build/api/v2/nip96/upload";

export interface UploadResult {
  url: string;
  hash: string;
  size: number;
  mime: string;
}

export interface FilePublishResult {
  eventId: string;
  acceptedBy: string[];
  rejected: RelayError[];
}

/**
 * SHA-256 hex digest of `bytes` via WebCrypto. Used to compute both the
 * NIP-98 payload hash and the NIP-94 `x` tag.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Sign a kind:27235 HTTP-auth event in Rust (sk stays in keychain) and
 * return the "Nostr <base64>" Authorization header. Matches smpl-tool's
 * upload-side auth path; only the JSON crosses the IPC boundary.
 */
export async function nip98AuthHeader(
  url: string,
  method: string,
  payloadHash: string,
): Promise<string> {
  const eventJson = await invoke<string>("nip98_sign_event", {
    url,
    method,
    payloadHash,
  });
  return "Nostr " + btoa(eventJson);
}

/** Upload a file to a NIP-96 endpoint (default: nostr.build). */
export async function uploadToNip96(
  bytes: Uint8Array,
  filename: string,
  mime: string,
  endpoint: string = DEFAULT_NIP96_ENDPOINT,
): Promise<UploadResult> {
  const hash = await sha256Hex(bytes);
  const auth = await nip98AuthHeader(endpoint, "POST", hash);

  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes.buffer as ArrayBuffer], { type: mime }),
    filename,
  );

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: auth },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upload ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    nip94_event?: { tags?: string[][] };
    data?: { url?: string }[];
    url?: string;
  };
  const url =
    json?.nip94_event?.tags?.find((t) => t[0] === "url")?.[1] ??
    json?.data?.[0]?.url ??
    json?.url;
  if (!url) throw new Error("upload succeeded but no URL returned");
  return { url, hash, size: bytes.byteLength, mime };
}

/**
 * Publish a kind:1063 file-metadata event for an uploaded file.
 * `tTag` is "sample" or "full" — categorisation for consumers.
 */
export async function publishFileMetadata(
  p: {
    url: string;
    sha256: string;
    size: number;
    mime: string;
    title: string;
    description?: string;
    tTag: "sample" | "full";
    relays: string[];
  },
): Promise<FilePublishResult> {
  return invoke<FilePublishResult>("publish_file_metadata", {
    url: p.url,
    sha256: p.sha256,
    size: p.size,
    mime: p.mime,
    title: p.title,
    description: p.description ?? "",
    tTag: p.tTag,
    relays: p.relays,
  });
}

export async function onSampleProgress(
  cb: (p: SampleProgress) => void,
): Promise<UnlistenFn> {
  return listen<SampleProgress>("sample-progress", (event) => cb(event.payload));
}

// ---- nostr reactions (kind:7 / kind:5 via Rust signing) ----

export interface RelayError {
  relay: string;
  error: string;
}

export interface ReactionResult {
  eventId: string;
  acceptedBy: string[];
  rejected: RelayError[];
}

export async function publishReaction(
  eventId: string,
  authorPk: string,
  targetKind: number,
  content: string,
): Promise<ReactionResult> {
  return invoke<ReactionResult>("publish_reaction", {
    eventId,
    authorPk,
    targetKind,
    content,
  });
}

export async function deleteReaction(
  reactionEventId: string,
): Promise<ReactionResult> {
  return invoke<ReactionResult>("delete_reaction", { reactionEventId });
}

/** A release ndisc has published to Nostr (from the suite-shared manifest). */
export interface ManifestRelease {
  id: number;
  artist: string;
  title: string;
  /** Absolute path of the release folder on disk. */
  dir: string;
}

export interface PublishedManifest {
  version: number;
  generatedAt: number;
  libraryRoot: string | null;
  releases: ManifestRelease[];
}

/** ndisc's published-release manifest, or null if it has never been exported.
 *  Null is a normal state, not an error — the user just hasn't run
 *  "Export published manifest" in ndisc yet. */
export async function loadPublishedManifest(): Promise<PublishedManifest | null> {
  return invoke("load_published_manifest");
}

/// How far the scan report has drifted from disk.
///
/// The report is a snapshot, and everything downstream — the Library tree, the
/// filters, the sampler's scope — reads it as if it were disk. It is not. A
/// stale index is silent by nature: ntree's own video-normalize pass renames
/// files out from under its report, and the sampler then failed on paths that
/// no longer existed for three runs before anyone noticed.
export interface LibraryDrift {
  root: string;
  generated: string | null;
  indexed: number;
  onDisk: number;
  /** On disk but not in the report — the sampler cannot see these at all. */
  unindexed: string[];
  unindexedTotal: number;
  /** In the report but gone from disk — the sampler will try these and fail. */
  stale: string[];
  staleTotal: number;
}

/** null when there is no report — that is nothing to compare against, not drift. */
export async function libraryDrift(): Promise<LibraryDrift | null> {
  return invoke<LibraryDrift | null>("library_drift");
}

/// Clip files whose SOURCE no longer exists — FILE-grain orphans.
///
/// Distinct from the folder-grain check: a track renamed inside a still-valid
/// release leaves a stale clip in a folder that is perfectly fine, and the
/// folder check is structurally incapable of seeing it.
export async function orphanClips(
  dest: string,
  root: string,
  durationSecs: number,
): Promise<string[]> {
  return invoke<string[]>("orphan_clips", { dest, root, durationSecs });
}

/// Trash clip files. Guarded server-side: every path must resolve to something
/// strictly inside `dest`. The source library is never a valid target.
export async function trashDestFiles(
  dest: string,
  root: string,
  paths: string[],
): Promise<number> {
  return invoke<number>("trash_dest_files", { dest, root, paths });
}
