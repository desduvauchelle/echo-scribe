//! Native smoke check: focus an existing local window and verify macOS focus.
//! Usage: cargo run --example check_window_focus -- "Roadmap in TextEdit"
#[tokio::main]
async fn main() -> Result<(), String> {
    let query = std::env::args()
        .nth(1)
        .ok_or("Pass an existing app or window name")?;
    println!(
        "{}",
        echo_scribe_lib::input::window_focus::focus(&query).await?
    );
    Ok(())
}
