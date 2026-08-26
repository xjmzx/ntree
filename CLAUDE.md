# ntree — notes for Claude

FLAC quality scanner, sampler and library mirror (binary `ndisc-tree`; the
GitHub repo is still named `ndisc.blobtree`). Tauri 2 · React. See
[`ntree-introduction.md`](ntree-introduction.md).

## Read SUITE.md first

[`../ndisc/SUITE.md`](https://github.com/xjmzx/ndisc/blob/main/SUITE.md) is
authoritative for anything shared across the suite — and this repo is the
**reference implementation** for the Library grammar and the row/density work,
so changes here set the pattern others follow.

Read it **before making a platform-sensitive choice**. It records constraints
invisible on the machine you are working on: `nchat` shipped Web Audio tones
that worked on macOS and were silent on Linux, which SUITE.md had already
documented.

## Build and verify

```
make dev      # hot reload
make check    # npm run build (tsc + vite) + cargo check
make build    # release
```

Release path is `tauri build`, which runs Vite. **Never `cargo build --release`**.

## Traps specific to this repo

- **Clip preview must reuse a single `HTMLMediaElement`.** Web Audio output is
  broken on WebKit2GTK, so the media element is the only working path — and
  constructing a fresh `Audio()` per click is the other thing that stack
  dislikes. The existing single reused element is deliberate, not laziness.
- **No database.** This app works against the filesystem live; there is no local
  index to migrate or keep in sync.
- Publishes NIP-94 clips and reactions with a local `nsec` from the OS keyring.
  Per the suite rule, the desktop tools sign with the **same** key so "my clips"
  reconciles under one author pubkey.
- `"csp": null` here. A media pattern proven in this repo may still need an
  explicit CSP entry in `nchat`, which is the one app that ships a real one.

## Not here

Machine-local paths, server addresses, credentials and per-box ops belong in a
machine-local `CLAUDE.md`, never in this file. **This repo is public.**
