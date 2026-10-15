//! Strict supported subset of dpkg 1.21.1 db-fsys-divert/override formats.
//! Validate complete databases, not translated --list output. Never rewrite them.
use crate::{pins, require, setup, Result};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Identity {
    User,
    Group,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Mcp,
    Setup,
}

impl Target {
    pub(crate) fn package(self) -> &'static str {
        match self {
            Self::Mcp => pins::PACKAGE,
            Self::Setup => setup::PACKAGE,
        }
    }

    #[cfg(any(target_os = "linux", test))]
    pub(crate) fn private(self) -> &'static str {
        match self {
            Self::Mcp => pins::PRIVATE,
            Self::Setup => setup::PRIVATE,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Validated {
    identities: Vec<(Identity, String, u32)>,
    paths: Vec<(String, String)>,
}

pub fn canonical(path: &str) -> Result<()> {
    require(
        path.starts_with('/')
            && path.len() <= 4095
            && !path.bytes().any(|b| b < 32 || b == 127)
            && (path == "/" || path[1..].split('/').all(|p| !matches!(p, "" | "." | ".."))),
        "Ambiguous/noncanonical metadata path",
    )
}

fn within(child: &str, parent: &str) -> bool {
    parent == "/"
        || child == parent
        || child
            .strip_prefix(parent)
            .is_some_and(|s| s.starts_with('/'))
}

pub fn disjoint(path: &str) -> Result<()> {
    disjoint_for(Target::Mcp, path)
}

pub fn disjoint_for(target: Target, path: &str) -> Result<()> {
    canonical(path)?;
    let (product, files, additional) = match target {
        Target::Mcp => ("/usr/lib/Creator Works MCP", pins::FILES, &[][..]),
        Target::Setup => (setup::NOTICE_ROOT, setup::FILES, setup::TOMBSTONE),
    };
    require(
        !within(path, product)
            && !within(product, path)
            && files.iter().chain(additional).all(|p| {
                let target = format!("/{}", p.path);
                !within(path, &target) && !within(&target, path)
            }),
        "Diversion/statoverride intersects target files or directories",
    )
}

fn lines(bytes: &[u8]) -> Result<Vec<&str>> {
    require(
        bytes.len() <= 4 * 1024 * 1024,
        "Metadata database too large",
    )?;
    let text = std::str::from_utf8(bytes)?;
    require(
        text.is_empty() || text.ends_with('\n'),
        "Truncated metadata database",
    )?;
    let lines = text.split_terminator('\n').collect::<Vec<_>>();
    require(
        lines.len() <= 24576
            && lines.iter().all(|l| {
                !l.is_empty() && l.len() <= 4095 && !l.bytes().any(|b| b < 32 || b == 127)
            }),
        "Malformed/oversized metadata record",
    )?;
    Ok(lines)
}

fn numeric_id(value: &str) -> Result<Option<u32>> {
    if let Some(number) = value.strip_prefix('#') {
        let id: u32 = number.parse()?;
        require(
            id != u32::MAX && number == id.to_string(),
            "Invalid numeric identity",
        )?;
        return Ok(Some(id));
    }
    require(
        !value.is_empty()
            && value.len() <= 255
            && value.bytes().enumerate().all(|(i, b)| {
                b.is_ascii_lowercase() || b == b'_' || (i > 0 && (b.is_ascii_digit() || b == b'-'))
            }),
        "Unsupported user/group name",
    )?;
    Ok(None)
}

fn check_path(
    target: Target,
    value: &str,
    resolve: &mut impl FnMut(&str) -> Result<String>,
    paths: &mut Vec<(String, String)>,
) -> Result<String> {
    disjoint_for(target, value)?;
    let resolved = resolve(value)?;
    disjoint_for(target, &resolved)?;
    paths.push((value.into(), resolved.clone()));
    Ok(resolved)
}

pub fn validate(
    diversions: &[u8],
    overrides: &[u8],
    identity: impl FnMut(Identity, &str) -> Result<u32>,
    resolve: impl FnMut(&str) -> Result<String>,
) -> Result<Validated> {
    validate_for(Target::Mcp, diversions, overrides, identity, resolve)
}

pub fn validate_for(
    target: Target,
    diversions: &[u8],
    overrides: &[u8],
    mut identity: impl FnMut(Identity, &str) -> Result<u32>,
    mut resolve: impl FnMut(&str) -> Result<String>,
) -> Result<Validated> {
    let mut result = Validated {
        identities: Vec::new(),
        paths: Vec::new(),
    };
    let diversions = lines(diversions)?;
    require(diversions.len() % 3 == 0, "Incomplete diversion triple")?;
    let mut endpoints = BTreeSet::new();
    let mut resolved_endpoints = BTreeSet::new();
    for triple in diversions.as_chunks::<3>().0 {
        let package = triple[2];
        require(
            package == ":"
                || (package.len() >= 2
                    && package.len() <= 255
                    && package.bytes().enumerate().all(|(i, b)| {
                        b.is_ascii_lowercase()
                            || b.is_ascii_digit()
                            || (i > 0 && matches!(b, b'+' | b'-' | b'.'))
                    })),
            "Invalid diversion package label",
        )?;
        require(
            package != target.package(),
            "Unexpected target-owned diversion",
        )?;
        for value in &triple[..2] {
            require(endpoints.insert(*value), "Conflicting diversion endpoints")?;
            let resolved = check_path(target, value, &mut resolve, &mut result.paths)?;
            require(
                resolved_endpoints.insert(resolved),
                "Aliased diversion endpoints conflict",
            )?;
        }
    }
    let mut paths = BTreeSet::new();
    let mut resolved_paths = BTreeSet::new();
    for line in lines(overrides)? {
        // Exactly three literal space separators; the remainder is the pathname.
        let fields = line.splitn(4, ' ').collect::<Vec<_>>();
        require(fields.len() == 4, "Incomplete statoverride record")?;
        for (kind, value) in [(Identity::User, fields[0]), (Identity::Group, fields[1])] {
            let id = match numeric_id(value)? {
                Some(id) => id,
                None => identity(kind, value)?,
            };
            require(id != u32::MAX, "Unknown/invalid system identity")?;
            result.identities.push((kind, value.into(), id));
        }
        require(
            !fields[2].is_empty()
                && fields[2].len() <= 4
                && fields[2].bytes().all(|b| matches!(b, b'0'..=b'7')),
            "Invalid statoverride mode",
        )?;
        require(
            u32::from_str_radix(fields[2], 8)? <= 0o7777,
            "Invalid statoverride mode",
        )?;
        require(paths.insert(fields[3]), "Duplicate statoverride path")?;
        let resolved = check_path(target, fields[3], &mut resolve, &mut result.paths)?;
        require(
            resolved_paths.insert(resolved),
            "Aliased statoverride paths conflict",
        )?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    const DIVERSION_FIXTURE: &[u8] = include_bytes!("../tests/fixtures/38655921324.diversions");
    const OVERRIDE_FIXTURE: &[u8] = include_bytes!("../tests/fixtures/38655921324.statoverride");

    fn check(diversions: &[u8], overrides: &[u8]) -> Result<Validated> {
        validate(
            diversions,
            overrides,
            |_, name| match name {
                "root" => Ok(0),
                "_chrony" => Ok(1),
                "crontab" | "ssl-cert" | "messagebus" => Ok(2),
                _ => Err("Unknown fixture identity".into()),
            },
            |path| Ok(path.into()),
        )
    }

    #[test]
    fn captured_unrelated_databases_are_fully_parsed_not_whitelisted() {
        let d = DIVERSION_FIXTURE;
        let s = OVERRIDE_FIXTURE;
        assert_eq!(d.len(), 850);
        assert_eq!(s.len(), 244);
        assert_eq!(
            crate::sha256(d),
            "4f52ad327289a43ebded110e1a504732d01a81f682bfc9bb287b6ac11334bbe1"
        );
        assert_eq!(
            crate::sha256(s),
            "2d720ba50d80368e90fc51dcb42112dc893eb0d3e06997f74f7f3e13f6670e3d"
        );
        let checked = check(d, s).unwrap();
        assert_eq!(checked.paths.len(), 30);
        assert_eq!(checked.identities.len(), 12);
        assert!(validate(
            d,
            s,
            |_, _| Err("Unresolved account".into()),
            |p| Ok(p.into())
        )
        .is_err());
        assert!(check(
            b"/unrelated/a\n/unrelated/b\n:\n",
            b"#0 #1 0644 /unrelated/c\n"
        )
        .is_ok());
    }

    #[test]
    fn captured_prefix_never_hides_later_intersections_or_bad_records() {
        for pin in pins::FILES {
            let target = format!("/{}", pin.path);
            for triple in [
                format!("{target}\n/elsewhere/file\n:\n"),
                format!("/elsewhere/file\n{target}\nother-package\n"),
            ] {
                let mut d = DIVERSION_FIXTURE.to_vec();
                d.extend_from_slice(triple.as_bytes());
                assert!(check(&d, OVERRIDE_FIXTURE).is_err(), "{target}");
            }
            let mut s = OVERRIDE_FIXTURE.to_vec();
            s.extend_from_slice(format!("root root 644 {target}\n").as_bytes());
            assert!(check(DIVERSION_FIXTURE, &s).is_err(), "{target}");
        }
        for tail in [
            b"/incomplete\n".as_slice(),
            b"/other/a\n/other/b\ncreator-works-mcp\n",
        ] {
            let mut d = DIVERSION_FIXTURE.to_vec();
            d.extend_from_slice(tail);
            assert!(check(&d, OVERRIDE_FIXTURE).is_err());
        }
        for tail in [
            "unknown root 644 /elsewhere/file\n",
            "root root 888 /elsewhere/file\n",
        ] {
            let mut s = OVERRIDE_FIXTURE.to_vec();
            s.extend_from_slice(tail.as_bytes());
            assert!(check(DIVERSION_FIXTURE, &s).is_err());
        }
    }

    #[test]
    fn whole_database_bounds_and_encoding_fail_closed() {
        let oversized = vec![b'x'; 4 * 1024 * 1024 + 1];
        let too_many_lines = b"/a\n/b\n:\n".repeat(8193);
        let too_long_line = format!("/{}\n/b\n:\n", "a".repeat(4095)).into_bytes();
        for bytes in [
            oversized.as_slice(),
            too_many_lines.as_slice(),
            too_long_line.as_slice(),
            b"/a\n/\xff\n:\n",
            b"/a\tname\n/b\n:\n",
            b"/a\n/b\n:\n\0",
        ] {
            assert!(lines(bytes).is_err());
            assert!(check(bytes, b"").is_err());
            assert!(check(b"", bytes).is_err());
        }
    }

    #[test]
    fn all_fourteen_files_ancestors_and_product_descendants_refuse() {
        for pin in pins::FILES {
            let target = format!("/{}", pin.path);
            for path in [
                target.clone(),
                target.rsplit_once('/').unwrap().0.into(),
                format!("{target}/child"),
            ] {
                assert!(disjoint(&path).is_err(), "{path}");
                for d in [
                    format!("{path}\n/elsewhere/file\n:\n"),
                    format!("/elsewhere/file\n{path}\nother-package\n"),
                ] {
                    assert!(check(d.as_bytes(), b"").is_err());
                }
                assert!(check(b"", format!("root root 644 {path}\n").as_bytes()).is_err());
            }
        }
        assert!(disjoint("/usr/lib/Creator Works MCP/untracked/future").is_err());
        for path in [
            "/usr/bin/unrelated",
            "/usr/lib/Creator Works MCP-extra/file",
            "/usr/bin/creator-works-mcp-launcher.old",
        ] {
            disjoint(path).unwrap();
        }
        assert!(check(b"/other/a\n/other/b\ncreator-works-mcp\n", b"").is_err());
    }

    #[test]
    fn malformed_complete_databases_never_hide_a_target() {
        for d in [
            b"/a\n/b\n".as_slice(),
            b"/a\n/b\n:\n/a\n/c\n:\n",
            b"/a\n/a\n:\n",
            b"/a\n/b\n:\n\n",
            b"/a\n/b\n:",
            b"/a\n/b\nBAD NAME\n",
            b"/a\r\n/b\n:\n",
        ] {
            assert!(check(d, b"").is_err());
        }
        for s in [
            "root root 644 /a",
            "root root 644 /a\n\n",
            "root root 644 /a\nroot root 755 /a\n",
            "root root 888 /a\n",
            "root root 10000 /a\n",
            "root root -1 /a\n",
            "unknown root 644 /a\n",
            "#4294967295 #0 644 /a\n",
            "#-1 #0 644 /a\n",
            "root  root 644 /a\n",
        ] {
            assert!(check(b"", s.as_bytes()).is_err(), "{s}");
        }
        for path in [
            "usr/a",
            "//usr/a",
            "/usr/../a",
            "/usr/./a",
            "/usr//a",
            "/usr/a/",
            "/usr/\0a",
        ] {
            assert!(check(b"", format!("root root 644 {path}\n").as_bytes()).is_err());
        }
    }

    #[test]
    fn aliases_and_unresolved_paths_fail_closed_and_identity_changes_are_observable() {
        let d = b"/bin/creator-works-mcp-launcher\n/other/b\n:\n";
        assert!(validate(
            d,
            b"",
            |_, _| Ok(0),
            |p| Ok(p.replacen("/bin/", "/usr/bin/", 1))
        )
        .is_err());
        assert!(validate(
            b"/other/a\n/other/b\n:\n",
            b"",
            |_, _| Ok(0),
            |_| Err("Unprotected alias".into())
        )
        .is_err());
        assert!(validate(
            b"/other/a\n/other/b\n:\n",
            b"",
            |_, _| Ok(0),
            |_| Ok("/same".into())
        )
        .is_err());
        let first = validate(
            b"",
            b"root root 644 /other\n",
            |_, _| Ok(0),
            |p| Ok(p.into()),
        )
        .unwrap();
        let changed = validate(
            b"",
            b"root root 644 /other\n",
            |_, _| Ok(1),
            |p| Ok(p.into()),
        )
        .unwrap();
        assert_ne!(first, changed);
    }

    #[test]
    fn setup_targets_include_all_five_old_files_the_notice_and_resolved_aliases() {
        assert_eq!(Target::Mcp.private(), pins::PRIVATE);
        assert_eq!(Target::Setup.private(), setup::PRIVATE);
        assert_ne!(Target::Mcp.private(), Target::Setup.private());
        for pin in setup::FILES.iter().chain(setup::TOMBSTONE) {
            let path = format!("/{}", pin.path);
            assert!(disjoint_for(Target::Setup, &path).is_err());
            assert!(disjoint_for(Target::Setup, path.rsplit_once('/').unwrap().0).is_err());
            for diversion in [
                format!("{path}\n/other/file\n:\n"),
                format!("/other/file\n{path}\nother-package\n"),
            ] {
                assert!(validate_for(
                    Target::Setup,
                    diversion.as_bytes(),
                    b"",
                    |_, _| Ok(0),
                    |p| Ok(p.into())
                )
                .is_err());
            }
            assert!(validate_for(
                Target::Setup,
                b"",
                format!("root root 644 {path}\n").as_bytes(),
                |_, _| Ok(0),
                |p| Ok(p.into())
            )
            .is_err());
            assert!(validate_for(
                Target::Setup,
                b"/alias/a\n/alias/b\n:\n",
                b"",
                |_, _| Ok(0),
                |_| Ok(path.clone())
            )
            .is_err());
        }
        assert!(disjoint_for(
            Target::Setup,
            "/usr/share/creator-project-setup/unknown/child"
        )
        .is_err());
        assert!(validate_for(
            Target::Setup,
            b"/other/a\n/other/b\ncreator-project-setup\n",
            b"",
            |_, _| Ok(0),
            |p| Ok(p.into())
        )
        .is_err());
        validate_for(
            Target::Setup,
            DIVERSION_FIXTURE,
            OVERRIDE_FIXTURE,
            |_, _| Ok(0),
            |p| Ok(p.into()),
        )
        .unwrap();
        // The MCP default remains target-specific; no Setup pin is added to it.
        disjoint("/usr/bin/creator-project-setup").unwrap();
        assert!(disjoint("/usr/bin/creator-works-mcp-launcher").is_err());
        disjoint_for(Target::Setup, "/usr/bin/creator-works-mcp-launcher").unwrap();
    }
}
