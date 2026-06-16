import { useEffect, useMemo, useState } from "react";
import { uniquePairs } from "./paths";
import {
  createMirrorTree,
  listDestFolders,
  trashDestFolder,
  type DestFolder,
  type MirrorResult,
  type ScanRow,
} from "./tauri";
import type { MirrorState } from "../components/OperationOutput";

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: MirrorResult }
  | { kind: "err"; message: string };

type Status = { text: string; tone: "muted" | "warn" | "ok" | "alert" };

interface UseMirrorArgs {
  /** Rows the mirror covers (filtered library) — the source release set. */
  rows: ScanRow[];
  libRoot: string;
  /** Shared workspace destination (set in the Destination panel). */
  dest: string;
  /** Source releases ("artist/release"); clip folders not in here are orphans. */
  sourceRels: Set<string>;
  onStatus: (s: Status) => void;
  /** Lifts mirror state to the shared OperationOutput strip. */
  onMirrorState?: (s: MirrorState) => void;
}

/**
 * All the "destination tree" logic that used to live inside WorkspacePanel,
 * decoupled from its UI so the controls (pkexec + create-mirror) can sit in
 * the Source & destination strip while the orphan list renders full-width
 * below it. Owns: the pkexec toggle, the create-mirror run + its lifted
 * state, the dest folder listing, and the derived orphan set.
 */
export function useMirror({
  rows,
  libRoot,
  dest,
  sourceRels,
  onStatus,
  onMirrorState,
}: UseMirrorArgs) {
  const [sudo, setSudo] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [folders, setFolders] = useState<DestFolder[]>([]);

  const pairs = useMemo(() => uniquePairs(rows, libRoot), [rows, libRoot]);

  // Mirror state up to the shared output strip.
  useEffect(() => {
    if (!onMirrorState) return;
    if (state.kind === "done") onMirrorState({ kind: "done", result: state.result });
    else if (state.kind === "err") onMirrorState({ kind: "err", error: state.message });
    else onMirrorState({ kind: state.kind });
  }, [state, onMirrorState]);

  async function refreshFolders() {
    if (!dest.trim()) {
      setFolders([]);
      return;
    }
    try {
      setFolders(await listDestFolders(dest));
    } catch (e) {
      onStatus({ text: `list folders failed: ${e}`, tone: "alert" });
    }
  }

  // Re-list whenever the destination changes — this is what surfaces orphans
  // (also re-run after a mirror-create or trash).
  useEffect(() => {
    refreshFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dest]);

  // Orphans = clip folders whose artist/release has no matching source
  // release (renamed/removed sources, stale leftovers). The Library tree shows
  // in-source releases; orphans are the residue it can't show.
  const orphans = useMemo(
    () =>
      folders.filter(
        (f) => !sourceRels.has(f.rel.split("/").slice(0, 2).join("/")),
      ),
    [folders, sourceRels],
  );

  async function createMirror() {
    const target = dest.trim();
    if (!target || pairs.length === 0) return;
    setState({ kind: "running" });
    onStatus({
      text: sudo ? "mirroring… (pkexec — watch for prompt)" : "mirroring…",
      tone: "warn",
    });
    try {
      const result = await createMirrorTree(target, libRoot, pairs, sudo);
      setState({ kind: "done", result });
      refreshFolders();
      // Detail (created / skipped / errors) lives in the OperationOutput strip;
      // the header chip stays a brief state word.
      onStatus({
        text: result.errors.length
          ? `mirror done · ${result.errors.length} errors`
          : "mirror done",
        tone: result.errors.length ? "warn" : "ok",
      });
    } catch (e) {
      setState({ kind: "err", message: String(e) });
      onStatus({ text: `mirror failed: ${e}`, tone: "alert" });
    }
  }

  async function trashFolder(f: DestFolder) {
    const n = f.audioCount;
    // Brief, fixed-size prompt — the folder name lives in the strip row, NOT
    // here. Embedding f.rel ballooned the native dialog for long titles (a
    // 200-char classical name filled the screen).
    if (
      !confirm(`Trash orphan? ${n} file${n === 1 ? "" : "s"} · recoverable.`)
    ) {
      return;
    }
    try {
      await trashDestFolder(dest, f.path);
      onStatus({ text: "trashed", tone: "ok" });
      refreshFolders();
    } catch (e) {
      onStatus({ text: `trash failed: ${e}`, tone: "alert" });
    }
  }

  const running = state.kind === "running";
  const canRun = !!dest.trim() && pairs.length > 0 && !running;

  return { sudo, setSudo, createMirror, running, canRun, pairs, orphans, trashFolder };
}

export type UseMirror = ReturnType<typeof useMirror>;
