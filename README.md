# ndisc.tree

(binary `ndisc-tree`; formerly `audio-flac-quality-check-tauri` / `ndisc.blobtree`)

Tauri 2 desktop port of [`audio-flac-quality-check`](https://github.com/xjmzx/audio-flac-quality-check).
Same heuristic, same thresholds, same workflow — different stack so it
matches the rest of the suite ([`smpl-tool`](https://github.com/xjmzx/smpl-tool),
[`ndisc`](https://github.com/xjmzx/ndisc), [`bpm-tapper`](https://github.com/xjmzx/bpm-tapper)).

**Stack:** Tauri 2 desktop binary + React 19 + TypeScript + Tailwind v3.
Frontend is Vite. Scanning runs in Rust commands that shell out to
`ffmpeg`/`ffprobe` in parallel via rayon.

## What it does

For each `.flac` file under a chosen root:

1. `ffprobe` verifies the stream is really FLAC and reads sample rate.
2. `ffmpeg -af highpass=f=16000,volumedetect` measures the peak sample
   (dBFS) in the high band.
3. Genuine lossless 44.1 kHz audio retains measurable energy above
   16 kHz (peak typically −10 to −45 dBFS). Lossy codecs low-pass below
   their bandwidth limit, so the peak above 16 kHz is essentially
   silence (well below −65 dBFS).

| Verdict | Peak above 16 kHz |
| --- | --- |
| `LOSSLESS` | ≥ −35 dB |
| `UNCERTAIN` | between (review manually — quiet/ambient genuine lossless can land here) |
| `PROBABLY-LOSSY` | ≤ −65 dB |
| `NOT-FLAC` | codec is not flac |
| `UNKNOWN` | ffprobe / ffmpeg failed |

The method does **not** rely on file size or compression ratio — those
cannot distinguish real lossless from a lossy source re-encoded as FLAC.

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
GNOME / KDE / XFCE app menus as **FLAC Library Browser**).

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

## Layout

```
ndisc.tree/
├── src/                              # React + TS frontend
│   ├── App.tsx                       # main layout
│   ├── components/                   # ScannerControls, Filters, LibraryTree,
│   │                                 # StatusBar, NostrPanel (stub), Section
│   ├── lib/cn.ts                     # clsx + tailwind-merge helper
│   └── lib/tauri.ts                  # typed wrappers around invoke() + events
├── src-tauri/
│   ├── src/lib.rs                    # scan_library / load_report /
│   │                                 # save_report / open_folder
│   ├── Cargo.toml
│   └── tauri.conf.json
├── icon.svg                          # suite-style 128px tile
├── ndisc-tree.desktop.in
└── Makefile
```

## Notes on the Nostr slot

The right-hand `NostrPanel` is a structural placeholder, matching the
suite-wide layout used in `smpl-tool` and `ndisc`. Nothing is wired —
the quality scanner has no obvious thing to publish yet. When a use case
appears (e.g. publish a library-quality summary, or share a suspect-track
list), copy `lib/nostr.ts` and the upload + publish flow from
[`smpl-tool`](https://github.com/xjmzx/smpl-tool/blob/main/src/lib/nostr.ts).

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
