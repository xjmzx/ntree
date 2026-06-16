import { useEffect, useMemo, useState } from "react";
import {
  FolderTree,
  Hammer,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Section } from "./Section";
import { cn } from "../lib/cn";
import { uniquePairs } from "../lib/paths";
import {
  createDestFolder,
  createMirrorTree,
  listDestFolders,
  trashDestFolder,
  type DestFolder,
  type MirrorResult,
  type ScanRow,
} from "../lib/tauri";
import { usePersistedBool } from "../lib/usePersistedString";

const EXPANDED_KEY = "afqc-tauri.mirrortree.expanded";

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: MirrorResult }
  | { kind: "err"; message: string };

interface WorkspacePanelProps {
  rows: ScanRow[];
  libRoot: string;
  anyFilter: boolean;
  /** Shared workspace destination — set in the Source & destination panel;
   *  read-only here (drives the mirror-create + orphan list). */
  dest: string;
  /** Source releases ("artist/release") — clip folders whose artist/release
   *  isn't in here are orphans (no matching release in the library). */
  sourceRels: Set<string>;
  onStatus: (s: { text: string; tone: "muted" | "warn" | "ok" | "alert" }) => void;
  /**
   * Lifts the mirror state (running / done / err) up so the shared
   * OperationOutput strip can render the result or error. The in-panel
   * result + error blocks are gone — this is now the only surface.
   */
  onMirrorState?: (s: {
    kind: "idle" | "running" | "done" | "err";
    result?: MirrorResult;
    error?: string;
  }) => void;
}

export function WorkspacePanel({
  rows,
  libRoot,
  anyFilter,
  dest,
  sourceRels,
  onStatus,
  onMirrorState,
}: WorkspacePanelProps) {
  // Default collapsed — orphan cleanup is occasional; collapsed it's a compact
  // strip so the rail's Radio (feed) gets the room.
  const [expanded, setExpanded] = usePersistedBool(EXPANDED_KEY, false);
  const [sudo, setSudo] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });

  // Emit state changes up so the shared OperationOutput can render
  // running / result / error from outside the panel.
  useEffect(() => {
    if (!onMirrorState) return;
    if (state.kind === "done") onMirrorState({ kind: "done", result: state.result });
    else if (state.kind === "err") onMirrorState({ kind: "err", error: state.message });
    else onMirrorState({ kind: state.kind });
  }, [state, onMirrorState]);

  const pairs = useMemo(() => uniquePairs(rows, libRoot), [rows, libRoot]);
  const artistCount = useMemo(
    () => new Set(pairs.map((p) => p.artist)).size,
    [pairs],
  );

  // --- Mirror-folder management (add / trash) ------------------------------
  const [folders, setFolders] = useState<DestFolder[]>([]);
  const [addName, setAddName] = useState("");
  const [loadingFolders, setLoadingFolders] = useState(false);

  async function refreshFolders() {
    if (!dest.trim()) {
      setFolders([]);
      return;
    }
    setLoadingFolders(true);
    try {
      setFolders(await listDestFolders(dest));
    } catch (e) {
      onStatus({ text: `list folders failed: ${e}`, tone: "alert" });
    } finally {
      setLoadingFolders(false);
    }
  }

  // Load the folder list whenever the panel opens or the dest changes.
  useEffect(() => {
    if (expanded && dest.trim()) refreshFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, dest]);

  async function addFolder() {
    const name = addName.trim();
    if (!name) return;
    try {
      await createDestFolder(dest, name);
      setAddName("");
      onStatus({ text: `created ${name}`, tone: "ok" });
      refreshFolders();
    } catch (e) {
      onStatus({ text: `create failed: ${e}`, tone: "alert" });
    }
  }

  async function trashFolder(f: DestFolder) {
    const n = f.audioCount;
    if (
      !confirm(
        `Move "${f.rel}" to the trash?\n\n${n} audio file${n === 1 ? "" : "s"} — recoverable from your desktop trash.`,
      )
    ) {
      return;
    }
    try {
      await trashDestFolder(dest, f.path);
      onStatus({ text: `trashed ${f.rel}`, tone: "ok" });
      refreshFolders();
    } catch (e) {
      onStatus({ text: `trash failed: ${e}`, tone: "alert" });
    }
  }

  async function createMirror() {
    const target = dest.trim();
    if (!target || pairs.length === 0) return;
    setState({ kind: "running" });
    onStatus({
      text: sudo
        ? `mirroring ${pairs.length} folders (pkexec — watch for password prompt)…`
        : `mirroring ${pairs.length} folders…`,
      tone: "warn",
    });
    try {
      const result = await createMirrorTree(target, libRoot, pairs, sudo);
      setState({ kind: "done", result });
      const suffix = sudo ? " · chown/chmod matched to source" : "";
      onStatus({
        text:
          `mirror complete · created ${result.created}, skipped ${result.skipped}` +
          (result.errors.length ? `, ${result.errors.length} errors` : "") +
          suffix,
        tone: result.errors.length ? "warn" : "ok",
      });
    } catch (e) {
      setState({ kind: "err", message: String(e) });
      onStatus({ text: `mirror failed: ${e}`, tone: "alert" });
    }
  }

  const running = state.kind === "running";
  const canRun = !!dest.trim() && pairs.length > 0 && !running;

  // Orphans = clip folders whose artist/release has no matching source
  // release. The library tree already shows in-source releases + their sampled
  // status (gaps); orphans are the residue it can't show, so the Mirror panel
  // narrows to just these — the cleanup targets (renamed/removed sources, stale
  // leftovers like the old Timber (A)/(B)).
  const orphans = useMemo(
    () =>
      folders.filter(
        (f) => !sourceRels.has(f.rel.split("/").slice(0, 2).join("/")),
      ),
    [folders, sourceRels],
  );

  return (
    <Section
      title="Sample tree"
      icon={<FolderTree size={16} />}
      onTitleClick={() => setExpanded(!expanded)}
      right={
        <label
          // stopPropagation so flipping the checkbox doesn't collapse
          // the panel (the title bar also handles click for that).
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "flex items-center gap-1.5 text-xs cursor-pointer select-none",
            "px-2 py-0.5 rounded hover:bg-surface/30",
            running && "opacity-50 cursor-not-allowed",
          )}
          title="Run mkdir + chown + chmod through pkexec — one system password prompt for the batch. The destination tree's owner/group/mode will be set to match the source library root."
        >
          <input
            type="checkbox"
            checked={sudo}
            onChange={(e) => setSudo(e.target.checked)}
            disabled={running}
            className="accent-accent"
          />
          <ShieldCheck
            size={11}
            className={sudo ? "text-accent" : "text-muted"}
          />
          <span className={sudo ? "text-fg" : "text-muted"}>pkexec</span>
        </label>
      }
    >
      {/* Pinned line — visible whether the panel is expanded or collapsed.
          Same counts that used to live in the secondary row below. */}
      <div className="text-xs text-fg/80">
        {pairs.length === 0 ? (
          <span className="text-muted">scan or clear the filter to mirror</span>
        ) : (
          <>
            <span className="font-semibold">{artistCount.toLocaleString()}</span>{" "}
            artist{artistCount === 1 ? "" : "s"}
            {" | "}
            <span className="font-semibold">{pairs.length.toLocaleString()}</span>{" "}
            release{pairs.length === 1 ? "" : "s"}
            {" | "}
            <span className="font-semibold">{rows.length.toLocaleString()}</span>{" "}
            {anyFilter ? "filtered " : ""}track{rows.length === 1 ? "" : "s"}
          </>
        )}
      </div>
      {expanded && (
        <>
          <div className="flex gap-2 items-center">
            {/* Destination is set in the Source & destination panel; shown
                here read-only so it's clear what the mirror writes into. */}
            <div
              className="flex-1 px-3 py-2 rounded-md bg-bg/50 text-xs font-mono truncate
                         text-fg/80"
              title={dest || "no destination set"}
            >
              {dest || (
                <span className="text-muted">
                  set a destination in Source &amp; destination
                </span>
              )}
            </div>
            <button
              onClick={createMirror}
              disabled={!canRun}
              className={cn(
                "px-3 py-2 rounded-md font-semibold",
                "flex items-center justify-center",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "bg-accent text-bg hover:opacity-90",
              )}
              title={
                running
                  ? "creating…"
                  : pairs.length === 0
                    ? "Scan or clear the filter first"
                    : !dest.trim()
                      ? "Choose a destination directory"
                      : `Create ${pairs.length} release folder${pairs.length === 1 ? "" : "s"} under ${dest}`
              }
              aria-label="Create mirror tree"
            >
              <Hammer size={14} className={running ? "animate-pulse" : ""} />
            </button>
          </div>

          {/* Orphans — clip folders with no matching release in the library
              (renamed/removed source, stale leftovers). The in-source releases
              live in the Library tree; only the residue surfaces here. Add a
              folder, or send orphans to the OS trash (recoverable). */}
          {dest.trim() && (
            <div className="mt-2 space-y-2">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted">
                <span>orphan clips</span>
                <span className="tabular-nums">{orphans.length}</span>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addFolder()}
                  placeholder="add folder (Artist/Release)…"
                  spellCheck={false}
                  className="flex-1 px-2.5 py-1.5 rounded-md bg-surface text-fg text-xs
                             placeholder:text-muted outline-none border border-transparent
                             focus:border-accent/50"
                />
                <button
                  onClick={addFolder}
                  disabled={!addName.trim()}
                  title="Create this folder under the destination"
                  className="px-2.5 py-1.5 rounded-md bg-surface hover:bg-surfaceHover
                             text-fg text-xs disabled:opacity-50 flex items-center gap-1"
                >
                  <Plus size={12} /> add
                </button>
                <button
                  onClick={refreshFolders}
                  title="Refresh folder list"
                  aria-label="Refresh folder list"
                  className="px-2 py-1.5 rounded-md bg-surface hover:bg-surfaceHover text-muted"
                >
                  <RefreshCw
                    size={12}
                    className={loadingFolders ? "animate-spin" : ""}
                  />
                </button>
              </div>

              {orphans.length === 0 ? (
                <p className="text-[10px] text-muted px-1">
                  {folders.length === 0
                    ? "no clip folders yet"
                    : "no orphans — every clip folder maps to a release"}
                </p>
              ) : (
                <ul className="max-h-[12rem] overflow-auto rounded-md bg-bg/40 divide-y divide-surface/50">
                  {orphans.map((f) => (
                    <li
                      key={f.path}
                      className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-mono"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "w-2 h-2 rounded-full shrink-0",
                          f.audioCount > 0 ? "bg-accent" : "border border-muted/70",
                        )}
                      />
                      <span className="truncate flex-1" title={f.path}>
                        {f.rel}
                      </span>
                      <span className="text-muted tabular-nums shrink-0">
                        {f.audioCount}
                      </span>
                      <button
                        onClick={() => trashFolder(f)}
                        title={`Move "${f.rel}" to trash (${f.audioCount} audio file${f.audioCount === 1 ? "" : "s"})`}
                        aria-label={`Trash ${f.rel}`}
                        className="text-muted hover:text-alert transition-colors shrink-0"
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </Section>
  );
}
