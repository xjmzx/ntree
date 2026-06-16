// Nostr identity helpers for ndisc.tree.
//
// The nsec lives in the OS keychain (libsecret on Linux) via the Rust
// `keyring` crate — never in localStorage. Mirrors ndisc's pattern.
// Dev builds use a separate keychain service (`audio-flac-quality-check
// -tauri-dev` vs `audio-flac-quality-check-tauri`) so `make dev` runs
// can't read or overwrite the installed binary's identity.
//
// The frontend only ever holds `{ npub, pk }`. `nsec` is returned ONCE
// by `generateIdentity()` so the user can back it up. After that, only
// the keychain holds it.

import { invoke } from "@tauri-apps/api/core";

export interface Identity {
  npub: string;
  /** hex pubkey, for relay author filters. */
  pk: string;
}

export interface GeneratedIdentity extends Identity {
  /** Returned once by generateIdentity — display, let the user copy, then drop. */
  nsec: string;
}

const LEGACY_NSEC_KEY = "afqc-tauri.nsec";
let migrationAttempted = false;

/** One-time migration: if the keychain is empty but the legacy
 *  localStorage nsec exists, import it and clear the legacy entry. */
async function migrateLegacyIfNeeded(): Promise<void> {
  if (migrationAttempted) return;
  migrationAttempted = true;
  try {
    const current = await invoke<Identity | null>("get_identity");
    if (current) return;
    const legacy = localStorage.getItem(LEGACY_NSEC_KEY);
    if (!legacy) return;
    await invoke<Identity>("import_identity", { nsec: legacy });
    localStorage.removeItem(LEGACY_NSEC_KEY);
  } catch {
    // Leave the legacy entry in place if migration fails; user can
    // re-import manually via NostrPanel.
  }
}

export async function loadIdentity(): Promise<Identity | null> {
  await migrateLegacyIfNeeded();
  return invoke<Identity | null>("get_identity");
}

export async function generateIdentity(): Promise<GeneratedIdentity> {
  return invoke<GeneratedIdentity>("generate_identity");
}

export async function saveKey(nsec: string): Promise<Identity> {
  return invoke<Identity>("import_identity", { nsec: nsec.trim() });
}

export async function clearIdentity(): Promise<void> {
  return invoke("clear_identity");
}

/** Short display form: "npub1abcdefgh…wxyz". */
export function shortNpub(npub: string): string {
  if (npub.length < 16) return npub;
  return `${npub.slice(0, 12)}…${npub.slice(-4)}`;
}
