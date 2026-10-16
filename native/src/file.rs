//! Native file-operation capabilities. All paths are host-resolved absolute paths;
//! this module never invokes a shell and never follows links.
use crate::contract::{Failure, Request, Result};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use crate::file_budget::{Budget, Page, finish, preview};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt as WindowsMetadataExt;

const MAX_ENTRIES: usize = 100_000;
const MAX_DEPTH: usize = 128;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;

// Deterministic work assertions are compiled only into the native unit tests.
#[cfg(test)]
mod metrics {
    use std::cell::RefCell;
    use std::io::Read;
    use std::path::PathBuf;
    #[derive(Default, Debug)]
    pub struct Work {
        pub metadata_names: Vec<String>,
        pub directories: Vec<PathBuf>,
        pub read_bytes: usize,
        pub content_items: usize,
        pub hit_positions: usize,
        pub glob_parses: usize,
        pub path_splits: usize,
    }
    thread_local! { static WORK: RefCell<Work> = RefCell::new(Work::default()); }
    pub fn record(f: impl FnOnce(&mut Work)) { WORK.with(|w| f(&mut w.borrow_mut())); }
    pub fn take() -> Work { WORK.with(|w| std::mem::take(&mut *w.borrow_mut())) }
    pub struct Reader<R>(pub R);
    impl<R: Read> Read for Reader<R> {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            let count = self.0.read(bytes)?;
            record(|w| w.read_bytes += count);
            Ok(count)
        }
    }
}
#[cfg(test)]
#[path = "file_tests.rs"]
mod tests;
#[path = "file_read.rs"]
mod bounded;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InspectArgs {
    path: String,
    #[serde(default = "one")]
    offset: usize,
    #[serde(default = "two_hundred")]
    limit: usize,
    #[serde(default = "utf8")]
    encoding: String,
    #[serde(default = "text")]
    view: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GlobArgs {
    path: String,
    pattern: Vec<String>,
    #[serde(default)]
    output_mode: String,
    #[serde(default)]
    sort: String,
    #[serde(default)]
    offset: usize,
    #[serde(default = "one_hundred")]
    limit: usize,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GrepArgs {
    path: String,
    pattern: String,
    #[serde(default)]
    glob: Vec<String>,
    #[serde(default)]
    output_mode: String,
    #[serde(default)]
    case_insensitive: bool,
    #[serde(default = "yes")]
    line_numbers: bool,
    #[serde(default)]
    before_context: usize,
    #[serde(default)]
    after_context: usize,
    #[serde(default)]
    multiline: bool,
    #[serde(default)]
    offset: usize,
    #[serde(default = "one_hundred")]
    limit: usize,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReplaceArgs {
    path: String,
    pattern: String,
    replacement: String,
    #[serde(default)]
    glob: Vec<String>,
    #[serde(default = "one_hundred")]
    max_replacements: usize,
    #[serde(default)]
    dry_run: bool,
}
fn one() -> usize { 1 }
fn two_hundred() -> usize { 200 }
fn one_hundred() -> usize { 100 }
fn yes() -> bool { true }
fn utf8() -> String { "utf-8".into() }
fn text() -> String { "text".into() }

pub fn dispatch(request: &Request) -> Result<Value> {
    match request.tool.as_str() {
        "inspect_local_file" => bounded::inspect(request),
        "glob" => bounded::glob(request),
        "grep" => bounded::grep(request),
        "replace" => replace(request),
        _ => Err(Failure::new("INVALID_ARGUMENT", "Unknown file capability")),
    }
}

fn target(raw: &str, _allow_missing: bool) -> Result<PathBuf> {
    Ok(crate::file_path::checked(raw)?.display)
}
fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}
#[cfg(test)]
fn host_link_or_reparse(path: &Path) -> bool {
    host_link_state(path).unwrap_or(true)
}
fn host_link_state(path: &Path) -> std::io::Result<bool> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() { return Ok(true); }
    #[cfg(windows)]
    if metadata.file_attributes() & 0x400 != 0 { return Ok(true); }
    Ok(false)
}
struct WalkResult {
    files: Vec<PathBuf>,
    truncated: bool,
}

fn walk(root: &Path, budget: &mut Budget) -> Result<WalkResult> {
    if !budget.visit() { return Ok(WalkResult { files: Vec::new(), truncated: true }); }
    let target = crate::file_path::checked(root.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?)?;
    let directory = target.parent.open_dir_nofollow(&target.name)?;
    let mut files = Vec::new();
    let mut truncated = false;
    visit_dir(root, directory, 0, &mut files, &mut truncated, budget)?;
    truncated |= budget.reason.is_some();
    Ok(WalkResult { files, truncated })
}
fn visit_dir(display: &Path, directory: cap_std::fs::Dir, depth: usize, output: &mut Vec<PathBuf>, truncated: &mut bool, budget: &mut Budget) -> Result<()> {
    if !budget.check() { *truncated = true; return Ok(()); }
    if depth > MAX_DEPTH || output.len() >= MAX_ENTRIES {
        *truncated = true;
        if budget.bounded() { budget.stop(if depth > MAX_DEPTH { "depthLimit" } else { "entryLimit" }); }
        return Ok(());
    }
    #[cfg(test)]
    metrics::record(|w| w.directories.push(display.to_path_buf()));
    let mut names = Vec::new();
    // A directory can change while it is being read. A broken child directory
    // is skipped, while failure to enumerate the requested root remains visible.
    let entries = match directory.entries() {
        Ok(entries) => entries,
        Err(error) if depth == 0 => return Err(error.into()),
        Err(_) => { if budget.bounded() { budget.stop("filesystemError"); } return Ok(()); },
    };
    for entry in entries {
        if !budget.visit() { *truncated = true; return Ok(()); }
        let Ok(entry) = entry else { if budget.bounded() { budget.stop("filesystemError"); return Ok(()); } continue };
        let Ok(name) = entry.file_name().into_string() else { continue };
        names.push(name);
    }
    names.sort_by(|a, b| { budget.check(); a.cmp(b) });
    for name in names {
        if !budget.check() { *truncated = true; return Ok(()); }
        // These rules depend only on the name, for files and directories alike.
        // The explicitly requested root is never subject to this child filter.
        if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target")
            || crate::file_path::validate_name(&name).is_err() { continue; }
        #[cfg(test)]
        metrics::record(|w| w.metadata_names.push(name.clone()));
        let metadata = match directory.symlink_metadata(&name) {
            Ok(metadata) => metadata,
            Err(_) => { if budget.bounded() { budget.stop("filesystemError"); return Ok(()); } continue },
        };
        if crate::file_path::link(&metadata) { continue; }
        let child = display.join(&name);
        match host_link_state(&child) {
            Ok(true) => continue,
            Ok(false) => {},
            Err(_) => { if budget.bounded() { budget.stop("filesystemError"); return Ok(()); } continue },
        }
        if metadata.is_file() {
            if output.len() >= MAX_ENTRIES { *truncated = true; if budget.bounded() { budget.stop("entryLimit"); } return Ok(()); }
            output.push(child);
            continue;
        }
        if metadata.is_dir() {
            let Ok(child_dir) = directory.open_dir_nofollow(&name) else { if budget.bounded() { budget.stop("filesystemError"); return Ok(()); } continue };
            visit_dir(&child, child_dir, depth + 1, output, truncated, budget)?;
            if *truncated && output.len() >= MAX_ENTRIES { return Ok(()); }
        }
    }
    Ok(())
}
struct GlobPattern<'a> { excluded: bool, segments: Vec<&'a str> }
struct GlobPatterns<'a> { patterns: Vec<GlobPattern<'a>>, has_positive: bool }
impl<'a> GlobPatterns<'a> {
    fn new(patterns: &'a [String]) -> Self {
        let patterns: Vec<_> = patterns.iter().map(|pattern| {
            #[cfg(test)]
            metrics::record(|w| w.glob_parses += 1);
            let excluded = pattern.starts_with('!');
            let pattern = pattern.strip_prefix('!').unwrap_or(pattern);
            GlobPattern { excluded, segments: pattern.trim_start_matches("./").split('/').collect() }
        }).collect();
        let has_positive = patterns.iter().any(|p| !p.excluded);
        Self { patterns, has_positive }
    }
    fn matches(&self, root: &Path, file: &Path) -> bool {
        let name = relative_display(root, file);
        #[cfg(test)]
        metrics::record(|w| w.path_splits += 1);
        let segments: Vec<_> = name.split('/').collect();
        let included = !self.has_positive || self.patterns.iter()
            .any(|p| !p.excluded && glob_segments(&p.segments, &segments));
        included && !self.patterns.iter()
            .any(|p| p.excluded && glob_segments(&p.segments, &segments))
    }
}
fn files_for(path: &str, patterns: &[String], budget: &mut Budget) -> Result<WalkResult> {
    let root = target(path, false)?;
    if root.is_file() {
        return Ok(WalkResult { files: vec![root.clone()], truncated: false });
    }
    let walked = walk(&root, budget)?;
    let patterns = GlobPatterns::new(patterns);
    Ok(WalkResult {
        files: walked.files.into_iter()
            .filter(|f| patterns.matches(&root, f))
            .collect(),
        truncated: walked.truncated,
    })
}
fn glob_segments(p: &[&str], v: &[&str]) -> bool {
    if p.is_empty() { return v.is_empty(); }
    if p[0] == "**" { return glob_segments(&p[1..], v) || (!v.is_empty() && glob_segments(p, &v[1..])); }
    !v.is_empty() && segment_match(p[0], v[0]) && glob_segments(&p[1..], &v[1..])
}
fn segment_match(pattern: &str, value: &str) -> bool {
    let (mut pi, mut vi, mut star, mut mark) = (0usize, 0usize, None, 0usize);
    let p = pattern.as_bytes(); let v = value.as_bytes();
    while vi < v.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi].eq_ignore_ascii_case(&v[vi])) { pi += 1; vi += 1; }
        else if pi < p.len() && p[pi] == b'*' { star = Some(pi); pi += 1; mark = vi; }
        else if let Some(s) = star { pi = s + 1; mark += 1; vi = mark; }
        else { return false; }
    }
    while pi < p.len() && p[pi] == b'*' { pi += 1; }
    pi == p.len()
}
fn hash_file(path: &Path) -> Result<String> {
    let bytes = read_bytes(path)?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}
fn open_bounded(path: &Path) -> Result<(cap_std::fs::File, u64)> {
    let raw = path.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let target = crate::file_path::checked(raw)?;
    let file = crate::file_path::read_file(&target)?;
    let size = file.metadata()?.len();
    if size > MAX_FILE_BYTES { return Err(Failure::new("OUTPUT_LIMIT", "File exceeds the bounded read budget")); }
    Ok((file, size))
}
fn read_bounded(reader: impl Read) -> Result<Vec<u8>> {
    #[cfg(test)]
    let reader = metrics::Reader(reader);
    let mut bytes = Vec::new();
    // A size check alone cannot bound I/O when the opened file grows.
    reader.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err(Failure::new("OUTPUT_LIMIT", "File exceeds the bounded read budget")); }
    Ok(bytes)
}
fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    let (file, _) = open_bounded(path)?;
    read_bounded(file)
}
fn read_hex_window(file: &mut cap_std::fs::File, size: u64, offset: usize, limit: usize) -> Result<(Vec<u8>, usize, usize)> {
    // Size is observed on the safely opened handle, not a content snapshot.
    let start = offset.saturating_mul(16).min(size as usize);
    let end = start.saturating_add(limit.saturating_mul(16)).min(size as usize);
    file.seek(SeekFrom::Start(start as u64))?;
    let mut bytes = vec![0; end - start];
    #[cfg(test)]
    let read = metrics::Reader(&mut *file).read_exact(&mut bytes);
    #[cfg(not(test))]
    let read = file.read_exact(&mut bytes);
    if let Err(error) = read {
        return Err(if error.kind() == std::io::ErrorKind::UnexpectedEof {
            Failure::new("REVISION_CONFLICT", "File size changed during hex inspection")
        } else { error.into() });
    }
    if file.metadata()?.len() != size {
        return Err(Failure::new("REVISION_CONFLICT", "File size changed during hex inspection"));
    }
    Ok((bytes, start, end))
}
fn modified(path: &Path) -> u64 { fs::symlink_metadata(path).ok().map_or(0, |m| m.len()) }
fn replace(request: &Request) -> Result<Value> {
    if request.read_only { return Err(Failure::new("POLICY_DENIED", "replace is unavailable in read-only mode")); }
    let args: ReplaceArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() || args.max_replacements == 0 || args.max_replacements > 100_000 { return Err(Failure::new("INVALID_ARGUMENT", "pattern and maxReplacements are required")); }
    let walked = files_for(&args.path, &args.glob, &mut Budget::unlimited())?; let mut plans = Vec::new(); let mut total = 0usize;
    for file in walked.files { let bytes=read_bytes(&file)?; let text=String::from_utf8(bytes.clone()).map_err(|_| Failure::new("INVALID_ARGUMENT", "replace only supports UTF-8 files"))?; let count=text.match_indices(&args.pattern).count(); if count>0 { total += count; plans.push((file, bytes, text, count)); } }
    if total > args.max_replacements { return Err(Failure::new("OUTPUT_LIMIT", "maxReplacements exceeded; no files were changed")); }
    let mut items=Vec::new(); for (file, original, text, count) in plans { let revision=hash_file(&file)?; let next=text.replace(&args.pattern,&args.replacement); items.push(json!({"path":file,"replacements":count,"revision":revision,"bytesBefore":original.len(),"bytesAfter":next.len()})); }
    if args.dry_run { return Ok(json!({"status":"completed","phase":"observe","changed":0,"matched":total,"skipped":0,"failed":0,"complete":true,"omitted":0,"dryRun":true,"items":items})); }
    let mut changed=0usize; for item in &items { let file=PathBuf::from(item["path"].as_str().unwrap_or(""));
        // Trusted transport owns this allowlist. Re-check every selected file,
        // not only the initial search root, immediately before publication.
        if let Some(roots) = &request.write_roots {
            let canonical = std::fs::canonicalize(&file)?;
            if !roots.iter().any(|root| std::fs::canonicalize(root).is_ok_and(|r| canonical.starts_with(r))) {
                return Err(Failure::new("POLICY_DENIED", "User authorized workspace writes only; target is outside DSH writable roots. Ask the user to select full access; do not retry or bypass."));
            }
        }
        let expected=item["revision"].as_str().unwrap_or(""); if hash_file(&file)? != expected { return Err(Failure::new("REVISION_CONFLICT", "file changed between observe and execute")); } let bytes=read_bytes(&file)?; let text=String::from_utf8(bytes).map_err(|_| Failure::new("INVALID_ARGUMENT", "replace only supports UTF-8 files"))?; let next=text.replace(&args.pattern,&args.replacement); atomic_write(&file,next.as_bytes())?; changed += item["replacements"].as_u64().unwrap_or(0) as usize; }
    Ok(json!({"status":"completed","phase":"verify","changed":changed,"matched":total,"skipped":0,"failed":0,"complete":true,"omitted":0,"items":items}))
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let raw = path.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let checked = crate::file_path::checked(raw)?;
    let parent = checked.parent;
    let name = checked.name;
    let temporary = format!(".{name}.dsh-ops-{}", uuid::Uuid::new_v4());
    let mut options = cap_std::fs::OpenOptions::new();
    options.write(true).create_new(true).follow(FollowSymlinks::No);
    let mut file = parent.open_with(&temporary, &options).map_err(|e| Failure::new("ACCESS_DENIED", format!("Atomic replacement create: {e}")))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    // Publication stays handle-relative and does not traverse links.
    let publish = parent.rename(&temporary, &parent, &name);
    if let Err(error) = publish {
        let _ = parent.remove_file(&temporary);
        return Err(Failure::new("ACCESS_DENIED", format!("Atomic replacement publish: {error}")));
    }
    #[cfg(unix)]
    parent.try_clone()?.into_std_file().sync_all()?;
    Ok(())
}
