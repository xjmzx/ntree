import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Pause,
  Play,
  Sprout,
  Upload,
} from "lucide-react";
import { LeafIcon } from "./LeafIcon";
import { cn } from "../lib/cn";
import { splitPath } from "../lib/paths";
import { openFolder, type ScanRow, type Verdict } from "../lib/tauri";

const VERDICT_COLOR: Record<Verdict, string> = {
  LOSSLESS: "text-ok",
  "PROBABLY-LOSSY": "text-alert",
  UNCERTAIN: "text-warn",
  LOSSY: "text-mauve",
  UNKNOWN: "text-muted",
};

interface TrackRow extends ScanRow {
  _artist: string;
  _album: string;
  _track: string;
}

interface Album {
  name: string;
  tracks: TrackRow[];
  /** Verdict tally, computed once in group() — avoids re-running countsFor
   *  over the tracks on every render of the (often fully-expanded) tree. */
  verdictCounts: Record<Verdict, number>;
}

interface Artist {
  name: string;
  albums: Album[];
  totalTracks: number;
  verdictCounts: Record<Verdict, number>;
}

function group(rows: ScanRow[], root: string): Artist[] {
  const byArtist = new Map<string, Map<string, TrackRow[]>>();
  for (const r of rows) {
    const [artist, album, track] = splitPath(r.path, root);
    const albums = byArtist.get(artist) ?? new Map<string, TrackRow[]>();
    if (!byArtist.has(artist)) byArtist.set(artist, albums);
    const tracks = albums.get(album) ?? [];
    if (!albums.has(album)) albums.set(album, tracks);
    tracks.push({ ...r, _artist: artist, _album: album, _track: track });
  }
  const out: Artist[] = [];
  for (const [name, albumsMap] of byArtist) {
    const albums: Album[] = [];
    let totalTracks = 0;
    const artistCounts = countsFor([]); // zeroed tally to accumulate into
    for (const [aname, tracks] of albumsMap) {
      tracks.sort((a, b) => a._track.toLowerCase().localeCompare(b._track.toLowerCase()));
      const verdictCounts = countsFor(tracks);
      albums.push({ name: aname, tracks, verdictCounts });
      totalTracks += tracks.length;
      (Object.keys(verdictCounts) as Verdict[]).forEach((v) => {
        artistCounts[v] += verdictCounts[v];
      });
    }
    albums.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    out.push({ name, albums, totalTracks, verdictCounts: artistCounts });
  }
  out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return out;
}

function countsFor(tracks: TrackRow[]): Record<Verdict, number> {
  const c: Record<Verdict, number> = {
    LOSSLESS: 0,
    "PROBABLY-LOSSY": 0,
    UNCERTAIN: 0,
    LOSSY: 0,
    UNKNOWN: 0,
  };
  for (const t of tracks) c[t.verdict]++;
  return c;
}

/**
 * Foliage meter — a fixed-width magnitude gauge. Three slots of the same
 * glyph (leaves for tracks, sprouts for releases); the first `litCount(n)`
 * are lit, the rest dimmed. The exact figure is unimportant on the row (it
 * lives in the title/hover) — the point is a glanceable "how much", and the
 * fixed three-slot width keeps every row aligned across all filtered views.
 */
function litCount(n: number, kind: "leaf" | "plant"): number {
  if (n <= 0) return 0;
  if (kind === "leaf") return n >= 50 ? 3 : n >= 10 ? 2 : 1;
  return n >= 10 ? 3 : n >= 3 ? 2 : 1;
}

function Meter({
  n,
  kind,
  title,
}: {
  n: number;
  kind: "leaf" | "plant";
  title: string;
}) {
  const lit = litCount(n, kind);
  const Glyph = kind === "leaf" ? LeafIcon : Sprout;
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title={title}
      aria-label={title}
    >
      {[0, 1, 2].map((i) => (
        <Glyph
          key={i}
          size={12}
          className={cn(
            // leaves share the filter bar's ~10°-past-12:00 lean; sprouts
            // stay upright (they're plants, not leaves).
            kind === "leaf" && "rotate-[10deg]",
            i < lit ? "text-fg/70" : "text-muted/25",
          )}
        />
      ))}
    </span>
  );
}

interface LibraryTreeProps {
  rows: ScanRow[];
  libRoot: string;
  anyFilter: boolean;
  onOpenStatus: (s: { text: string; tone: "muted" | "warn" | "ok" | "alert" }) => void;
  /**
   * Per-scope Sample action. `label` is the human-readable scope name
   * (artist name, or "artist / album"), used for confirmation copy +
   * status. `tracks` is the exact row subset to sample. Layout-only for
   * now — the implementation in App.tsx just emits a status message
   * until backend lands.
   */
  onSampleScope: (label: string, tracks: ScanRow[]) => void;
  /**
   * Returns true if a 10-second clip exists under the workspace dest for
   * the given row. Used to tint the leaf sample button (grey → green, or
   * purple when partial) on artist/album rows that already have clips.
   */
  hasSample: (row: ScanRow) => boolean;
  /**
   * Source-signature of the row whose clip is currently playing (or
   * null when nothing's playing). Drives the Play/Pause icon swap on
   * per-track rows; matches the keys `hasSample` uses.
   */
  playingSig: string | null;
  /** Toggle play/stop for a row's sampled clip. */
  onPlaySample: (row: ScanRow) => void;
  /** Compute the same signature App uses, so rows can match `playingSig`. */
  signatureOf: (row: ScanRow) => string;
  /** Open the publish dialog for a row's sampled clip. */
  onPublishSample: (row: ScanRow) => void;
}

export function LibraryTree({
  rows,
  libRoot,
  anyFilter,
  onOpenStatus,
  onSampleScope,
  hasSample,
  playingSig,
  onPlaySample,
  signatureOf,
  onPublishSample,
}: LibraryTreeProps) {
  const artists = useMemo(() => group(rows, libRoot), [rows, libRoot]);
  const [openArtists, setOpenArtists] = useState<Set<string>>(new Set());
  const [openAlbums, setOpenAlbums] = useState<Set<string>>(new Set());

  // Entering a filter starts the view fully collapsed — artists AND releases —
  // exactly like startup and Collapse-all. Only the matching artists are
  // listed; click to drill in. Acting only on the transition into filtering
  // (guarded by the ref) means a manual expand made while refining the query
  // sticks. It's also the cheapest render: nothing but artist rows mounts
  // until you open one.
  const wasFiltering = useRef(false);
  useEffect(() => {
    if (anyFilter && !wasFiltering.current) {
      setOpenArtists(new Set());
      setOpenAlbums(new Set());
    }
    wasFiltering.current = anyFilter;
  }, [anyFilter]);

  function toggleArtist(name: string) {
    const next = new Set(openArtists);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setOpenArtists(next);
  }
  function toggleAlbum(key: string) {
    const next = new Set(openAlbums);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpenAlbums(next);
  }

  function expandAll() {
    setOpenArtists(new Set(artists.map((a) => a.name)));
    setOpenAlbums(
      new Set(artists.flatMap((a) => a.albums.map((al) => `${a.name}//${al.name}`))),
    );
  }
  function collapseAll() {
    setOpenArtists(new Set());
    setOpenAlbums(new Set());
  }

  async function openTrackFolder(row: TrackRow) {
    const full = `${libRoot.replace(/\/$/, "")}/${row._artist}/${row._album}/${row._track}`;
    const folder = full.split("/").slice(0, -1).join("/");
    try {
      await openFolder(folder);
      onOpenStatus({ text: `opened ${folder}`, tone: "muted" });
    } catch (e) {
      onOpenStatus({ text: `open failed: ${e}`, tone: "alert" });
    }
  }

  return (
    <>
      {/* Bare tree — no Section wrapper. The merged "Library" Section in
          App.tsx provides the title/icon/collapse + the flex-1 sizing. */}
      <div className="flex items-center justify-end gap-1 shrink-0 -mt-1">
        <button
          onClick={collapseAll}
          disabled={artists.length === 0}
          title="Collapse all"
          className="px-2 py-1 rounded text-muted hover:text-fg hover:bg-surface/40
                     disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronsDownUp size={14} />
        </button>
        <button
          onClick={expandAll}
          disabled={artists.length === 0}
          title="Expand all"
          className="px-2 py-1 rounded text-muted hover:text-fg hover:bg-surface/40
                     disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronsUpDown size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto rounded-md bg-bg/40 divide-y divide-surface/40">
        {artists.length === 0 && (
          <div className="h-full flex items-center justify-center text-center text-muted text-xs p-8">
            <span>
              No tracks to display.<br />
              Run a scan, or clear the active filter (Esc).
            </span>
          </div>
        )}
        {artists.map((artist) => {
          const isOpen = openArtists.has(artist.name);
          const allArtistTracks = artist.albums.flatMap((a) => a.tracks);
          const sampledHere = allArtistTracks.filter(hasSample).length;
          const sampleState =
            sampledHere === 0
              ? "none"
              : sampledHere === allArtistTracks.length
                ? "all"
                : "partial";
          const leafClass =
            sampleState === "all"
              ? "text-ok"
              : sampleState === "partial"
                ? "text-mauve"
                : "text-muted";
          const leafTitle =
            sampleState === "all"
              ? `All ${allArtistTracks.length} tracks already sampled · click to re-sample`
              : sampleState === "partial"
                ? `${sampledHere} of ${allArtistTracks.length} tracks sampled · click to sample the rest`
                : `Sample ${artist.totalTracks} tracks across ${artist.albums.length} albums — 10s each`;
          return (
            <div key={artist.name}>
              <div className="w-full flex items-center pr-2 py-1.5 hover:bg-surface/30">
                <button
                  onClick={() => toggleArtist(artist.name)}
                  className="flex-1 min-w-0 flex items-center gap-2 px-3 text-left
                             text-accent font-semibold text-sm"
                >
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="flex-1 truncate">{artist.name}</span>
                  {/* Foliage meter — plants = releases, leaves = tracks.
                      Both fixed three-slot gauges (magnitude, not exact
                      counts) so the column aligns on every row. */}
                  <span className="flex items-center gap-2 shrink-0">
                    <Meter
                      n={artist.albums.length}
                      kind="plant"
                      title={`${artist.albums.length} release${artist.albums.length === 1 ? "" : "s"}`}
                    />
                    <Meter
                      n={artist.totalTracks}
                      kind="leaf"
                      title={`${artist.totalTracks.toLocaleString()} track${artist.totalTracks === 1 ? "" : "s"}`}
                    />
                  </span>
                </button>
                <button
                  onClick={() => onSampleScope(artist.name, allArtistTracks)}
                  title={leafTitle}
                  className={cn(
                    "ml-2 px-2 py-1 rounded hover:text-accent hover:bg-surface/40 shrink-0",
                    leafClass,
                  )}
                  aria-label={`Sample all tracks by ${artist.name}`}
                >
                  <LeafIcon size={14} className="rotate-[10deg]" />
                </button>
              </div>
              {isOpen &&
                artist.albums.map((album) => {
                  const key = `${artist.name}//${album.name}`;
                  const alOpen = openAlbums.has(key);
                  const alSampled = album.tracks.filter(hasSample).length;
                  const alState =
                    alSampled === 0
                      ? "none"
                      : alSampled === album.tracks.length
                        ? "all"
                        : "partial";
                  const alLeafClass =
                    alState === "all"
                      ? "text-ok"
                      : alState === "partial"
                        ? "text-mauve"
                        : "text-muted";
                  const alLeafTitle =
                    alState === "all"
                      ? `All ${album.tracks.length} tracks already sampled · click to re-sample`
                      : alState === "partial"
                        ? `${alSampled} of ${album.tracks.length} tracks sampled · click to sample the rest`
                        : `Sample ${album.tracks.length} tracks from this release — 10s each`;
                  return (
                    <div key={key}>
                      <div className="w-full flex items-center pr-2 py-1 hover:bg-surface/20">
                        <button
                          onClick={() => toggleAlbum(key)}
                          className="flex-1 min-w-0 flex items-center gap-2 pl-8 pr-2
                                     text-left text-fg italic text-sm"
                        >
                          {alOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <span className="flex-1 truncate">{album.name}</span>
                          {/* leaves = tracks (one release ⇒ no plant meter);
                              right-anchored so it aligns under the artist
                              leaf meter above. */}
                          <span className="flex items-center shrink-0">
                            <Meter
                              n={album.tracks.length}
                              kind="leaf"
                              title={`${album.tracks.length.toLocaleString()} track${album.tracks.length === 1 ? "" : "s"}`}
                            />
                          </span>
                        </button>
                        <button
                          onClick={() => onSampleScope(`${artist.name} / ${album.name}`, album.tracks)}
                          title={alLeafTitle}
                          className={cn(
                            "ml-2 px-2 py-1 rounded hover:text-accent hover:bg-surface/40 shrink-0",
                            alLeafClass,
                          )}
                          aria-label={`Sample release ${album.name}`}
                        >
                          <LeafIcon size={14} className="rotate-[10deg]" />
                        </button>
                      </div>
                      {alOpen &&
                        album.tracks.map((t, i) => {
                          const sampled = hasSample(t);
                          const isPlaying = sampled && playingSig === signatureOf(t);
                          return (
                            <div
                              key={t.path}
                              onDoubleClick={() => openTrackFolder(t)}
                              title={t.path}
                              className={cn(
                                "grid grid-cols-[16px_16px_1fr_120px_90px_70px] gap-2 items-center",
                                "pl-12 pr-3 py-0.5 text-xs font-mono cursor-pointer",
                                "hover:bg-surface/40",
                                i % 2 === 1 && "bg-bg/40",
                              )}
                            >
                              {sampled ? (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onPlaySample(t);
                                  }}
                                  title={
                                    isPlaying
                                      ? "Stop playback"
                                      : "Play 10s sample"
                                  }
                                  aria-label={
                                    isPlaying
                                      ? `Stop playback of ${t._track}`
                                      : `Play sample of ${t._track}`
                                  }
                                  className={cn(
                                    "flex items-center justify-center rounded",
                                    "hover:text-accent",
                                    isPlaying ? "text-mauve" : "text-ok",
                                  )}
                                >
                                  {isPlaying ? (
                                    <Pause size={11} />
                                  ) : (
                                    <Play size={11} />
                                  )}
                                </button>
                              ) : (
                                <span aria-hidden className="block w-4 h-4" />
                              )}
                              {sampled ? (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onPublishSample(t);
                                  }}
                                  title="Publish to Nostr (kind:1063)"
                                  aria-label={`Publish ${t._track} to Nostr`}
                                  className="flex items-center justify-center rounded
                                             text-muted hover:text-accent"
                                >
                                  <Upload size={11} />
                                </button>
                              ) : (
                                <span aria-hidden className="block w-4 h-4" />
                              )}
                              <span className="truncate text-fg/80">{t._track}</span>
                              <span className={cn(VERDICT_COLOR[t.verdict])}>{t.verdict}</span>
                              <span className="text-right text-muted">
                                {t.peak !== null ? `${t.peak >= 0 ? "+" : ""}${t.peak.toFixed(1)} dB` : ""}
                              </span>
                              <span className="text-right text-muted">
                                {t.sr ? `${t.sr.toLocaleString()} Hz` : ""}
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </>
  );
}
