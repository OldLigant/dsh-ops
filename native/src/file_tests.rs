use super::*;
use std::collections::BTreeSet;

// Each test owns an explicit unique directory below the caller's test temp root.
// Cleanup inventories the whole tree before deleting only registered files.
struct Fixture { root: PathBuf, files: BTreeSet<PathBuf>, dirs: BTreeSet<PathBuf> }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("dsh-ops-pr1-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self { root, files: BTreeSet::new(), dirs: BTreeSet::new() }
    }
    fn path(&self, name: &str) -> PathBuf { self.root.join(name).components().collect() }
    fn write(&mut self, name: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
        let path = self.path(name);
        let mut parent = path.parent().unwrap();
        while parent != self.root {
            self.dirs.insert(parent.to_path_buf());
            parent = parent.parent().unwrap();
        }
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        self.files.insert(path.clone());
        path
    }
    fn call(&self, tool: &str, mut args: Value) -> Result<Value> {
        if args.get("path").is_none() { args["path"] = json!(self.root); }
        dispatch(&serde_json::from_value(json!({
            "root": self.root, "scope": "pr1-test", "read_only": true, "tool": tool, "args": args,
        })).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fn inventory(path: &Path, files: &mut BTreeSet<PathBuf>, dirs: &mut BTreeSet<PathBuf>) -> std::io::Result<()> {
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                let path = entry.path();
                let kind = entry.file_type()?;
                if kind.is_file() { files.insert(path); }
                else if kind.is_dir() && !host_link_or_reparse(&path) {
                    dirs.insert(path.clone()); inventory(&path, files, dirs)?;
                } else { return Err(std::io::Error::other("Unexpected link or special object")); }
            }
            Ok(())
        }
        let (mut files, mut dirs) = (BTreeSet::new(), BTreeSet::new());
        if inventory(&self.root, &mut files, &mut dirs).is_err() || files != self.files || dirs != self.dirs {
            eprintln!("Refusing cleanup of unexpected fixture contents: {}", self.root.display());
            return;
        }
        for file in &files { fs::remove_file(file).unwrap(); }
        let mut dirs: Vec<_> = dirs.into_iter().collect();
        dirs.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
        for dir in dirs { fs::remove_dir(dir).unwrap(); }
        fs::remove_dir(&self.root).unwrap();
    }
}

#[test]
fn excluded_names_do_no_metadata_and_hidden_root_is_searchable() {
    let mut f = Fixture::new();
    for name in [".hidden", ".git", ".dsh-ops", "node_modules", "target", ".venv"] {
        f.write(&format!("{name}/nested/secret.txt"), "hit");
    }
    let keep = f.write("visible/keep.txt", "hit");
    metrics::take();
    let result = f.call("glob", json!({"pattern":["**/*"],"outputMode":"paths"})).unwrap();
    assert_eq!(result["items"], json!([keep]));
    let work = metrics::take();
    assert_eq!(work.metadata_names, ["visible", "keep.txt"]);
    assert_eq!(work.directories, [f.root.clone(), f.path("visible")]);
    let result = f.call("grep", json!({"path":f.path(".hidden"),"pattern":"hit","outputMode":"summary"})).unwrap();
    assert_eq!(result["matched"], 1);
}

#[test]
fn oversize_handle_is_rejected_without_body_reads() {
    let mut f = Fixture::new();
    let file = f.write("huge.txt", "");
    fs::OpenOptions::new().write(true).open(&file).unwrap().set_len(MAX_FILE_BYTES + 1).unwrap();
    metrics::take();
    assert_eq!(read_bytes(&file).unwrap_err().code, "OUTPUT_LIMIT");
    assert_eq!(metrics::take().read_bytes, 0);
    for view in ["text", "hex"] {
        assert_eq!(f.call("inspect_local_file", json!({"path":file,"view":view,"limit":1})).unwrap_err().code, "OUTPUT_LIMIT");
        assert_eq!(metrics::take().read_bytes, 0);
    }
}

#[test]
fn summary_and_count_preserve_line_counts_without_hit_vectors() {
    let mut f = Fixture::new();
    f.write("a.txt", "hit hit\r\nmiss\nhit\n");
    f.write("b.txt", "hit\n");
    metrics::take();
    let result = f.call("grep", json!({"pattern":"hit","outputMode":"summary","limit":1})).unwrap();
    assert_eq!((result["matched"].as_u64(), result["files"].as_u64()), (Some(3), Some(2)));
    let work = metrics::take();
    assert_eq!(work.content_items, 0);
    assert_eq!(work.hit_positions, 0);
    let result = f.call("grep", json!({"pattern":"hit","outputMode":"count","limit":1})).unwrap();
    assert_eq!(result["matched"], 2);
    assert_eq!(result["totalLowerBound"], 1);
    assert_eq!(result["totalExact"], false);
    assert!(result.get("total").is_none());
    assert_eq!(result["items"][0]["count"], 2);
    let work = metrics::take();
    assert_eq!(work.content_items, 0);
    assert_eq!(work.hit_positions, 0);
}

#[test]
fn content_only_constructs_page_but_counts_whole_last_file() {
    let mut f = Fixture::new();
    f.write("a.txt", "hit hit\n".repeat(300));
    f.write("b.txt", "hit\n".repeat(50));
    metrics::take();
    let result = f.call("grep", json!({"pattern":"hit","outputMode":"content","offset":128,"limit":2,"beforeContext":1,"afterContext":1})).unwrap();
    assert_eq!(result["matched"], 300);
    assert_eq!(result["totalLowerBound"], 300);
    assert_eq!(result["scanComplete"], false);
    assert_eq!(result["stopReason"], "pageLimit");
    assert!(result.get("total").is_none());
    assert!(result.get("omitted").is_none());
    assert_eq!(result["nextOffset"], 130);
    assert_eq!(result["items"][0]["line"], 129);
    assert_eq!(result["items"][0]["text"], "hit hit\nhit hit\nhit hit");
    assert_eq!(metrics::take().content_items, 2);
    let result = f.call("grep", json!({"pattern":"hit","outputMode":"content","offset":299,"limit":2,"lineNumbers":false})).unwrap();
    assert_eq!(result["matched"], 350);
    assert_eq!(result["total"], 350);
    assert_eq!(result["items"].as_array().unwrap().len(), 2);
    assert_eq!(result["items"][0]["line"], 0);
    assert_eq!(result["items"][1]["path"], json!(f.path("b.txt")));
    assert_eq!(metrics::take().content_items, 2);
    let result = f.call("grep", json!({"pattern":"hit","outputMode":"files_with_matches","offset":1,"limit":1})).unwrap();
    assert_eq!(result["total"], 2);
    assert_eq!(result["matched"], 350);
    assert_eq!(result["items"][0]["path"], json!(f.path("b.txt")));
    let result = f.call("grep", json!({"pattern":"hit","outputMode":"content","offset":900,"limit":1})).unwrap();
    assert_eq!(result["total"], 350);
    assert_eq!(result["items"], json!([]));
    assert_eq!(metrics::take().content_items, 0);
}

#[test]
fn glob_patterns_are_parsed_once_and_paths_split_once() {
    let mut f = Fixture::new();
    f.write("a.TXT", "hit"); f.write("dir/b.txt", "hit"); f.write("dir/skip.txt", "hit");
    metrics::take();
    let result = f.call("glob", json!({"pattern":["./**/*.txt","!**/skip.*"],"outputMode":"paths"})).unwrap();
    assert_eq!(result["items"], json!([f.path("a.TXT"),f.path("dir/b.txt")]));
    let work = metrics::take();
    assert_eq!(work.glob_parses, 2);
    assert_eq!(work.path_splits, 3);
    let result = f.call("grep", json!({"glob":["!**/skip.*"],"pattern":"hit","outputMode":"summary"})).unwrap();
    assert_eq!(result["files"], 2);
    // Explicit file targets continue bypassing glob filters.
    let result = f.call("grep", json!({"path":f.path("a.TXT"),"glob":["!**"],"pattern":"hit","outputMode":"summary"})).unwrap();
    assert_eq!(result["files"], 1);
}

#[test]
fn hex_window_reads_only_requested_bytes_and_keeps_offset_units() {
    let mut f = Fixture::new();
    let file = f.write("bytes.dat", (0..=255).cycle().take(1024 * 1024).collect::<Vec<u8>>());
    metrics::take();
    let result = f.call("inspect_local_file", json!({"path":file,"view":"hex","offset":1,"limit":2})).unwrap();
    assert_eq!(result["items"][0]["offset"], 16);
    assert_eq!(result["items"][0]["text"].as_str().unwrap().split(' ').count(), 32);
    assert_eq!(result["omitted"], 1024 * 1024 - 48);
    assert_eq!(metrics::take().read_bytes, 32);
    let result = f.call("inspect_local_file", json!({"path":file,"view":"hex","offset":usize::MAX,"limit":1})).unwrap();
    assert_eq!(result["items"][0]["text"], "");
    assert_eq!(result["complete"], true);
    assert_eq!(metrics::take().read_bytes, 0);
}

#[test]
fn strict_utf8_bom_nul_crlf_and_boundary_semantics_are_preserved() {
    let mut f = Fixture::new();
    let mut invalid = b"hit\n".to_vec(); invalid.push(0xff);
    let bad = f.write("bad.txt", invalid);
    let good = f.write("good.txt", format!("{}中hit\0\r\n\u{feff}hit\n", "x".repeat(4095)));
    for mode in ["summary", "count", "files_with_matches", "content"] {
        let result = f.call("grep", json!({"pattern":"hit","outputMode":mode})).unwrap();
        assert_eq!(result["matched"], 2, "{mode}");
    }
    assert_eq!(f.call("inspect_local_file", json!({"path":bad})).unwrap_err().code, "INVALID_ARGUMENT");
    let result = f.call("inspect_local_file", json!({"path":good,"offset":2,"limit":1})).unwrap();
    assert_eq!(result["total"], 2);
    assert_eq!(result["items"][0]["text"], "\u{feff}hit");
}

#[test]
fn growth_after_handle_precheck_reads_at_most_one_probe_byte() {
    let mut f = Fixture::new();
    let path = f.write("growth.dat", "");
    let (file, size) = open_bounded(&path).unwrap();
    assert_eq!(size, 0);
    fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(MAX_FILE_BYTES + 1024).unwrap();
    metrics::take();
    assert_eq!(read_bounded(file).unwrap_err().code, "OUTPUT_LIMIT");
    assert_eq!(metrics::take().read_bytes as u64, MAX_FILE_BYTES + 1);
    fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(MAX_FILE_BYTES).unwrap();
    assert_eq!(read_bytes(&path).unwrap().len() as u64, MAX_FILE_BYTES);
    assert_eq!(metrics::take().read_bytes as u64, MAX_FILE_BYTES);
    let empty = f.write("empty.txt", "");
    assert!(read_bytes(&empty).unwrap().is_empty());
}

#[test]
fn hex_size_changes_and_short_reads_are_conflicts() {
    let mut f = Fixture::new();
    let path = f.write("changing.dat", [1; 64]);
    let (mut file, size) = open_bounded(&path).unwrap();
    fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(8).unwrap();
    assert_eq!(read_hex_window(&mut file, size, 0, 2).unwrap_err().code, "REVISION_CONFLICT");
    let (mut file, size) = open_bounded(&path).unwrap();
    fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(64).unwrap();
    assert_eq!(read_hex_window(&mut file, size, 0, 1).unwrap_err().code, "REVISION_CONFLICT");
    let result = f.call("inspect_local_file", json!({"path":path,"view":"hex","offset":3,"limit":2})).unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(result["items"][0]["text"].as_str().unwrap().split(' ').count(), 16);
}

#[test]
fn glob_legacy_syntax_and_negative_priority_remain_byte_oriented() {
    let root = Path::new("root");
    let cases = [
        ("**/*.txt", "a.txt", true), ("**/*.txt", "d/a.TXT", true),
        ("*.txt", "d/a.txt", false), ("././**/*.txt", "d/a.txt", true),
        ("a?", "a中", false), ("a???", "a中", true),
        ("[ab].txt", "a.txt", false), ("{a,b}.txt", "a.txt", false),
        ("[ab].txt", "[ab].txt", true), ("Ä.txt", "ä.txt", false),
        ("**/a/**/b", "a/b", true), ("**/a/**/b", "x/a/y/b", true),
        ("a\\b", "a/b", false), ("", "a.txt", false),
    ];
    for (pattern, name, expected) in cases {
        let patterns = vec![pattern.to_owned()];
        assert_eq!(GlobPatterns::new(&patterns).matches(root, &root.join(name)), expected, "{pattern} {name}");
    }
    let patterns = vec!["!**/*.txt".to_owned(), "**/*".to_owned()];
    assert!(!GlobPatterns::new(&patterns).matches(root, &root.join("a.txt")));
    assert!(GlobPatterns::new(&patterns).matches(root, &root.join("a.rs")));
    assert!(GlobPatterns::new(&[]).matches(root, &root.join("a.txt")));
}

fn budget_call(f: &Fixture, tool: &str, mut args: Value, limits: Value) -> Value {
    if args.get("path").is_none() { args["path"] = json!(f.root); }
    let request: Request = serde_json::from_value(json!({
        "root":f.root,"scope":"budget-test","read_only":true,"tool":tool,"args":args,"file_budget":limits,
    })).unwrap();
    dispatch(&request).unwrap()
}

#[test]
fn visited_and_deadline_stops_do_not_claim_full_tree_absence() {
    let mut f = Fixture::new();
    for i in 0..10 { f.write(&format!("f{i}.txt"), "none\n"); }
    for limits in [json!({"maxVisitedEntries":2}), json!({"timeoutMs":0})] {
        let result = budget_call(&f, "grep", json!({"pattern":"hit","outputMode":"summary"}), limits);
        assert_eq!(result["scanComplete"], false);
        assert_eq!(result["totalExact"], false);
        assert_eq!(result["complete"], false);
        assert!(result.get("total").is_none());
        assert!(result.get("omitted").is_none());
    }
}

#[test]
fn read_budget_discards_the_unvalidated_current_file() {
    let mut f = Fixture::new();
    f.write("a.txt", "hit\n");
    let mut bad = b"hit\n".repeat(100); bad.push(0xff);
    f.write("b.txt", bad);
    let result = budget_call(&f, "grep", json!({"pattern":"hit","outputMode":"summary"}), json!({"maxReadBytes":20}));
    assert_eq!(result["matched"], 1);
    assert_eq!(result["files"], 1);
    assert_eq!(result["stopReason"], "readBytes");
    assert_eq!(result["scanComplete"], false);
    assert_eq!(result["totalExact"], false);
}

#[test]
fn escaped_long_line_fits_json_budget_and_page_advances() {
    let mut f = Fixture::new();
    f.write("long.txt", format!("hit{}\nhit second\n", "中\"\\\t".repeat(10000)));
    let result = budget_call(&f, "grep", json!({"pattern":"hit","outputMode":"content","limit":1}), json!({"maxOutputBytes":4096,"maxLineBytes":2048}));
    assert!(serde_json::to_vec(&result).unwrap().len() <= 4096);
    assert_eq!(result["nextOffset"], 1);
    assert_eq!(result["items"][0]["textTruncated"], true);
    let next = budget_call(&f, "grep", json!({"pattern":"hit","outputMode":"content","offset":1,"limit":1}), json!({"maxOutputBytes":4096}));
    assert_eq!(next["nextOffset"], 2);
    assert_eq!(next["items"][0]["line"], 2);
}

#[test]
fn context_preview_is_a_prefix_even_at_multibyte_boundary() {
    let (text, bytes) = preview(["中中", "next"], 5);
    assert_eq!(text, "中");
    assert_eq!(bytes, 11);
}

#[test]
fn output_limited_glob_pages_keep_exact_totals_and_advance() {
    let mut f = Fixture::new();
    for i in 0..40 { f.write(&format!("file-{i:03}-{}.txt", "a".repeat(40)), "hit\n"); }
    let first = budget_call(&f, "glob", json!({"pattern":["*.txt"],"limit":40}), json!({"maxOutputBytes":2048}));
    assert_eq!(first["scanComplete"], true);
    assert_eq!(first["totalExact"], true);
    assert_eq!(first["total"], 40);
    assert_eq!(first["stopReason"], "outputBytes");
    let next = first["nextOffset"].as_u64().unwrap();
    assert!(next > 0 && next < 40);
    assert!(serde_json::to_vec(&first).unwrap().len() + 1 <= 2048);
    let second = budget_call(&f, "glob", json!({"pattern":["*.txt"],"offset":next,"limit":40}), json!({"maxOutputBytes":2048}));
    assert!(second["nextOffset"].as_u64().unwrap() > next);
    assert_ne!(first["items"][0], second["items"][0]);
}

#[test]
fn inspect_text_preview_keeps_exact_lines_and_hex_pages_are_contiguous() {
    let mut f = Fixture::new();
    let path = f.write("inspect.txt", format!("{}\nsecond\n", "中".repeat(10000)));
    let text = budget_call(&f, "inspect_local_file", json!({"path":path,"limit":1}), json!({"maxOutputBytes":2048,"maxLineBytes":100}));
    assert_eq!(text["total"], 2);
    assert_eq!(text["nextOffset"], 2);
    let next_text = budget_call(&f, "inspect_local_file", json!({"path":path,"offset":text["nextOffset"],"limit":1}), json!({"maxOutputBytes":2048}));
    assert_eq!(next_text["items"][0]["text"], "second");
    assert_eq!(text["items"][0]["textTruncated"], true);
    let first = budget_call(&f, "inspect_local_file", json!({"path":path,"view":"hex","offset":0,"limit":1000}), json!({"maxOutputBytes":2048,"maxLineBytes":96}));
    let next = first["nextOffset"].as_u64().unwrap();
    assert_eq!(next, 2);
    assert_eq!(first["omitted"], fs::metadata(&path).unwrap().len() - 32);
    let second = budget_call(&f, "inspect_local_file", json!({"path":path,"view":"hex","offset":next,"limit":1000}), json!({"maxOutputBytes":2048,"maxLineBytes":96}));
    assert_eq!(second["items"][0]["offset"], 32);
}

#[test]
fn io_errors_stop_with_unconfirmed_counts_and_reads_stay_bounded() {
    struct Broken;
    impl Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> { Err(std::io::Error::other("fixture read failure")) }
    }
    let mut budget = Budget::new(Default::default()).unwrap();
    assert!(bounded::read_chunks(Broken, &mut budget).is_err());
    assert_eq!(budget.reason, Some("readError"));
    let result = finish(Page::new(&budget.limits), 0, 0, 1, 0, false, &mut budget).unwrap();
    assert_eq!(result["scanComplete"], false);
    assert!(result.get("total").is_none());
}
