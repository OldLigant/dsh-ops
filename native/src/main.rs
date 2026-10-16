#![forbid(unsafe_code)]
use dsh_ops_core::{
    contract::{Failure, Request},
    dispatch,
};
use serde_json::json;
use std::io::{Read, Write};
fn main() {
    if std::env::args().any(|a| a == "--version") {
        println!("dsh-ops-worker {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let mut read_output_budget = None;
    let value = (|| {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(Failure::from)?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(Failure::new("OUTPUT_LIMIT", "Request exceeds 2 MiB"));
        }
        let request: Request = serde_json::from_slice(&bytes)?;
        if matches!(request.tool.as_str(), "inspect_local_file" | "glob" | "grep") {
            read_output_budget = Some(request.file_budget.as_ref().map_or(48 * 1024, |limits| limits.max_output_bytes).clamp(2048, 98304));
        }
        dispatch(request)
    })();
    let output = match value {
        Ok(v) => v,
        Err(mut e) => {
            if read_output_budget.is_some() && e.message.len() > 512 {
                let mut end = 512;
                while !e.message.is_char_boundary(end) { end -= 1; }
                e.message.truncate(end);
                e.message.push_str("… (diagnostic shortened)");
            }
            json!({ "status": "error", "error": e })
        },
    };
    // stdout is a single bounded canonical JSON result. No execution facts depend on presentation.
    let mut encoded = serde_json::to_vec(&output)
        .unwrap_or_else(|_| b"{\"status\":\"error\",\"code\":\"OUTPUT_LIMIT\"}".to_vec());
    if read_output_budget.is_some_and(|limit| encoded.len() + 1 > limit) {
        encoded = serde_json::to_vec(&json!({"status":"error","error":Failure::new("OUTPUT_LIMIT", "Result exceeds native JSON budget")})).unwrap();
    }
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(&encoded);
    let _ = stdout.write_all(b"\n");
}
