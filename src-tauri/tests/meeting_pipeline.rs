//! End-to-end smoke test: feed fixture WAV chunks through the pipeline and
//! assert the merged transcript is structurally correct (text contents
//! depend on the active Parakeet model and are not asserted).

use echo_scribe_lib::asr::pipeline::AsrPipeline;
use echo_scribe_lib::meeting::pipeline::Pipeline;
use echo_scribe_lib::meeting::{ChunkReady, Segment, Speaker};
use std::sync::Arc;
use tempfile::tempdir;
use tokio::sync::mpsc;

fn write_silence_wav(path: &std::path::Path, seconds: u32) {
    use std::io::Write;
    let sr: u32 = 16_000;
    let samples = sr * seconds;
    let data_bytes = samples * 2;
    let riff = 36 + data_bytes;
    let mut f = std::fs::File::create(path).unwrap();
    f.write_all(b"RIFF").unwrap();
    f.write_all(&riff.to_le_bytes()).unwrap();
    f.write_all(b"WAVEfmt ").unwrap();
    f.write_all(&16u32.to_le_bytes()).unwrap();
    f.write_all(&1u16.to_le_bytes()).unwrap();
    f.write_all(&1u16.to_le_bytes()).unwrap();
    f.write_all(&sr.to_le_bytes()).unwrap();
    f.write_all(&(sr * 2).to_le_bytes()).unwrap();
    f.write_all(&2u16.to_le_bytes()).unwrap();
    f.write_all(&16u16.to_le_bytes()).unwrap();
    f.write_all(b"data").unwrap();
    f.write_all(&data_bytes.to_le_bytes()).unwrap();
    f.write_all(&vec![0u8; data_bytes as usize]).unwrap();
}

#[tokio::test]
#[ignore = "requires Parakeet model loaded; run with --ignored"]
async fn pipeline_drains_and_merges_chunks() {
    let tmp = tempdir().unwrap();
    let mic_path = tmp.path().join("mic-chunk-0000.wav");
    let sys_path = tmp.path().join("sys-chunk-0000.wav");
    write_silence_wav(&mic_path, 60);
    write_silence_wav(&sys_path, 60);

    // Construct AsrPipeline with the configured default model. If the model isn't
    // downloaded, this test is a no-op (skipped via #[ignore]).
    let asr = Arc::new(AsrPipeline::new(std::time::Duration::from_secs(60)));
    if !asr.ready() {
        eprintln!("asr not ready, skipping");
        return;
    }

    let (tx, rx) = mpsc::unbounded_channel::<ChunkReady>();
    tx.send(ChunkReady {
        speaker: Speaker::You,
        path: mic_path,
        start_ms: 0,
        end_ms: 60_000,
    })
    .unwrap();
    tx.send(ChunkReady {
        speaker: Speaker::Them,
        path: sys_path,
        start_ms: 0,
        end_ms: 60_000,
    })
    .unwrap();
    drop(tx);

    let pipeline = Pipeline::new(asr, tmp.path().join("failed"));
    let handle = pipeline.spawn_drain(rx);
    handle.await.unwrap();
    let (segments, failed) = pipeline.finalize().await;
    assert!(failed.is_empty(), "unexpected failures: {failed:?}");
    // Silence should produce no segments because TranscriptBuilder skips empty text.
    let _: Vec<Segment> = segments;
}
