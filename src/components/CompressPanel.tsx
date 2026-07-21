import type { ReactNode } from "react";
import { FolderOpen, Shrink, Square } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Section } from "./Section";
import { cn } from "../lib/cn";
import type { SampleProgress } from "../lib/tauri";
import { usePersistedBool } from "../lib/usePersistedString";

const EXPANDED_KEY = "afqc-tauri.compress.expanded";

interface CompressPanelProps {
  /** Total FLAC clips available to compress (the sampled-clip count). */
  total: number;
  /** How many of those have no Opus copy yet — the real work this run does.
   *  Compression is idempotent (existing web clips are skipped), so `total`
   *  alone overstates the work. */
  pending: number;
  /** Web-optimised (Opus) destination — persisted in lib/library. */
  dest: string;
  setDest: (v: string) => void;
  /** Live progress when a compress run is in flight; null when idle. */
  compressing: SampleProgress | null;
  /** Encode the pending FLAC clips to Opus. */
  onCompress: () => void;
  /** Stop the running batch (in-flight ffmpegs finish). */
  onCancel: () => void;
  /** Render bare (no Section card) — for the merged Source & Destination panel. */
  bare?: boolean;
  /** Extra controls rendered at the end of the control row. */
  trailing?: ReactNode;
}

export function CompressPanel({
  total,
  pending,
  dest,
  setDest,
  compressing,
  onCompress,
  onCancel,
  bare = false,
  trailing,
}: CompressPanelProps) {
  const [expanded, setExpanded] = usePersistedBool(EXPANDED_KEY, true);
  const open = bare || expanded;
  const running = compressing !== null;
  const done = total - pending;
  // Nothing to do is a real state, not an error — a run over already-encoded
  // clips should say so rather than churn through skips.
  const canRun = !running && pending > 0 && dest.trim() !== "";

  async function browse() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose compress destination",
      defaultPath: dest || undefined,
    });
    if (typeof picked === "string") setDest(picked);
  }

  return (
    <Section
      title="Compress"
      icon={<Shrink size={16} />}
      onTitleClick={() => setExpanded(!expanded)}
      flat={bare}
    >
      {/* Pinned line — visible whether the panel is expanded or collapsed. */}
      <p className="text-xs text-muted">
        Web-optimised Opus copies of the clips.
      </p>
      {open && (
        <>
      <div className="flex gap-2">
        <input
          type="text"
          value={dest}
          onChange={(e) => setDest(e.target.value)}
          placeholder="/path/to/web-clips"
          disabled={running}
          title={dest}
          className="flex-1 min-w-0 px-3 py-2 rounded-md bg-surface text-fg
                     placeholder:text-muted outline-none border border-transparent
                     focus:border-accent/50 disabled:opacity-50"
          spellCheck={false}
        />
        <button
          onClick={browse}
          disabled={running}
          className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                     text-fg disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center justify-center"
          title="Browse for destination"
          aria-label="Browse for destination"
        >
          <FolderOpen size={14} />
        </button>
        {running ? (
          <button
            onClick={onCancel}
            className={cn(
              "px-3 py-2 rounded-md font-semibold",
              "flex items-center justify-center",
              "bg-alert/15 text-alert hover:bg-alert hover:text-bg transition-colors",
            )}
            title="Stop compress — in-flight files finish, no new ones start"
            aria-label="Stop compress"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            onClick={onCompress}
            disabled={!canRun}
            className={cn(
              "px-3 py-2 rounded-md font-semibold",
              "flex items-center justify-center gap-1.5",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "bg-accent text-bg hover:opacity-90",
            )}
            title={
              total === 0
                ? "Sample some clips first"
                : dest.trim() === ""
                  ? "Choose a compress destination directory"
                  : pending === 0
                    ? `Every one of the ${total.toLocaleString()} clips already has a web copy — nothing to do.`
                    : `Encode ${pending.toLocaleString()} of ${total.toLocaleString()} clips to Opus → ${dest}` +
                      (done > 0
                        ? `\n\n${done.toLocaleString()} already have a web copy and will be skipped.`
                        : "")
            }
            aria-label={
              pending > 0
                ? `Compress ${pending.toLocaleString()} clips`
                : "Nothing to compress"
            }
          >
            <Shrink size={14} />
            {/* The count is the point of showing it — a long batch should never
                start from an unlabelled icon. */}
            {total > 0 && (
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
