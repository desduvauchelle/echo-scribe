//! Best-effort repair for almost-valid JSON from small local models.
//!
//! Observed failure shapes this fixes (from real gemma guide-review output in
//! the wild — see the 2026-08-03 log): a `}` where the still-open array needed
//! `]` first, output that stops (EOS) before the root object closes, and a
//! dangling partial token at the truncation point. Structure is repaired here;
//! type mismatches (array-for-string) are handled by tolerant deserializers at
//! the struct level, not by this pass.

/// Repair bracket structure of a JSON object. Returns the repaired string, or
/// `None` when the input contains no `{` at all. Valid input passes through
/// unchanged (modulo any preamble/suffix outside the root object, which is
/// dropped).
pub(crate) fn repair_json(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;

    let mut out = String::with_capacity(input.len() - start + 8);
    // Stack of open containers: '{' or '['.
    let mut stack: Vec<u8> = Vec::new();
    let mut in_str = false;
    let mut esc = false;

    for &b in &bytes[start..] {
        if in_str {
            out.push(b as char);
            if esc {
                esc = false;
            } else if b == b'\\' {
                esc = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => {
                in_str = true;
                out.push('"');
            }
            b'{' | b'[' => {
                stack.push(b);
                out.push(b as char);
            }
            b'}' => {
                // Close any arrays the model forgot to close first.
                while stack.last() == Some(&b'[') {
                    trim_dangling_tail(&mut out);
                    out.push(']');
                    stack.pop();
                }
                if stack.last() == Some(&b'{') {
                    trim_dangling_tail(&mut out);
                    out.push('}');
                    stack.pop();
                    if stack.is_empty() {
                        // Root object closed — ignore anything after it.
                        return Some(out);
                    }
                }
                // Unmatched '}' with nothing open: drop it.
            }
            b']' => {
                while stack.last() == Some(&b'{') {
                    trim_dangling_tail(&mut out);
                    out.push('}');
                    stack.pop();
                }
                if stack.last() == Some(&b'[') {
                    trim_dangling_tail(&mut out);
                    out.push(']');
                    stack.pop();
                }
            }
            _ => out.push(b as char),
        }
    }

    // EOF with structure still open (truncated output). Close an unterminated
    // string, drop any partial trailing token, then close every container.
    if in_str {
        if esc {
            out.pop();
        }
        out.push('"');
    }
    trim_dangling_tail(&mut out);
    while let Some(open) = stack.pop() {
        trim_dangling_tail(&mut out);
        out.push(if open == b'{' { '}' } else { ']' });
    }
    Some(out)
}

/// Remove a trailing comma or complete a dangling `"key":` so the container
/// can be closed without a syntax error at the seam.
fn trim_dangling_tail(out: &mut String) {
    let trimmed_len = out.trim_end().len();
    out.truncate(trimmed_len);
    if out.ends_with(',') {
        out.pop();
        // A second pass in case of `"key": ,` style damage.
        let trimmed_len = out.trim_end().len();
        out.truncate(trimmed_len);
    }
    if out.ends_with(':') {
        out.push_str(" null");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parses(s: &str) -> bool {
        serde_json::from_str::<serde_json::Value>(s).is_ok()
    }

    #[test]
    fn valid_json_passes_through() {
        let src = r#"{"a": [1, 2], "b": {"c": "x"}}"#;
        assert_eq!(repair_json(src).unwrap(), src);
    }

    #[test]
    fn strips_preamble_and_trailing_prose() {
        let src = "Here you go:\n```json\n{\"a\": 1}\n```\nHope that helps!";
        assert_eq!(repair_json(src).unwrap(), "{\"a\": 1}");
    }

    #[test]
    fn inserts_missing_array_close_before_root_brace() {
        // The exact "Leadership presence" failure: emergent list never closed.
        let src = r#"{"emergent": [
            {"observation": "a"},
            {"observation": "b"}
        }"#;
        let fixed = repair_json(src).unwrap();
        assert!(parses(&fixed), "not valid after repair: {fixed}");
        assert!(fixed.ends_with("]}"));
    }

    #[test]
    fn closes_everything_on_truncated_output() {
        // The "Sales conversation" failure: output stops mid-structure.
        let src = r#"{"scorecard": [{"criterion": "x", "evidence_refs": [{"segment_index": 26, "quote": "q"}], "tip": ""}]"#;
        let fixed = repair_json(src).unwrap();
        assert!(parses(&fixed), "not valid after repair: {fixed}");
    }

    #[test]
    fn trims_partial_trailing_string_and_key() {
        let src = r#"{"a": "done", "b": "cut off mid sen"#;
        let fixed = repair_json(src).unwrap();
        assert!(parses(&fixed), "not valid after repair: {fixed}");

        let src2 = r#"{"a": "done", "b":"#;
        let fixed2 = repair_json(src2).unwrap();
        assert!(parses(&fixed2), "not valid after repair: {fixed2}");
        assert!(fixed2.contains("null"));
    }

    #[test]
    fn trims_trailing_comma_before_close() {
        let src = r#"{"a": [1, 2,"#;
        let fixed = repair_json(src).unwrap();
        assert!(parses(&fixed), "not valid after repair: {fixed}");
    }

    #[test]
    fn mismatched_object_close_inside_array_of_objects() {
        // `]` arriving while an object is still open.
        let src = r#"{"items": [{"a": 1]}"#;
        let fixed = repair_json(src).unwrap();
        assert!(parses(&fixed), "not valid after repair: {fixed}");
    }

    #[test]
    fn no_object_returns_none() {
        assert!(repair_json("no json here").is_none());
    }

    #[test]
    fn escaped_quotes_and_brackets_in_strings_are_ignored() {
        let src = r#"{"a": "quote \" and } and ] inside", "b": 1}"#;
        assert_eq!(repair_json(src).unwrap(), src);
    }
}
