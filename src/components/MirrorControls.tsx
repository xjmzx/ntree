import { Hammer, ShieldCheck, Trash2 } from "lucide-react";
import { cn } from "../lib/cn";
import type { UseMirror } from "../lib/useMirror";

/**
 * pkexec toggle + create-mirror (hammer) — the two always-on destination-tree
 * controls, compact enough to ride at the end of the Destination control row.
 * The orphan list lives separately ({@link OrphanStrip}) so this never grows
 * the strip's height.
 */
export function MirrorControls({
  mirror,
  dest,
}: {
  mirror: UseMirror;
  dest: string;
}) {
  const { sudo, setSudo, createMirror, running, canRun, pairs } = mirror;
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <label
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
        <ShieldCheck size={11} className={sudo ? "text-accent" : "text-muted"} />
        <span className={sudo ? "text-fg" : "text-muted"}>pkexec</span>
      </label>
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
                : `Create ${pairs.length} release folder${pairs.length === 1 ? "" : "s"} under ${dest} (build the mirror tree)`
        }
        aria-label="Create mirror tree"
      >
        <Hammer size={14} className={running ? "animate-pulse" : ""} />
      </button>
    </div>
  );
}

/**
 * Orphan clips — clip folders on disk with no matching source release. Renders
 * a full-width strip below Source & destination, and ONLY when there's
 * something to clean (so it costs zero height when the tree is tidy).
 */
export function OrphanStrip({ mirror }: { mirror: UseMirror }) {
  const { orphans, trashFolder, orphanFiles, trashOrphanFiles } = mirror;
  if (orphans.length === 0 && orphanFiles.length === 0) return null;
  return (
    <div className="rounded-md bg-bg/40 border border-warn/30">
      {/* FILE-grain orphans: the source track was renamed or removed while its
          release stayed put. The folder check below cannot see these — the
          folder is valid, only the file inside is stale. Rendered first because
          it is the case that used to go completely unnoticed. */}
      {orphanFiles.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface/40">
          <span className="w-1.5 h-1.5 rounded-full bg-warn shrink-0" aria-hidden />
          <span className="tabular-nums text-warn font-semibold text-[10px]">
            {orphanFiles.length}
          </span>
          <span className="text-muted text-[10px] uppercase tracking-wide">
            orphan clip{orphanFiles.length === 1 ? "" : "s"}
          </span>
          <span
            className="text-muted text-[11px] truncate flex-1"
            title={orphanFiles.slice(0, 20).join("\n")}
          >
            — source file renamed or removed
          </span>
          <button
            onClick={trashOrphanFiles}
            title={`Move ${orphanFiles.length} orphan clip file(s) to trash. Recoverable.`}
            className="shrink-0 px-2 py-0.5 text-[11px] rounded bg-surface
                       hover:bg-alert hover:text-bg text-muted transition-colors"
          >
            Trash all
          </button>
        </div>
      )}
      {/* FOLDER-grain orphans: a whole clip folder with no source release. */}
      {orphans.length > 0 && (
      <>
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wide"
        title="Clip folders with no matching source release — trash to clean up"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-warn shrink-0" aria-hidden />
        <span className="tabular-nums text-warn font-semibold">
          {orphans.length}
        </span>
        <span className="text-muted">
          orphan{orphans.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="max-h-[12rem] overflow-auto divide-y divide-surface/40 border-t border-surface/40">
        {orphans.map((f) => (
          <li
            key={f.path}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono"
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
      </>
      )}
    </div>
  );
}
