import { useState } from "react";
import { Check, Copy, KeyRound, Sparkles } from "lucide-react";
import { Section } from "./Section";
import { usePersistedBool } from "../lib/usePersistedString";
import { generateIdentity, saveKey, type Identity } from "../lib/nostr";

const EXPANDED_KEY = "afqc-tauri.publish.expanded";

interface NostrPanelProps {
  identity: Identity | null;
  setIdentity: (i: Identity | null) => void;
}

// Sign-in surface only. When signed in, identity management (forget) lives in
// the header chip and the relay editor is gone — so this panel renders nothing
// once an identity is present, except the one-time post-generate nsec backup.
export function NostrPanel({ identity, setIdentity }: NostrPanelProps) {
  const [expanded, setExpanded] = usePersistedBool(EXPANDED_KEY, true);
  const [input, setInput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [backupNsec, setBackupNsec] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSave() {
    setErr(null);
    setBusy(true);
    try {
      const id = await saveKey(input);
      setIdentity(id);
      setInput("");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerate() {
    setErr(null);
    setBusy(true);
    try {
      const id = await generateIdentity();
      setIdentity({ npub: id.npub, pk: id.pk });
      setBackupNsec(id.nsec);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyNsec() {
    if (!backupNsec) return;
    try {
      await navigator.clipboard.writeText(backupNsec);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied */
    }
  }

  // Signed in with nothing to back up → nothing to show here; the header chip
  // owns the signed-in state.
  if (identity && !backupNsec) return null;

  return (
    <Section
      icon={<KeyRound size={16} aria-label="Sign in" />}
      onTitleClick={() => setExpanded(!expanded)}
    >
      {expanded && (
        <>
          {!identity && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted mb-1">
                Identity
              </div>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSave()}
                    placeholder="nsec1…"
                    disabled={busy}
                    className="flex-1 px-2.5 py-1.5 rounded-md bg-surface text-fg
                               placeholder:text-muted outline-none border border-transparent
                               focus:border-accent/50 text-xs font-mono disabled:opacity-50"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    onClick={handleSave}
                    disabled={!input.trim() || busy}
                    className="px-2.5 py-1.5 rounded-md bg-surface hover:bg-surfaceHover
                               text-fg disabled:opacity-50 text-xs"
                  >
                    Load
                  </button>
                </div>
                <button
                  onClick={handleGenerate}
                  disabled={busy}
                  className="w-full px-2.5 py-1.5 rounded-md bg-surface hover:bg-surfaceHover
                             text-fg text-xs flex items-center justify-center gap-1.5
                             disabled:opacity-50"
                >
                  <Sparkles size={12} />
                  Generate new key
                </button>
              </div>
              {err && (
                <p className="text-[10px] text-alert font-mono break-all mt-2">
                  {err}
                </p>
              )}
            </div>
          )}

          {backupNsec && (
            <div className="rounded-md bg-warn/10 border border-warn/40 px-2.5 py-2 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wide text-warn font-semibold">
                Back up your secret key
              </div>
              <p className="text-[11px] text-fg/80">
                The nsec is stored in your OS keychain, but it&apos;s only shown
                here once. Copy it somewhere safe — you can&apos;t recover it
                later.
              </p>
              <div className="flex items-center gap-2">
                <code
                  className="font-mono text-[10px] text-fg truncate flex-1
                             rounded bg-bg/60 px-2 py-1"
                >
                  {backupNsec}
                </code>
                <button
                  onClick={handleCopyNsec}
                  className="text-muted hover:text-fg shrink-0"
                  title={copied ? "Copied" : "Copy nsec"}
                >
                  {copied ? (
                    <Check size={12} className="text-ok" />
                  ) : (
                    <Copy size={12} />
                  )}
                </button>
              </div>
              <button
                onClick={() => setBackupNsec(null)}
                className="text-[10px] text-muted hover:text-fg underline"
              >
                I&apos;ve saved it — dismiss
              </button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
