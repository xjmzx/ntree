import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Film,
  Pause,
  Play,
} from "lucide-react";
import { LeafDots, ReleaseTree } from "./LeafIcon";
import { cn } from "../lib/cn";
import { splitPath } from "../lib/paths";
import { openFolder, type ScanRow, type Verdict } from "../lib/tauri";

const VERDICT_COLOR: Record<Verdict, string> = {
  LOSSLESS: "text-ok",
  "PROBABLY-LOSSY": "text-alert",
  UNCERTAIN: "text-warn",
  LOSSY: "text-lossy",
  UNKNOWN: "text-muted",
};

interface TrackRow extends ScanRow {
  _artist: string;
  _album: string;
  _track: string;
}

// A video (audio-visual) file isn't analysed — the backend marks it with
// info "video". Kept out of `tracks` so all audio logic (verdict tallies,
// sampling, leaf-dots) is untouched; surfaced as a parallel display-only list.
const isVideoRow = (r: ScanRow): boolean => r.info === "video";

interface Album {
  name: string;
  tracks: TrackRow[]; // audio only
  videos: TrackRow[]; // audio-visual files — display only, never analysed/sampled
  /** Verdict tally, computed once in group() — avoids re-running countsFor
   *  over the tracks on every render of the (often fully-expanded) tree. */
  verdictCounts: Record<Verdict, number>;
}

interface Artist {
  name: string;
  albums: Album[];
  totalTracks: number;
  videoCount: number;
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
    let videoCount = 0;
    const artistCounts = countsFor([]); // zeroed tally to accumulate into
    for (const [aname, allRows] of albumsMap) {
      // Split audio (analysed) from video (display-only) so existing
      // audio logic operates on `tracks` exactly as before.
      const tracks = allRows.filter((r) => !isVideoRow(r));
      const videos = allRows.filter(isVideoRow);
      const cmp = (a: TrackRow, b: TrackRow) =>
        a._track.toLowerCase().localeCompare(b._track.toLowerCase());
      tracks.sort(cmp);
      videos.sort(cmp);
      const verdictCounts = countsFor(tracks);
      albums.push({ name: aname, tracks, videos, verdictCounts });
      totalTracks += tracks.length;
      videoCount += videos.length;
      (Object.keys(verdictCounts) as Verdict[]).forEach((v) => {
        artistCounts[v] += verdictCounts[v];
      });
    }
    albums.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    out.push({ name, albums, totalTracks, videoCount, verdictCounts: artistCounts });
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

// Sample-state of a scope as a simple status dot, reusing the suite's three
// colour values: not sampled (muted) · sampled (ok green) · sampled + published
// (mauve). Replaces the old colour-coded leaf on the scope sample buttons.
//
// "Published" HERE means a CLIP this app pushed as a NIP-94 kind:1063 file
// event, tracked in localStorage with no relay verification. It is NOT the
// filter bar's `released` chip, which means a kind:31237 RELEASE that *ndisc*
// published. Two kinds, two subjects, two sources of truth — the tooltips say
// which, because the colour cannot.
//
// Note the precedence: mauve beats green, so a scope that is published but only
// half-sampled looks the same as one fully sampled. The tooltip carries the
// real counts.
function scopeStatus(
  tracks: ScanRow[],
  hasSample: (r: ScanRow) => boolean,
  isPublished: (r: ScanRow) => boolean,
): { sampled: number; published: number; dot: string } {
  const sampled = tracks.filter(hasSample).length;
  const published = tracks.filter(isPublished).length;
  const dot =
    published > 0 ? "bg-nostr" : sampled > 0 ? "bg-ok" : "bg-muted/40";
  return { sampled, published, dot };
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
   * Returns true if the row's clip has been published to Nostr (tracked
   * locally — recorded when you publish from the Sample panel).
   */
  isPublished: (row: ScanRow) => boolean;
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
  /** Source-signature of the row selected into the left Sample panel. */
  selectedSig: string | null;
  /** Select a track into the left Sample panel (info · preview · publish). */
  onSelect: (row: ScanRow) => void;
}

export function LibraryTree({
  rows,
  libRoot,
  anyFilter,
  onOpenStatus,
  onSampleScope,
  hasSample,
  isPublished,
  playingSig,
  onPlaySample,
  signatureOf,
  selectedSig,
  onSelect,
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
          // Audio AND video. A clip is an *audio* excerpt, and a music
          // video's audio is legitimate library content — the batch Scissors
          // has always included them, so the per-scope one must too or the
          // two buttons mean different things by "this release".
          const allArtistTracks = artist.albums.flatMap((a) => [
            ...a.tracks,
            ...a.videos,
          ]);
          const {
            sampled: sampledHere,
            published: publishedHere,
            dot: artistDot,
          } = scopeStatus(allArtistTracks, hasSample, isPublished);
          const artistDotTitle =
            publishedHere > 0
              ? `${publishedHere} of ${allArtistTracks.length} clips published to Nostr by this app (kind:1063) · click to (re)sample`
              : sampledHere > 0
                ? `${sampledHere} of ${allArtistTracks.length} tracks sampled · click to sample the rest`
                : `Sample ${artist.totalTracks} tracks across ${artist.albums.length} releases — 10s each`;
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
                  {/* Release count — a leaf-green numbered circle (suite
                      CountBadge): "how many releases under this artist", the
                      same glyph ndisc uses for a release's disc count. The
                      square tile / dots stay reserved for tracks. */}
                  <span className="flex items-center gap-2 shrink-0">
                    {artist.videoCount > 0 && (
                      <span
                        className="inline-flex items-center gap-0.5 text-mauve"
                        title={`${artist.videoCount} video file${artist.videoCount === 1 ? "" : "s"}`}
                      >
                        <Film size={12} className="shrink-0" />
                        <span className="text-[10px]">{artist.videoCount}</span>
                      </span>
                    )}
                    <ReleaseTree n={artist.albums.length} />
                  </span>
                </button>
                <button
                  onClick={() => onSampleScope(artist.name, allArtistTracks)}
                  title={artistDotTitle}
                  className="ml-2 shrink-0 inline-flex items-center justify-center
                             h-5 px-1.5 rounded bg-mauve/20 hover:bg-mauve/30
                             transition-colors"
                  aria-label={`Sample all tracks by ${artist.name}`}
                >
                  <span
                    className={cn("w-2.5 h-2.5 rounded-full transition-colors", artistDot)}
                  />
                </button>
              </div>
              {isOpen &&
                artist.albums.map((album) => {
                  const key = `${artist.name}//${album.name}`;
                  const alOpen = openAlbums.has(key);
                  // Everything with an audio track in it — audio files and
                  // videos alike. Matches what the batch Scissors samples.
                  const albumSampleable = [...album.tracks, ...album.videos];
                  const {
                    sampled: alSampled,
                    published: alPublished,
                    dot: alDot,
                  } = scopeStatus(albumSampleable, hasSample, isPublished);
                  const alDotTitle =
                    alPublished > 0
                      ? `${alPublished} of ${album.tracks.length} clips published to Nostr by this app (kind:1063) · click to (re)sample`
                      : alSampled > 0
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
                          {/* leaf-dots = audio tracks on this release (branch);
                              a Film marker flags any audio-visual files. */}
                          <span className="flex items-center justify-end gap-1.5 shrink-0">
                            {album.videos.length > 0 && (
                              <span
                                className="inline-flex items-center gap-0.5 text-mauve"
                                title={`${album.videos.length} video file${album.videos.length === 1 ? "" : "s"}`}
                              >
                                <Film size={11} className="shrink-0" />
                                {album.videos.length > 1 && (
                                  <span className="text-[10px]">{album.videos.length}</span>
                                )}
                              </span>
                            )}
                            <LeafDots
                              n={album.tracks.length}
                              maxCols={8}
                              maxRows={4}
                            />
                          </span>
                        </button>
                        <button
                          onClick={() =>
                            onSampleScope(
                              `${artist.name} / ${album.name}`,
                              albumSampleable,
                            )
                          }
                          title={alDotTitle}
                          className="ml-2 shrink-0 inline-flex items-center justify-center
                                     h-5 px-1.5 rounded bg-mauve/20 hover:bg-mauve/30
                                     transition-colors"
                          aria-label={`Sample release ${album.name}`}
                        >
                          <span
                            className={cn("w-2.5 h-2.5 rounded-full transition-colors", alDot)}
                          />
                        </button>
                      </div>
                      {alOpen &&
                        album.tracks.map((t, i) => {
                          const sampled = hasSample(t);
                          const isPlaying = sampled && playingSig === signatureOf(t);
                          const selected = selectedSig === signatureOf(t);
                          return (
                            <div
                              key={t.path}
                              onClick={() => onSelect(t)}
                              onDoubleClick={() => openTrackFolder(t)}
                              title={t.path}
                              className={cn(
                                "grid grid-cols-[16px_1fr_120px_90px_70px] gap-2 items-center",
                                "pl-12 pr-3 py-0.5 text-xs font-mono cursor-pointer",
                                "hover:bg-surface/40",
                                i % 2 === 1 && "bg-bg/40",
                                selected && "bg-accent/15 hover:bg-accent/20",
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
                      {/* Audio-visual files — never *analysed* (no lossless
                          verdict), but they ARE sampled: the clip is an audio
                          excerpt, and a music video's audio counts. Double-click
                          reveals in folder. */}
                      {alOpen &&
                        album.videos.map((v) => (
                          <div
                            key={v.path}
                            onDoubleClick={() => openTrackFolder(v)}
                            title={`${v.path} · video (not analysed)`}
                            className={cn(
                              "grid grid-cols-[16px_1fr_120px_90px_70px] gap-2 items-center",
                              "pl-12 pr-3 py-0.5 text-xs font-mono",
                              "hover:bg-surface/40 text-fg/70",
                            )}
                          >
                            <span className="flex items-center justify-center text-mauve">
                              <Film size={11} />
                            </span>
                            <span className="truncate text-fg/80">{v._track}</span>
                            <span className="text-mauve">video</span>
                            <span className="text-right text-muted" />
                            <span className="text-right text-muted" />
                          </div>
                        ))}
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
