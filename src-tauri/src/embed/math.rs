//! Pure vector helpers. No model state — fully unit-testable.

/// L2-normalize in place. A zero vector is left unchanged.
pub fn normalize(v: &mut [f32]) {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/// Truncate to `dim` (Matryoshka) then L2-normalize. If `v` is shorter than
/// `dim`, it is used as-is (then normalized).
pub fn truncate_renormalize(v: &[f32], dim: usize) -> Vec<f32> {
    let take = dim.min(v.len());
    let mut out = v[..take].to_vec();
    normalize(&mut out);
    out
}

/// Dot product. For L2-normalized inputs this equals cosine similarity.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Pack f32 little-endian for BLOB storage.
pub fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(v.len() * 4);
    for x in v {
        b.extend_from_slice(&x.to_le_bytes());
    }
    b
}

/// Unpack a little-endian f32 BLOB. Trailing bytes that don't form a full
/// f32 are ignored.
pub fn blob_to_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_makes_unit_length() {
        let mut v = vec![3.0, 4.0];
        normalize(&mut v);
        let len = (v[0] * v[0] + v[1] * v[1]).sqrt();
        assert!((len - 1.0).abs() < 1e-6, "len was {len}");
    }

    #[test]
    fn normalize_leaves_zero_vector() {
        let mut v = vec![0.0, 0.0, 0.0];
        normalize(&mut v);
        assert_eq!(v, vec![0.0, 0.0, 0.0]);
    }

    #[test]
    fn truncate_renormalize_truncates_and_unit_normalizes() {
        let v = vec![1.0, 2.0, 3.0, 4.0];
        let out = truncate_renormalize(&v, 2);
        assert_eq!(out.len(), 2);
        let len = (out[0] * out[0] + out[1] * out[1]).sqrt();
        assert!((len - 1.0).abs() < 1e-6);
    }

    #[test]
    fn dot_of_identical_unit_vectors_is_one() {
        let mut a = vec![1.0, 2.0, 2.0];
        normalize(&mut a);
        assert!((dot(&a, &a) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn blob_roundtrip() {
        let v = vec![0.5, -1.25, 3.0, 0.0];
        let back = blob_to_vec(&vec_to_blob(&v));
        assert_eq!(v, back);
    }
}
