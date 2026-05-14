//! End-to-end integration test for the daily-recap pipeline against the
//! user's real local DB + LLM model. Lets us iterate on prompt design,
//! parser tolerance, and budget tuning without rebuilding the .app bundle.
//!
//! Marked `#[ignore]` so it never runs in CI — it requires:
//!   - the user's DB at `~/Library/Application Support/EchoScribe/echo.db`
//!   - the gemma model downloaded under `~/Library/Application Support/EchoScribe/llm-models/`
//!
//! Run explicitly:
//!   `cargo test --test daily_summary_e2e -- --ignored --nocapture`
//!
//! Optionally override the target date via `DAILY_RECAP_DATE=YYYY-MM-DD`.
//! Defaults to yesterday in local time.

use std::path::PathBuf;
use std::time::Duration;

use echo_scribe_lib::daily_summary::{generate_for_date, DailySummaryResult, DEFAULT_LLM_MODEL_ID};
use echo_scribe_lib::db::{daily_summaries, Db};
use echo_scribe_lib::llm::{self, registry, Llm};

fn user_db_path() -> PathBuf {
    dirs::home_dir()
        .expect("home dir")
        .join("Library/Application Support/EchoScribe/echo.db")
}

fn yesterday_local() -> String {
    let today = chrono::Local::now().date_naive();
    (today - chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string()
}

#[tokio::test]
#[ignore = "requires user-local DB and LLM model; run with --ignored"]
async fn daily_recap_against_real_data() {
    // ------------------------------------------------------------------
    // Init tracing so we can see what `daily_summary::generate_for_date`
    // logs internally (the `info!` / `error!` lines we added for diagnosis).
    // ------------------------------------------------------------------
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "echo_scribe_lib::daily_summary=debug,info".into()),
        )
        .with_test_writer()
        .try_init();

    // ------------------------------------------------------------------
    // Open the real DB. We re-use the user's existing rows so the
    // collector sees the actual meetings + dictations we want to summarize.
    // ------------------------------------------------------------------
    let db_path = user_db_path();
    assert!(
        db_path.exists(),
        "expected user DB at {} — open the app at least once first",
        db_path.display()
    );
    let db = Db::open_at(&db_path).expect("open user db");

    // ------------------------------------------------------------------
    // Build + activate the LLM. Reuses the registry the live app uses.
    // ------------------------------------------------------------------
    let llm = Llm::new(Duration::ZERO); // never auto-unload during test
    let entry = registry::lookup(DEFAULT_LLM_MODEL_ID)
        .expect("default LLM model present in registry");
    assert!(
        llm::is_downloaded(entry),
        "model {} is not downloaded; run the app at least once to download it",
        entry.id
    );
    llm.set_active_model(entry.clone());

    // ------------------------------------------------------------------
    // Run the pipeline for the target date.
    // ------------------------------------------------------------------
    let date = std::env::var("DAILY_RECAP_DATE").unwrap_or_else(|_| yesterday_local());
    eprintln!("=== daily_summary E2E against date={date} ===");

    let result = generate_for_date(&db, &llm, &date, DEFAULT_LLM_MODEL_ID)
        .await
        .expect("orchestrator should not error at the DB layer");

    eprintln!("=== orchestrator result: {result:?} ===");

    // Pull the row that was written so we can print it.
    let row = db
        .with_conn(|conn| daily_summaries::get(conn, &date).map_err(echo_scribe_lib::db::DbError::from))
        .expect("get daily_summary")
        .expect("a row should exist after generate_for_date");
    eprintln!("status:        {:?}", row.status);
    eprintln!("model_version: {}", row.model_version);
    eprintln!("narrative:     {}", row.narrative);
    eprintln!("sections_json: {}", row.sections_json);

    match result {
        DailySummaryResult::Generated { .. } => {
            assert!(
                !row.narrative.trim().is_empty(),
                "generated row should have a non-empty narrative"
            );
        }
        DailySummaryResult::Skipped { .. } => {
            eprintln!("(empty day — no LLM call was made)");
        }
        DailySummaryResult::Failed { reason, .. } => {
            // Don't `panic!` — the whole point of this test is to surface the
            // failure reason for diagnosis. Print it loudly and let CI-style
            // pass/fail be decided by the caller.
            eprintln!("!!! daily_summary FAILED: {reason}");
            panic!("daily_summary failed: {reason}");
        }
    }
}
