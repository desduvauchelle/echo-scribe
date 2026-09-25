
### Use Gemma E4B for the daily recap when it's downloaded
- **Kind:** decision-needed · **Severity:** med
- **Found:** 2026-09-25, while rewriting the daily recap pipeline (commit 2313222)
- **Decision needed:** Is ~10 s more runtime and a temporary E2B→E4B model swap (extra ~2–3 GB RAM while the once-a-day job runs) worth noticeably better recaps?
- **Context:** Ran `cargo run --release --example recap_preview -- 2026-09-24 <model>` (src-tauri/examples/recap_preview.rs) on real data. E2B took 23 s; E4B took 33 s and was clearly sharper: it caught decisions E2B missed (e.g. "give Lucy her own inbox") and its topics were cleaner. Right now `Llm` (/Users/denisduvauchelle/Documents/code/echo-scribe/src-tauri/src/llm/mod.rs) has one active engine, and `generate_for_date` (/Users/denisduvauchelle/Documents/code/echo-scribe/src-tauri/src/daily_summary/mod.rs) uses whichever model is active. Proposed change: if `gemma-4-e4b-it-q4_k_m` is downloaded, the scheduler temporarily activates it for the recap and then restores the user's model, or it uses a separate short-lived `Llm` instance. Also note that `DEFAULT_LLM_MODEL_ID` only labels `model_version`; it does not select the model.
