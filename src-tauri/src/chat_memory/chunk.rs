//! Splits text into overlapping passages on paragraph/sentence boundaries,
//! capped at `max_passages`. Character-based (EmbeddingGemma's 2048-token
//! window easily holds a ~900-char passage).

const TARGET_CHARS: usize = 900;
const OVERLAP_CHARS: usize = 120;
const HARD_MAX_CHARS: usize = 1200;

/// Returns trimmed, non-empty passages (at most `max_passages`).
pub fn passages(text: &str, max_passages: usize) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() || max_passages == 0 {
        return Vec::new();
    }

    // Build atoms: split on blank lines, then newlines, then sentence enders;
    // finally hard-split any atom still longer than HARD_MAX_CHARS so no
    // passage can exceed the embedding context (even boundary-less text).
    let mut atoms: Vec<String> = Vec::new();
    for para in text.split("\n\n") {
        for line in para.split('\n') {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let pieces: Vec<&str> = if line.len() <= HARD_MAX_CHARS {
                vec![line]
            } else {
                split_sentences(line)
            };
            for p in pieces {
                if p.chars().count() <= HARD_MAX_CHARS {
                    atoms.push(p.to_string());
                } else {
                    atoms.extend(hard_split(p, HARD_MAX_CHARS));
                }
            }
        }
    }

    // Greedily pack atoms into ~TARGET_CHARS passages with a little overlap.
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for atom in &atoms {
        if !cur.is_empty() && cur.len() + 1 + atom.len() > TARGET_CHARS {
            out.push(cur.clone());
            if out.len() >= max_passages {
                return out;
            }
            // Carry the tail of the previous passage as overlap context.
            cur = tail(&cur, OVERLAP_CHARS);
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(atom);
        // A single atom at the hard cap should flush as its own passage.
        if cur.len() >= HARD_MAX_CHARS {
            out.push(cur.clone());
            if out.len() >= max_passages {
                return out;
            }
            cur.clear();
        }
    }
    if !cur.trim().is_empty() && out.len() < max_passages {
        out.push(cur.trim().to_string());
    }
    out
}

fn split_sentences(line: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let bytes = line.as_bytes();
    let mut start = 0;
    for (i, &b) in bytes.iter().enumerate() {
        if (b == b'.' || b == b'?' || b == b'!') && i + 1 < bytes.len() && bytes[i + 1] == b' ' {
            let s = line[start..=i].trim();
            if !s.is_empty() {
                parts.push(s);
            }
            start = i + 1;
        }
    }
    let s = line[start..].trim();
    if !s.is_empty() {
        parts.push(s);
    }
    parts
}

/// Hard-split boundary-less text into char-bounded pieces (UTF-8 safe).
fn hard_split(s: &str, max: usize) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return vec![s.to_string()];
    }
    chars.chunks(max).map(|c| c.iter().collect()).collect()
}

/// Last `n` chars of `s` (char-safe), used as overlap.
fn tail(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        return s.to_string();
    }
    chars[chars.len() - n..].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_one_passage() {
        let p = passages("just a short note", 40);
        assert_eq!(p, vec!["just a short note".to_string()]);
    }

    #[test]
    fn empty_text_yields_nothing() {
        assert!(passages("   ", 40).is_empty());
        assert!(passages("anything", 0).is_empty());
    }

    #[test]
    fn long_text_splits_into_multiple_passages() {
        let para = "Sentence number ".repeat(200); // ~3200 chars
        let p = passages(&para, 40);
        assert!(p.len() >= 2, "expected multiple passages, got {}", p.len());
        for chunk in &p {
            assert!(chunk.len() <= HARD_MAX_CHARS + 1);
        }
    }

    #[test]
    fn respects_max_passages_cap() {
        let para = "word ".repeat(5000); // very long, no sentence breaks
        let p = passages(&para, 3);
        assert_eq!(p.len(), 3);
    }
}
