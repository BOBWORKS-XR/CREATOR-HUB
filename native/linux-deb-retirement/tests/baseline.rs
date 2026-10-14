use creator_hub_linux_deb_retirement::{
    compatibility_listing, compatibility_state, listing, pins, sha256,
};

#[test]
fn measured_native_list_and_control_pins_match() {
    listing(include_bytes!("fixtures/baseline.list")).unwrap();
    assert_eq!(
        sha256(include_bytes!("fixtures/baseline.control")),
        "1b5ab5aa32886336f2eec3e48690c09286715e7438448813dcaa070c73111213"
    );
    assert_eq!(
        sha256(include_bytes!("fixtures/baseline.md5sums")),
        pins::MD5_SHA256
    );
    for line in include_str!("fixtures/baseline.md5sums").lines() {
        let (md5, path) = line.split_once("  ").unwrap();
        assert_eq!(
            pins::FILES.iter().find(|p| p.path == path).unwrap().md5,
            md5
        );
    }
}

#[test]
fn compatibility_list_is_measured_and_distinct_from_original() {
    let old = include_bytes!("fixtures/baseline.list");
    let new = include_bytes!("fixtures/compatibility.list");
    compatibility_listing(new).unwrap();
    assert!(compatibility_listing(old).is_err());
    assert!(listing(new).is_err());
    let status = format!(
        "{}\t{}\tamd64\tinstall ok installed\n",
        pins::PACKAGE,
        pins::NEW
    );
    compatibility_state(status.as_bytes()).unwrap();
    for (from, to) in [
        (pins::NEW, pins::OLD),
        ("install ok", "hold ok"),
        ("installed", "unpacked"),
        ("ok", "reinstreq"),
        ("amd64", "arm64"),
    ] {
        assert!(compatibility_state(status.replace(from, to).as_bytes()).is_err());
    }
    assert!(compatibility_listing(
        [new.as_slice(), b"/usr/bin/creator-works-mcp-launcher\n"]
            .concat()
            .as_slice()
    )
    .is_err());
}
