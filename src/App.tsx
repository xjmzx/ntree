import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  Columns2,
  FolderTree,
  KeyRound,
  Lock,
  LogOut,
  PanelLeftClose,
  PanelRightClose,
  Radio,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { SimplePool } from "nostr-tools";
import { cn } from "./lib/cn";
import { ScannerControls } from "./components/ScannerControls";
import { SamplerPanel } from "./components/SamplerPanel";
import { Filters, type FilterState } from "./components/Filters";
import { LibraryTree } from "./components/LibraryTree";
import { OperationOutput, type MirrorState } from "./components/OperationOutput";
import { PublishSampleDialog } from "./components/PublishSampleDialog";
import { Section } from "./components/Section";
import { MirrorControls, OrphanStrip } from "./components/MirrorControls";
import { useMirror } from "./lib/useMirror";
import { FeedPanel } from "./components/FeedPanel";
import { NostrPanel } from "./components/NostrPanel";
import {
  cancelSample,
  loadReport,
  onSampleProgress,
  readAudioBytes,
  sampleTracks,
  scanSampleDest,
  type SampleProgress,
  type ScanProgress,
  type ScanRow,
  type Verdict,
} from "./lib/tauri";
import {
  clearIdentity,
  loadIdentity,
  shortNpub,
  type Identity,
} from "./lib/nostr";
import { usePersistedString } from "./lib/usePersistedString";
import { useLibrary } from "./lib/library";
import { sampleDestPath, sourceSignature, uniquePairs } from "./lib/paths";

const SAMPLE_SECS = 10;
const SAMPLE_START_OFFSET_SECS = 30;

// Theme is the one config scalar that stays in App — it's UI chrome, not
// library data. Scanner root / workspace dest / relays moved to lib/library
// (the report-DB + config store).
const THEME_KEY = "afqc-tauri.theme";
const PROFILE_RELAYS = ["wss://relay.fizx.uk"];
type Theme = "fizx" | "upleb";

// Header status chip — tone-tinted background + text per tone.
// Enumerated literal classes so Tailwind JIT sees them at build time.
const TONE_CHIP: Record<"muted" | "warn" | "ok" | "alert", string> = {
  muted: "bg-surface/50 text-fg/80",
  warn: "bg-warn/15 text-warn",
  ok: "bg-ok/15 text-ok",
  alert: "bg-alert/15 text-alert",
};

interface ProfileMeta {
  name?: string;
  display_name?: string;
  nip05?: string;
}

function loadTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY);
  return v === "upleb" ? "upleb" : "fizx";
}

export default function App() {
  // Report-DB + persisted config + derived selectors, consolidated in one
  // store (lib/library). The load/scan/sample lifecycle stays here in App.
  const {
    report,
    setReport,
    root,
    setRoot,
    workspaceDest,
    setWorkspaceDest,
    relays,
    libRoot,
  } = useLibrary();
  // Full set of source releases ("artist/release") — lets the Mirror panel
  // flag orphan clip folders (clips on disk with no matching release).
  const sourceRels = useMemo(
    () =>
      new Set(
        uniquePairs(report?.rows ?? [], libRoot).map(
          (p) => `${p.artist}/${p.release}`,
        ),
      ),
    [report, libRoot],
  );
  const [filter, setFilter] = useState<FilterState>({
    verdict: "All",
    search: "",
    sample: "all",
  });
  const [status, setStatus] = useState<{ text: string; tone: "muted" | "warn" | "ok" | "alert" }>(
    { text: "ready", tone: "muted" },
  );
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [profile, setProfile] = useState<ProfileMeta | null>(null);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // Sampler dispatch state — shared by the panel batch button and the
  // per-scope Scissors in LibraryTree. One in-flight batch at a time;
  // null when idle.
  const [sampling, setSampling] = useState<SampleProgress | null>(null);
  const samplingActive = useRef(false);
  const sampleCancelledRef = useRef(false);
  const sampleUnlisten = useRef<(() => void) | null>(null);
  // Source signatures of already-sampled tracks under the workspace dest.
  // Refreshed when the dest changes and after each sample batch resolves.
  // LibraryTree uses it to tint the Scissors icons green on artist/album
  // rows that already have clips on disk.
  const [sampledSignatures, setSampledSignatures] = useState<Set<string>>(
    () => new Set(),
  );
  // Sample playback — single HTMLAudioElement reused across rows, one
  // clip at a time. `playingSig` is the source-signature of the row whose
  // clip is currently playing (matches the keys used in `sampledSignatures`).
  // Reusing the element rather than creating a new Audio() per click keeps
  // WebKit2GTK happy — Web Audio output is broken on this stack, so
  // HTMLMediaElement is the only working path (same pattern as FeedPanel).
  // Row pending a "publish to Nostr" click — when non-null the dialog
  // overlays the UI; on close (cancel or success) we reset to null.
  const [publishTarget, setPublishTarget] = useState<ScanRow | null>(null);

  // Lifted state for the shared OperationOutput strip below the three
  // operation panels. Each panel emits its own live state up via a
  // setter callback; the strip renders whichever op is active.
  const [scanState, setScanState] = useState<{
    active: boolean;
    progress: ScanProgress | null;
    cancelling: boolean;
  }>({ active: false, progress: null, cancelling: false });
  const [mirrorState, setMirrorState] = useState<MirrorState>({ kind: "idle" });

  // Main-row layout — three ways to split the Library (source) and the
  // Nostr · Radio rail: full Library, split (both), or full Radio. Persisted.
  const [layout, setLayout] = usePersistedString("afqc-tauri.layout", "split");
  const showLibrary = layout !== "radio";
  const showRail = layout !== "library";
  const railFull = layout === "radio";

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Track the current object URL so we can revoke it when playback ends
  // or a new clip starts — Blob URLs leak memory otherwise.
  const audioUrlRef = useRef<string | null>(null);
  const [playingSig, setPlayingSig] = useState<string | null>(null);

  function clearAudio() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }

  async function playSample(row: ScanRow) {
    const sig = sourceSignature(row.path, libRoot);
    if (playingSig === sig) {
      clearAudio();
      setPlayingSig(null);
      return;
    }
    clearAudio();
    const destPath = sampleDestPath(row.path, libRoot, workspaceDest, SAMPLE_SECS);
    try {
      const bytes = await readAudioBytes(destPath);
      // Cast: Uint8Array.buffer is `ArrayBufferLike` in modern lib.dom.d.ts
      // (could be SharedArrayBuffer in theory); Blob's signature wants
      // ArrayBuffer specifically. We know it's plain ArrayBuffer here.
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "audio/flac" });
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = audioRef.current ?? new Audio();
      audio.src = url;
      audio.onended = () => {
        setPlayingSig((p) => (p === sig ? null : p));
        clearAudio();
      };
      audio.onerror = () => {
        setPlayingSig((p) => (p === sig ? null : p));
        setStatus({ text: `playback failed: ${destPath}`, tone: "alert" });
        clearAudio();
      };
      audioRef.current = audio;
      setPlayingSig(sig);
      await audio.play();
    } catch (e) {
      setPlayingSig((p) => (p === sig ? null : p));
      setStatus({ text: `playback failed: ${e}`, tone: "alert" });
      clearAudio();
    }
  }

  async function refreshSampledSignatures(dest: string) {
    if (!dest.trim()) {
      setSampledSignatures(new Set());
      return;
    }
    try {
      const sigs = await scanSampleDest(dest.trim(), SAMPLE_SECS);
      setSampledSignatures(new Set(sigs));
    } catch {
      // Dest unreadable or missing — treat as no samples present.
      setSampledSignatures(new Set());
    }
  }

  // Re-scan whenever the workspace dest changes (including app start,
  // since the persisted value rehydrates on mount).
  useEffect(() => {
    refreshSampledSignatures(workspaceDest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceDest]);

  // Apply + persist theme.
  useEffect(() => {
    document.documentElement.classList.toggle("theme-upleb", theme === "upleb");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // Resolve app version once.
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

  // Hydrate identity from the OS keychain on mount.
  useEffect(() => {
    loadIdentity()
      .then(setIdentity)
      .catch(() => setIdentity(null));
  }, []);

  // Forget the nsec from the OS keychain — the header chip's action, replacing
  // the old in-panel identity block (sign-in still lives in NostrPanel).
  async function handleForgetIdentity() {
    try {
      await clearIdentity();
    } catch {
      /* even if the keychain delete fails, drop the in-memory identity */
    }
    setIdentity(null);
  }

  // Best-effort profile fetch (kind:0 metadata) for display_name / name.
  // Mirrors ndisc's pattern. Silent on failure — npub stays as-is if the
  // relay has no metadata for this pubkey.
  useEffect(() => {
    if (!identity) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const pool = new SimplePool();
        const event = await pool.get(PROFILE_RELAYS, {
          kinds: [0],
          authors: [identity.pk],
        });
        pool.close(PROFILE_RELAYS);
        if (cancelled || !event) return;
        try {
          setProfile(JSON.parse(event.content) as ProfileMeta);
        } catch {
          /* malformed metadata, leave profile as null */
        }
      } catch {
        /* best-effort fetch, leave profile as null */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity?.pk]);

  // Hydrate the last saved report on mount.
  useEffect(() => {
    loadReport()
      .then((r) => {
        if (r) {
          setReport(r);
          setRoot(r.root);
          // No "loaded N entries" status — the Scanner pinned line + the
          // Library count already show it; keep the header chip quiet.
          setStatus({ text: "ready", tone: "muted" });
        } else {
          setStatus({ text: "no saved report — click Re-scan", tone: "warn" });
        }
      })
      .catch((e) => setStatus({ text: `load failed: ${e}`, tone: "alert" }));
  }, []);

  // Single sample dispatch — used by both SamplerPanel's batch button and
  // LibraryTree's per-scope Scissors. Guards on dest + non-empty subset +
  // not-already-running, then mirrors Scanner's pattern (subscribe to
  // progress, await command, surface a summary status).
  async function runSample(label: string, tracks: ScanRow[]) {
    if (samplingActive.current) {
      setStatus({ text: "sample already running — stop it first", tone: "warn" });
      return;
    }
    const dest = workspaceDest.trim();
    if (!dest) {
      setStatus({ text: "set a workspace destination first", tone: "warn" });
      return;
    }
    if (tracks.length === 0) {
      setStatus({ text: "no tracks to sample", tone: "warn" });
      return;
    }
    const items = tracks.map((t) => ({
      src: t.path,
      dest: sampleDestPath(t.path, libRoot, dest, SAMPLE_SECS),
    }));

    samplingActive.current = true;
    sampleCancelledRef.current = false;
    setSampling({ done: 0, total: tracks.length, path: "", outcome: "Created" });
    setStatus({
      text: `sampling ${tracks.length.toLocaleString()} tracks (${label}) — ${SAMPLE_SECS}s each → ${dest}`,
      tone: "warn",
    });

    try {
      const unlisten = await onSampleProgress((p) => setSampling(p));
      sampleUnlisten.current = unlisten;
      const result = await sampleTracks(items, SAMPLE_SECS, SAMPLE_START_OFFSET_SECS);
      const parts: string[] = [];
      if (result.created > 0) parts.push(`${result.created.toLocaleString()} created`);
      if (result.skipped > 0) parts.push(`${result.skipped.toLocaleString()} skipped`);
      if (result.failed > 0) parts.push(`${result.failed.toLocaleString()} failed`);
      if (result.timedOut > 0) parts.push(`${result.timedOut.toLocaleString()} timed out`);
      if (result.cancelled > 0) parts.push(`${result.cancelled.toLocaleString()} cancelled`);
      const summary = parts.join(" · ");
      if (sampleCancelledRef.current) {
        setStatus({ text: `sample cancelled — ${summary}`, tone: "warn" });
      } else if (result.failed + result.timedOut > 0) {
        setStatus({ text: `sample done with errors — ${summary}`, tone: "alert" });
      } else {
        setStatus({ text: `sample complete — ${summary}`, tone: "ok" });
      }
    } catch (e) {
      setStatus({ text: `sample failed: ${e}`, tone: "alert" });
    } finally {
      samplingActive.current = false;
      setSampling(null);
      sampleUnlisten.current?.();
      sampleUnlisten.current = null;
      // Refresh the sampled-signatures set so LibraryTree's Scissors icons
      // pick up the new clips immediately (whether the run completed,
      // cancelled mid-flight, or errored — some files may have landed).
      refreshSampledSignatures(workspaceDest);
    }
  }

  async function stopSample() {
    if (!samplingActive.current || sampleCancelledRef.current) return;
    sampleCancelledRef.current = true;
    try {
      await cancelSample();
    } catch (e) {
      console.warn("cancel_sample failed", e);
    }
    setStatus({ text: "cancelling sample… waiting for in-flight files", tone: "muted" });
  }

  // Esc clears filter + search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setFilter({ verdict: "All", search: "", sample: "all" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Lowercased paths, computed once per report rather than on every search
  // keystroke — the per-row toLowerCase() over ~18k rows was a big slice of
  // the filter cost.
  const lowerPaths = useMemo(
    () => report?.rows.map((r) => r.path.toLowerCase()) ?? [],
    [report],
  );

  const filteredRows: ScanRow[] = useMemo(() => {
    if (!report) return [];
    const q = filter.search.trim().toLowerCase();
    return report.rows.filter((r, i) => {
      if (filter.verdict !== "All" && r.verdict !== filter.verdict) return false;
      if (q && !lowerPaths[i].includes(q)) return false;
      if (filter.sample !== "all") {
        const has = sampledSignatures.has(sourceSignature(r.path, libRoot));
        if (filter.sample === "sampled" && !has) return false;
        if (filter.sample === "unsampled" && has) return false;
      }
      return true;
    });
  }, [report, filter, sampledSignatures, libRoot, lowerPaths]);

  const counts = useMemo(() => {
    const c: Record<Verdict, number> = {
      LOSSLESS: 0,
      "PROBABLY-LOSSY": 0,
      UNCERTAIN: 0,
      LOSSY: 0,
      UNKNOWN: 0,
    };
    if (report) for (const r of report.rows) c[r.verdict]++;
    return c;
  }, [report]);

  const anyFilter =
    filter.verdict !== "All" ||
    filter.search.trim() !== "" ||
    filter.sample !== "all";

  // Destination-tree logic (pkexec + create-mirror + orphan listing), decoupled
  // from any one panel: the controls render in the Source & destination strip,
  // the orphan list as a strip below it.
  const mirror = useMirror({
    rows: filteredRows,
    libRoot,
    dest: workspaceDest,
    sourceRels,
    onStatus: setStatus,
    onMirrorState: setMirrorState,
  });

  // Library totals for the section header — full library, or "filtered / total"
  // when a filter is active.
  const libraryStats = useMemo(() => {
    const all = report?.rows ?? [];
    const allPairs = uniquePairs(all, libRoot);
    const total = {
      artists: new Set(allPairs.map((p) => p.artist)).size,
      releases: allPairs.length,
      tracks: all.length,
    };
    if (!anyFilter) return { ...total, filtered: false as const, total };
    const fPairs = uniquePairs(filteredRows, libRoot);
    return {
      artists: new Set(fPairs.map((p) => p.artist)).size,
      releases: fPairs.length,
      tracks: filteredRows.length,
      filtered: true as const,
      total,
    };
  }, [report, filteredRows, libRoot, anyFilter]);

  return (
    <div className="h-screen p-6 max-w-[1400px] mx-auto flex flex-col gap-4">
      <header className="shrink-0 rounded-lg bg-panel border border-surface/60
                         px-4 py-3 flex md:grid md:grid-cols-[1fr_auto_1fr]
                         items-start gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setTheme((t) => (t === "fizx" ? "upleb" : "fizx"))}
            title={
              theme === "fizx"
                ? "Theme: fizx.uk — click to switch to upleb.uk"
                : "Theme: upleb.uk — click to switch to fizx.uk"
            }
            aria-label="Switch colour theme"
            className="text-3xl font-bold tracking-tight leading-none shrink-0
                       cursor-pointer transition-opacity hover:opacity-70"
          >
            <span className="text-accent">n</span>
            <span className="text-fg">disc</span>
            <span className="text-mauve">.tree</span>
          </button>
          {appVersion &&
            (() => {
              // The version chip doubles as the status surface: at rest it's
              // just the version; when there's something to say ("not ready")
              // it extends to a tinted status with the version dimmed beside it.
              const idle = status.text === "ready";
              const icon =
                status.tone === "ok" ? (
                  <Check size={12} />
                ) : status.tone === "warn" || status.tone === "alert" ? (
                  <AlertTriangle size={12} />
                ) : null;
              return (
                <span
                  className={cn(
                    "hidden md:inline-flex items-center gap-1.5 px-2.5 py-2",
                    "rounded-md font-mono text-xs shrink-0 max-w-[28rem]",
                    idle ? "bg-surface text-mauve" : TONE_CHIP[status.tone],
                  )}
                  title={idle ? `v${appVersion}` : status.text}
                >
                  {!idle && (
                    <>
                      {icon}
                      <span className="truncate">{status.text}</span>
                    </>
                  )}
                  <span className={idle ? undefined : "text-fg/40 shrink-0"}>
                    v{appVersion}
                  </span>
                </span>
              );
            })()}
        </div>
        {/*
          Last-scan module: 5-segment proportional verdict bar in the middle
          grid column (1fr_auto_1fr), centered between title and right edge.
        */}
        {report && (
          <div className="hidden md:flex flex-col items-center gap-1.5 min-w-[520px] mt-1">
            {(() => {
              const total = Math.max(1, report.rows.length);
              const seg = (n: number) => (100 * n) / total;
              return (
                <div className="w-full h-1.5 rounded-sm overflow-hidden bg-bg/60 flex">
                  <div
                    className="h-full bg-ok"
                    style={{ width: `${seg(counts.LOSSLESS)}%` }}
                    title={`LOSSLESS ${counts.LOSSLESS.toLocaleString()}`}
                  />
                  <div
                    className="h-full bg-alert"
                    style={{ width: `${seg(counts["PROBABLY-LOSSY"])}%` }}
                    title={`PROBABLY-LOSSY ${counts["PROBABLY-LOSSY"].toLocaleString()}`}
                  />
                  <div
                    className="h-full bg-warn"
                    style={{ width: `${seg(counts.UNCERTAIN)}%` }}
                    title={`UNCERTAIN ${counts.UNCERTAIN.toLocaleString()}`}
                  />
                  <div
                    className="h-full bg-mauve"
                    style={{ width: `${seg(counts.LOSSY)}%` }}
                    title={`LOSSY ${counts.LOSSY.toLocaleString()}`}
                  />
                  <div
                    className="h-full bg-muted"
                    style={{ width: `${seg(counts.UNKNOWN)}%` }}
                    title={`UNKNOWN ${counts.UNKNOWN.toLocaleString()}`}
                  />
                </div>
              );
            })()}
          </div>
        )}
        {/* Right grid slot — forget-identity button (status now lives in the
            version chip, top-left). Balances the 1fr title column so the
            middle module stays centered. */}
        <div className="hidden md:flex items-center justify-end gap-2 mt-1">
          {/* Forget-identity chip — only when signed in (the ndisc/smpl
              pattern). Sign-in itself lives in the NostrPanel. */}
          {identity && (
            <button
              type="button"
              onClick={handleForgetIdentity}
              title="Signed in — click to forget the nsec from the OS keychain"
              aria-label="Forget identity"
              className="p-2 rounded-md bg-mauve text-bg hover:bg-mauve/80
                         inline-flex items-center transition-colors cursor-pointer shrink-0"
            >
              <LogOut size={14} />
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col gap-4">
        {/* Slim top strip — Source (scan config) and Destination (sample
            config + mirror-tree controls) side by side; the dest editor lives
            only here. The rail toggle (right) collapses the Nostr · Radio rail
            so the Library can go full-width. */}
        <Section
          title="Source & destination"
          icon={<ArrowRightLeft size={16} />}
          right={
            <div className="flex items-center gap-0.5 rounded-md bg-bg/40 p-0.5">
              {(
                [
                  ["library", <PanelRightClose size={14} />, "Full Library"],
                  ["split", <Columns2 size={14} />, "Library + Radio"],
                  ["radio", <PanelLeftClose size={14} />, "Full Radio"],
                ] as const
              ).map(([key, icon, title]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setLayout(key)}
                  aria-pressed={layout === key}
                  title={title}
                  className={cn(
                    "p-1.5 rounded transition-colors",
                    layout === key
                      ? "bg-surface text-accent"
                      : "text-muted hover:text-fg hover:bg-surface/40",
                  )}
                >
                  {icon}
                </button>
              ))}
            </div>
          }
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <ScannerControls
                bare
                root={root}
                setRoot={setRoot}
                onReport={(r) => {
                  setReport(r);
                  setRoot(r.root);
                }}
                onStatus={setStatus}
                onScanState={setScanState}
                report={report}
              />
            </div>
            <div className="lg:border-l lg:border-surface/50 lg:pl-4">
              <SamplerPanel
                bare
                rows={filteredRows}
                dest={workspaceDest}
                setDest={setWorkspaceDest}
                sampling={sampling}
                onSample={(tracks) =>
                  runSample(
                    anyFilter ? "filtered library" : "full library",
                    tracks,
                  )
                }
                onCancelSample={stopSample}
                trailing={<MirrorControls mirror={mirror} dest={workspaceDest} />}
              />
            </div>
          </div>
        </Section>

        {/* Orphan clips — full-width strip directly under Source & destination,
            present only when there's something to clean. */}
        <OrphanStrip mirror={mirror} />

        <OperationOutput
          scan={scanState}
          mirror={mirrorState}
          sampling={sampling}
          samplingCancelling={sampleCancelledRef.current}
        />

        {/* Main row — the Library (source) is the dominant surface, full-width
            when the rail is collapsed; the Nostr · Radio rail sits beside it on
            demand. */}
        <div className="flex-1 min-h-0 flex gap-4">
          {/* Library — filter band (incl. the all/has-clip/no-clip toggle) +
              tree. The old library/samples toggle was dropped: it duplicated
              the clip-exists filter (Samples == has-clip). Hidden in Full Radio. */}
          {showLibrary && (
          <Section
            title="Library"
            icon={<FolderTree size={16} />}
            className="flex-1 min-w-0 min-h-0"
            contentClassName="flex-1 min-h-0 flex flex-col gap-3"
            right={
              report ? (
                <span className="text-[11px] text-muted font-normal tabular-nums">
                  {libraryStats.filtered ? (
                    <>
                      {libraryStats.artists}/{libraryStats.total.artists} artists ·{" "}
                      {libraryStats.releases}/{libraryStats.total.releases} releases ·{" "}
                      {libraryStats.tracks.toLocaleString()}/
                      {libraryStats.total.tracks.toLocaleString()} tracks
                    </>
                  ) : (
                    <>
                      {libraryStats.artists.toLocaleString()} artists ·{" "}
                      {libraryStats.releases.toLocaleString()} releases ·{" "}
                      {libraryStats.tracks.toLocaleString()} tracks
                    </>
                  )}
                </span>
              ) : undefined
            }
          >
            <Filters filter={filter} setFilter={setFilter} />
            <LibraryTree
              rows={filteredRows}
              libRoot={libRoot}
              anyFilter={anyFilter}
              onOpenStatus={setStatus}
              onSampleScope={(label, tracks) => runSample(label, tracks)}
              hasSample={(row) =>
                sampledSignatures.has(sourceSignature(row.path, libRoot))
              }
              playingSig={playingSig}
              onPlaySample={playSample}
              signatureOf={(row) => sourceSignature(row.path, libRoot)}
              onPublishSample={(row) => setPublishTarget(row)}
            />
          </Section>
          )}

          {showRail && (
            <div
              className={cn(
                "flex flex-col gap-4 min-h-0",
                railFull ? "flex-1 min-w-0" : "w-[340px] shrink-0",
              )}
            >
              <NostrPanel identity={identity} setIdentity={setIdentity} />
              <FeedPanel identity={identity} relays={relays} />
            </div>
          )}
        </div>
      </div>

      <footer className="shrink-0 rounded-lg bg-panel border border-surface/60
                         px-4 py-2 flex flex-wrap items-center justify-between
                         gap-x-8 gap-y-1 text-xs text-muted">
        <span>stack: Tauri 2 + React + TS + Tailwind</span>

        {/* Centered identity chip — middle child of a flex justify-between
            row, same pattern as ndisc's footer. */}
        {identity ? (
          <span className="inline-flex items-center gap-2 min-w-0">
            {(profile?.display_name || profile?.name) && (
              <span className="text-fg/80 truncate">
                {profile?.display_name || profile?.name}
              </span>
            )}
            <span className="font-mono text-mauve" title={identity.npub}>
              {shortNpub(identity.npub)}
            </span>
            <span
              className="inline-flex items-center gap-1 text-ok"
              title="signed in · nsec stored in OS keychain (libsecret on Linux)"
            >
              <Lock size={11} />
              <span>nsec stored in keychain</span>
            </span>
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 text-muted/80"
            title="No key in the OS keychain for this build. Load or generate one in the Publish · Nostr panel."
          >
            <KeyRound size={11} className="opacity-60" />
            <span>not signed in · no key in keychain</span>
          </span>
        )}

        {/* Relay indicator — first host is the user-editable publish
            relay (defaults to wss://relay.fizx.uk), the other two are
            locked secondaries. Tooltip shows the full ws:// URLs. */}
        <span
          className="inline-flex items-center gap-1.5 font-mono min-w-0"
          title={relays.map((r) => r).join("\n")}
        >
          <Radio size={11} className="opacity-70 shrink-0" />
          <span className="truncate">
            <span className="text-fg/80">
              {relays[0].replace(/^wss:\/\//, "")}
            </span>
            <span className="text-muted/70">
              {" · "}
              {relays
                .slice(1)
                .map((r) => r.replace(/^wss:\/\//, ""))
                .join(" · ")}
            </span>
          </span>
        </span>
      </footer>

      {publishTarget && (
        <PublishSampleDialog
          row={publishTarget}
          libRoot={libRoot}
          workspaceDest={workspaceDest}
          relays={relays}
          identityNpub={identity?.npub ?? null}
          onClose={() => {
            setPublishTarget(null);
            // Refresh in case the publish flow had side effects worth
            // surfacing later (e.g. once we add a has-published indicator).
            refreshSampledSignatures(workspaceDest);
          }}
          onStatus={setStatus}
        />
      )}
    </div>
  );
}
