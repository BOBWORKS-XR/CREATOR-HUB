pub const NEW_SETUP_SELECTION: &str = "auto";

// Keep the order of the existing groups stable for saved manual selections.
const GROUPS: [&str; 7] = [
    "core",
    "read",
    "author",
    "test",
    "banter",
    "shadergraph",
    "creator",
];

pub fn normalize(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() {
        return Ok("core".into());
    }
    let mut entries: Vec<_> = value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    entries.sort_unstable();
    entries.dedup();
    if entries.is_empty() {
        return Err("Choose Auto or a manual capability profile.".into());
    }
    if entries.iter().any(|s| ["all", "none", "auto"].contains(s)) {
        if entries.len() != 1 {
            return Err("Auto, all and none cannot be combined with other tool groups.".into());
        }
        return Ok(entries[0].into());
    }
    if entries.iter().any(|s| !GROUPS.contains(s)) {
        return Err("Unknown tool groups. Choose auto, all, none, core, read, author, test, banter, shadergraph or creator.".into());
    }
    Ok(GROUPS
        .iter()
        .copied()
        .filter(|g| entries.contains(g))
        .collect::<Vec<_>>()
        .join(","))
}

pub fn recommended(profile: &str) -> Option<&'static str> {
    match profile {
        "creator" => Some("core,creator"),
        "banter" => Some("core,banter"),
        "hybrid" => Some("core,banter,creator"),
        "none" => Some("core"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_choices_keep_their_previous_meaning_and_order() {
        for value in [
            "all",
            "none",
            "core",
            "read",
            "core,banter",
            "core,shadergraph",
        ] {
            assert_eq!(normalize(value).unwrap(), value);
        }
        assert_eq!(normalize("").unwrap(), "core");
        assert_eq!(
            normalize(" ShaderGraph, Read, read ").unwrap(),
            "read,shadergraph"
        );
    }

    #[test]
    fn auto_is_explicit_and_not_a_concrete_client_profile() {
        assert_eq!(normalize(" AUTO ").unwrap(), NEW_SETUP_SELECTION);
        for value in [
            "auto,core",
            "auto,all",
            "none,creator",
            "all,read",
            "admin",
            ",,,",
        ] {
            assert!(normalize(value).is_err(), "{value}");
        }
    }

    #[test]
    fn recommendations_distinguish_sdk_families_without_guessing() {
        assert_eq!(recommended("creator"), Some("core,creator"));
        assert_eq!(recommended("banter"), Some("core,banter"));
        assert_eq!(recommended("hybrid"), Some("core,banter,creator"));
        assert_eq!(recommended("none"), Some("core"));
        assert_eq!(recommended("unknown"), None);
        assert_eq!(recommended("future-sdk"), None);
        assert_eq!(
            normalize(recommended("hybrid").unwrap()).unwrap(),
            "core,banter,creator"
        );
    }
}
