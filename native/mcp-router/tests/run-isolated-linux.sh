#!/usr/bin/env bash
# Optional local WSL/native fixture runner. Tools stay in an isolated directory.
set -euo pipefail
repo="$(realpath "${1:?Provide the exact Creator Hub checkout}")"
test -f "$repo/native/mcp-router/tests/unix-execution.cjs"
work="$(mktemp -d /var/tmp/creator-hub-unix-native.XXXXXXXX)"
export RUSTUP_HOME="$work/rustup"
export CARGO_HOME="$work/cargo"
export CARGO_TARGET_DIR="$work/target"
export PATH="$CARGO_HOME/bin:$PATH"
printf 'Isolated native tools/evidence: %s\n' "$work"
curl -fsSL --connect-timeout 20 --max-time 180 https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init -o "$work/rustup-init"
curl -fsSL --connect-timeout 20 --max-time 30 https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init.sha256 -o "$work/rustup-init.sha256"
expected="$(awk '{print $1}' "$work/rustup-init.sha256")"
test "$(sha256sum "$work/rustup-init" | awk '{print $1}')" = "$expected"
chmod 700 "$work/rustup-init"
"$work/rustup-init" -y --no-modify-path --profile minimal --default-toolchain 1.92.0
curl -fsSL --connect-timeout 20 --max-time 180 https://nodejs.org/dist/v24.17.0/node-v24.17.0-linux-x64.tar.xz -o "$work/node.tar.xz"
# Same archive pin as modules/mcp/scripts/stage-node-runtime.mjs.
test "$(sha256sum "$work/node.tar.xz" | awk '{print $1}')" = ab343a1b747c7cbf3630dfd7dbf818c5423fab2eb4f5ad1afc896f6bd121a917
mkdir "$work/node"
tar -xJf "$work/node.tar.xz" --strip-components=1 -C "$work/node"
test "$(sha256sum "$work/node/bin/node" | awk '{print $1}')" = 62d66443847de1f527f74afe715900b12884ace52136dc9cd8e91e61acc2f527
cd "$repo"
cargo test --release --locked --manifest-path native/mcp-router/Cargo.toml
cargo test --locked --manifest-path native/mcp-router/tests/hosted-payload/Cargo.toml
"$work/node/bin/node" native/mcp-router/tests/unix-execution.cjs "$work/node/bin/node" | tee "$work/native-console.json"
