fn main() {
    if std::env::args_os().len() != 1 {
        eprintln!("Creator Hub MCP router does not accept paths or configuration overrides.");
        std::process::exit(64);
    }
    match creator_hub_mcp_router::Store::installed()
        .and_then(|store| store.resolve())
        .and_then(|runtime| runtime.run())
    {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("Creator Hub MCP: {error}");
            std::process::exit(1);
        }
    }
}
