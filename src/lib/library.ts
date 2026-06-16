import { useMemo, useState } from "react";
import { usePersistedString } from "./usePersistedString";
import type { ScanReport } from "./tauri";

// ---------------------------------------------------------------------------
// blobtree's library "store" — the single home for the app's DB + config.
//
// "DB" here is the scan report (a JSON document persisted by the Rust side as
// last_scan.json; load/save live in lib/tauri). "Config" is the small set of
// persisted scalars that parameterise every read/scan/sample/publish path.
// Before this, all of it was declared inline in a 700+-line App component
// alongside the UI; pulling it here makes initialisation + data management one
// cohesive unit that App and the panels consume, instead of scattered useState.
//
// Scope (intentional, first pass): owns STATE + CONFIG + DERIVED selectors.
// The lifecycle (load-on-mount, scan, sample) stays in App for now because
// those flows also drive App's status UX; they can migrate here incrementally.
//
// ---------------------------------------------------------------------------
// UNIVERSALISING DB MANAGEMENT ACROSS THE ndisc SUITE (reference + spec)
//
// ndisc, ndisc.smpl and ndisc.blobtree each carry a near-identical shape:
// a local "DB" + a handful of persisted path/config scalars + derived
// selectors over them. They will NOT share features 1:1, but they CAN share
// this *contract*. What a shared `@ndisc/library` (or copied spec) would need:
//
//  1. A DB abstraction with a uniform lifecycle: load() on mount, a current
//     snapshot in state, save() on mutation. blobtree's DB is a JSON report;
//     ndisc/smpl use SQLite (rusqlite). So the shared piece is the *interface*
//     (load / snapshot / save / path), not the storage engine.
//  2. Config as a typed, namespaced, persisted key set. Today each app
//     hardcodes `afqc-tauri.*` / `smpl-tool.*` / `uk.upleb.ndisc` keys ad hoc.
//     Universalise: one `persistedConfig<Schema>(namespace)` helper so every
//     app declares its scalars once with a prefix.
//  3. The roots/terrain model as the shared path vocabulary — `(root, relpath)`
//     identity + the suite roots manifest (see ndisc schema/terrain-roots).
//     `libRoot`, `workspaceDest` etc. become named roots, not bare strings,
//     so the same DB rows resolve across machines/OSes.
//  4. Derived selectors (libRoot, relays, filtered/grouped views, sampled
//     signatures) as pure functions over (db, config) — shareable verbatim
//     once 1–3 align.
//  5. Identity/keychain as a separate, already-shared-by-convention layer
//     (lib/nostr per app); not part of the DB store, but co-initialised.
//
// Migration reality: the storage engines differ (JSON vs SQLite), so the win
// is a shared *interface + config-key + roots* spec with per-app adapters —
// this file is the working reference for the JSON-report variant.
// ---------------------------------------------------------------------------

const DEFAULT_ROOT = "/data/music";
const SCANNER_ROOT_KEY = "afqc-tauri.scanner.root";
const WORKSPACE_DEST_KEY = "afqc-tauri.workspace.dest";
const PUBLISH_RELAY_KEY = "afqc-tauri.publish.relay";
const DEFAULT_PUBLISH_RELAY = "wss://relay.fizx.uk";
const SECONDARY_RELAYS = ["wss://nos.lol", "wss://relay.primal.net"];

export interface Library {
  /** The "DB": the current scan report (null until loaded/scanned). */
  report: ScanReport | null;
  setReport: (r: ScanReport | null) => void;
  /** Scanner source root (persisted). */
  root: string;
  setRoot: (v: string) => void;
  /** Shared mirror/sample destination (persisted). */
  workspaceDest: string;
  setWorkspaceDest: (v: string) => void;
  /** Editable first relay (persisted); joined with the locked secondaries. */
  publishRelay: string;
  /** Effective relay trio used across reads/publish. */
  relays: string[];
  /** The library root the rows are relative to: the report's root if loaded,
   *  else the configured scanner root. */
  libRoot: string;
  defaultPublishRelay: string;
}

export function useLibrary(): Library {
  const [report, setReport] = useState<ScanReport | null>(null);
  const [root, setRoot] = usePersistedString(SCANNER_ROOT_KEY, DEFAULT_ROOT);
  const [workspaceDest, setWorkspaceDest] = usePersistedString(
    WORKSPACE_DEST_KEY,
    "",
  );
  const [publishRelay] = usePersistedString(
    PUBLISH_RELAY_KEY,
    DEFAULT_PUBLISH_RELAY,
  );
  const relays = useMemo(
    () => [publishRelay.trim() || DEFAULT_PUBLISH_RELAY, ...SECONDARY_RELAYS],
    [publishRelay],
  );
  const libRoot = report?.root ?? root;

  return {
    report,
    setReport,
    root,
    setRoot,
    workspaceDest,
    setWorkspaceDest,
    publishRelay,
    relays,
    libRoot,
    defaultPublishRelay: DEFAULT_PUBLISH_RELAY,
  };
}
