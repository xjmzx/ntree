<img src="docs/ntree-lockup.svg" alt="ntree" width="300">

# ntree

(binary `ndisc-tree`; formerly `audio-flac-quality-check-tauri` / `ndisc.blobtree`)

Tauri 2 desktop port of [`audio-flac-quality-check`](https://github.com/xjmzx/audio-flac-quality-check).
Same heuristic, same thresholds, same workflow — different stack so it
matches the rest of the suite ([`smpl-tool`](https://github.com/xjmzx/smpl-tool),
[`ndisc`](https://github.com/xjmzx/ndisc), [`bpm-tapper`](https://github.com/xjmzx/bpm-tapper)).

**Stack:** Tauri 2 desktop binary + React 19 + TypeScript + Tailwind v3.
Frontend is Vite. Scanning runs in Rust commands that shell out to
`ffmpeg`/`ffprobe` in parallel via rayon.

## What it does

ntree is a technician's bench for auditing and staging a FLAC music
library. Its core is a **spectral quality scanner**; around that it has
grown a sampler, a mirror-tree builder, a video normalizer, and a Nostr
publish/feed surface.

### Quality scan

For each `.flac` file under a chosen root:

1. `ffprobe` verifies the stream is really FLAC and reads sample rate.
2. `ffmpeg -af highpass=f=16000,volumedetect` measures the peak sample
   (dBFS) in the high band.
3. Genuine lossless 44.1 kHz audio retains measurable energy above
   16 kHz (peak typically −10 to −45 dBFS). Lossy codecs low-pass below
   their bandwidth limit, so the peak above 16 kHz is essentially
   silence (well below −65 dBFS).

| Verdict | Meaning |
| --- | --- |
| `LOSSLESS` | FLAC peak above 16 kHz ≥ −35 dB, or a natively lossless codec (ALAC, PCM, APE…) |
| `UNCERTAIN` | FLAC between the thresholds — review manually (quiet/ambient genuine lossless can land here) |
| `PROBABLY-LOSSY` | FLAC peak above 16 kHz ≤ −65 dB — likely a lossy source re-encoded as FLAC |
| `LOSSY` | codec is lossy by design (MP3, AAC, Opus…) — honest lossy, not lossy-pretending |
| `UNKNOWN` | ffprobe / ffmpeg failed, or unrecognized codec |

The method does **not** rely on file size or compression ratio — those
cannot distinguish real lossless from a lossy source re-encoded as FLAC.

### Beyond the scan

- **Sampler** — cuts short (~10 s) preview clips of tracks
  (`sample_tracks`), per-release or in batch, with orphan-clip detection
  and pruning.
- **Mirror tree** — builds a parallel library tree via a privileged
  (`pkexec`) copy, with orphan pruning.
- **Video census + normalize** — classifies legacy library videos and
  remuxes / transcodes them to faststart H.264/AAC mp4
  (`classify_videos` / `normalize_videos`).
- **Nostr** — signs with an `nsec` held in the OS keychain; publishes
  clips as NIP-94 **kind:1063** file events (NIP-96 upload + NIP-98
  auth); shows a live kind:1063 **feed** you can react to (kind:7).
- **Released filter** — cross-references `ndisc`'s exported manifest to
  scope the library down to already-**released** (kind:31237) tracks.
- **Clip-coverage bars** — the scan records each track's duration, and every
  track row shows its 10 s clip as a (perceptually-scaled) fraction of the full
  track, with album/artist rollups.

## Install runtime dependencies (Debian / Ubuntu)

The app shells out to `ffmpeg`/`ffprobe` — same runtime dep as the Python
original.

```sh
sudo apt update
sudo apt install ffmpeg
```

Tauri's [Linux prerequisites](https://tauri.app/start/prerequisites/#linux):

```sh
sudo apt install \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  build-essential \
  curl wget file
```

Plus a Node toolchain and a Rust toolchain:

```sh
sudo apt install nodejs npm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Quick start

```sh
git clone https://github.com/xjmzx/ndisc.tree.git
cd ndisc.tree

make deps      # npm install + cargo fetch
make icons     # one-time: generate Tauri bundle icons from icon.svg
make dev       # opens the Tauri window with hot reload
```

## Build / install / deploy

The `Makefile` builds a release binary and places it under `PREFIX/bin`,
the icon under `PREFIX/share/icons/hicolor/scalable/apps`, and a
`.desktop` entry under `PREFIX/share/applications` (so the app appears in
GNOME / KDE / XFCE app menus as **ntree** — generic name *FLAC Library
Quality Browser*).

```sh
# user-level install (no sudo) — default PREFIX is $HOME/.local
make install

# system-wide
sudo make install PREFIX=/usr/local

# remove
make uninstall                     # or: sudo make uninstall PREFIX=/usr/local
```

Other targets:

```sh
make help     # list everything
make check    # tsc + vite build + cargo check (no full Tauri build)
make build    # release build only
make clean    # remove dist/ and src-tauri/target/
```

## Keybindings (matches the Python Tk version)

| Key | Action |
| --- | --- |
| `Ctrl+R` | Re-scan the configured root |
| `Ctrl+F` | Focus the search box |
| `Esc` | Clear filter + search |
| Double-click a track row | Open its containing folder (`xdg-open`) |

## Persistence

Scan reports are cached as JSON in the standard Tauri app-data dir
(`~/.local/share/uk.fizx.audioflacqualitycheck/last_scan.json` on Linux),
not next to the binary. The window restores the last scan on launch.

Other state:

- **Signing key** — the `nsec` lives in the OS keychain (never in
  localStorage).
- **UI + config** — theme, published-clip set, and panel-collapse flags
  are `localStorage` keys (`afqc-tauri.theme`, `afqc-tauri.published`,
  `afqc-tauri.leftCollapsed` / `afqc-tauri.rightCollapsed`); scan root,
  clip destination and relay list persist via the `lib/library` config
  store.

(The **released filter** instead *reads* `ndisc`'s exported
`~/.local/share/ndisc-suite/published.json` — an input, not ntree state.)

## Layout

```
ndisc.tree/
├── src/                              # React + TS frontend
│   ├── App.tsx                       # three-column layout + views
│   ├── components/                   # ScannerControls, Filters, LibraryTree,
│   │                                 # SamplerPanel, PublishPanel, FeedPanel,
│   │                                 # MirrorControls, VideoCensus, NostrPanel,
│   │                                 # StatsView, TableView, AudioPlayer, Section
│   ├── hooks/useReactions.ts         # kind:7 reaction state
│   ├── lib/nostr.ts                  # keychain nsec + relay helpers
│   ├── lib/useMirror.ts              # mirror-tree + orphan pruning
│   ├── lib/{paths,library,rating}.ts # clip-path, config, verdict helpers
│   ├── lib/cn.ts                     # clsx + tailwind-merge helper
│   └── lib/tauri.ts                  # typed wrappers around ~30 invoke() commands
├── src-tauri/
│   ├── src/lib.rs                    # scan_library, sample_tracks, classify_/
│   │                                 # normalize_videos, publish_file_metadata,
│   │                                 # publish_reaction, mirror, open_folder, …
│   ├── Cargo.toml
│   └── tauri.conf.json
├── icon.svg                          # suite-style 128px tile
├── ndisc-tree.desktop.in
└── Makefile
```

## Nostr

Signing uses an `nsec` stored in the OS keychain — `NostrPanel` signs in
or generates a key. ntree publishes its sampled clips as NIP-94
**kind:1063** file events (NIP-96 upload via `uploadToNip96` + NIP-98
auth, then the 1063 event over a relay — `PublishPanel`), and subscribes
to a live kind:1063 **feed** (`FeedPanel`) you can react to with kind:7
(`useReactions`). The clip-provenance and multi-relay gaps below are the
remaining work here.

## Still to come

The scanner, sampler, mirror and video-normalize passes are complete. The
open work is on the **clip publishing** side — the kind:1063 event ships
today with only file-metadata tags, so the plumbing is half-done:

- **Link each clip to its release** — a published clip carries no `a`-tag
  pointing at its parent `kind:31237` release, so it can't be traced back
  to what it came from. Land this as **`clip.v1`** provenance
  (`ndisc/schema/clip.v1.json`): an `a`-ref + track locator, reconciled off
  the relays.
- **Share ntree's own clips as an `nevent`** — `smpl-tool` already emits a
  share link for a published sample; ntree's clips have none.
- **Multi-relay feed** — `FeedPanel` still reads only the first relay
  (`TODO(relays)`); refactor the raw-WebSocket logic onto `SimplePool` over
  the full relay set.
- **Durable publish state** — published-clip state lives in `localStorage`
  (`afqc-tauri.published`) only; move it to durable storage so it survives
  a reinstall and reconciles against the relays.
- **Per-clip length for the coverage bar** — the bar currently assumes the
  constant 10 s (`SAMPLE_SECS`); once variable-length sampling exists, read the
  real length from the `.<secs>s.flac` clip, the way `nsmpl` already does.

## Caveats

Spectral cutoff is a heuristic; pure drone / sub-bass / silent ambient
tracks have no high-frequency content even when fully lossless and will
show up as `PROBABLY-LOSSY`. Verify suspect tracks by listening, by
checking metadata (encoder, source bitrate), or with a spectrum
visualiser like Spek.

## Companion projects

- [`audio-flac-quality-check`](https://github.com/xjmzx/audio-flac-quality-check) — the original Python + Tk version this is a port of.
- [`smpl-tool`](https://github.com/xjmzx/smpl-tool)
- [`ndisc`](https://github.com/xjmzx/ndisc)
- [`bpm-tapper`](https://github.com/xjmzx/bpm-tapper)
