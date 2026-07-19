# ntree — FLAC quality scanner · sampler · library mirror

> Part of the **n-suite**. Shared conventions, the Nostr wire contract, the
> design language, and the roadmap live in the hub doc:
> **[ndisc/SUITE.md](https://github.com/xjmzx/ndisc/blob/main/SUITE.md)**
> (locally: `../ndisc/SUITE.md`). This file covers **ntree** specifically.
>
> *(The built binary is named `ndisc-tree`.)*

`ntree` inspects the library's **audio quality**, cuts short **sample clips**,
and maintains a **mirror** of the library — a technician's-bench companion to
`ndisc`.

## What it does
- Scans FLAC (and other) files for real quality, including ffmpeg spectral
  analysis (spotting transcodes / lossy-sourced "lossless").
- **Sampler** — cuts ~10 s clips from tracks for preview and for publishing.
- Maintains a **mirror tree** of the library (privileged copy via `pkexec`).
- Three-column **[Sample · Library · Radio]** layout with collapse-flanks;
  recognises and marks video via the shared `VIDEO_EXTS`.
- Reads a **kind:1063** clip feed and lets you **react** (kind 7).

## Tech stack & build
Tauri 2 · React + Vite + TypeScript · Rust backend · filesystem-oriented (no
SQLite) · OS keyring for the signing key · `nostr-sdk`. `make dev` /
`make install`.

## Suite integration
- **References `ndisc` releases**: clips are cut from library files that map back
  to catalogued releases (provenance — a growing near-term goal is to make each
  published clip explicitly reference its source release).
- **Reads** a **kind:1063** clip feed and posts **reactions** (kind 7) using
  the shared `lib/rating.ts` aggregation, consistent with the rest of the suite.
- Shares the leaf/foliage vocabulary with `nsmpl` (leaves = clips/provenance).

## Nostr surface
Publishes **NIP-94 file metadata (kind 1063)** for clips and **reactions
(kind 7)**; reads a **kind:1063** clip feed. Signs with a local `nsec` in the
OS keyring.

## Styling notes
Shared design language. Three-column collapse-flanks layout, squared boxes,
fizx palette. Shares the leaf-dot / green leaf-cluster motifs with `nsmpl`.

## Backlog & direction
- Make published clips reference their source `ndisc` release (provenance link).
- Planned **"Normalize videos"** batch op: remux/transcode library videos to
  playable H.264/AAC faststart mp4 for `nplay` (census + buckets, in-place +
  backup-originals tree).
- Deeper clip provenance / "leaves" diagrammatic tree (shared direction with
  `nsmpl`).
- See **[SUITE.md → Direction](https://github.com/xjmzx/ndisc/blob/main/SUITE.md#direction--roadmap)**
  for the sampling → collaboration → publishing arc.
