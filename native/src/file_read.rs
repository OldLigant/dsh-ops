//! Read-only file operations: cooperative budgets and explicit result completeness.
use super::*;

fn validate_patterns(patterns: &[String]) -> Result<()> {
    if patterns.len() > 128
        || patterns
            .iter()
            .any(|p| p.len() > 4096 || p.split('/').count() > 256)
    {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "At most 128 globs, 4096 bytes and 256 segments per glob are supported",
        ));
    }
    Ok(())
}
fn segments(p: &[&str], v: &[&str], budget: &mut Budget) -> bool {
    if !budget.check() {
        return false;
    }
    if p.is_empty() {
        return v.is_empty();
    }
    if p[0] == "**" {
        return segments(&p[1..], v, budget) || (!v.is_empty() && segments(p, &v[1..], budget));
    }
    !v.is_empty() && segment_match(p[0], v[0]) && segments(&p[1..], &v[1..], budget)
}
fn matches(patterns: &GlobPatterns<'_>, root: &Path, file: &Path, budget: &mut Budget) -> bool {
    if patterns.patterns.is_empty() {
        return true;
    }
    let name = relative_display(root, file);
    #[cfg(test)]
    metrics::record(|w| w.path_splits += 1);
    let parts: Vec<_> = name.split('/').collect();
    let included = !patterns.has_positive
        || patterns
            .patterns
            .iter()
            .any(|p| !p.excluded && segments(&p.segments, &parts, budget));
    included
        && !patterns
            .patterns
            .iter()
            .any(|p| p.excluded && segments(&p.segments, &parts, budget))
}
fn candidates(path: &str, patterns: &[String], budget: &mut Budget) -> Result<WalkResult> {
    validate_patterns(patterns)?;
    let root = target(path, false)?;
    if root.is_file() {
        let accepted = budget.visit();
        return Ok(WalkResult {
            files: if accepted { vec![root] } else { vec![] },
            truncated: !accepted,
        });
    }
    let walked = walk(&root, budget)?;
    let patterns = GlobPatterns::new(patterns);
    let mut files = Vec::new();
    for file in walked.files {
        if !budget.check() {
            break;
        }
        if matches(&patterns, &root, &file, budget) {
            files.push(file);
        }
    }
    Ok(WalkResult {
        files,
        truncated: walked.truncated || budget.reason.is_some(),
    })
}

fn read_file(path: &Path, budget: &mut Budget) -> Result<Option<Vec<u8>>> {
    if !budget.check() {
        return Ok(None);
    }
    let (file, size) = open_bounded(path).map_err(|error| {
        if error.code != "OUTPUT_LIMIT" {
            budget.stop("readError");
        }
        error
    })?;
    if size > budget.limits.max_file_bytes {
        return Err(Failure::new(
            "OUTPUT_LIMIT",
            "File exceeds the bounded read budget",
        ));
    }
    read_chunks(file, budget)
}
pub(super) fn read_chunks(reader: impl Read, budget: &mut Budget) -> Result<Option<Vec<u8>>> {
    #[cfg(test)]
    let reader = metrics::Reader(reader);
    let mut reader = reader.take(budget.limits.max_file_bytes + 1);
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let allowance = budget.read_allowance(chunk.len());
        if allowance == 0 {
            return Ok(None);
        }
        let n = loop {
            match reader.read(&mut chunk[..allowance]) {
                Ok(n) => break n,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                    if !budget.check() {
                        return Ok(None);
                    }
                }
                Err(error) => {
                    budget.stop("readError");
                    return Err(error.into());
                }
            }
        };
        budget.read_bytes += n as u64;
        if !budget.check() {
            return Ok(None);
        }
        if n == 0 {
            return Ok(Some(bytes));
        }
        bytes.extend_from_slice(&chunk[..n]);
        if bytes.len() as u64 > budget.limits.max_file_bytes {
            return Err(Failure::new(
                "OUTPUT_LIMIT",
                "File exceeds the bounded read budget",
            ));
        }
    }
}
fn summary(files: usize, hits: usize, scan_complete: bool, budget: &mut Budget) -> Result<Value> {
    budget.check();
    let complete = scan_complete && budget.reason.is_none();
    let mut result = json!({"status":"completed","phase":"verify","changed":0,"matched":hits,"skipped":0,
        "failed":0,"complete":complete,"scanComplete":complete,"pageComplete":complete,"totalExact":complete,
        "truncated":!complete,"stopReason":budget.reason,"files":files,"matches":hits,
        "visitedEntries":budget.visited,"readBytes":budget.read_bytes});
    if complete {
        result["omitted"] = json!(0);
    }
    if serde_json::to_vec(&result)?.len() + 1 > budget.limits.max_output_bytes {
        return Err(Failure::new(
            "OUTPUT_LIMIT",
            "Summary exceeds output budget",
        ));
    }
    Ok(result)
}

pub(super) fn inspect(request: &Request) -> Result<Value> {
    let mut budget = Budget::new(request.file_budget.clone().unwrap_or_default())?;
    let args: InspectArgs = serde_json::from_value(request.args.clone())?;
    if args.limit == 0 || args.limit > 10000 || !args.encoding.eq_ignore_ascii_case("utf-8") {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "inspect supports UTF-8 and a bounded limit",
        ));
    }
    if !matches!(args.view.as_str(), "text" | "hex") {
        return Err(Failure::new("INVALID_ARGUMENT", "view must be text or hex"));
    }
    let path = target(&args.path, false)?;
    if !path.is_file() {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "path is a directory; use ops_glob or ops_grep",
        ));
    }
    let mut page = Page::new(&budget.limits);
    let offset = args.offset.saturating_sub(1);
    if !budget.visit() {
        return finish(page, 0, offset, args.limit, 0, false, &mut budget);
    }
    if args.view == "hex" {
        let (mut file, size) = open_bounded(&path)?;
        if size > budget.limits.max_file_bytes {
            return Err(Failure::new(
                "OUTPUT_LIMIT",
                "File exceeds the bounded read budget",
            ));
        }
        let path_bytes = serde_json::to_vec(&path)?.len();
        let output_rows = page.remaining().saturating_sub(path_bytes + 256) / 48;
        let line_rows = budget.limits.max_line_bytes.saturating_add(1) / 48;
        let rows = output_rows.min(line_rows).max(1);
        let count = rows.min(args.limit);
        let start = args.offset.saturating_mul(16).min(size as usize);
        let end = start.saturating_add(count * 16).min(size as usize);
        if budget.read_allowance(end - start) < end - start {
            budget.stop("readBytes");
            return finish(page, 0, args.offset, args.limit, 0, false, &mut budget);
        }
        let (bytes, start, end) = read_hex_window(&mut file, size, args.offset, count)?;
        budget.read_bytes += bytes.len() as u64;
        if !budget.check() {
            return finish(page, 0, args.offset, args.limit, 0, false, &mut budget);
        }
        let text = bytes
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(" ");
        if text.len() > budget.limits.max_line_bytes {
            return Err(Failure::new(
                "OUTPUT_LIMIT",
                "One hex row exceeds maxLineBytes; increase the line budget",
            ));
        }
        page.push(json!({"path":path,"view":"hex","offset":start,"text":text}));
        if count < args.limit && end < size as usize {
            page.preview = Some(if line_rows <= output_rows {
                "lineBytes"
            } else {
                "outputBytes"
            });
        }
        let preview = page.preview;
        // Hex pagination units remain 16-byte offsets, distinct from text lines.
        let mut result = finish(
            page,
            (size as usize).div_ceil(16),
            args.offset,
            args.limit,
            1,
            true,
            &mut budget,
        )?;
        if result["scanComplete"] != true {
            return Ok(result);
        }
        result["skipped"] = json!(start);
        result["omitted"] = json!((size as usize).saturating_sub(end));
        result["nextOffset"] = json!(end.div_ceil(16));
        result["complete"] = json!(end == size as usize);
        result["pageComplete"] = json!(end == size as usize || end - start >= args.limit * 16);
        result["stopReason"] = json!(if end == size as usize {
            None
        } else {
            preview.or(Some("pageLimit"))
        });
        return Ok(result);
    }
    let bytes = match read_file(&path, &mut budget)? {
        Some(bytes) => bytes,
        None => return finish(page, 0, offset, args.limit, 0, false, &mut budget),
    };
    let text = String::from_utf8(bytes)
        .map_err(|_| Failure::new("INVALID_ARGUMENT", "file is not valid UTF-8"))?;
    let mut total = 0usize;
    for line in text.lines() {
        if !budget.check() {
            page = Page::new(&budget.limits);
            return finish(page, 0, offset, args.limit, 0, false, &mut budget);
        }
        if total >= offset && total < offset.saturating_add(args.limit) && !page.blocked {
            let (text, text_bytes) = preview([line], budget.limits.max_line_bytes);
            page.push_text(json!({"path":path,"line":total+1,"text":text}), text_bytes);
        }
        total += 1;
    }
    let mut result = finish(page, total, offset, args.limit, total, true, &mut budget)?;
    if let Some(next) = result.get("nextOffset").and_then(Value::as_u64) {
        result["nextOffset"] = json!(next.saturating_add(1));
    }
    Ok(result)
}

pub(super) fn glob(request: &Request) -> Result<Value> {
    let mut budget = Budget::new(request.file_budget.clone().unwrap_or_default())?;
    let args: GlobArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() || args.pattern.iter().all(|p| p.starts_with('!')) {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "pattern requires a positive glob",
        ));
    }
    if args.limit == 0 || args.limit > 10000 {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "glob requires a bounded limit",
        ));
    }
    if !args.sort.is_empty() && !matches!(args.sort.as_str(), "path" | "modified") {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "sort must be path or modified",
        ));
    }
    let output_mode = if args.output_mode.is_empty() {
        "paths"
    } else {
        &args.output_mode
    };
    if !matches!(output_mode, "paths" | "details") {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "outputMode must be paths or details",
        ));
    }
    let root = target(&args.path, false)?;
    if !root.is_dir() {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "glob path must be a directory",
        ));
    }
    let walked = candidates(&args.path, &args.pattern, &mut budget)?;
    let mut files = walked.files;
    if args.sort == "modified" {
        // Preserve the existing key/ordering; correcting modified is separate work.
        let mut keyed = Vec::new();
        for file in files {
            if !budget.check() {
                break;
            }
            keyed.push((modified(&file), file));
        }
        keyed.sort_by(|a, b| {
            budget.check();
            b.0.cmp(&a.0)
        });
        files = keyed.into_iter().map(|(_, file)| file).collect();
    }
    let total = files.len();
    let mut page = Page::new(&budget.limits);
    for file in files.into_iter().skip(args.offset).take(args.limit) {
        if !budget.check() {
            break;
        }
        let item = if output_mode == "paths" {
            json!(file)
        } else {
            let modified_at = modified(&file);
            json!({"path":file,"bytes":fs::symlink_metadata(&file).map(|m|m.len()).unwrap_or(0),"modified":modified_at})
        };
        if !page.push(item) {
            break;
        }
    }
    finish(
        page,
        total,
        args.offset,
        args.limit,
        total,
        !walked.truncated,
        &mut budget,
    )
}

pub(super) fn grep(request: &Request) -> Result<Value> {
    let mut budget = Budget::new(request.file_budget.clone().unwrap_or_default())?;
    let args: GrepArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty()
        || args.pattern.len() > 65536
        || args.limit == 0
        || args.limit > 10000
    {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "pattern and bounded limit are required (regex up to 65536 bytes)",
        ));
    }
    if args.before_context > 32 || args.after_context > 32 {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "context is limited to 32 lines",
        ));
    }
    let regex = RegexBuilder::new(&args.pattern)
        .case_insensitive(args.case_insensitive)
        .multi_line(args.multiline)
        .build()
        .map_err(|e| Failure::new("INVALID_ARGUMENT", e))?;
    let walked = candidates(&args.path, &args.glob, &mut budget)?;
    let summary_mode = args.output_mode == "summary";
    let file_items = matches!(args.output_mode.as_str(), "count" | "files_with_matches");
    let mut page = Page::new(&budget.limits);
    let (mut files, mut matched, mut observed, mut consumed) = (0usize, 0usize, 0usize, 0usize);
    let file_total = walked.files.len();
    let page_end = args.offset.saturating_add(args.limit);
    for file in walked.files {
        if !budget.check() {
            break;
        }
        let bytes = match read_file(&file, &mut budget) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break,
            Err(_) => {
                consumed += 1;
                continue;
            }
        };
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => {
                consumed += 1;
                continue;
            }
        };
        let saved = page.checkpoint();
        let mut local_observed = observed;
        let mut hits = 0usize;
        // Context needs line references; collect cooperatively, without hit positions.
        let mut lines = Vec::new();
        if !summary_mode && !file_items && (args.before_context > 0 || args.after_context > 0) {
            for line in text.lines() {
                if !budget.check() {
                    break;
                }
                lines.push(line);
            }
        }
        for (i, line) in text.lines().enumerate() {
            if !budget.check() {
                break;
            }
            let hit = regex.is_match(line);
            if !budget.check() {
                break;
            }
            if !hit {
                continue;
            }
            hits += 1;
            if summary_mode || file_items {
                continue;
            }
            if local_observed >= args.offset && local_observed < page_end && !page.blocked {
                let (content, text_bytes) = if lines.is_empty() {
                    preview([line], budget.limits.max_line_bytes)
                } else {
                    let start = i.saturating_sub(args.before_context);
                    let end = (i + args.after_context + 1).min(lines.len());
                    preview(
                        lines[start..end].iter().copied(),
                        budget.limits.max_line_bytes,
                    )
                };
                #[cfg(test)]
                metrics::record(|w| w.content_items += 1);
                page.push_text(
                    json!({"path":file,"line":if args.line_numbers {i+1} else {0},"text":content}),
                    text_bytes,
                );
            }
            local_observed += 1;
        }
        if !budget.check() {
            page.restore(saved);
            break;
        }
        consumed += 1;
        if hits == 0 {
            continue;
        }
        if file_items {
            if local_observed >= args.offset && local_observed < page_end && !page.blocked {
                page.push(if args.output_mode == "count" {
                    json!({"path":file,"count":hits})
                } else {
                    json!({"path":file})
                });
            }
            local_observed += 1;
        }
        observed = local_observed;
        matched += hits;
        files += 1;
        if !summary_mode && (observed >= page_end || page.blocked) {
            break;
        }
    }
    let scan_complete = !walked.truncated && consumed == file_total && budget.reason.is_none();
    if summary_mode {
        summary(files, matched, scan_complete, &mut budget)
    } else {
        finish(
            page,
            observed,
            args.offset,
            args.limit,
            matched,
            scan_complete,
            &mut budget,
        )
    }
}
