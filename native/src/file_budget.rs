//! Per-call read budgets and JSON-aware page construction. No write effects.
use crate::contract::{Failure, Result};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Limits {
    pub timeout_ms: u64,
    pub max_visited_entries: u64,
    pub max_read_bytes: u64,
    pub max_file_bytes: u64,
    pub max_output_bytes: usize,
    pub max_line_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            timeout_ms: 30000,
            max_visited_entries: 100000,
            max_read_bytes: 268435456,
            max_file_bytes: 33554432,
            max_output_bytes: 48 * 1024,
            max_line_bytes: 4096,
        }
    }
}
pub struct Budget {
    pub limits: Limits,
    pub visited: u64,
    pub read_bytes: u64,
    pub reason: Option<&'static str>,
    deadline: Option<Instant>,
}
impl Budget {
    pub fn new(limits: Limits) -> Result<Self> {
        if limits.timeout_ms > 600000
            || limits.max_visited_entries == 0
            || limits.max_visited_entries > 1000000
            || limits.max_read_bytes == 0
            || limits.max_file_bytes == 0
            || limits.max_file_bytes > 33554432
            || !(2048..=98304).contains(&limits.max_output_bytes)
            || !(1..=16384).contains(&limits.max_line_bytes)
        {
            return Err(Failure::new(
                "INVALID_ARGUMENT",
                "Invalid native file_budget limits",
            ));
        }
        let deadline = Some(Instant::now() + Duration::from_millis(limits.timeout_ms));
        Ok(Self {
            limits,
            deadline,
            visited: 0,
            read_bytes: 0,
            reason: None,
        })
    }
    pub fn unlimited() -> Self {
        Self {
            limits: Limits {
                max_visited_entries: u64::MAX,
                ..Limits::default()
            },
            deadline: None,
            visited: 0,
            read_bytes: 0,
            reason: None,
        }
    }
    pub fn bounded(&self) -> bool {
        self.deadline.is_some()
    }
    pub fn stop(&mut self, reason: &'static str) {
        if self.reason.is_none() {
            self.reason = Some(reason);
        }
    }
    pub fn check(&mut self) -> bool {
        if self.deadline.is_some_and(|end| Instant::now() >= end) {
            self.stop("deadline");
        }
        self.reason.is_none()
    }
    pub fn visit(&mut self) -> bool {
        if !self.check() {
            return false;
        }
        if self.visited >= self.limits.max_visited_entries {
            self.stop("visitedEntries");
            return false;
        }
        self.visited += 1;
        true
    }
    pub fn read_allowance(&mut self, desired: usize) -> usize {
        if !self.check() {
            return 0;
        }
        let remaining = self.limits.max_read_bytes.saturating_sub(self.read_bytes);
        if remaining == 0 {
            self.stop("readBytes");
        }
        desired.min(remaining.min(usize::MAX as u64) as usize)
    }
}

#[derive(Clone, Copy)]
pub struct Checkpoint {
    count: usize,
    used: usize,
    preview: Option<&'static str>,
    blocked: bool,
}
pub struct Page {
    pub items: Vec<Value>,
    pub preview: Option<&'static str>,
    pub blocked: bool,
    used: usize,
    capacity: usize,
}
impl Page {
    pub fn new(limits: &Limits) -> Self {
        // The remaining 1 KiB covers the result's keys, counters, reasons and brackets.
        Self {
            items: Vec::new(),
            used: 0,
            capacity: limits.max_output_bytes - 1024,
            preview: None,
            blocked: false,
        }
    }
    pub fn remaining(&self) -> usize {
        self.capacity
            .saturating_sub(self.used + usize::from(!self.items.is_empty()))
    }
    pub fn checkpoint(&self) -> Checkpoint {
        Checkpoint {
            count: self.items.len(),
            used: self.used,
            preview: self.preview,
            blocked: self.blocked,
        }
    }
    pub fn restore(&mut self, checkpoint: Checkpoint) {
        self.items.truncate(checkpoint.count);
        self.used = checkpoint.used;
        self.preview = checkpoint.preview;
        self.blocked = checkpoint.blocked;
    }
    pub fn push(&mut self, item: Value) -> bool {
        if self.blocked {
            return false;
        }
        let size = serde_json::to_vec(&item)
            .expect("JSON values serialize")
            .len();
        if size > self.remaining() {
            self.blocked = true;
            return false;
        }
        self.used += size + usize::from(!self.items.is_empty());
        self.items.push(item);
        true
    }
    pub fn push_text(&mut self, mut item: Value, original_bytes: usize) -> bool {
        if self.blocked {
            return false;
        }
        let text = item["text"].as_str().unwrap_or("").to_owned();
        let initially_shortened = text.len() < original_bytes;
        if initially_shortened {
            item["textTruncated"] = json!(true);
            item["textBytes"] = json!(original_bytes);
        }
        let available = self.remaining();
        if serde_json::to_vec(&item).unwrap().len() <= available {
            if initially_shortened {
                self.preview.get_or_insert("lineBytes");
            }
            return self.push(item);
        }
        item["textTruncated"] = json!(true);
        item["textBytes"] = json!(original_bytes);
        let (mut low, mut high) = (0, text.len());
        // JSON escaping may expand each source byte; fit the serialized item.
        while low < high {
            let middle = low + (high - low).div_ceil(2);
            let boundary = floor_char_boundary(&text, middle);
            item["text"] = json!(&text[..boundary]);
            if serde_json::to_vec(&item).unwrap().len() <= available {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        let end = floor_char_boundary(&text, low);
        if end == 0 && !text.is_empty() {
            self.blocked = true;
            return false;
        }
        item["text"] = json!(&text[..end]);
        self.preview = Some("outputBytes");
        self.push(item)
    }
    pub fn ensure_progress(&self) -> Result<()> {
        if self.blocked && self.items.is_empty() {
            return Err(Failure::new(
                "OUTPUT_LIMIT",
                "One result path/position cannot fit the output budget; narrow the path or increase fileBudgets.maxOutputBytes",
            ));
        }
        Ok(())
    }
}
fn floor_char_boundary(text: &str, mut end: usize) -> usize {
    end = end.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}
pub fn preview<'a>(parts: impl IntoIterator<Item = &'a str>, max_bytes: usize) -> (String, usize) {
    let mut output = String::new();
    let mut total = 0usize;
    let mut shortened = false;
    for (i, part) in parts.into_iter().enumerate() {
        if i > 0 {
            total = total.saturating_add(1);
            if !shortened && output.len() < max_bytes {
                output.push('\n');
            } else {
                shortened = true;
            }
        }
        total = total.saturating_add(part.len());
        if !shortened {
            let end = floor_char_boundary(part, max_bytes.saturating_sub(output.len()));
            output.push_str(&part[..end]);
            shortened = end < part.len();
        }
    }
    (output, total)
}

pub fn finish(
    page: Page,
    total: usize,
    offset: usize,
    limit: usize,
    matched: usize,
    scan_complete: bool,
    budget: &mut Budget,
) -> Result<Value> {
    budget.check();
    let scan_complete = scan_complete && budget.reason.is_none();
    page.ensure_progress()?;
    let next = offset.saturating_add(page.items.len());
    let reason = budget
        .reason
        .or(if page.blocked {
            Some("outputBytes")
        } else {
            page.preview
        })
        .or(if !scan_complete || next < total {
            Some("pageLimit")
        } else {
            None
        });
    let page_complete =
        !page.blocked && (page.items.len() >= limit || (scan_complete && next >= total));
    let complete = scan_complete && next >= total && page.preview.is_none() && !page.blocked;
    let mut result = json!({"status":"completed","phase":"verify","changed":0,"matched":matched,
        "skipped":offset,"failed":0,"complete":complete,"scanComplete":scan_complete,"pageComplete":page_complete,
        "totalExact":scan_complete,"stopReason":reason,"truncated":budget.reason.is_some() || page.blocked || page.preview.is_some(),
        "items":page.items,"visitedEntries":budget.visited,"readBytes":budget.read_bytes});
    if scan_complete {
        result["total"] = json!(total);
        result["omitted"] = json!(total.saturating_sub(next));
    } else {
        result["totalLowerBound"] = json!(total);
    }
    if budget.reason.is_none() {
        result["nextOffset"] = json!(next);
    }
    if serde_json::to_vec(&result)?.len() + 1 > budget.limits.max_output_bytes {
        return Err(Failure::new(
            "OUTPUT_LIMIT",
            "Result envelope exceeds output budget",
        ));
    }
    Ok(result)
}
