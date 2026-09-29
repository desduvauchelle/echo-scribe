//! Development-only comparison commands. Release builds reject every operation;
//! the worker and its model registry are never bundled with the application.
#[cfg(debug_assertions)]
use crate::asr::{
    downloader,
    registry::{self, ModelEntry},
};
#[cfg(debug_assertions)]
use serde_json::json;
use serde_json::Value;
use tauri::AppHandle;
#[cfg(debug_assertions)]
use tauri::Emitter;
#[cfg(debug_assertions)]
use tokio::io::AsyncWriteExt;

#[cfg(debug_assertions)]
static JOB: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(debug_assertions)]
fn entries() -> Vec<ModelEntry> {
    let mut models = vec![registry::lookup("parakeet-v3").unwrap().clone()];
    models.extend(
        serde_json::from_str::<Vec<ModelEntry>>(include_str!("../asr-lab/models.json"))
            .expect("valid lab model manifest"),
    );
    // The production Parakeet aggregate is historical; show exact file totals in the lab.
    for model in &mut models {
        model.size_bytes = model.files.iter().map(|file| file.size_bytes).sum();
    }
    models
}
#[cfg(debug_assertions)]
fn entry(id: &str) -> Result<ModelEntry, String> {
    entries()
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| "Unknown comparison model".into())
}
#[cfg(debug_assertions)]
fn worker_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/asr-lab/release")
        .join(if cfg!(windows) {
            "tucky-asr-lab.exe"
        } else {
            "tucky-asr-lab"
        })
}

#[tauri::command]
pub fn asr_lab_status() -> Result<Value, String> {
    #[cfg(debug_assertions)]
    return Ok(
        json!({"worker_ready": worker_path().is_file(), "models": entries().iter().map(|m| json!({"id": m.id, "name": m.display_name, "size_bytes": m.size_bytes, "downloaded": downloader::is_downloaded(m)})).collect::<Vec<_>>() }),
    );
    #[cfg(not(debug_assertions))]
    Err("Speech comparison is available only in local development builds".into())
}

#[tauri::command]
pub async fn asr_lab_download(app: AppHandle, id: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        let _guard = JOB
            .try_lock()
            .map_err(|_| "A comparison or download is already running")?;
        let model = entry(&id)?;
        downloader::download_model(&model, &downloader::model_dir(&model), move |progress| {
            let _ = app.emit("asr-lab-download", progress);
        })
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (app, id);
        Err("Speech comparison is available only in local development builds".into())
    }
}

#[tauri::command]
pub async fn asr_lab_run(id: String, samples: Vec<f32>) -> Result<Value, String> {
    #[cfg(debug_assertions)]
    {
        let _guard = JOB
            .try_lock()
            .map_err(|_| "A comparison or download is already running")?;
        if samples.len() < 1600
            || samples.len() > 16000 * 60
            || samples.iter().any(|x| !x.is_finite() || x.abs() > 1.0)
        {
            return Err("Use a recording between 0.1 and 60 seconds".into());
        }
        let model = entry(&id)?;
        if !downloader::is_downloaded(&model) {
            return Err("Download this model first".into());
        }
        let dir = downloader::model_dir(&model);
        let path = if id == "parakeet-v3" {
            dir
        } else {
            dir.join(&model.files[0].name)
        };
        let input = serde_json::to_vec(&json!({"model": id, "path": path, "samples": samples}))
            .map_err(|e| e.to_string())?;
        let start = std::time::Instant::now();
        let mut child = tokio::process::Command::new(worker_path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Build the local worker with bun run asr:setup. {e}"))?;
        let mut stdin = child.stdin.take().ok_or("Worker input unavailable")?;
        let operation = async move {
            stdin.write_all(&input).await.map_err(|e| e.to_string())?;
            drop(stdin);
            child.wait_with_output().await.map_err(|e| e.to_string())
        };
        let output = tokio::time::timeout(std::time::Duration::from_secs(240), operation)
            .await
            .map_err(|_| "Comparison exceeded four minutes; worker stopped")??;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Model test failed: {}",
                message
                    .chars()
                    .rev()
                    .take(1800)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            ));
        }
        let mut result: Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("Invalid worker response: {e}"))?;
        result["id"] = json!(id);
        result["total_ms"] = json!(start.elapsed().as_secs_f64() * 1000.0);
        Ok(result)
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (id, samples);
        Err("Speech comparison is available only in local development builds".into())
    }
}

#[tauri::command]
pub async fn asr_lab_export(app: AppHandle, report: String) -> Result<Option<String>, String> {
    #[cfg(debug_assertions)]
    {
        use tauri_plugin_dialog::DialogExt;
        if report.len() > 1_000_000 {
            return Err("Report is too large".into());
        }
        let _: Value = serde_json::from_str(&report).map_err(|e| e.to_string())?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog()
            .file()
            .set_title("Export speech comparison")
            .set_file_name("speech-comparison.json")
            .add_filter("JSON", &["json"])
            .save_file(move |path| {
                let _ = tx.send(path.and_then(|p| p.as_path().map(std::path::PathBuf::from)));
            });
        let Some(path) = rx.await.map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        tokio::fs::write(&path, report)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (app, report);
        Err("Speech comparison is available only in local development builds".into())
    }
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;
    #[test]
    fn lab_registry_does_not_change_dictation_models() {
        assert_eq!(entries().len(), 3);
        assert!(registry::lookup("whisper-turbo").is_none());
        assert!(entry("../arbitrary").is_err());
        for model in entries() {
            assert_eq!(
                model.size_bytes,
                model.files.iter().map(|f| f.size_bytes).sum::<u64>()
            );
            assert!(model
                .files
                .iter()
                .all(|f| f.sha256.len() == 64 && f.url.contains("/resolve/")));
        }
    }
    #[tokio::test]
    async fn rejects_invalid_audio_before_starting_worker() {
        assert!(asr_lab_run("parakeet-v3".into(), vec![])
            .await
            .unwrap_err()
            .contains("recording"));
        assert!(asr_lab_run("parakeet-v3".into(), vec![f32::NAN; 1600])
            .await
            .is_err());
        assert!(asr_lab_run("parakeet-v3".into(), vec![0.0; 960001])
            .await
            .is_err());
    }
}
