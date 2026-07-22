import type { ReactNode } from "react";
import { FolderOpen, Scissors, Square } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Section } from "./Section";
import { cn } from "../lib/cn";
import type { SampleProgress, ScanRow } from "../lib/tauri";
import { usePersistedBool } from "../lib/usePersistedString";

const SAMPLE_SECS = 10;
const EXPANDED_KEY = "afqc-tauri.destination.expanded";

interface SamplerPanelProps {
  rows: ScanRow[];
  /** How many of `rows` have no clip yet — i.e. the work this run would
   *  actually do. Sampling is idempotent (existing clips are skipped), so the
   *  scope size alone overstates it, sometimes wildly. */
  pending: number;
  /** Shared workspace destination — also set by WorkspacePanel. */
  dest: string;
  setDest: (v: string) => void;
  /** Live progress when a sample run is in flight; null when idle. */
  sampling: SampleProgress | null;
  /** Kick a batch over the given subset of rows. */
  onSample: (tracks: ScanRow[]) => void;
  /** Stop the running batch (in-flight ffmpegs finish, ≤60s). */
  onCancelSample: () => void;
  /** Render bare (no Section card) — for the merged Source & Destination panel. */
  bare?: boolean;
  /** Extra controls rendered at the end of the dest control row (mirror tree). */
  trailing?: ReactNode;
}

export function SamplerPanel({
  rows,
  pending,
  dest,
  setDest,
  sampling,
  onSample,
  onCancelSample,
  bare = false,
  trailing,
}: SamplerPanelProps) {
  const [expanded, setExpanded] = usePersistedBool(EXPANDED_KEY, true);
  const open = bare || expanded;
  const running = sampling !== null;
  const count = rows.length;
  const done = count - pending;
  // Nothing to do is a real state, not an error — with a scope this size, a
  // run that would clip nothing should say so rather than churn through
  // thousands of skips.
  const canRun = !running && pending > 0 && dest.trim() !== "";

  async function browse() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose sample destination",
      defaultPath: dest || undefined,
    });
    if (typeof picked === "string") setDest(picked);
  }

  return (
    <Section
      title="Destination"
      icon={<Scissors size={16} />}
      onTitleClick={() => setExpanded(!expanded)}
      flat={bare}
    >
      {/* Pinned line — visible whether the panel is expanded or collapsed;
          hidden in the merged (bare) strip, where the column label + icon say
          what this is and dropping it keeps the three path rows aligned. */}
      {!bare && (
        <p className="text-xs text-muted">Saves a sample to tree.</p>
      )}
      {open && (
        <>
      <div className="flex gap-2">
        <input
          type="text"
          value={dest}
          onChange={(e) => setDest(e.target.value)}
          placeholder="/path/to/samples"
          disabled={running}
          title={dest}
          className="flex-1 min-w-0 px-2.5 py-1 rounded-md bg-surface text-fg
                     placeholder:text-muted outline-none border border-transparent
                     focus:border-accent/50 disabled:opacity-50"
          spellCheck={false}
        />
        <button
          onClick={browse}
          disabled={running}
          className="px-2.5 py-1 rounded-md bg-surface hover:bg-surfaceHover
                     text-fg disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center justify-center"
          title="Browse for destination"
          aria-label="Browse for destination"
        >
          <FolderOpen size={14} />
        </button>
        {running ? (
          <button
            onClick={onCancelSample}
            className={cn(
              "px-2.5 py-1 rounded-md font-semibold",
              "flex items-center justify-center",
              "bg-alert/15 text-alert hover:bg-alert hover:text-bg transition-colors",
            )}
            title="Stop sample — in-flight files finish, no new ones start"
            aria-label="Stop sample"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            onClick={() => onSample(rows)}
            disabled={!canRun}
            className={cn(
              "px-2.5 py-1 rounded-md font-semibold",
              "flex items-center justify-center gap-1.5",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "bg-accent text-bg hover:opacity-90",
            )}
            title={
              count === 0
                ? "Scan the library first"
                : dest.trim() === ""
                  ? "Choose a destination directory"
                  : pending === 0
                    ? `Every one of the ${count.toLocaleString()} tracks in scope already has a clip — nothing to do.`
                    : `Clip ${pending.toLocaleString()} of the ${count.toLocaleString()} tracks in scope · ${SAMPLE_SECS}s each → ${dest}` +
                      (done > 0
                        ? `\n\n${done.toLocaleString()} already have a clip and will be skipped.`
                        : "")
            }
            aria-label={
              pending > 0
                ? `Clip ${pending.toLocaleString()} tracks`
                : "Nothing to clip"
            }
          >
            <Scissors size={14} />
            {/* The count is the whole point of showing it: an hours-long run
                over 12k tracks should never start from an unlabelled icon. */}
            {count > 0 && (
              <span className="text-xs tabular-nums">
                {pending.toLocaleString()}
              </span>
            )}
          </button>
        )}
        {trailing}
      </div>

        </>
      )}
    </Section>
  );
}
