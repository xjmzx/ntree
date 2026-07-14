import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { Section } from "./Section";
import { cn } from "../lib/cn";
import {
  publishFileMetadata,
  readAudioBytes,
  uploadToNip96,
  type ScanRow,
} from "../lib/tauri";
import { sampleDestPath } from "../lib/paths";

const SAMPLE_SECS = 10;
type Kind = "sample" | "full";
type Phase = "idle" | "uploading" | "publishing";

function relayHost(url: string): string {
  return url.replace(/^wss?:\/\//, "").replace(/\/+$/, "");
}

interface PublishPanelProps {
  /** The track selected in the Library (the clip to publish), or null. */
  row: ScanRow | null;
  libRoot: string;
  workspaceDest: string;
  relays: string[];
  identityNpub: string | null;
  hasClip: boolean;
  onPublished?: (row: ScanRow) => void;
  onStatus: (s: { text: string; tone: "muted" | "warn" | "ok" | "alert" }) => void;
}

// Left-flank bottom pane — its own publish surface. Clip metadata form plus a
// row of relay chips whose leaf-dots light up as each relay accepts the
// publish (the clip's "leaf" blown out onto the wire).
export function PublishPanel({
  row,
  libRoot,
  workspaceDest,
  relays,
  identityNpub,
  hasClip,
  onPublished,
  onStatus,
}: PublishPanelProps) {
  const norm = libRoot.replace(/\/+$/, "");
  const rel = row ? row.path.replace(norm + "/", "") : "";

  const [kind, setKind] = useState<Kind>("sample");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string | null>(null);
  // Per-relay outcome of the last publish, keyed by relay URL.
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());

  // Reset the form + relay outcomes when the selection changes.
  useEffect(() => {
    setKind("sample");
    setTitle(rel.replace(/\.[^.]+$/, "").replace(/\//g, " — "));
    setDescription("");
    setErr(null);
    setPhase("idle");
    setAccepted(new Set());
    setRejected(new Set());
  }, [row?.path]);

  const busy = phase !== "idle";
  const canPublish =
    !!row && !!identityNpub && !!title.trim() && (kind === "full" || hasClip);

  async function handlePublish() {
    if (!row) return;
    setErr(null);
    setAccepted(new Set());
    setRejected(new Set());
    if (!identityNpub) {
      setErr("Load or generate a Nostr key first (Radio · Nostr panel).");
      return;
    }
    const clipPath = sampleDestPath(row.path, libRoot, workspaceDest, SAMPLE_SECS);
    try {
      setPhase("uploading");
      onStatus({ text: `uploading ${title} to nostr.build…`, tone: "warn" });
      const bytes = await readAudioBytes(clipPath);
      const filename = clipPath.split("/").pop() ?? "sample.10s.flac";
      const upload = await uploadToNip96(bytes, filename, "audio/flac");

      setPhase("publishing");
      onStatus({ text: `publishing kind:1063 (${kind})…`, tone: "warn" });
      const res = await publishFileMetadata({
        url: upload.url,
        sha256: upload.hash,
        size: upload.size,
        mime: upload.mime,
        title,
        description,
        tTag: kind,
        relays,
      });
      setAccepted(new Set(res.acceptedBy));
      setRejected(new Set(res.rejected.map((r) => r.relay)));
      onStatus({
        text: `published ${kind} · ${res.acceptedBy.length}/${relays.length} relays accepted`,
        tone: res.rejected.length > 0 ? "warn" : "ok",
      });
      if (res.acceptedBy.length > 0) onPublished?.(row);
      setPhase("idle");
    } catch (e) {
      setErr(String(e));
      setPhase("idle");
    }
  }

  return (
    <Section
      title="Publish"
      icon={<span className="inline-block w-2 h-2 rounded-full bg-mauve" />}
      // Default border, like Library and Radio — see SampleDetails.
      className="w-full shrink-0"
      contentClassName="flex flex-col gap-2"
    >
      <div className="flex gap-2">
        {(["sample", "full"] as const).map((k) => (
          <button
            key={k}
            type="button"
            disabled={busy}
            onClick={() => setKind(k)}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs flex-1",
              k === kind
                ? "bg-accent text-bg font-semibold"
                : "bg-surface text-fg/80 hover:bg-surfaceHover",
              busy && "opacity-50 cursor-not-allowed",
            )}
          >
            {k === "sample" ? `Sample (${SAMPLE_SECS}s)` : "Full track"}
          </button>
        ))}
      </div>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={busy}
        placeholder="Title"
        className="w-full px-2.5 py-1.5 rounded-md bg-surface text-fg text-xs
                   outline-none border border-transparent
                   focus:border-accent/50 disabled:opacity-50"
        spellCheck={false}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={busy}
        rows={2}
        placeholder="Description (optional)"
        className="w-full px-2.5 py-1.5 rounded-md bg-surface text-fg text-xs
                   outline-none border border-transparent
                   focus:border-accent/50 disabled:opacity-50 resize-none
                   placeholder:text-muted/60"
        spellCheck={false}
      />

      {/* Relay chips — the clip's leaf blown to each relay. The leaf-dot lights
          green when that relay accepts, red on reject, muted before/while. */}
      <div className="flex flex-wrap gap-1.5">
        {relays.map((r) => {
          const ok = accepted.has(r);
          const bad = rejected.has(r);
          const dot = ok ? "bg-ok" : bad ? "bg-alert" : "bg-muted/40";
          return (
            <span
              key={r}
              title={
                ok ? `${r} — accepted` : bad ? `${r} — rejected` : r
              }
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md",
                "bg-bg/40 text-[10px] font-mono text-muted",
                busy && "animate-pulse",
              )}
            >
              <span
                className={cn(
                  "w-1.5 h-1.5 rounded-full transition-colors",
                  dot,
                )}
              />
              {relayHost(r)}
            </span>
          );
        })}
      </div>

      {err && <p className="text-[11px] text-alert font-mono break-all">{err}</p>}

      <button
        onClick={handlePublish}
        disabled={busy || !canPublish}
        title={
          !row
            ? "Select a track in the Library"
            : !identityNpub
              ? "Sign in to publish (Radio · Nostr panel)"
              : kind === "sample" && !hasClip
                ? "No clip on disk — sample this track first"
                : "Publish to Nostr (kind:1063)"
        }
        className={cn(
          "px-3 py-1.5 rounded-md font-semibold text-xs flex items-center justify-center gap-1.5",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "bg-accent text-bg hover:opacity-90",
        )}
      >
        <Upload size={12} />
        {phase === "uploading"
          ? "uploading…"
          : phase === "publishing"
            ? "publishing…"
            : "Publish"}
      </button>
    </Section>
  );
}
