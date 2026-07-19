# Changelog

All notable changes to **ntree** (binary `ndisc-tree`; formerly
`audio-flac-quality-check-tauri`, then `ndisc.blobtree`, then `ndisc.tree`).

ntree publishes **NIP-94 (kind:1063)** clip metadata and reads **kind:7**
reactions, but it is *not* a participant in ndisc's `release.vN` wire contract —
it describes clips, not releases. So it tracks a single axis: this app's own
semver, below. Shared contracts it *consumes* are named per entry (currently
ndisc's `published.json` manifest, and `~/.config/ndisc-suite/roots.json`).

> **Note on the entries below.** This file was started at **0.3.0** (2026-07-14).
> Everything from **0.2.12** down is **reconstructed from git history and the tag
> ranges** — the `Cut 0.2.x` commits carry good bodies, so the substance is
> accurate, but these are summaries written after the fact rather than notes
> taken at the time. Treat the git log as canonical if they ever disagree.
> The **0.2.7** entry covers a six-week, 37-commit stretch that was tagged only
> at the end of it.

## 0.3.1 — unreleased

### Clip-coverage bars in the Library
- The scan now records each track's **duration** — added to the existing
  ffprobe call (`format=duration`, a header read, no extra cost). Reports
  written by older builds load unchanged and simply show no bar until the next
  re-scan.
- Every audio track row gains a **clip-coverage bar**: the fixed 10 s clip as a
  fraction of the full source-track duration, on a perceptual (sqrt) scale so
  the common 3–4 % range stays visible (tracks ≤ 10 s read as fully sampled).
  Album and artist rows carry a duration-weighted **rollup**. No `%` labels —
  the true durations ride in the tooltip.

*Forward note:* the bar assumes the constant 10 s clip (`SAMPLE_SECS`). When
variable-length sampling lands, per-track clip length should be read from the
actual `.<secs>s.flac` clip rather than the constant — `nsmpl` already probes
per-clip length this way.

## 0.3.0 — 2026-07-14

### Monochrome theme — and it is now the default
- **New `mono` theme**; the title cycles **fizx → upleb → mono**. Monochrome is
  the **default**: no stored choice, an unrecognised one, or no localStorage at
  all resolves to `mono`. An existing choice is respected, so only a fresh
  install lands there.
- **Chrome goes greyscale; MEANING keeps its colour.** `.theme-mono` declares
  *only* the greyscale tokens — anything it does not redeclare keeps its `:root`
  value, so `ok` / `warn` / `alert` / `lossy` / `nostr` stay coloured with no
  work. **The block is a list of what does not mean anything.**
- Brand tokens were each doing two jobs, but hue was never their *only* carrier —
  hierarchy also lives in indent, fill, icons and labels — so it moves onto
  **luminance**: `mauve` (upper tier) sits brighter than `digital` (lower tier).
- **Fixes a theme flash on every launch.** The class was applied in a `useEffect`,
  which runs *after* the first paint. Now set pre-render by an inline script in
  `index.html`.

### Two brand tokens were carrying DATA — split before the theme could exist
- **`--c-lossy`.** `mauve` was the **LOSSY verdict** colour. Greyscale the brand
  and LOSSY becomes indistinguishable from **UNKNOWN** (`muted`). A verdict is
  data; it does not get to depend on the theme's brand colour. It was duplicated
  across **four** files (LibraryTree, TableView, SampleDetails, StatsView), now
  consistent for the first time.
- **`--c-nostr`.** `mauve` was *also* the published-clip dot, which in mono
  collapses into "not sampled". Split to what it always meant; the `released`
  chip moved with it.
- Same lesson as ndisc's `--c-nostr` vs `--c-warn`: **a state riding on a brand
  token is a bug waiting for a theme change.** The theme did not just restyle the
  app — it audited it.
- *Known softness:* the tri-state clip-dot filter still greys "no clip" close to
  "all" in mono. The tooltip carries it, and it is a control you drive rather than
  read — but it is the theme's weakest spot.

## 0.2.12 — 2026-07-14

- **Bitrate came from the CONTAINER, not the audio stream.** v0.2.11 reported
  half the MP3 library as "over 320 kbps" — a rate MP3 cannot produce. Container
  bitrate counts embedded cover art and ID3 tags, so a 320 kbps CBR MP3 with a
  JPEG in it probes at 322. Corrected: 55.9% of the MP3s are 320 CBR, 7.9% under
  128, and nothing above 320.
- The same mistake as mapping artwork into a sample clip, made twice in one day:
  **ask for the audio, not the file.** Now reads the stream's `bit_rate` with the
  container's as a fallback (first-key-wins parsing gives that precedence for
  free, since ffprobe prints stream fields before format fields).

## 0.2.11 — 2026-07-14

- **The stats view could say 44% of the library was lossless. It could not say
  what the library was MADE of** — the codec lived only inside a free-text `info`
  string (`"lossy · codec=mp3"`), and bit depth, bitrate and channel count were
  never captured at all.
- The scanner already ran an ffprobe per file; it now pulls **five fields in that
  same call** instead of two — so the extra data is free. They land as structured
  `Option` fields with `serde(default)`, so a report written before this still
  loads (it just has no detail until the next scan, and the view says so rather
  than rendering empty charts).
- **Keyed ffprobe output.** ffprobe emits fields in *its* order, not the requested
  one, so positional parsing was a trap waiting for the first file that omits a
  field. `"N/A"` (a lossy codec has no bit depth) is dropped rather than parsed
  into a bogus zero.
- New sections: **codec / sample rate / bit depth / channels**, plus a separate
  **lossy-bitrate** breakdown with 320 kbps on its own row — a 320 kbps MP3 and a
  96 kbps one are both just `LOSSY`, and the verdict cannot tell them apart.
- The verdicts **judge** the audio (spectral analysis); these breakdowns
  **describe** what it is (file headers). Different questions.

## 0.2.10 — 2026-07-14

### The source library is now guarded
- **`/data/music` is the only irreplaceable thing here** — the clip tree is
  derived and regenerates in minutes, the report is a cache. The old guard asked
  *"is the target inside `dest`?"* — but **`dest` is a user-editable text field**.
  Point it at the library by typo and an orphan prune would have destroyed it
  **with the guard's blessing**.
- Every delete now routes through `guard_deletable()`, which refuses if the target
  is inside the source library (whatever `dest` claims), if `dest` is or contains
  the source library, or if the target is outside `dest`. **Four tests.**

### Drift detection
- The scan report is a snapshot, and everything downstream — the Library tree, the
  filters, the sampler's scope — reads it **as if it were disk**. Nothing ever
  said otherwise. ntree's own video-normalize renames files out from under its own
  report; the sampler then spent three runs failing on paths that no longer
  existed.
- New `library_drift` walks the root and diffs **both ways**: on disk but
  unindexed (the sampler cannot see these), and indexed but gone (it will try them
  and fail). Cheap — a walk, no analysis. No report returns `null`: nothing to
  compare against is not drift.

### File-grain orphans
- The orphan check was **folder-grain**, and structurally blind to a clip whose
  source was renamed *inside a still-valid release*. Renaming 14 tracks left 14
  orphan clips it could never have seen.

## 0.2.9 — 2026-07-14

- Sample and Publish were overriding `Section`'s border colour, which made them
  read as a different kind of box from Library and Radio. Tint dropped.

## 0.2.8 — 2026-07-14

**A 12k-track mass sample of the ndisc-published discography flushed out four
bugs. The last one is why the other three took three runs to find.**

- **THE ORPHAN PRUNE WAS DELETING GOOD CLIPS.** `splitPath`'s `release` absorbs
  every middle segment (`"The The/Hyena"`), while the orphan test truncated the
  clip folder to two segments (`"Soundtracks/The The"`). They could **never**
  match for anything nested deeper than `artist/release` — every category folder
  and **every multi-disc release** — and that list feeds a delete button. **152
  clips went to the trash** (recovered). The clip tree mirrors the source tree, so
  the relpath *is* the key: compare the mirrored path to the mirrored path, do not
  re-derive it. Also guards the worse latent case: with no scan loaded,
  `sourceRels` is empty and **every** clip folder looked orphaned.
- **PIPE-BUFFER DEADLOCK.** `run_with_timeout` piped stdout/stderr and waited
  **without draining them**. A pipe holds ~64 KB; once full the child blocks on
  write and can never exit — so the 60s timeout killed a process that was doing
  nothing but waiting for us to read. One mp3 emitted **259 KB** of ffmpeg
  warnings. Those files were never slow. Standalone runs never showed it because
  **every shell drains as it goes**.
- **BROKEN COVER ART KILLED GOOD AUDIO.** The clip command mapped every stream,
  including embedded artwork. Plenty of tags lie about their own format (an APIC
  frame declaring PNG while holding JPEG bytes), and when the picture fails to
  decode ffmpeg **aborts the whole conversion and writes nothing**. Adds `-vn`.
  A clip is audio.
- **FAILURES NOW SAY WHY.** The backend had always built an error list and the UI
  **threw it away**. "14 failed" is unactionable and sent us guessing at ffmpeg
  from the outside. The moment reasons surfaced, the answer was plain: *"No such
  file or directory"* — a **stale scan report** still pointing at the `.avi`/`.mpg`
  files ntree's own video-normalize had turned into `.mp4`.
- Also reconciles video scope: the batch Scissors always sampled videos (their
  audio is legitimate) while the per-release Scissors excluded them and the code
  claimed they were "never analysed or sampled". Now both include them.

**Result: 12,407 of 12,407 tracks across the 1,609 released releases carry a
clip. No duplicates, no orphans.**

## 0.2.7 — 2026-07-13

*Tagged at the end of a six-week, 37-commit stretch (2026-06-16 → 07-13).*

### Video — the "Normalize videos" op
- **Census (part A)** — read-only `classify_videos`, bucketing every video into
  *plays* / *remux* / *audioFix* / *transcode*. Order-independent ffprobe parse.
- **Normalize (part B)** — `normalize_videos`: temp → backup → swap, originals
  never deleted. Per-bucket scope, default sibling backup folder.
- **Failures report WHY** (`a8743a2`) — backup-folder permission errors, ffmpeg's
  last stderr line, name collisions, "converted but could not put it in place".
  *(The `/data` partition is root-owned, so the default sibling backup path is
  unwritable — a "0 converted, 3 failed" that looked like a tool bug.)*

### Library, table, layout
- **Three-column `[ Sample · Library · Radio ]`** layout with collapse flanks.
- **Files table virtualized**, 2000-row cap dropped; in-table filter over
  artist / release / file.
- Scanner + Destination merged into one **Source & destination** panel; DB +
  config consolidated into `lib/library`; NOSTR moved to a header chip.
- **Mirror-tree folder management** (add / trash-to-OS-trash).
- Leaf → **dot vocabulary**; stats page; ndisc count-badge + chip language
  adopted; leaf-dots right-to-left fill synced with ndisc.
- **Video files recognised and displayed** (full media spectrum) — shared
  `VIDEO_EXTS` with the suite; markers only.
- Renamed **ndisc.tree → ntree** (header, dock name).

### Packaging
- `.deb` now declares the runtime dependencies ntree shells out to.

## 0.2.6 — 2026-05-27

- **Library + Filter merge.** `Filters` stripped of its own Section and collapse
  state (now a bare controls div); `LibraryTree` similarly returns a bare fragment
  with no Section wrapper of its own — the parent Library Section owns both.
- Scan stats relocated; more vivid alert/warn treatment.

## 0.2.5 — 2026-05-27

- Major right-column and top-row reshuffle plus a pile of UI compression.
  Functionally similar to 0.2.4 — no new wire format, no new commands — but the
  surface area is much tighter.

## 0.2.4 — 2026-05-27

- **End-to-end clip workflow: sample → play → publish.** Plus a Scanner / Mirror
  top sub-row and a verdict-bar treatment in the library tree.

## 0.2.3 — 2026-05-27

- **Closes the "what's already sampled" gap.** The workspace dest is walked on
  start, on dest change, and after each sample run; the resulting source
  signatures drive both the LibraryTree tints and a new filter.

## 0.2.2 — 2026-05-26

- **Selective sampling, end to end**, and non-FLAC audio is acknowledged instead
  of being pretended out of existence. Centred library-health module; per-panel
  collapsing.

## 0.2.1 — 2026-05-26

- Scanner robustness: **Stop button**, per-file ffmpeg/ffprobe timeout, 30s decode
  cap. Adopts ndisc's release workflow as the first Release.
