//! Only the approved private transport can bind a signed, retained router.
use tauri::{AppHandle, Manager};

pub struct ManagedClient(pub creator_hub_mcp_router::Router);

pub fn bind(app: &AppHandle) -> Result<(), String> {
    let root = app
        .try_state::<crate::hosted_payload::Root>()
        .ok_or("Managed routing requires an approved writable payload.")?;
    let store = creator_hub_mcp_router::Store::installed()?;
    let runtime = store.resolve()?;
    let normalize = |path| crate::normalized_existing_path(path);
    if normalize(runtime.node)
        != normalize(
            root.0
                .join("runtime")
                .join(if cfg!(windows) { "node.exe" } else { "node" }),
        )
        || normalize(runtime.server) != normalize(root.0.join("creator-works-mcp.mjs"))
    {
        return Err("The active signed route changed before this view opened. Reopen MCP; no client settings were changed.".into());
    }
    if !app.manage(ManagedClient(store.router()?)) {
        return Err("Managed routing was already bound for this session.".into());
    }
    Ok(())
}

pub fn target(app: &AppHandle, server: &str) -> Result<(String, String), String> {
    if let Some(managed) = app.try_state::<ManagedClient>() {
        return Ok((
            crate::normalized_existing_path(managed.0.command.clone())
                .to_string_lossy()
                .into_owned(),
            String::new(),
        ));
    }
    Ok((
        crate::resolve_node_command(app)?
            .0
            .to_string_lossy()
            .into_owned(),
        server.into(),
    ))
}

pub fn arguments(server: &str) -> Vec<&str> {
    if server.is_empty() {
        Vec::new()
    } else {
        vec![server]
    }
}
