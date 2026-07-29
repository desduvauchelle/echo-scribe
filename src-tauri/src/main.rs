// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--mcp") {
        if let Err(error) = echo_scribe_lib::mcp::run_stdio() {
            eprintln!("EchoScribe MCP failed: {error}");
            std::process::exit(1);
        }
    } else {
        echo_scribe_lib::run();
    }
}
