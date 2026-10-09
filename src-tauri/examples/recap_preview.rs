//! Offline diagnostic: run the daily-recap pipeline for one date against a
//! copy of the live DB and print the prompt inputs + generated JSON. Writes
//! nothing back. Usage: cargo run --release --example recap_preview -- 2026-09-24 [model-id]
use echo_scribe_lib::{daily_summary::{collector, generator}, llm::{registry, Llm}};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let date = args.next().ok_or("pass a YYYY-MM-DD date")?;
    let model = args.next().unwrap_or_else(|| "gemma-4-e2b-it-q4_k_m".into());
    let db_path = echo_scribe_lib::db::default_db_path()?;
    let conn = rusqlite::Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let input = collector::collect(&conn, &date)?;
    eprintln!("meetings={} notes={} dictations={} meaningful={}", input.meetings.len(), input.notes.len(),
        input.dictations.len(), generator::meaningful_dictations(&input).len());
    tracing_subscriber::fmt().with_writer(std::io::stderr).with_env_filter("daily_summary=info").init();
    let llm = Llm::new(std::time::Duration::ZERO);
    llm.set_active_model(registry::lookup(&model).ok_or("unknown model")?.clone());
    let t = std::time::Instant::now();
    let out = generator::generate(&llm, &input).await.map_err(|e| e.to_string())?;
    eprintln!("took {:?}", t.elapsed());
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
