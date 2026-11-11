//! Resolve once before creation; an unavailable registry never silently selects an older SDK.
use crate::{logic, sdk_requirements};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Selection {
    pub version: String,
    pub visual_scripting_version: String,
    pub declared_urp_version: Option<String>,
    pub declared_input_version: String,
    pub compatibility_overrides: Vec<String>,
    pub source: &'static str,
}

fn stable(version: &str) -> Result<semver::Version, String> {
    let parsed = semver::Version::parse(version)
        .map_err(|_| "The SDK selection must be an exact stable version.")?;
    if version.len() > 128 || parsed.to_string() != version || !parsed.pre.is_empty() {
        return Err("The SDK selection must be an exact stable version.".into());
    }
    Ok(parsed)
}

pub(crate) fn resolve(request: &logic::CreateRequest) -> Result<Selection, String> {
    resolve_with(request, |version| match version {
        Some(version) => sdk_requirements::exact(version),
        None => sdk_requirements::latest(),
    })
}

fn resolve_with(
    request: &logic::CreateRequest,
    lookup: impl FnOnce(Option<&str>) -> Result<sdk_requirements::Requirements, String>,
) -> Result<Selection, String> {
    if request.use_tested_sdk {
        if request.sdk_version.is_some() {
            return Err("Choose either the latest SDK or the tested fallback, not both.".into());
        }
        return Ok(Selection {
            version: logic::CREATOR_SDK_VERSION.into(),
            visual_scripting_version: "1.9.1".into(),
            declared_urp_version: Some(logic::SDK_DECLARED_URP_VERSION.into()),
            declared_input_version: "1.4.4".into(),
            compatibility_overrides: vec!["Tested fallback tool versions".into()],
            source: "explicit-tested-fallback",
        });
    }
    if let Some(version) = &request.sdk_version {
        stable(version)?;
    }
    let metadata = lookup(request.sdk_version.as_deref()).map_err(|error| format!(
        "The selected stable SDK could not be verified. {error} No project files were created. Retry the SDK check, or explicitly choose the tested SDK in Project Setup."
    ))?;
    stable(&metadata.version)?;
    if request
        .sdk_version
        .as_ref()
        .is_some_and(|version| version != &metadata.version)
    {
        return Err(
            "The registry returned a different SDK version. Check again before creating a project."
                .into(),
        );
    }
    if let Some(minimum) = &metadata.unity_version {
        let full = if minimum.split('.').count() == 2 {
            format!("{minimum}.0f0")
        } else {
            minimum.clone()
        };
        let required = crate::repair::unity_version(&full)
            .ok_or("The SDK's Unity requirement could not be verified.")?;
        let selected = crate::repair::unity_version(logic::EDITOR_VERSION)
            .ok_or("The creation Editor version could not be verified.")?;
        if selected < required {
            return Err(format!(
                "SDK {} requires Unity {minimum} or newer; this creation recipe uses Unity {}. No project files were created. Choose another SDK or check again after updating Hub.",
                metadata.version, logic::EDITOR_VERSION
            ));
        }
    }
    let vs = metadata.dependencies.get("com.unity.visualscripting")
        .ok_or("The SDK does not declare an exact Visual Scripting dependency. No project files were created; retry or explicitly choose the tested SDK.")?;
    stable(vs)?;
    let urp = metadata
        .dependencies
        .get("com.unity.render-pipelines.universal")
        .ok_or(
            "The SDK does not declare an exact URP dependency. No project files were created.",
        )?;
    let input = metadata.dependencies.get("com.unity.inputsystem").ok_or(
        "The SDK does not declare an exact Input System dependency. No project files were created.",
    )?;
    let compatibility_overrides = validate_tool_versions(urp, input)?;
    Ok(Selection {
        version: metadata.version,
        visual_scripting_version: vs.into(),
        declared_urp_version: Some(urp.clone()),
        declared_input_version: input.clone(),
        compatibility_overrides,
        source: "official-registry",
    })
}

fn validate_tool_versions(urp: &str, input: &str) -> Result<Vec<String>, String> {
    let mut overrides = Vec::new();
    for (name, declared, selected) in [
        ("URP", urp, logic::URP_VERSION),
        ("Input System", input, logic::INPUT_SYSTEM_VERSION),
    ] {
        let required = stable(declared)?;
        let installed = stable(selected)?;
        // Trial the documented Editor/URP combination in new projects only.
        // Exact SDK/node/pipeline validation in two Unity processes must pass;
        // this does not qualify arbitrary SDKs or downgrade existing projects.
        let validate_urp_in_new_project = name == "URP"
            && declared == "17.4.0"
            && selected == "17.3.0"
            && logic::EDITOR_VERSION == "6000.3.21f1";
        if (required.major != installed.major || required > installed) && !validate_urp_in_new_project {
            return Err(format!("The SDK requires {name} {declared}; this creation recipe uses {selected}. No project files were created. Choose the tested SDK or update Hub's tool recipe."));
        }
        if declared != selected {
            overrides.push(format!(
                "{name}: SDK declares {declared}; creation validates {selected}"
            ));
        }
    }
    Ok(overrides)
}

impl Selection {
    pub fn recipe(&self) -> logic::Recipe {
        let mut recipe = logic::recipe();
        recipe.creator_sdk_version = self.version.clone();
        if let Some(urp) = &self.declared_urp_version {
            recipe.sdk_declared_urp_version = urp.clone();
        }
        recipe
    }

    pub fn validation_script(&self) -> String {
        let script = include_str!("ProjectSetupValidator.cs")
            .replace("@@EDITOR_VERSION@@", logic::EDITOR_VERSION)
            .replace("@@CREATOR_SDK_VERSION@@", &self.version)
            .replace(
                "@@VISUAL_SCRIPTING_VERSION@@",
                &self.visual_scripting_version,
            )
            .replace("@@URP_VERSION@@", logic::URP_VERSION)
            .replace("@@INPUT_SYSTEM_VERSION@@", logic::INPUT_SYSTEM_VERSION);
        if stable(&self.version).is_ok_and(|version| version >= semver::Version::new(4, 0, 22)) {
            format!("#define CREATOR_SETUP_NEW_PROJECT\n#define CREATOR_SETUP_SDK4022_VS1912_CANDIDATE\n{script}")
        } else {
            script
        }
    }

    pub fn accepts(&self, value: &serde_json::Value) -> bool {
        value["success"] == true
            && value["creatorSdkVersion"] == self.version
            && value["visualScriptingVersion"] == self.visual_scripting_version
            && value["unityVersion"] == logic::EDITOR_VERSION
            && value["urpVersion"] == logic::URP_VERSION
            && value["inputSystemVersion"] == logic::INPUT_SYSTEM_VERSION
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> logic::CreateRequest {
        serde_json::from_value(json!({"projectName":"New", "parentDirectory":"unused"})).unwrap()
    }

    fn metadata(version: &str) -> sdk_requirements::Requirements {
        sdk_requirements::parse(&serde_json::to_vec(&json!({
            "name":"com.sidequest.creator-sdk", "version":version,
            "unity":"6000.3", "unityRelease":"21f1",
            "dependencies":{"com.unity.visualscripting":"1.9.1", "com.unity.render-pipelines.universal":"17.4.0", "com.unity.inputsystem":"1.4.4"}
        })).unwrap()).unwrap()
    }

    #[test]
    fn latest_is_resolved_once_and_pinned_in_recipe_and_validator() {
        let selected = resolve_with(&request(), |version| {
            assert_eq!(version, None);
            Ok(metadata("4.0.25"))
        })
        .unwrap();
        assert_eq!(selected.recipe().creator_sdk_version, "4.0.25");
        assert!(selected
            .validation_script()
            .starts_with("#define CREATOR_SETUP_NEW_PROJECT\n"));
        assert!(selected.validation_script().contains("!= \"4.0.25\""));
        assert!(!selected.validation_script().contains("@@"));
    }

    #[test]
    fn registry_failure_never_silently_falls_back() {
        let error = resolve_with(&request(), |_| Err("offline".into())).unwrap_err();
        assert!(error.contains("No project files were created"));
        assert!(error.contains("explicitly choose"));
    }

    #[test]
    fn fallback_requires_explicit_choice_and_does_not_contact_registry() {
        let mut request = request();
        request.use_tested_sdk = true;
        let selected =
            resolve_with(&request, |_| panic!("fallback must not contact registry")).unwrap();
        assert_eq!(selected.version, logic::CREATOR_SDK_VERSION);
        assert_eq!(selected.source, "explicit-tested-fallback");
        request.sdk_version = Some("4.0.25".into());
        assert!(resolve_with(&request, |_| panic!("conflicting choice")).is_err());
    }

    #[test]
    fn selected_version_is_reverified_and_mismatch_or_prerelease_is_refused() {
        let mut selected_request = request();
        selected_request.sdk_version = Some("4.0.25".into());
        assert!(resolve_with(&selected_request, |v| {
            assert_eq!(v, Some("4.0.25"));
            Ok(metadata("4.0.26"))
        })
        .is_err());
        assert!(resolve_with(&request(), |_| Ok(metadata("4.1.0-preview.1"))).is_err());
        for version in ["latest", "^4.0.25", "4.0.25/other", "4.0.25-preview.1"] {
            selected_request.sdk_version = Some(version.into());
            assert!(resolve_with(&selected_request, |_| panic!(
                "invalid selection contacted registry"
            ))
            .is_err());
        }
    }

    #[test]
    fn newer_sdk_is_not_rejected_by_a_static_sdk_allowlist() {
        assert_eq!(
            resolve_with(&request(), |_| Ok(metadata("99.0.0")))
                .unwrap()
                .version,
            "99.0.0"
        );
        let mut latest = metadata("4.0.26");
        latest.unity_version = Some("6000.4.0f1".into());
        assert!(resolve_with(&request(), |_| Ok(latest))
            .unwrap_err()
            .contains("requires Unity"));
    }

    #[test]
    fn success_requires_the_selected_versions_not_just_a_success_flag() {
        let selected = resolve_with(&request(), |_| Ok(metadata("4.0.25"))).unwrap();
        let mut result = json!({"success":true,"creatorSdkVersion":"4.0.25","visualScriptingVersion":"1.9.1",
            "unityVersion":logic::EDITOR_VERSION,"urpVersion":logic::URP_VERSION,"inputSystemVersion":logic::INPUT_SYSTEM_VERSION});
        assert!(selected.accepts(&result));
        for key in ["creatorSdkVersion", "visualScriptingVersion", "unityVersion", "urpVersion", "inputSystemVersion"] {
            let saved = result[key].clone();
            result[key] = json!("0.0.0");
            assert!(!selected.accepts(&result), "{key}");
            result[key] = saved;
        }
    }

    #[test]
    fn missing_or_non_exact_dependency_does_not_select_an_old_version() {
        for name in [
            "com.unity.visualscripting",
            "com.unity.render-pipelines.universal",
            "com.unity.inputsystem",
        ] {
            let mut latest = metadata("4.0.25");
            latest.dependencies.remove(name);
            assert!(resolve_with(&request(), |_| Ok(latest)).is_err());
        }
        let ranged = sdk_requirements::parse(&serde_json::to_vec(&json!({
            "name":"com.sidequest.creator-sdk", "version":"4.0.25",
            "dependencies":{"com.unity.visualscripting":"^1.9.12",
                "com.unity.render-pipelines.universal":"17.4.0", "com.unity.inputsystem":"1.4.4"}
        })).unwrap()).unwrap();
        assert!(resolve_with(&request(), |_| Ok(ranged)).is_err());
    }

    #[test]
    fn newer_dependency_requirements_are_not_silently_downgraded() {
        assert!(validate_tool_versions("17.4.0", "1.4.4").is_ok());
        for (urp, input) in [
            ("18.0.0", "1.4.4"),
            ("17.5.0", "1.4.4"),
            ("17.4.0", "1.21.0"),
            ("17.4.0", "2.0.0"),
        ] {
            assert!(validate_tool_versions(urp, input).is_err());
        }
    }

    #[test]
    fn fresh_material_upgrade_uses_real_urp_work_and_checks_errors_before_saving() {
        let selected = resolve_with(&request(), |_| Ok(metadata("4.0.25"))).unwrap();
        let script = selected.validation_script().replace("\r\n", "\n");
        let upgrade = script.split("private static void UpgradeNewProjectMaterials()").nth(1).unwrap()
            .split("private static void RequireNewProjectMaterialsCurrent()").next().unwrap();
        assert!(upgrade.contains("upgrade.Invoke(null, null);\n            RequireNoCandidateErrors();\n            save.Invoke(null, null);\n            RequireNoCandidateErrors();"));
        assert!(!upgrade.contains("SetValue"));
        assert!(!script.contains("materialVersionForUpgrade ="));
        assert!(script.contains("First error: "));
    }
}
