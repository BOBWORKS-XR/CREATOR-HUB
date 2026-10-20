//! Approved private transport or native Hub service binds a signed, retained router.
use tauri::{AppHandle, Manager};

pub struct ManagedClient(pub creator_hub_mcp_router::Router);

pub fn bind(app: &AppHandle) -> Result<(), String> {
    let root = app
        .try_state::<crate::hosted_payload::Root>()
        .ok_or("Managed routing requires an approved writable payload.")?;
    let managed = prepare(&root)?;
    if !app.manage(managed) {
        return Err("Managed routing was already bound for this session.".into());
    }
    Ok(())
}

pub(crate) fn prepare(root: &crate::hosted_payload::Root) -> Result<ManagedClient, String> {
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
    Ok(ManagedClient(store.router()?))
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
    require_direct_target()?;
    Ok((
        crate::resolve_node_command(app)?
            .0
            .to_string_lossy()
            .into_owned(),
        server.into(),
    ))
}

fn require_direct_target() -> Result<(), String> {
    if crate::integration_context::active() {
        return Err("Approve and bind Hub's signed MCP route before changing AI client settings. No direct runtime fallback is permitted in Hub.".into());
    }
    Ok(())
}

pub fn arguments(server: &str) -> Vec<&str> {
    if server.is_empty() {
        Vec::new()
    } else {
        vec![server]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_target_contract_is_unchanged() {
        assert!(require_direct_target().is_ok());
        assert_eq!(arguments("server.mjs"), ["server.mjs"]);
        assert!(arguments("").is_empty());
    }

    #[cfg(feature = "integrated-service")]
    #[test]
    fn integrated_calls_cannot_fall_back_to_a_direct_node_target() {
        let scope = crate::integration_context::Scope::enter().unwrap();
        assert!(require_direct_target().is_err());
        drop(scope);
        assert!(require_direct_target().is_ok());
    }
}
