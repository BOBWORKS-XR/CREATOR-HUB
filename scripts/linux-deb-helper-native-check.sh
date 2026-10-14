#!/bin/bash
# Fixture-only body. No installation, sudo, pkexec or dispatch.
set -euo pipefail
if [[ "${CREATOR_LINUX_DEB_HELPER_FIXTURES:-}" != "1" ||
      "${GITHUB_ACTIONS:-}" != "true" ||
      "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ||
      "${GITHUB_REPOSITORY:-}" != "BOBWORKS-XR/CREATOR-HUB" ||
      "${GITHUB_REPOSITORY_ID:-}" != "1364807512" ||
      "${GITHUB_REF:-}" != "refs/heads/validation/linux-deb-helper-fixtures-014" ||
      "${GITHUB_EVENT_NAME:-}" != "push" ||
      "${RUNNER_OS:-}" != "Linux" || "${RUNNER_ARCH:-}" != "X64" ||
      "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" || "$(id -u)" == "0" ]]; then
  printf '%s\n' 'Refused: opted-in, unprivileged disposable GitHub-hosted Linux X64 only.' >&2
  exit 2
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
crate=native/linux-deb-retirement/Cargo.toml
cargo fmt --manifest-path "$crate" -- --check
cargo test --locked --manifest-path "$crate"
cargo clippy --locked --all-targets --manifest-path "$crate" -- -D warnings
# Separate output: the default executable used by Node must remain default-off.
cargo test --locked --features experimental-transaction --target-dir native/linux-deb-retirement/target/experimental --manifest-path "$crate"
cargo clippy --locked --features experimental-transaction --all-targets --manifest-path "$crate" -- -D warnings
cargo build --locked --manifest-path "$crate"
node --test scripts/linux-deb-helper.test.cjs
printf '%s\n' 'Unprivileged fixtures only; actual dpkg transaction and native approval remain unaccepted.'
