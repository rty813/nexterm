#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // MCP clients start `nexterm.exe mcp` (or `--mcp`): a stdio bridge to the running
    // app, handled before Tauri (and its single-instance hand-off) starts. The bare `mcp`
    // form needs no `--` in `claude mcp add`, which PowerShell would swallow.
    let first = std::env::args().nth(1);
    if matches!(first.as_deref(), Some("mcp" | "--mcp")) {
        nexterm_lib::mcp::run_bridge();
        return;
    }
    nexterm_lib::run()
}
