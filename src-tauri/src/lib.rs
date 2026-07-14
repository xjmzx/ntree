// Tauri commands for ndisc.tree (binary: ndisc-tree).
//
// 1:1 port of the Python check_flac_quality.sh + flac_library_browser.py:
//   - scan_library: walks <root>/**/*.flac, runs ffprobe + ffmpeg high-pass
//     volumedetect per file in parallel, emits "scan-progress" events.
//   - load_report / save_report: JSON cache in Tauri app data dir.
//   - open_folder: xdg-open on the containing folder (double-click action).

use std::collections::{HashMap, HashSet};
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
// Video (audio-visual) extensions — the same set ndisc recognises, so the
// suite shares one definition of "carries video". The scanner lists these so
// the library is aware of the full media spectrum, but never analyses them
// (no ffprobe/spectral pass): classify short-circuits a video row.
const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "mov", "webm", "m4v", "avi", "wmv", "flv", "mpg", "mpeg", "ogv",
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

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
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
    #[default]
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Default)]
// Existing fields are all single words, so this is backward-compatible with
// reports already on disk; it only affects the new bit_depth/bit_rate.
#[serde(rename_all = "camelCase")]
struct ScanRow {
    verdict: Verdict,
    path: String,
    peak: Option<f32>,
    sr: Option<u32>,
    info: String,
    // ---- structured technical detail -------------------------------------
    // The codec used to live only inside the free-text `info` string
    // ("lossy · codec=mp3"), which meant the UI could show a verdict but could
    // not tell you what the library is actually MADE of. These come from the
    // same ffprobe call the scan already runs, so they cost nothing.
    //
    // All Option + serde(default): a report written before this change still
    // loads, it just has no detail until the next scan.
    #[serde(default)]
    codec: Option<String>,
    /// Bits per raw sample. Meaningful for lossless; absent for lossy codecs,
    /// which have no such thing.
    #[serde(default)]
    bit_depth: Option<u32>,
    /// bits/sec, from the container. The honest measure of a lossy file.
    #[serde(default)]
    bit_rate: Option<u32>,
    #[serde(default)]
    channels: Option<u8>,
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

    // Drain both pipes on their own threads WHILE the child runs.
    //
    // This used to wait first and read afterwards, which deadlocks: a pipe
    // holds ~64 KB, and once it is full the child BLOCKS on write and can
    // never exit. ffmpeg is chatty — a single mp3 with a stream of decode
    // warnings emitted 259 KB of stderr — so the child would wedge, the wait
    // would hit its timeout, and a perfectly good file was reported as
    // "timed out" after 60s of doing nothing. It was never slow; it was stuck
    // on a pipe we weren't reading. Standalone runs never showed it, because
    // every shell and test harness drains as it goes.
    let out_h = child.stdout.take().map(|mut h| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = h.read_to_end(&mut buf);
            buf
        })
    });
    let err_h = child.stderr.take().map(|mut h| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = h.read_to_end(&mut buf);
            buf
        })
    });

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
    // The child has exited, so both readers see EOF and join promptly.
    let stdout = out_h.and_then(|h| h.join().ok()).unwrap_or_default();
    let stderr = err_h.and_then(|h| h.join().ok()).unwrap_or_default();
    RunOutcome::Ok(ProcessOutput { status, stdout, stderr })
}

enum FfprobeOutcome {
    Ok {
        codec: Option<String>,
        sr: Option<u32>,
        bit_depth: Option<u32>,
        bit_rate: Option<u32>,
        channels: Option<u8>,
    },
    TimedOut,
    Failed,
}

fn ffprobe_fields(path: &Path) -> FfprobeOutcome {
    let mut cmd = Command::new("ffprobe");
    cmd.args([
        "-v", "error",
        "-select_streams", "a:0",
        // One call, five fields. The scan already pays for this subprocess; the
        // extra fields are free, and they are what turns "62% lossless" into a
        // description of what the library is actually made of.
        "-show_entries",
        "stream=codec_name,sample_rate,bits_per_raw_sample,channels:format=bit_rate",
        // KEYED output. ffprobe emits fields in ITS order, not the requested
        // one (probe_video learned this the hard way), so positional parsing is
        // a trap waiting for the first file that omits a field.
        "-of", "default=noprint_wrappers=1",
    ])
    .arg(path);
    match run_with_timeout(cmd, Duration::from_secs(FFPROBE_TIMEOUT_SECS)) {
        RunOutcome::Ok(out) => {
            if !out.status.success() {
                return FfprobeOutcome::Failed;
            }
            let s = String::from_utf8_lossy(&out.stdout);
            let mut map: HashMap<&str, &str> = HashMap::new();
            for line in s.lines() {
                if let Some((k, v)) = line.split_once('=') {
                    let v = v.trim();
                    // ffprobe writes "N/A" for fields a codec doesn't have —
                    // lossy formats have no bits_per_raw_sample.
                    if !v.is_empty() && v != "N/A" {
                        map.insert(k.trim(), v);
                    }
                }
            }
            FfprobeOutcome::Ok {
                codec: map.get("codec_name").map(|s| (*s).to_string()),
                sr: map.get("sample_rate").and_then(|s| s.parse().ok()),
                bit_depth: map.get("bits_per_raw_sample").and_then(|s| s.parse().ok()),
                bit_rate: map.get("bit_rate").and_then(|s| s.parse().ok()),
                channels: map.get("channels").and_then(|s| s.parse().ok()),
            }
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
    // Video files are recognised but never analysed — short-circuit before any
    // ffprobe/ffmpeg work. The row is marked with info "video" and verdict
    // Unknown (no quality state); the UI keys off the file extension to render
    // a Film marker and to exclude it from the audio-quality tallies.
    if has_video_ext(path) {
        return ScanRow {
            verdict: Verdict::Unknown,
            path: path_str,
            peak: None,
            sr: None,
            info: "video".into(),
            ..Default::default()
        };
    }
    let (codec, sr, bit_depth, bit_rate, channels) = match ffprobe_fields(path) {
        FfprobeOutcome::Ok { codec, sr, bit_depth, bit_rate, channels } => {
            (codec, sr, bit_depth, bit_rate, channels)
        }
        FfprobeOutcome::TimedOut => {
            return ScanRow {
                verdict: Verdict::Unknown,
                path: path_str,
                peak: None,
                sr: None,
                info: format!("ffprobe timed out ({FFPROBE_TIMEOUT_SECS}s)"),
                ..Default::default()
            };
        }
        FfprobeOutcome::Failed => {
            return ScanRow {
                verdict: Verdict::Unknown,
                path: path_str,
                peak: None,
                sr: None,
                info: "ffprobe failed".into(),
                ..Default::default()
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
            ..Default::default()
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
            codec: Some(codec.clone()),
            bit_depth,
            bit_rate,
            channels,
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
            codec: Some(codec.clone()),
            bit_depth,
            bit_rate,
            channels,
        };
    }
    let Some(sr_val) = sr else {
        return ScanRow {
            verdict: Verdict::Unknown,
            path: path_str,
            peak: None,
            sr,
            info: "flac · no sample rate".into(),
            codec: Some(codec.clone()),
            bit_depth,
            bit_rate,
            channels,
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
                codec: Some(codec.clone()),
                bit_depth,
                bit_rate,
                channels,
            };
        }
        PeakOutcome::Failed => {
            return ScanRow {
                verdict: Verdict::Unknown,
                path: path_str,
                peak: None,
                sr,
                info: "ffmpeg/volumedetect failed".into(),
                codec: Some(codec.clone()),
                bit_depth,
                bit_rate,
                channels,
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
        codec: Some(codec),
        bit_depth,
        bit_rate,
        channels,
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

/// True if the path's extension matches one of [`VIDEO_EXTS`]. Case-insensitive.
fn has_video_ext(p: &Path) -> bool {
    p.extension()
        .and_then(|x| x.to_str())
        .map(|x| {
            let lower = x.to_ascii_lowercase();
            VIDEO_EXTS.contains(&lower.as_str())
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
            let p = entry.path();
            if !entry.file_type().is_file() || !(has_audio_ext(p) || has_video_ext(p)) {
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

// ---- video classification (verify types for the Normalize-videos plan) ----
//
// Part A: probe each video's codecs/container/faststart and bucket it. Purely
// read-only — no file is touched. The buckets map to the eventual remux /
// transcode actions; this census lets the user see what they have first.

#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
enum VideoBucket {
    /// h264 + libav-playable audio in an mp4/m4v with faststart — plays as-is.
    Plays,
    /// h264 + playable audio, but wrong container or moov-at-end → `-c copy +faststart`.
    Remux,
    /// h264 but audio libav can't decode → `-c:v copy -c:a aac +faststart`.
    AudioFix,
    /// Legacy video codec (mpeg/avi/…) → full libx264/aac transcode.
    Transcode,
    /// ffprobe failed / no video stream.
    Unknown,
}

struct VideoProbe {
    vcodec: Option<String>,
    acodec: Option<String>,
}

/// One ffprobe call listing every stream's `codec_type,codec_name`; takes the
/// first real video stream (skipping attached-cover image codecs) and the first
/// audio stream.
fn probe_video(path: &Path) -> Option<VideoProbe> {
    let mut cmd = Command::new("ffprobe");
    cmd.args([
        "-v", "error",
        "-show_entries", "stream=codec_type,codec_name",
        "-of", "csv=p=0",
    ])
    .arg(path);
    match run_with_timeout(cmd, Duration::from_secs(FFPROBE_TIMEOUT_SECS)) {
        RunOutcome::Ok(out) if out.status.success() => {
            let s = String::from_utf8_lossy(&out.stdout);
            let img = ["mjpeg", "mjpegb", "png", "bmp", "gif"];
            let mut vcodecs: Vec<String> = Vec::new();
            let mut acodec: Option<String> = None;
            // ffprobe csv emits the two fields in its own internal order
            // (codec_name,codec_type), NOT the order requested — so identify the
            // codec_type token wherever it lands rather than assuming position.
            let is_type =
                |x: &str| matches!(x, "video" | "audio" | "data" | "subtitle" | "attachment");
            for line in s.lines() {
                let parts: Vec<&str> = line
                    .split(',')
                    .map(str::trim)
                    .filter(|x| !x.is_empty())
                    .collect();
                let kind = parts.iter().copied().find(|x| is_type(x));
                let name = parts.iter().copied().find(|x| !is_type(x));
                match (kind, name) {
                    (Some("video"), Some(n)) => vcodecs.push(n.to_string()),
                    (Some("audio"), Some(n)) if acodec.is_none() => {
                        acodec = Some(n.to_string())
                    }
                    _ => {}
                }
            }
            // Prefer a non-image video stream (cover art shows as mjpeg/png).
            let vcodec = vcodecs
                .iter()
                .find(|c| !img.contains(&c.as_str()))
                .or_else(|| vcodecs.first())
                .cloned();
            Some(VideoProbe { vcodec, acodec })
        }
        _ => None,
    }
}

/// True if an ISO-BMFF file (mp4/m4v/mov) has its `moov` atom before `mdat`
/// (i.e. faststart). Reads only top-level box headers — cheap. Non-ISO
/// containers return false (they need a transcode regardless).
fn mp4_faststart(path: &Path) -> bool {
    use std::io::{Seek, SeekFrom};
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    let mut pos: u64 = 0;
    loop {
        if f.seek(SeekFrom::Start(pos)).is_err() {
            return false;
        }
        let mut hdr = [0u8; 8];
        if f.read_exact(&mut hdr).is_err() {
            return false;
        }
        let mut size = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as u64;
        let typ = [hdr[4], hdr[5], hdr[6], hdr[7]];
        let mut header_len = 8u64;
        if size == 1 {
            // 64-bit largesize follows the type.
            let mut ext = [0u8; 8];
            if f.read_exact(&mut ext).is_err() {
                return false;
            }
            size = u64::from_be_bytes(ext);
            header_len = 16;
        }
        match &typ {
            b"moov" => return true,
            b"mdat" => return false,
            _ => {}
        }
        if size < header_len {
            return false; // malformed or size-0 (box-to-EOF) before any moov
        }
        pos = match pos.checked_add(size) {
            Some(p) => p,
            None => return false,
        };
    }
}

fn video_bucket(
    ext: &str,
    vcodec: &Option<String>,
    acodec: &Option<String>,
    faststart: bool,
) -> VideoBucket {
    let Some(v) = vcodec.as_deref() else {
        return VideoBucket::Unknown;
    };
    let mp4ish = matches!(ext, "mp4" | "m4v");
    // Target = plays-in-nplay-locally (WebKit2GTK + gstreamer1.0-libav over the
    // loopback <video>): the real gate is an mp4/m4v container + h264 video;
    // audio is permissive because libav decodes far more than web-baseline aac
    // (ac3 etc. play — confirmed against the user's library).
    let audio_ok = match acodec.as_deref() {
        None => true, // no audio stream — video-only, still fine
        Some(a) => matches!(
            a,
            "aac" | "mp3" | "ac3" | "eac3" | "opus" | "vorbis" | "flac" | "mp2"
        ),
    };
    if v == "h264" {
        if audio_ok {
            if mp4ish && faststart {
                VideoBucket::Plays
            } else {
                VideoBucket::Remux
            }
        } else {
            VideoBucket::AudioFix
        }
    } else {
        VideoBucket::Transcode
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VideoRow {
    path: String,
    vcodec: Option<String>,
    acodec: Option<String>,
    container: String,
    faststart: bool,
    bucket: VideoBucket,
}

/// Walk the root, probe every video file, and bucket it. Read-only census for
/// the Normalize-videos plan — nothing is modified.
#[tauri::command]
async fn classify_videos(root: String) -> Result<Vec<VideoRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root_pb = PathBuf::from(&root);
        if !root_pb.is_dir() {
            return Err(format!("not a directory: {root}"));
        }
        let files: Vec<PathBuf> = WalkDir::new(&root_pb)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file() && has_video_ext(e.path()))
            .map(|e| e.path().to_path_buf())
            .collect();

        let worker_count = available_parallelism()
            .ok()
            .map(|n| (n.get() / 2).max(2))
            .unwrap_or(2);
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(worker_count)
            .build()
            .map_err(|e| e.to_string())?;

        let rows: Vec<VideoRow> = pool.install(|| {
            files
                .par_iter()
                .map(|p| {
                    let ext = p
                        .extension()
                        .and_then(|x| x.to_str())
                        .map(|x| x.to_ascii_lowercase())
                        .unwrap_or_default();
                    let probe = probe_video(p);
                    let (vcodec, acodec) = match &probe {
                        Some(pr) => (pr.vcodec.clone(), pr.acodec.clone()),
                        None => (None, None),
                    };
                    let faststart = matches!(ext.as_str(), "mp4" | "m4v" | "mov")
                        && mp4_faststart(p);
                    let bucket = if probe.is_none() {
                        VideoBucket::Unknown
                    } else {
                        video_bucket(&ext, &vcodec, &acodec, faststart)
                    };
                    VideoRow {
                        path: p.to_string_lossy().into_owned(),
                        vcodec,
                        acodec,
                        container: ext,
                        faststart,
                        bucket,
                    }
                })
                .collect()
        });
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- normalize videos (Part B: remux / transcode to playable mp4) ---------
//
// Writes the user's files. Per bucket: convert the source to a temp mp4, then
// (only on success) move the ORIGINAL into a parallel backup tree and move the
// new mp4 into the original's folder. Originals are never deleted — recoverable
// from the backup tree. Reuses the ffmpeg CLI already required by the scanner.

const NORMALIZE_TIMEOUT_SECS: u64 = 1800; // 30 min cap per file (transcodes)

/// Sibling of the scan/sample cancel flags for the normalize op.
struct NormalizeCancel(Arc<AtomicBool>);
impl NormalizeCancel {
    fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NormalizeItem {
    path: String,
    /// "remux" | "audioFix" | "transcode" (from the census).
    bucket: String,
}

#[derive(Serialize, Clone, Copy, PartialEq)]
enum NormalizeOutcome {
    Converted,
    Skipped,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NormalizeProgress {
    done: usize,
    total: usize,
    path: String,
    bucket: String,
    outcome: NormalizeOutcome,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NormalizeReport {
    total: usize,
    converted: usize,
    skipped: usize,
    failed: usize,
    timed_out: usize,
    cancelled: usize,
    errors: Vec<String>,
}

/// Move a file, falling back to copy+remove across filesystems.
fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(from, to)?;
            fs::remove_file(from)?;
            Ok(())
        }
    }
}

fn ffmpeg_args_for(bucket: &str) -> Option<&'static [&'static str]> {
    // `0:V:0` selects the first non-attached-pic video stream (skips cover art);
    // `0:a:0?` the first audio if present. +faststart for HTTP-streamed playback.
    match bucket {
        "remux" => Some(&[
            "-map", "0:V:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart",
        ]),
        "audioFix" => Some(&[
            "-map", "0:V:0", "-map", "0:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
        ]),
        "transcode" => Some(&[
            "-map", "0:V:0", "-map", "0:a:0?", "-c:v", "libx264", "-crf", "18", "-preset",
            "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags",
            "+faststart",
        ]),
        _ => None,
    }
}

/// Convert one video. Returns the outcome plus, on failure, WHY.
///
/// The reason matters: a permission problem and a corrupt file both used to
/// surface as a bare "failed", which is the least useful thing a batch op can
/// say. (This bit for real — the default backup path sat under a root-owned
/// /data, so every file converted fine and then failed at the backup step, with
/// nothing on screen to say so.)
fn normalize_one(
    item: &NormalizeItem,
    root: &Path,
    backup_root: &Path,
) -> (NormalizeOutcome, Option<String>) {
    let fail = |msg: String| (NormalizeOutcome::Failed, Some(msg));
    let src = Path::new(&item.path);
    if !src.is_file() {
        return fail("file is gone from disk".into());
    }
    let Some(args) = ffmpeg_args_for(&item.bucket) else {
        return (NormalizeOutcome::Skipped, None); // plays / unknown — shouldn't be sent
    };
    let (Some(dir), Some(stem)) = (src.parent(), src.file_stem().and_then(|s| s.to_str()))
    else {
        return fail("cannot read the file's folder or name".into());
    };
    let out = dir.join(format!("{stem}.mp4"));
    // Don't clobber an unrelated existing stem.mp4 (when converting e.g. a .mpg
    // and a .mp4 of the same name already sits beside it).
    if out.exists() && out != src {
        return fail(format!("{stem}.mp4 already exists beside it — refusing to overwrite"));
    }

    let tmp = dir.join(format!(".ndisc-normalize-{stem}.mp4"));
    let _ = fs::remove_file(&tmp);
    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-nostdin").arg("-i").arg(src);
    for a in args {
        cmd.arg(a);
    }
    cmd.arg("-y").arg(&tmp);

    match run_with_timeout(cmd, Duration::from_secs(NORMALIZE_TIMEOUT_SECS)) {
        RunOutcome::Ok(o) if o.status.success() => {
            // Back up the original (preserving its relpath under the library),
            // then move the new mp4 into its place.
            let rel = src.strip_prefix(root).unwrap_or(src);
            let backup_dest = backup_root.join(rel);
            if let Some(p) = backup_dest.parent() {
                if let Err(e) = fs::create_dir_all(p) {
                    let _ = fs::remove_file(&tmp);
                    return fail(format!(
                        "cannot create the backup folder {} — {e}",
                        p.display()
                    ));
                }
            }
            if let Err(e) = move_file(src, &backup_dest) {
                let _ = fs::remove_file(&tmp);
                return fail(format!("cannot move the original into the backup — {e}"));
            }
            if let Err(e) = move_file(&tmp, &out) {
                // Restore the original so we never lose the file.
                let _ = move_file(&backup_dest, src);
                let _ = fs::remove_file(&tmp);
                return fail(format!("converted, but could not put the new mp4 in place — {e} (original restored)"));
            }
            (NormalizeOutcome::Converted, None)
        }
        RunOutcome::Ok(o) => {
            let _ = fs::remove_file(&tmp);
            // ffmpeg says why on stderr; the last line is almost always the
            // actual complaint.
            let err = String::from_utf8_lossy(&o.stderr);
            let last = err
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("ffmpeg failed")
                .trim()
                .to_string();
            fail(format!("ffmpeg: {last}"))
        }
        RunOutcome::TimedOut => {
            let _ = fs::remove_file(&tmp);
            (NormalizeOutcome::TimedOut, None)
        }
        RunOutcome::Failed => {
            let _ = fs::remove_file(&tmp);
            fail("could not run ffmpeg — is it installed and on PATH?".into())
        }
    }
}

#[tauri::command]
async fn normalize_videos(
    items: Vec<NormalizeItem>,
    root: String,
    backup_root: String,
    app: AppHandle,
    cancel: tauri::State<'_, NormalizeCancel>,
) -> Result<NormalizeReport, String> {
    let root_pb = PathBuf::from(&root);
    let backup_pb = PathBuf::from(&backup_root);
    if backup_root.trim().is_empty() {
        return Err("choose a backup folder for the originals".into());
    }
    if !root_pb.is_dir() {
        return Err(format!("library root not found: {root}"));
    }
    if backup_pb == root_pb || backup_pb.starts_with(&root_pb) || root_pb.starts_with(&backup_pb) {
        return Err("the backup folder must be outside the library root".into());
    }
    let flag = cancel.0.clone();
    flag.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        normalize_inner(items, root_pb, backup_pb, app, flag)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_normalize(cancel: tauri::State<NormalizeCancel>) {
    cancel.0.store(true, Ordering::Relaxed);
}

fn normalize_inner(
    items: Vec<NormalizeItem>,
    root: PathBuf,
    backup_root: PathBuf,
    app: AppHandle,
    cancel: Arc<AtomicBool>,
) -> Result<NormalizeReport, String> {
    let total = items.len();
    if total == 0 {
        return Err("no videos to normalize".into());
    }
    let mut report = NormalizeReport {
        total,
        converted: 0,
        skipped: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        errors: Vec::new(),
    };
    // Sequential: transcodes are CPU-heavy and libx264 already multi-threads,
    // so one ffmpeg at a time avoids thrashing and keeps progress legible.
    for (i, item) in items.iter().enumerate() {
        let (outcome, reason) = if cancel.load(Ordering::Relaxed) {
            (NormalizeOutcome::Cancelled, None)
        } else {
            normalize_one(item, &root, &backup_root)
        };
        let name = Path::new(&item.path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| item.path.clone());
        match outcome {
            NormalizeOutcome::Converted => report.converted += 1,
            NormalizeOutcome::Skipped => report.skipped += 1,
            NormalizeOutcome::Cancelled => report.cancelled += 1,
            NormalizeOutcome::Failed => {
                report.failed += 1;
                if report.errors.len() < ERROR_SAMPLE {
                    report.errors.push(match reason {
                        Some(r) => format!("{name} — {r}"),
                        None => name.clone(),
                    });
                }
            }
            NormalizeOutcome::TimedOut => {
                report.timed_out += 1;
                if report.errors.len() < ERROR_SAMPLE {
                    report.errors.push(format!("{name} — timed out"));
                }
            }
        }
        let _ = app.emit(
            "normalize-progress",
            NormalizeProgress {
                done: i + 1,
                total,
                path: item.path.clone(),
                bucket: item.bucket.clone(),
                outcome,
            },
        );
    }
    Ok(report)
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
        .filter(|e| {
            e.file_type().is_file()
                && (has_audio_ext(e.path()) || has_video_ext(e.path()))
        })
        .map(|e| e.path().to_path_buf())
        .collect();

    let total = files.len();
    if total == 0 {
        return Err(format!("no audio/video files under {root}"));
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
/// Returns the outcome and, when it went wrong, WHY. A bare count of failures
/// is unactionable — it sends you guessing at ffmpeg from the outside instead
/// of reading the error the tool already produced.
fn sample_one(
    item: &SampleItem,
    duration_secs: u32,
    start_offset_secs: u32,
) -> (SampleOutcome, Option<String>) {
    let src = Path::new(&item.src);
    let dest = Path::new(&item.dest);

    if dest.exists() {
        return (SampleOutcome::Skipped, None);
    }
    if let Some(parent) = dest.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return (
                SampleOutcome::Failed,
                Some(format!("could not create {}: {e}", parent.display())),
            );
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
    // -vn: audio only. Without it ffmpeg maps EVERY stream, including a
    // track's embedded cover art, and tries to re-encode the picture into the
    // clip. Plenty of tags lie about their own image format — an APIC frame
    // declaring PNG while holding JPEG bytes ("Invalid PNG signature
    // 0xFFD8FFE0…") — and when the picture fails to decode, ffmpeg aborts the
    // whole conversion and writes nothing. The perfectly good audio was being
    // thrown away because of a broken thumbnail. A clip is audio; it has no
    // business touching the artwork.
    //
    // This also covers video sources, whose audio is what we want anyway.
    .args(["-vn", "-c:a", "flac", "-y"])
    .arg(dest);

    match run_with_timeout(cmd, Duration::from_secs(FFMPEG_TIMEOUT_SECS)) {
        RunOutcome::Ok(out) => {
            if out.status.success() {
                (SampleOutcome::Created, None)
            } else {
                let _ = fs::remove_file(dest);
                // ffmpeg puts the real reason on the last line of stderr.
                let err = String::from_utf8_lossy(&out.stderr);
                let last = err
                    .lines()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("no output")
                    .trim()
                    .to_string();
                (SampleOutcome::Failed, Some(format!("ffmpeg: {last}")))
            }
        }
        RunOutcome::TimedOut => {
            let _ = fs::remove_file(dest);
            (
                SampleOutcome::TimedOut,
                Some(format!("no response after {FFMPEG_TIMEOUT_SECS}s — killed")),
            )
        }
        RunOutcome::Failed => (
            SampleOutcome::Failed,
            Some("could not run ffmpeg (is it installed?)".to_string()),
        ),
    }
}

/// Walk the workspace destination and enumerate already-sampled clips.
/// Returns a list of "source signatures" — the relative path under
/// `dest_root` with the `.<duration_secs>s.flac` suffix stripped. The
/// frontend mirrors this via `sourceSignature(srcPath, srcRoot)` so a
/// scan row is "has-local-sample" iff its signature is in the returned
/// set. Empty list if the dest doesn't exist (fresh setup).
// ---------------------------------------------------------------------------
// ndisc published manifest — cross-app scope
// ---------------------------------------------------------------------------
//
// ntree has no idea what has been published to Nostr; ndisc does. Rather than
// read ndisc's SQLite (coupling ntree to that schema and file location), ndisc
// EXPORTS a manifest to a suite-shared path and ntree reads it. Derived and
// disposable — if it is absent or stale, the filter simply cannot be used, and
// nothing else breaks.

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ManifestRelease {
    id: i64,
    artist: String,
    title: String,
    /// Absolute path of the release folder on disk.
    dir: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PublishedManifest {
    version: u32,
    generated_at: i64,
    library_root: Option<String>,
    releases: Vec<ManifestRelease>,
}

/// Read ndisc's published-release manifest from the suite-shared path.
/// `Ok(None)` when it has never been exported — that is a normal state, not an
/// error: the user just has not run "Export published manifest" in ndisc.
#[tauri::command]
fn load_published_manifest() -> Result<Option<PublishedManifest>, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME: {e}"))?;
    let path = PathBuf::from(home).join(".local/share/ndisc-suite/published.json");
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let manifest: PublishedManifest = serde_json::from_str(&text)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok(Some(manifest))
}

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
async fn trash_dest_folder(
    dest: String,
    root: String,
    path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let target = PathBuf::from(&path);
        guard_deletable(Path::new(&dest), Path::new(&root), &target)?;
        trash::delete(target.canonicalize().map_err(|e| e.to_string())?)
            .map_err(|e| format!("trash failed: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The one invariant this app has about the filesystem: **nothing may ever be
/// deleted from the source library.** /data/music is the only irreplaceable
/// thing here — the clip tree is derived and can be regenerated from it in
/// minutes, the report is a cache, the BPM store is recoverable. The source is
/// not.
///
/// Every delete path routes through this. It is not enough to check "is the
/// target inside `dest`", because `dest` is a user-editable text field: point it
/// at /data/music by typo or misclick and an orphan prune would cheerfully
/// destroy the library with the old guard's blessing.
fn guard_deletable(dest: &Path, src_root: &Path, target: &Path) -> Result<(), String> {
    let base = dest
        .canonicalize()
        .map_err(|e| format!("destination: {e}"))?;
    let target = target
        .canonicalize()
        .map_err(|e| format!("target: {e}"))?;

    // 1. Never inside the source library, whatever `dest` claims.
    if let Ok(root) = src_root.canonicalize() {
        if target == root || target.starts_with(&root) {
            return Err(format!(
                "REFUSING to delete {} — it is inside the source library ({}). \
                 Nothing in this app deletes from the source.",
                target.display(),
                root.display()
            ));
        }
        // A destination that IS the source (or contains it) is a misconfiguration,
        // not a workspace. Refuse the whole operation rather than pick through it.
        if base == root || root.starts_with(&base) {
            return Err(format!(
                "REFUSING to operate: the destination ({}) is, or contains, the \
                 source library ({}). Point the workspace somewhere else.",
                base.display(),
                root.display()
            ));
        }
    }

    // 2. And still strictly inside the destination.
    if target == base || !target.starts_with(&base) {
        return Err("refusing to trash a path outside the mirror destination".into());
    }
    Ok(())
}

/// Clip files whose SOURCE no longer exists — file-grain orphans.
///
/// The folder-grain check (`orphans` in useMirror) only sees a clip folder with
/// no matching source folder. It cannot see a clip whose source was *renamed
/// inside a still-valid release*: the folder is fine, only the file is stale.
/// Renaming 14 tracks in one release left 14 orphan clips that the folder check
/// was structurally incapable of noticing.
///
/// A clip `<dest>/<rel>/<stem>.<dur>s.flac` is an orphan iff no media file
/// `<root>/<rel>/<stem>.*` exists. Source stems are collected once, so this is
/// two walks, not a readdir per clip.
#[tauri::command]
async fn orphan_clips(
    dest: String,
    root: String,
    duration_secs: u32,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        let dest_pb = PathBuf::from(&dest);
        let root_pb = PathBuf::from(&root);
        if !dest_pb.is_dir() {
            return Ok(Vec::new());
        }
        // Every source file, as relpath-minus-extension.
        let mut stems: HashSet<String> = HashSet::new();
        for e in WalkDir::new(&root_pb).into_iter().filter_map(|e| e.ok()) {
            let p = e.path();
            if !e.file_type().is_file() || !(has_audio_ext(p) || has_video_ext(p)) {
                continue;
            }
            if let Ok(rel) = p.strip_prefix(&root_pb) {
                let mut s = rel.to_path_buf();
                s.set_extension("");
                stems.insert(s.to_string_lossy().into_owned());
            }
        }
        // A source set of zero means we cannot know — an unreadable or wrong
        // root must never be reported as "everything is an orphan", because
        // this list feeds a delete button.
        if stems.is_empty() {
            return Ok(Vec::new());
        }

        let suffix = format!(".{duration_secs}s.flac");
        let mut out = Vec::new();
        for e in WalkDir::new(&dest_pb).into_iter().filter_map(|e| e.ok()) {
            let p = e.path();
            if !e.file_type().is_file() {
                continue;
            }
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(stem) = name.strip_suffix(&suffix) else {
                continue; // not a clip of this duration — leave it alone
            };
            let Ok(rel_dir) = p.parent().unwrap_or(&dest_pb).strip_prefix(&dest_pb) else {
                continue;
            };
            let key = if rel_dir.as_os_str().is_empty() {
                stem.to_string()
            } else {
                format!("{}/{stem}", rel_dir.to_string_lossy())
            };
            if !stems.contains(&key) {
                out.push(p.to_string_lossy().into_owned());
            }
        }
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Trash clip FILES. Same guard as `trash_dest_folder`: every path must
/// canonicalize to something strictly inside the mirror destination. The source
/// library is never a valid target — nothing in this app deletes from it.
#[tauri::command]
async fn trash_dest_files(
    dest: String,
    root: String,
    paths: Vec<String>,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<usize, String> {
        let mut n = 0usize;
        for path in &paths {
            let target = PathBuf::from(path);
            guard_deletable(Path::new(&dest), Path::new(&root), &target)?;
            trash::delete(target.canonicalize().map_err(|e| e.to_string())?)
                .map_err(|e| format!("trash failed for {path}: {e}"))?;
            n += 1;
        }
        Ok(n)
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

    let outcomes: Vec<(SampleOutcome, Option<String>)> = pool.install(|| {
        items
            .par_iter()
            .map(|item| {
                let (outcome, why) = if cancel.load(Ordering::Relaxed) {
                    (SampleOutcome::Cancelled, None)
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
                (outcome, why)
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
    for (item, (o, why)) in items.iter().zip(outcomes.iter()) {
        // The reason travels with the path — "N failed" on its own tells you
        // nothing you can act on.
        let name = Path::new(&item.src)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| item.src.clone());
        match o {
            SampleOutcome::Created => report.created += 1,
            SampleOutcome::Skipped => report.skipped += 1,
            SampleOutcome::Failed => {
                report.failed += 1;
                if report.errors.len() < ERROR_SAMPLE {
                    report.errors.push(match why {
                        Some(w) => format!("{name} — {w}"),
                        None => name,
                    });
                }
            }
            SampleOutcome::TimedOut => {
                report.timed_out += 1;
                if report.errors.len() < ERROR_SAMPLE {
                    report.errors.push(match why {
                        Some(w) => format!("{name} — {w}"),
                        None => format!("{name} — timed out"),
                    });
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

// ---- drift: has the library moved under the report? ------------------------
//
// The report is a snapshot. Everything downstream — the Library tree, the
// filters, the sampler's scope — reads it as if it were disk. It is not, and
// nothing ever said so.
//
// This is not hypothetical. ntree's own "Normalize videos" pass transcodes
// .avi/.mpg to .mp4 and moves the originals away, which invalidates its own
// report; the sampler then spent three runs trying to clip files that no longer
// existed, and only owned up once failures started reporting their reason. A
// stale index is silent by nature — that is what makes it worth surfacing.
//
// Cheap on purpose: a directory walk with no analysis. The expensive part of a
// scan is the per-file ffmpeg spectral pass, and drift needs none of it. Uses
// the SAME media predicate as the scanner, so the two cannot disagree about
// what counts as a file.

/// How far the report has drifted from disk. Lists are capped — the counts are
/// the signal; the samples are there to make it concrete.
const DRIFT_SAMPLE: usize = 40;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryDrift {
    root: String,
    /// When the report was generated (its `generated` field, verbatim).
    generated: Option<String>,
    /// Media files the report knows about.
    indexed: usize,
    /// Media files actually on disk under the root, right now.
    on_disk: usize,
    /// On disk but NOT in the report — the sampler cannot see these at all.
    unindexed: Vec<String>,
    unindexed_total: usize,
    /// In the report but GONE from disk — the sampler will try these and fail.
    stale: Vec<String>,
    stale_total: usize,
}

#[tauri::command]
async fn library_drift(app: AppHandle) -> Result<Option<LibraryDrift>, String> {
    let report = load_report(app)?;
    // No report is not drift — it is simply nothing to compare against.
    let Some(report) = report else {
        return Ok(None);
    };

    tauri::async_runtime::spawn_blocking(move || {
        let root_pb = PathBuf::from(&report.root);
        let mut on_disk: HashSet<String> = HashSet::new();
        for entry in WalkDir::new(&root_pb).into_iter().filter_map(|e| e.ok()) {
            let p = entry.path();
            if entry.file_type().is_file() && (has_audio_ext(p) || has_video_ext(p)) {
                on_disk.insert(p.to_string_lossy().into_owned());
            }
        }
        let indexed: HashSet<String> =
            report.rows.iter().map(|r| r.path.clone()).collect();

        let mut unindexed: Vec<String> =
            on_disk.difference(&indexed).cloned().collect();
        let mut stale: Vec<String> = indexed.difference(&on_disk).cloned().collect();
        unindexed.sort();
        stale.sort();

        let (unindexed_total, stale_total) = (unindexed.len(), stale.len());
        unindexed.truncate(DRIFT_SAMPLE);
        stale.truncate(DRIFT_SAMPLE);

        Ok(Some(LibraryDrift {
            root: report.root.clone(),
            generated: Some(report.generated.clone()),
            indexed: indexed.len(),
            on_disk: on_disk.len(),
            unindexed,
            unindexed_total,
            stale,
            stale_total,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
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
        .manage(NormalizeCancel::new())
        .invoke_handler(tauri::generate_handler![
            scan_library,
            cancel_scan,
            sample_tracks,
            cancel_sample,
            scan_sample_dest,
            load_published_manifest,
            list_dest_folders,
            trash_dest_folder,
            orphan_clips,
            trash_dest_files,
            create_dest_folder,
            read_audio_bytes,
            nip98_sign_event,
            publish_file_metadata,
            count_audio_files,
            classify_videos,
            normalize_videos,
            cancel_normalize,
            create_mirror_tree,
            load_report,
            library_drift,
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

#[cfg(test)]
mod guard_tests {
    use super::*;
    use std::fs;

    // The suite's one hard invariant: nothing is ever deleted from the source
    // library. /data/music is the only irreplaceable thing — clips regenerate,
    // the report is a cache. These pin the guard that enforces it.
    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ntree-guard-{name}"));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn refuses_to_delete_inside_the_source_library() {
        let root = tmp("src");
        let dest = tmp("dst");
        let victim = root.join("track.flac");
        fs::write(&victim, b"x").unwrap();
        assert!(guard_deletable(&dest, &root, &victim).is_err());
    }

    #[test]
    fn refuses_when_the_destination_is_the_source_library() {
        // The hole this closes: `dest` is a user-editable text field. Point it
        // at the library and the old guard ("is it inside dest?") said yes.
        let root = tmp("src2");
        let victim = root.join("track.flac");
        fs::write(&victim, b"x").unwrap();
        assert!(guard_deletable(&root, &root, &victim).is_err());
    }

    #[test]
    fn allows_a_clip_inside_a_real_destination() {
        let root = tmp("src3");
        let dest = tmp("dst3");
        let clip = dest.join("track.10s.flac");
        fs::write(&clip, b"x").unwrap();
        assert!(guard_deletable(&dest, &root, &clip).is_ok());
    }

    #[test]
    fn still_refuses_outside_the_destination() {
        let root = tmp("src4");
        let dest = tmp("dst4");
        let elsewhere = tmp("other4").join("f");
        fs::write(&elsewhere, b"x").unwrap();
        assert!(guard_deletable(&dest, &root, &elsewhere).is_err());
    }
}
