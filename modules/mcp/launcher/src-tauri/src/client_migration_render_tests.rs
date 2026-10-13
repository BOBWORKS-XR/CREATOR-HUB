use super::*;
use std::fs;

struct Fixture {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    router: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let router = root.join(if cfg!(windows) {
            "creator-hub-mcp-router.exe"
        } else {
            "creator-hub-mcp-router"
        });
        fs::write(&router, b"not executed").unwrap();
        Self {
            _temporary: temporary,
            root,
            router,
        }
    }
    fn old(&self) -> Value {
        serde_json::json!({"command":self.root.join("legacy").join(if cfg!(windows) { "node.exe" } else { "node" }),
            "args":[self.root.join("legacy/creator-works-mcp.mjs")],
            "env":{"CUSTOM":"keep","UNITY_PROJECT_PATH":"keep project"}})
    }
    fn review(&self, format: Format, text: &str) -> Plan {
        let path = self.root.join("config");
        fs::write(&path, text).unwrap();
        Plan::review_router("Fixture", &path, format, &self.router)
            .unwrap()
            .unwrap()
    }
}

#[test]
fn router_review_preserves_internal_jsonc_comments_and_custom_bytes() {
    let f = Fixture::new();
    let old = f.old();
    let original = format!("{{\r\n // root comment\r\n \"mcp\": {{\"banter\": {{\r\n   \"type\": \"local\",\r\n   \"command\": [ /* node comment */ {}, // server comment\r\n {} ],\r\n   // disabled comment\r\n   \"enabled\": false,\r\n   \"custom\": {{ \"literal\": \"/* not a comment */\", \"nested\": [1,{{\"x\":2}}] }},\r\n   \"environment\": {{ // environment comment\r\n     \"CUSTOM\": \"keep\", /* custom comment */\r\n     \"UNITY_PROJECT_PATH\": \"keep project\" // project comment\r\n   }}\r\n }}, \"other\": {{ \"type\": \"remote\", \"url\": \"https://example.invalid\" }} }}\r\n}}\r\n", old["command"], old["args"][0]);
    let plan = f.review(Format::OpenCode, &original);
    for fragment in ["// root comment", "/* node comment */", "// server comment", "// disabled comment\r\n   \"enabled\": false", "\"custom\": { \"literal\": \"/* not a comment */\", \"nested\": [1,{\"x\":2}] }", "// environment comment\r\n     \"CUSTOM\": \"keep\", /* custom comment */\r\n     \"UNITY_PROJECT_PATH\": \"keep project\"", "// project comment\r\n", "\"other\": { \"type\": \"remote\", \"url\": \"https://example.invalid\" }"] {
        assert!(plan.after.contains(fragment), "lost: {fragment}\n{}", plan.after);
    }
    assert_eq!(
        jsonc::parse_unambiguous(&plan.after).unwrap()["mcp"]["banter"]["enabled"],
        false
    );
    assert_eq!(fs::read_to_string(&plan.path).unwrap(), original);
}

#[test]
fn json_field_edits_handle_empty_env_missing_env_escaped_keys_and_compact_closers() {
    let f = Fixture::new();
    for env in ["", ",\"env\":{}", ",\"env\":{\"CUSTOM\":\"keep\"}"] {
        let old = f.old();
        let original = format!("{{\"mcpServers\":{{\"creator-\\u0077orks\":{{\"command\":{},\"disabled\":true,\"timeout\":37,\"args\":[{}]{env}}},\"other\":{{ \"command\":\"keep\" }}}}}}", old["command"], old["args"][0]);
        let plan = f.review(Format::Json, &original);
        assert!(plan.after.contains("\"creator-\\u0077orks\""));
        assert!(plan.after.contains("\"disabled\":true,\"timeout\":37"));
        assert!(plan.after.contains("\"other\":{ \"command\":\"keep\" }"));
        assert!(client_ownership::guard_json(
            &jsonc::parse_unambiguous(&plan.after).unwrap(),
            None,
            false
        )
        .unwrap());
    }
}

#[test]
fn toml_router_review_preserves_changed_field_and_environment_comments() {
    let f = Fixture::new();
    let old = f.old();
    let node = old["command"].as_str().unwrap();
    let server = old["args"][0].as_str().unwrap();
    let original = format!("# root comment\n[mcp_servers.'creator-works']\ncommand='{node}' # command comment\nargs=[\n # node argument comment\n '{server}', # argument tail comment\n] # args comment\nenabled=false # disabled comment\n[mcp_servers.'creator-works'.env]\nCUSTOM='keep' # custom comment\nUNITY_PROJECT_PATH='keep' # project comment\n");
    let plan = f.review(Format::Codex, &original);
    for comment in [
        "# root comment",
        "# command comment",
        "# node argument comment",
        "# argument tail comment",
        "# args comment",
        "enabled=false # disabled comment",
        "CUSTOM='keep' # custom comment",
        "UNITY_PROJECT_PATH='keep' # project comment",
    ] {
        assert!(
            plan.after.contains(comment),
            "lost {comment}\n{}",
            plan.after
        );
    }
    let doc = plan.after.parse::<toml_edit::Document>().unwrap();
    assert!(doc["mcp_servers"]["creator-works"]["args"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(fs::read_to_string(&plan.path).unwrap(), original);
}

#[cfg(windows)]
#[test]
fn approved_existing_codex_claude_code_and_desktop_batch_has_a_single_recoverable_journal() {
    let f = Fixture::new();
    let old = f.old();
    let mut plans = Vec::new();
    let mut paths = Vec::new();
    for (name, format, text) in [
        (
            "Codex",
            Format::Codex,
            format!(
                "# keep\n[mcp_servers.creator-works]\ncommand='{}'\nargs=['{}']\nenabled=false\n",
                old["command"].as_str().unwrap(),
                old["args"][0].as_str().unwrap()
            ),
        ),
        (
            "Claude Code",
            Format::Json,
            serde_json::json!({"mcpServers":{"banter":old},"custom":{"keep":true}}).to_string(),
        ),
        (
            "Claude Desktop",
            Format::Json,
            serde_json::json!({"mcpServers":{"creator-works":old},"preferences":{"keep":true}})
                .to_string(),
        ),
    ] {
        let path = f.root.join(format!("{}.config", name.replace(' ', "-")));
        fs::write(&path, text).unwrap();
        plans.push(
            Plan::review_router(name, &path, format, &f.router)
                .unwrap()
                .unwrap(),
        );
        paths.push(path);
    }
    let root = f.root.join("batch-journal");
    assert!(Plan::apply_reviewed(&plans, &root, |_| false)
        .unwrap()
        .is_none());
    assert!(!root.exists());
    let result = Plan::apply_reviewed(&plans, &root, |review| review.len() == 3)
        .unwrap()
        .unwrap();
    assert!(result.completed);
    for file in &result.files {
        assert!(plans.iter().any(|plan| plan.client == file.client));
        assert_eq!(
            fs::read(&file.before_image).unwrap(),
            fs::read(&file.before_backup).unwrap()
        );
        assert_eq!(
            fs::read(&file.after_image).unwrap(),
            fs::read(&file.path).unwrap()
        );
    }
    assert!(
        recovery::Transaction::open(&result.journal, &paths)
            .unwrap()
            .resume(|_| true)
            .unwrap()
            .completed
    );
}
