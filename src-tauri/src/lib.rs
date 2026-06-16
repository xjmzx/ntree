// Tauri commands for ndisc.tree (binary: ndisc-tree).
//
// 1:1 port of the Python check_flac_quality.sh + flac_library_browser.py:
//   - scan_library: walks <root>/**/*.flac, runs ffprobe + ffmpeg high-pass
//     volumedetect per file in parallel, emits "scan-progress" events.
//   - load_report / save_report: JSON cache in Tauri app data dir.
//   - open_folder: xdg-open on the containing folder (double-click action).

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output as ProcessOutput, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::available_parallelism;
use std::time::Duration;

use wait_timeout::ChildExt;

use keyring::Entry;
use nostr::nips::nip19::{FromBech32, ToBech32};
use nostr::{EventBuilder, Keys, Kind, SecretKey, Tag};
use nostr_sdk::prelude::Output;
use nostr_sdk::Client;
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

const HIGHPASS_HZ: u32 = 16_000;
const LOSSY_DB: f32 = -65.0;
const LOSSLESS_DB: f32 = -35.0;
const ANALYSIS_SECS: u32 = 30;
// Audio file extensions the scanner picks up. FLAC stays the focus
// (spectral heuristic only runs on it); other formats are categorized
// by codec name alone — no ffmpeg decode for lossy-by-design files.
const AUDIO_EXTS: &[&str] = &[
    "flac", "mp3", "m4a", "aac", "ogg", "opus", "wav", "aiff", "aif",
    "ape", "wv", "tak", "alac", "mp2", "wma",
];
// Wall-clock caps per child process. ffmpeg with ANALYSIS_SECS=30 normally
// finishes in 1–5s on modern hardware; 60s leaves >10× headroom so legitimate
// scans never trip the cap. ffprobe is metadata-only and should be near
// instant. Tripping either signals a genuine hang (corrupt input, NFS stall).
const FFMPEG_TIMEOUT_SECS: u64 = 60;
const FFPROBE_TIMEOUT_SECS: u64 = 15;
const REPORT_FILENAME: &str = "last_scan.json";
// Kept on the original name across the ndisc.tree rename ON PURPOSE: the
// keychain service is a stable identity — renaming it would orphan the user's
// already-stored Nostr nsec.
const KEYRING_SERVICE_RELEASE: &str = "audio-flac-quality-check-tauri";
const KEYRING_SERVICE_DEV: &str = "audio-flac-quality-check-tauri-dev";
const KEYRING_USER: &str = "default";

/// Debug builds (`tauri dev`) use a separate keychain service so dev
/// state never reads or writes the real installed-app nsec. Matches
/// ndisc's pattern.
fn keyring_service() -> &'static str {
    if cfg!(debug_assertions) {
        KEYRING_SERVICE_DEV
    } else {
        KEYRING_SERVICE_RELEASE
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
enum Verdict {
    /// FLAC passes spectral OR codec is natively lossless (ALAC, PCM-*, APE, …).
    #[serde(rename = "LOSSLESS")]
    Lossless,
    /// FLAC fails the spectral check (peak above 16 kHz ≤ −65 dB).
    #[serde(rename = "PROBABLY-LOSSY")]
    ProbablyLossy,
    /// FLAC between thresholds — could be genuine quiet/ambient lossless.
    #[serde(rename = "UNCERTAIN")]
    Uncertain,
    /// Codec is lossy by design (MP3, AAC, Opus, …) — separate from
    /// PROBABLY-LOSSY since this is honest lossy, not lossy-pretending.
    #[serde(rename = "LOSSY")]
    Lossy,
    /// ffprobe failed, unrecognized codec, or missing sample rate on a FLAC.
    #[serde(rename = "UNKNOWN")]
    Unknown,
}

#[derive(Serialize, Deserialize, Clone)]
struct ScanRow {
    verdict: Verdict,
    path: String,
    peak: Option<f32>,
    sr: Option<u32>,
    info: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct ScanReport {
    root: String,
    generated: String,
    rows: Vec<ScanRow>,
}

#[derive(Serialize, Clone)]
struct ScanProgress {
    done: usize,
    total: usize,
    path: String,
    verdict: Verdict,
}

/// Tauri-managed cancel flag for the running scan. `cancel_scan` flips
/// it to true; `scan_library` clears it at start; `scan_inner`'s par_iter
/// short-circuits per-file when set. In-flight ffmpeg calls finish (≤30s
/// with the ANALYSIS_SECS cap) — no mid-process kill.
struct ScanCancel(Arc<AtomicBool>);

impl ScanCancel {
    fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
}

/// Sibling of [`ScanCancel`] for the Sampler — separate so cancelling
/// a sample doesn't interrupt a concurrent scan, and vice versa.
struct SampleCancel(Arc<AtomicBool>);

impl SampleCancel {
    fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SampleItem {
    src: String,
    dest: String,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
enum SampleOutcome {
    Created,
    Skipped,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SampleProgress {
    done: usize,
    total: usize,
    path: String,
    outcome: SampleOutcome,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SampleReport {
    total: usize,
    created: usize,
    skipped: usize,
    failed: usize,
    timed_out: usize,
    cancelled: usize,
    /// Up to `ERROR_SAMPLE` source paths for files that failed/timed out,
    /// surfaced so the user can inspect or retry. Not the full list.
    errors: Vec<String>,
}

const ERROR_SAMPLE: usize = 20;

// ---- ffprobe + ffmpeg --------------------------------------------------

/// Outcome of `run_with_timeout`. `TimedOut` is distinguished from `Failed`
/// so the caller can surface "this file took too long" separately from
/// "spawn failed / non-zero exit".
enum RunOutcome {
    Ok(ProcessOutput),
    TimedOut,
    Failed,
}

/// `Command::output()` with a wall-clock cap. On timeout, kill the child
/// and reap it so the process slot is released. stdout/stderr are piped so
/// callers that parse stderr (ffmpeg's volumedetect line) keep working.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> RunOutcome {
    let mut child = match cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(_) => return RunOutcome::Failed,
    };
    let status = match child.wait_timeout(timeout) {
        Ok(Some(s)) => s,
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            return RunOutcome::TimedOut;
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return RunOutcome::Failed;
        }
    };
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut h) = child.stdout.take() { let _ = h.read_to_end(&mut stdout); }
    if let Some(mut h) = child.stderr.take() { let _ = h.read_to_end(&mut stderr); }
    RunOutcome::Ok(ProcessOutput { status, stdout, stderr })
}

enum FfprobeOutcome {
    Ok { codec: Option<String>, sr: Option<u32> },
    TimedOut,
    Failed,
}

fn ffprobe_fields(path: &Path) -> FfprobeOutcome {
    let mut cmd = Command::new("ffprobe");
    cmd.args([
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,sample_rate",
        "-of", "default=noprint_wrappers=1:nokey=1",
    ])
    .arg(path);
    match run_with_timeout(cmd, Duration::from_secs(FFPROBE_TIMEOUT_SECS)) {
        RunOutcome::Ok(out) => {
            if !out.status.success() {
                return FfprobeOutcome::Failed;
            }
            let s = String::from_utf8_lossy(&out.stdout);
            let mut lines = s.lines();
            let codec = lines.next().map(str::trim).filter(|x| !x.is_empty()).map(String::from);
            let sr = lines.next().and_then(|s| s.trim().parse::<u32>().ok());
            FfprobeOutcome::Ok { codec, sr }
        }
        RunOutcome::TimedOut => FfprobeOutcome::TimedOut,
        RunOutcome::Failed => FfprobeOutcome::Failed,
    }
}

enum PeakOutcome {
    Ok(f32),
    TimedOut,
    Failed,
}

fn measure_high_band_peak(path: &Path, cutoff_hz: u32, vol_re: &Regex) -> PeakOutcome {
    // Cap analysis to the first ANALYSIS_SECS of audio. A lossy encoder
    // applies the same band-cut to the entire file, so the peak above the
    // cutoff is consistent across the track — no point decoding a 60-min
    // FLAC end to end.
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-nostdin", "-t", &ANALYSIS_SECS.to_string(), "-i"])
        .arg(path)
        .args([
            "-af",
            &format!("highpass=f={cutoff_hz},volumedetect"),
            "-f", "null", "-",
        ]);
    match run_with_timeout(cmd, Duration::from_secs(FFMPEG_TIMEOUT_SECS)) {
        RunOutcome::Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            match vol_re
                .captures(&stderr)
                .and_then(|c| c.get(1))
                .and_then(|m| m.as_str().parse::<f32>().ok())
            {
                Some(v) => PeakOutcome::Ok(v),
                None => PeakOutcome::Failed,
            }
        }
        RunOutcome::TimedOut => PeakOutcome::TimedOut,
        RunOutcome::Failed => PeakOutcome::Failed,
    }
}

/// Codec → categorisation. FLAC routes to the spectral check; other
/// audio codecs are tagged by their codec name. Returns `None` for
/// codecs we don't recognise (caller marks Unknown).
fn codec_category(codec: &str) -> Option<Verdict> {
    if codec == "flac" {
        return None; // signal: caller should run the spectral check
    }
    // Native lossless families recognised by ffprobe. PCM covers WAV /
    // AIFF / raw — every pcm_* sub-codec stays lossless.
    if matches!(codec, "alac" | "wavpack" | "ape" | "tak")
        || codec.starts_with("pcm_")
    {
        return Some(Verdict::Lossless);
    }
    // Codecs that are lossy by design.
    if matches!(
        codec,
        "mp3" | "aac" | "opus" | "vorbis" | "ac3" | "eac3" | "wma" | "wmav1" | "wmav2" | "mp2"
    ) {
        return Some(Verdict::Lossy);
    }
    None
}

fn classify(path: &Path, vol_re: &Regex) -> ScanRow {
    let path_str = path.to_string_lossy().into_owned();
    let (codec, sr) = match ffprobe_fields(path) {
        FfprobeOutcome::Ok { codec, sr } => (codec, sr),
        FfprobeOutcome::TimedOut => {
            return ScanRow {
                verdict: Verdict::Unknown,
                path: path_str,
                peak: None,
                sr: None,
                info: format!("ffprobe timed out ({FFPROBE_TIMEOUT_SECS}s)"),
            };
        }
        FfprobeOutcome::Failed => {
            return ScanRow {
                verdict: Verdict::Unknown,
                path: path_str,
                peak: None,
                sr: None,
                info: "ffprobe failed".into(),
            };
        }
    };
    let Some(codec) = codec else {
        return ScanRow {
            verdict: Verdict::Unknown,
            path: path_str,
            peak: None,
            sr: None,
            info: "ffprobe: no codec".into(),
        };
    };

    // Non-FLAC codecs: categorise by codec name alone — no ffmpeg pass.
    if let Some(verdict) = codec_category(&codec) {
        let kind = match verdict {
            Verdict::Lossless => "native lossless",
            Verdict::Lossy => "lossy",
            _ => "categorised",
        };
        return ScanRow {
            verdict,
            path: path_str,
            peak: None,
            sr,
            info: format!("{kind} · codec={codec}"),
        };
    }

    // FLAC path: the spectral heuristic gates this — same as before.
    if codec != "flac" {
        return ScanRow {
            verdict: Verdict::Unknown,
            path: path_str,
            peak: None,
            sr,
            info: format!("unrecognised codec={codec}"),
        };
    }
    let Some(sr_val) = sr else {
        return ScanRow {
            verdict: Verdict::Unknown,
            path: path_str,
            peak: None,
            sr,
            info: "flac · no sample rate".into(),
        };
    };

    // Low-rate safety: if the file's sample rate can't span 2× the cutoff,
    // drop the cutoff to a quarter of the rate (matches the Python).
    let cutoff = if sr_val < 2 * HIGHPASS_HZ {
        ((sr_val / 4).max(4000)) as u32
    } else {
        HIGHPASS_HZ
    };

    let peak = match measure_high_band_peak(path, cutoff, vol_re) {
        PeakOutcome::Ok(p) => p,
        PeakOutcome::TimedOut => {
            return ScanRow {
                verdict: Verdict::Unknown,
                path: path_str,
                peak: None,
                sr,
                info: format!("ffmpeg timed out ({FFMPEG_TIMEOUT_SECS}s)"),
            };
        }
        PeakOutcome::Failed => {
            return ScanRow {
                verdict: Verdict::Unknown,
                path: path_str,
                peak: None,
                sr,
                info: "ffmpeg/volumedetect failed".into(),
            };
        }
    };

    let info = format!("flac · peak>{cutoff}Hz={peak:+.1}dB sr={sr_val}");
    let verdict = if peak <= LOSSY_DB {
        Verdict::ProbablyLossy
    } else if peak >= LOSSLESS_DB {
        Verdict::Lossless
    } else {
        Verdict::Uncertain
    };
    ScanRow {
        verdict,
        path: path_str,
        peak: Some(peak),
        sr,
        info,
    }
}

// ---- commands ---------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioCount {
    file_count: usize,
    total_bytes: u64,
}

/// True if the path's extension matches one of [`AUDIO_EXTS`]. Case-insensitive.
fn has_audio_ext(p: &Path) -> bool {
    p.extension()
        .and_then(|x| x.to_str())
        .map(|x| {
            let lower = x.to_ascii_lowercase();
            AUDIO_EXTS.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

#[tauri::command]
async fn count_audio_files(root: String) -> Result<AudioCount, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root_pb = PathBuf::from(&root);
        if !root_pb.is_dir() {
            return Err(format!("not a directory: {root}"));
        }
        let mut file_count = 0usize;
        let mut total_bytes = 0u64;
        for entry in WalkDir::new(&root_pb).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() || !has_audio_ext(entry.path()) {
                continue;
            }
            file_count += 1;
            if let Ok(meta) = entry.metadata() {
                total_bytes = total_bytes.saturating_add(meta.len());
            }
        }
        Ok(AudioCount { file_count, total_bytes })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MirrorPair {
    artist: String,
    release: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MirrorResult {
    created: usize,
    skipped: usize,
    errors: Vec<String>,
}

#[tauri::command]
async fn create_mirror_tree(
    dest: String,
    source_root: String,
    pairs: Vec<MirrorPair>,
    sudo: bool,
) -> Result<MirrorResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if sudo {
            mirror_tree_pkexec(dest, source_root, pairs)
        } else {
            mirror_tree_plain(dest, pairs)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn mirror_tree_plain(dest: String, pairs: Vec<MirrorPair>) -> Result<MirrorResult, String> {
    let dest_pb = PathBuf::from(&dest);
    if dest_pb.exists() && !dest_pb.is_dir() {
        return Err(format!("destination exists and is not a directory: {dest}"));
    }
    fs::create_dir_all(&dest_pb)
        .map_err(|e| format!("create {}: {e}", dest_pb.display()))?;

    let mut created = 0usize;
    let mut skipped = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for pair in pairs {
        let artist = sanitize(&pair.artist);
        let release = sanitize(&pair.release);
        if artist.is_empty() || release.is_empty() {
            errors.push(format!("skipped empty pair: {:?}/{:?}", pair.artist, pair.release));
            continue;
        }
        let target = dest_pb.join(&artist).join(&release);
        if target.exists() {
            skipped += 1;
            continue;
        }
        match fs::create_dir_all(&target) {
            Ok(()) => created += 1,
            Err(e) => errors.push(format!("{}: {e}", target.display())),
        }
    }
    Ok(MirrorResult { created, skipped, errors })
}

fn mirror_tree_pkexec(
    dest: String,
    source_root: String,
    pairs: Vec<MirrorPair>,
) -> Result<MirrorResult, String> {
    use std::os::unix::fs::MetadataExt;

    let dest_pb = PathBuf::from(&dest);
    let src_pb = PathBuf::from(&source_root);

    let src_meta = fs::metadata(&src_pb)
        .map_err(|e| format!("stat source {}: {e}", src_pb.display()))?;
    let uid = src_meta.uid();
    let gid = src_meta.gid();
    let mode = src_meta.mode() & 0o7777;

    // Sanitize + classify pairs into existing (skip) vs missing (need mkdir).
    let mut to_create: Vec<PathBuf> = Vec::new();
    let mut skipped = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for pair in pairs {
        let artist = sanitize(&pair.artist);
        let release = sanitize(&pair.release);
        if artist.is_empty() || release.is_empty() {
            errors.push(format!("skipped empty pair: {:?}/{:?}", pair.artist, pair.release));
            continue;
        }
        let target = dest_pb.join(&artist).join(&release);
        if target.exists() {
            skipped += 1;
        } else {
            to_create.push(target);
        }
    }

    // Always run chown/chmod on the destination root even if nothing new — so
    // a half-finished previous attempt gets corrected. mkdir is no-op when
    // to_create is empty.
    let dest_q = shell_quote(&dest_pb.to_string_lossy());
    let mut script = String::new();
    script.push_str(&format!("mkdir -p -- {dest_q}"));
    if !to_create.is_empty() {
        let mkdir_args = to_create
            .iter()
            .map(|p| shell_quote(&p.to_string_lossy()))
            .collect::<Vec<_>>()
            .join(" ");
        script.push_str(&format!(" && mkdir -p -- {mkdir_args}"));
    }
    script.push_str(&format!(
        " && chown -R {uid}:{gid} -- {dest_q} && chmod -R {mode:o} -- {dest_q}"
    ));

    let output = std::process::Command::new("pkexec")
        .arg("sh")
        .arg("-c")
        .arg(&script)
        .output()
        .map_err(|e| format!("pkexec spawn failed (is pkexec installed?): {e}"))?;

    if !output.status.success() {
        // Code 126/127 = user dismissed / not authorized.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code().unwrap_or(-1);
        let msg = if stderr.trim().is_empty() {
            "authorization failed".to_string()
        } else {
            stderr.trim().to_string()
        };
        return Err(format!("pkexec exit {code}: {msg}"));
    }

    Ok(MirrorResult {
        created: to_create.len(),
        skipped,
        errors,
    })
}

fn sanitize(component: &str) -> String {
    component
        .trim()
        .trim_matches('/')
        .replace("..", "_")
        .replace('\0', "")
}

/// Single-quote-wrap a string for embedding in an `sh -c` script. Embedded
/// single quotes become `'\''` (close, escaped quote, reopen).
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[tauri::command]
async fn scan_library(
    root: String,
    workers: Option<usize>,
    app: AppHandle,
    cancel: tauri::State<'_, ScanCancel>,
) -> Result<ScanReport, String> {
    let flag = cancel.0.clone();
    flag.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || scan_inner(root, workers, app, flag))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_scan(cancel: tauri::State<ScanCancel>) {
    cancel.0.store(true, Ordering::Relaxed);
}

fn scan_inner(
    root: String,
    workers: Option<usize>,
    app: AppHandle,
    cancel: Arc<AtomicBool>,
) -> Result<ScanReport, String> {
    let root_pb = PathBuf::from(&root);
    if !root_pb.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let files: Vec<PathBuf> = WalkDir::new(&root_pb)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && has_audio_ext(e.path()))
        .map(|e| e.path().to_path_buf())
        .collect();

    let total = files.len();
    if total == 0 {
        return Err(format!("no audio files under {root}"));
    }

    let worker_count = workers
        .or_else(|| available_parallelism().ok().map(|n| (n.get() / 2).max(2)))
        .unwrap_or(2);

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(worker_count)
        .build()
        .map_err(|e| e.to_string())?;

    let done = AtomicUsize::new(0);
    let vol_re = Regex::new(r"max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB").unwrap();

    let rows: Vec<ScanRow> = pool.install(|| {
        files
            .par_iter()
            .filter_map(|p| {
                // Cancel honoured at file-grain — files already inside
                // `classify` keep going to completion (capped by
                // ANALYSIS_SECS) but no new work is started.
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                let row = classify(p, &vol_re);
                let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = app.emit(
                    "scan-progress",
                    ScanProgress {
                        done: d,
                        total,
                        path: row.path.clone(),
                        verdict: row.verdict,
                    },
                );
                Some(row)
            })
            .collect()
    });

    Ok(ScanReport {
        root,
        generated: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        rows,
    })
}

// ---- sampler -----------------------------------------------------------

/// Extracts a fixed-length clip from one source file into dest. ffmpeg
/// `-ss <offset> -t <dur>` placed BEFORE `-i` for input-side seek (fast
/// even on huge files; doesn't decode-and-discard). `-c:a flac` re-encodes
/// to a self-contained FLAC. Idempotent: existing dest files are skipped.
/// Partial output from a failed run is removed.
fn sample_one(item: &SampleItem, duration_secs: u32, start_offset_secs: u32) -> SampleOutcome {
    let src = Path::new(&item.src);
    let dest = Path::new(&item.dest);

    if dest.exists() {
        return SampleOutcome::Skipped;
    }
    if let Some(parent) = dest.parent() {
        if fs::create_dir_all(parent).is_err() {
            return SampleOutcome::Failed;
        }
    }

    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-nostdin",
        "-ss", &start_offset_secs.to_string(),
        "-t", &duration_secs.to_string(),
        "-i",
    ])
    .arg(src)
    .args(["-c:a", "flac", "-y"])
    .arg(dest);

    match run_with_timeout(cmd, Duration::from_secs(FFMPEG_TIMEOUT_SECS)) {
        RunOutcome::Ok(out) => {
            if out.status.success() {
                SampleOutcome::Created
            } else {
                let _ = fs::remove_file(dest);
                SampleOutcome::Failed
            }
        }
        RunOutcome::TimedOut => {
            let _ = fs::remove_file(dest);
            SampleOutcome::TimedOut
        }
        RunOutcome::Failed => SampleOutcome::Failed,
    }
}

/// Walk the workspace destination and enumerate already-sampled clips.
/// Returns a list of "source signatures" — the relative path under
/// `dest_root` with the `.<duration_secs>s.flac` suffix stripped. The
/// frontend mirrors this via `sourceSignature(srcPath, srcRoot)` so a
/// scan row is "has-local-sample" iff its signature is in the returned
/// set. Empty list if the dest doesn't exist (fresh setup).
#[tauri::command]
async fn scan_sample_dest(
    dest_root: String,
    duration_secs: u32,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        let root = PathBuf::from(&dest_root);
        if !root.is_dir() {
            return Ok(Vec::new());
        }
        let suffix = format!(".{duration_secs}s.flac");
        let mut sigs = Vec::new();
        for entry in WalkDir::new(&root).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if !name.ends_with(&suffix) {
                continue;
            }
            let rel = match path.strip_prefix(&root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let parent = rel
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let stem = &name[..name.len() - suffix.len()];
            let sig = if parent.is_empty() {
                stem.to_string()
            } else {
                format!("{parent}/{stem}")
            };
            sigs.push(sig);
        }
        Ok(sigs)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Mirror-tree folder management — manual add / delete on the mirror dest.
// Delete goes to the OS trash (recoverable); add is a plain mkdir. Both are
// strictly confined to inside the configured dest.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DestFolder {
    /// Path relative to the dest, e.g. "Artist/Release".
    rel: String,
    /// Absolute path (the trash target).
    path: String,
    /// Direct audio-file count — 0 marks an empty folder (a prime delete
    /// candidate, e.g. a stale sampling leftover).
    audio_count: usize,
}

/// List the leaf folders (no child dirs — where files live) under the mirror
/// dest, with their direct audio counts. Empties surface as the obvious
/// deletion targets.
#[tauri::command]
async fn list_dest_folders(dest: String) -> Result<Vec<DestFolder>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<DestFolder>, String> {
        let base = PathBuf::from(&dest);
        if !base.is_dir() {
            return Ok(Vec::new());
        }
        let mut out: Vec<DestFolder> = Vec::new();
        for entry in WalkDir::new(&base).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_dir() {
                continue;
            }
            let p = entry.path();
            let has_subdir = fs::read_dir(p)
                .map(|rd| rd.filter_map(|e| e.ok()).any(|e| e.path().is_dir()))
                .unwrap_or(false);
            if has_subdir {
                continue; // not a leaf
            }
            let rel = match p.strip_prefix(&base) {
                Ok(r) if !r.as_os_str().is_empty() => r,
                _ => continue,
            };
            let audio_count = fs::read_dir(p)
                .map(|rd| {
                    rd.filter_map(|e| e.ok())
                        .filter(|e| e.path().is_file() && has_audio_ext(&e.path()))
                        .count()
                })
                .unwrap_or(0);
            out.push(DestFolder {
                rel: rel.to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
                audio_count,
            });
        }
        out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Move a folder to the OS trash. Hard guard: the target must canonicalize to
/// a path strictly *inside* the dest and not be the dest itself — so a stray
/// call can never trash the library or the dest root.
#[tauri::command]
async fn trash_dest_folder(dest: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let base = PathBuf::from(&dest)
            .canonicalize()
            .map_err(|e| format!("destination: {e}"))?;
        let target = PathBuf::from(&path)
            .canonicalize()
            .map_err(|e| format!("target: {e}"))?;
        if target == base || !target.starts_with(&base) {
            return Err("refusing to trash a path outside the mirror destination".into());
        }
        trash::delete(&target).map_err(|e| format!("trash failed: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create a subfolder (relative path) under the mirror dest; returns its
/// absolute path. Rejects absolute paths and `..` traversal.
#[tauri::command]
async fn create_dest_folder(dest: String, rel: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let base = PathBuf::from(&dest);
        if !base.is_dir() {
            return Err(format!("destination is not a directory: {dest}"));
        }
        let clean = rel.trim().trim_matches('/');
        if clean.is_empty() {
            return Err("empty folder name".into());
        }
        if rel.trim().starts_with('/') || clean.split('/').any(|c| c.is_empty() || c == "..") {
            return Err("invalid folder path".into());
        }
        let target = base.join(clean);
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read the bytes of a sample clip so the renderer can feed them to an
/// HTMLAudioElement via a Blob URL. The asset:// protocol on WebKit2GTK
/// rejects local sample paths with NotSupportedError despite the scope
/// being wide-open — going through IPC avoids the quirk entirely. Files
/// are small (10s FLAC ≈ 500 KB–1 MB) so the per-play transfer cost is
/// acceptable.
#[tauri::command]
async fn read_audio_bytes(path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || std::fs::read(&path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sample_tracks(
    items: Vec<SampleItem>,
    duration_secs: u32,
    start_offset_secs: u32,
    workers: Option<usize>,
    app: AppHandle,
    cancel: tauri::State<'_, SampleCancel>,
) -> Result<SampleReport, String> {
    let flag = cancel.0.clone();
    flag.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        sample_inner(items, duration_secs, start_offset_secs, workers, app, flag)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_sample(cancel: tauri::State<SampleCancel>) {
    cancel.0.store(true, Ordering::Relaxed);
}

fn sample_inner(
    items: Vec<SampleItem>,
    duration_secs: u32,
    start_offset_secs: u32,
    workers: Option<usize>,
    app: AppHandle,
    cancel: Arc<AtomicBool>,
) -> Result<SampleReport, String> {
    let total = items.len();
    if total == 0 {
        return Err("no items to sample".into());
    }

    let worker_count = workers
        .or_else(|| available_parallelism().ok().map(|n| (n.get() / 2).max(2)))
        .unwrap_or(2);

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(worker_count)
        .build()
        .map_err(|e| e.to_string())?;

    let done = AtomicUsize::new(0);

    let outcomes: Vec<SampleOutcome> = pool.install(|| {
        items
            .par_iter()
            .map(|item| {
                let outcome = if cancel.load(Ordering::Relaxed) {
                    SampleOutcome::Cancelled
                } else {
                    sample_one(item, duration_secs, start_offset_secs)
                };
                let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = app.emit(
                    "sample-progress",
                    SampleProgress {
                        done: d,
                        total,
                        path: item.src.clone(),
                        outcome,
                    },
                );
                outcome
            })
            .collect()
    });

    let mut report = SampleReport {
        total,
        created: 0,
        skipped: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        errors: Vec::new(),
    };
    for (item, o) in items.iter().zip(outcomes.iter()) {
        match o {
            SampleOutcome::Created => report.created += 1,
            SampleOutcome::Skipped => report.skipped += 1,
            SampleOutcome::Failed => {
                report.failed += 1;
                if report.errors.len() < ERROR_SAMPLE {
                    report.errors.push(item.src.clone());
                }
            }
            SampleOutcome::TimedOut => {
                report.timed_out += 1;
                if report.errors.len() < ERROR_SAMPLE {
                    report.errors.push(format!("{} (timed out)", item.src));
                }
            }
            SampleOutcome::Cancelled => report.cancelled += 1,
        }
    }

    Ok(report)
}

// ---- report cache ------------------------------------------------------

/// Debug builds (`tauri dev`) get a sibling app-data dir with a `.dev`
/// suffix, so dev runs don't pollute the installed binary's scan report.
/// Mirrors the keyring service split above.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = if cfg!(debug_assertions) {
        let name = base
            .file_name()
            .map(|n| {
                let mut s = n.to_os_string();
                s.push(".dev");
                s
            })
            .ok_or_else(|| "app_data_dir has no final component".to_string())?;
        match base.parent() {
            Some(parent) => parent.join(name),
            None => PathBuf::from(name),
        }
    } else {
        base
    };
    fs::create_dir_all(&dir).map_err(|e| format!("create app_data_dir: {e}"))?;
    Ok(dir)
}

fn report_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(REPORT_FILENAME))
}

#[tauri::command]
fn load_report(app: AppHandle) -> Result<Option<ScanReport>, String> {
    let p = report_path(&app)?;
    if !p.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
    let report: ScanReport =
        serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", p.display()))?;
    Ok(Some(report))
}

#[tauri::command]
fn save_report(report: ScanReport, app: AppHandle) -> Result<(), String> {
    let p = report_path(&app)?;
    let text = serde_json::to_string(&report).map_err(|e| e.to_string())?;
    fs::write(&p, text).map_err(|e| format!("write {}: {e}", p.display()))
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("xdg-open {path}: {e}"))?;
    Ok(())
}

// ---- nostr identity (OS keychain) -------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    npub: String,
    pk: String, // hex pubkey, for relay author filters
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedIdentity {
    npub: String,
    pk: String,
    /// Returned ONCE on generate so the user can back the key up. After
    /// `get_identity`, only npub + pk are returned; nsec stays in the
    /// keychain.
    nsec: String,
}

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(keyring_service(), KEYRING_USER).map_err(|e| e.to_string())
}

fn load_nsec() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn store_nsec(nsec: &str) -> Result<(), String> {
    keyring_entry()?
        .set_password(nsec)
        .map_err(|e| e.to_string())
}

fn keys_from_nsec(nsec: &str) -> Result<Keys, String> {
    let sk = SecretKey::from_bech32(nsec).map_err(|e| format!("invalid nsec: {e}"))?;
    Ok(Keys::new(sk))
}

fn identity_from_keys(keys: &Keys) -> Result<Identity, String> {
    let npub = keys.public_key().to_bech32().map_err(|e| e.to_string())?;
    let pk = keys.public_key().to_hex();
    Ok(Identity { npub, pk })
}

#[tauri::command]
fn get_identity() -> Result<Option<Identity>, String> {
    let Some(nsec) = load_nsec()? else {
        return Ok(None);
    };
    let keys = keys_from_nsec(&nsec)?;
    Ok(Some(identity_from_keys(&keys)?))
}

#[tauri::command]
fn generate_identity() -> Result<GeneratedIdentity, String> {
    let keys = Keys::generate();
    let nsec = keys
        .secret_key()
        .to_bech32()
        .map_err(|e| e.to_string())?;
    let id = identity_from_keys(&keys)?;
    store_nsec(&nsec)?;
    Ok(GeneratedIdentity {
        npub: id.npub,
        pk: id.pk,
        nsec,
    })
}

#[tauri::command]
fn import_identity(nsec: String) -> Result<Identity, String> {
    let nsec = nsec.trim().to_owned();
    let keys = keys_from_nsec(&nsec)?;
    let id = identity_from_keys(&keys)?;
    store_nsec(&nsec)?;
    Ok(id)
}

#[tauri::command]
fn clear_identity() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- nostr reactions (kind:7 / kind:5) --------------------------------

const REACTION_RELAYS: &[&str] = &["wss://relay.fizx.uk", "wss://nos.lol"];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RelayError {
    relay: String,
    error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReactionResult {
    event_id: String,
    accepted_by: Vec<String>,
    rejected: Vec<RelayError>,
}

async fn build_client(keys: Keys, relays: &[&str]) -> Client {
    let client = Client::builder().signer(keys).build();
    for url in relays {
        let _ = client.add_relay(*url).await;
    }
    client.connect().await;
    client
}

fn split_send_output(output: &Output<nostr::EventId>) -> (Vec<String>, Vec<RelayError>) {
    let accepted: Vec<String> = output.success.iter().map(|u| u.to_string()).collect();
    let rejected: Vec<RelayError> = output
        .failed
        .iter()
        .map(|(url, err)| RelayError {
            relay: url.to_string(),
            error: err.clone(),
        })
        .collect();
    (accepted, rejected)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishResult {
    event_id: String,
    accepted_by: Vec<String>,
    rejected: Vec<RelayError>,
}

/// Sign a kind:27235 NIP-98 HTTP-auth event for an outgoing request.
/// Returns the event JSON; the renderer base64-encodes it and prefixes
/// with "Nostr " for the Authorization header. Used by the NIP-96
/// upload to nostr.build — sk stays in the keychain, only the signed
/// event reaches JS.
#[tauri::command]
async fn nip98_sign_event(
    url: String,
    method: String,
    payload_hash: String,
) -> Result<String, String> {
    let nsec = load_nsec()?.ok_or_else(|| "no Nostr identity in keychain".to_string())?;
    let keys = keys_from_nsec(&nsec)?;

    let tags = vec![
        Tag::parse(["u", &url]).map_err(|e| e.to_string())?,
        Tag::parse(["method", &method]).map_err(|e| e.to_string())?,
        Tag::parse(["payload", &payload_hash]).map_err(|e| e.to_string())?,
    ];

    let event = EventBuilder::new(Kind::Custom(27235), "")
        .tags(tags)
        .sign_with_keys(&keys)
        .map_err(|e| e.to_string())?;

    serde_json::to_string(&event).map_err(|e| e.to_string())
}

/// Publish a kind:1063 NIP-94 file metadata event for a hosted file.
/// `t_tag` categorises the file ("sample" or "full"). Relays come from
/// the renderer so the indicator chip + the actual publish target stay
/// in sync (no hardcoded constant). Returns per-relay accept/reject
/// matching publish_reaction's shape.
#[tauri::command]
async fn publish_file_metadata(
    url: String,
    sha256: String,
    size: u64,
    mime: String,
    title: String,
    description: String,
    t_tag: String,
    relays: Vec<String>,
) -> Result<PublishResult, String> {
    let nsec = load_nsec()?.ok_or_else(|| "no Nostr identity in keychain".to_string())?;
    let keys = keys_from_nsec(&nsec)?;

    let tags = vec![
        Tag::parse(["url", &url]).map_err(|e| e.to_string())?,
        Tag::parse(["m", &mime]).map_err(|e| e.to_string())?,
        Tag::parse(["x", &sha256]).map_err(|e| e.to_string())?,
        Tag::parse(["size", &size.to_string()]).map_err(|e| e.to_string())?,
        Tag::parse(["title", &title]).map_err(|e| e.to_string())?,
        Tag::parse(["alt", &title]).map_err(|e| e.to_string())?,
        Tag::parse(["t", &t_tag]).map_err(|e| e.to_string())?,
    ];

    let content = if description.trim().is_empty() {
        title.clone()
    } else {
        description
    };

    let event = EventBuilder::new(Kind::Custom(1063), &content)
        .tags(tags)
        .sign_with_keys(&keys)
        .map_err(|e| e.to_string())?;
    let id = event.id.to_string();

    let relay_refs: Vec<&str> = relays.iter().map(String::as_str).collect();
    let client = build_client(keys, &relay_refs).await;
    let send_result = client.send_event(&event).await;
    let _ = client.shutdown().await;

    let output = send_result.map_err(|e| e.to_string())?;
    let (accepted_by, rejected) = split_send_output(&output);

    if accepted_by.is_empty() {
        let first = rejected
            .first()
            .map(|r| format!("{}: {}", r.relay, r.error))
            .unwrap_or_else(|| "no relays accepted the event".to_string());
        return Err(format!("publish failed — {first}"));
    }

    Ok(PublishResult {
        event_id: id,
        accepted_by,
        rejected,
    })
}

/// Publish a kind:7 reaction referencing an arbitrary (non-replaceable)
/// event. For kind:1063 audio in the FeedPanel: target_kind = 1063,
/// content = "+" / "-" / emoji.
#[tauri::command]
async fn publish_reaction(
    event_id: String,
    author_pk: String,
    target_kind: u16,
    content: String,
) -> Result<ReactionResult, String> {
    let nsec = load_nsec()?.ok_or_else(|| "no Nostr identity in keychain".to_string())?;
    let keys = keys_from_nsec(&nsec)?;

    let tags = vec![
        Tag::parse(["e", &event_id]).map_err(|e| e.to_string())?,
        Tag::parse(["p", &author_pk]).map_err(|e| e.to_string())?,
        Tag::parse(["k", &target_kind.to_string()]).map_err(|e| e.to_string())?,
    ];

    let event = EventBuilder::new(Kind::Reaction, &content)
        .tags(tags)
        .sign_with_keys(&keys)
        .map_err(|e| e.to_string())?;
    let id = event.id.to_string();

    let client = build_client(keys, REACTION_RELAYS).await;
    let send_result = client.send_event(&event).await;
    let _ = client.shutdown().await;

    let output = send_result.map_err(|e| e.to_string())?;
    let (accepted_by, rejected) = split_send_output(&output);

    if accepted_by.is_empty() {
        let first = rejected
            .first()
            .map(|r| format!("{}: {}", r.relay, r.error))
            .unwrap_or_else(|| "no relays accepted the event".to_string());
        return Err(format!("publish failed — {first}"));
    }

    Ok(ReactionResult {
        event_id: id,
        accepted_by,
        rejected,
    })
}

/// Publish a kind:5 deletion event for one of *our* prior reactions
/// (undoes a previously-published kind:7).
#[tauri::command]
async fn delete_reaction(reaction_event_id: String) -> Result<ReactionResult, String> {
    let nsec = load_nsec()?.ok_or_else(|| "no Nostr identity in keychain".to_string())?;
    let keys = keys_from_nsec(&nsec)?;

    let tags = vec![
        Tag::parse(["e", &reaction_event_id]).map_err(|e| e.to_string())?,
        Tag::parse(["k", "7"]).map_err(|e| e.to_string())?,
    ];

    let event = EventBuilder::new(Kind::EventDeletion, "")
        .tags(tags)
        .sign_with_keys(&keys)
        .map_err(|e| e.to_string())?;
    let id = event.id.to_string();

    let client = build_client(keys, REACTION_RELAYS).await;
    let send_result = client.send_event(&event).await;
    let _ = client.shutdown().await;

    let output = send_result.map_err(|e| e.to_string())?;
    let (accepted_by, rejected) = split_send_output(&output);

    Ok(ReactionResult {
        event_id: id,
        accepted_by,
        rejected,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ScanCancel::new())
        .manage(SampleCancel::new())
        .invoke_handler(tauri::generate_handler![
            scan_library,
            cancel_scan,
            sample_tracks,
            cancel_sample,
            scan_sample_dest,
            list_dest_folders,
            trash_dest_folder,
            create_dest_folder,
            read_audio_bytes,
            nip98_sign_event,
            publish_file_metadata,
            count_audio_files,
            create_mirror_tree,
            load_report,
            save_report,
            open_folder,
            get_identity,
            generate_identity,
            import_identity,
            clear_identity,
            publish_reaction,
            delete_reaction
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
