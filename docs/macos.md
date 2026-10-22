# macOS (arm64 and Intel x64)

Supported on **macOS 13 or later**, natively on Apple Silicon (`darwin-arm64`) and Intel
(`darwin-x64`). Exact native targets are `win32-x64`, `linux-x64`, `darwin-arm64` and
`darwin-x64`; the npm `os`/`cpu` projection is not a promise that every combination works.

macOS 12 is not fully supported: its kernel lacks `CLONE_ACL`, so overwriting an existing file,
`replace` and `copy` fail closed. Reads and non-mutating tools work. See [macOS 12](#macos-12)
below; the fallback is a separate follow-up.

## Native worker and source build

Published runtime-bearing packages use `runtime/darwin-arm64/dsh-ops-worker` or
`runtime/darwin-x64/dsh-ops-worker`, each with a version/target/executable/SHA256 receipt. A Git
checkout does not contain generated workers.

```console
npm ci --ignore-scripts
cargo build --release --locked --manifest-path native/Cargo.toml

# Apple Silicon
node bin/native-runtime.mjs stage --platform darwin-arm64 --input native/target/release
node bin/native-runtime.mjs check --platform darwin-arm64

# Intel
node bin/native-runtime.mjs stage --platform darwin-x64 --input native/target/release
node bin/native-runtime.mjs check --platform darwin-x64
```

`npm run build:ptc` builds and stages the host target, so it selects `darwin-arm64` on Apple
Silicon and `darwin-x64` on Intel. A custom `CARGO_TARGET_DIR` or `cargo --target` requires the
matching explicit stage `--input`; never stage an old default-directory build by accident. The
resolver refuses missing/corrupt receipts and targets outside the matrix.

## macOS 12

`replace`, `copy` and writes that overwrite an existing file stage a copy-on-write sibling with
`fclonefileat(..., CLONE_ACL)` so APFS ACLs and extended attributes survive. The xnu kernel in
macOS 12 (`xnu-8020`) does not implement `CLONE_ACL` and returns `EINVAL`; the worker reports
`METADATA_UNSUPPORTED` and publishes nothing. macOS 13, 14 and 15 (`xnu-8792`, `xnu-10002`,
`xnu-11215`) implement it. New files and read-only operations do not use the flag. Do not treat
macOS 12 as fully supported until the fallback lands; that fallback is a separate follow-up, not
part of this change.

## Shells

Bash is a **Windows-only optional npm payload** of the main package; PowerShell stays with the host.
npm installs no payload on a Mac and there is no postinstall downloader. macOS `ops_bash` is enabled
by default and resolves an explicit `bashPath`, then PATH and Homebrew/system locations:

- Apple Silicon Homebrew: `/opt/homebrew/bin/bash`
- Intel Homebrew: `/usr/local/bin/bash`
- System Bash: `/bin/bash`

```yaml
- id: dsh-ops-shell
  name: dsh-ops/shell
  config:
    bashPath: /opt/homebrew/bin/bash   # Intel Homebrew: /usr/local/bin/bash
```

`/bin/bash` is usable when Homebrew Bash is not installed. Restricted calls still require DSH
confinement; unavailable confinement is an executor failure, never permission to run unconfined.
The host disables its pwsh tool on macOS, so provisioning a pwsh executable does not create that
tool.

## PTC and filesystem boundaries

- file and opt-in PTC use the independent Rust worker.
- PTC tools publish only in pure PTC presentation. `batch.root` must be absolute when supplied;
  result paging of a batch audit must use the same root when it differs from the session root.
- macOS `/tmp` and `/var` are system aliases. The file bridge canonicalizes the **parent chain**,
  preserving the final entry for no-follow checks. Descendants of those aliases work; directly
  naming a symlink still fails closed. Canonical write-root checks remain in force.
- `replace` and overwrite operations on macOS require APFS clone support and `CLONE_ACL`
  (macOS 13+). Unsupported clone operations fail before publication rather than dropping a deny
  entry. Ordinary mode/owner/xattrs are restored before the final fsync and rename.
- Hidden `.dsh-ops-update-*.lock` sidecars are cooperative path locks, removed by the writer that
  holds one. A sidecar left by a killed writer is reused and removed by the next write of that name;
  it is never a stuck lock.

## Verification evidence

- CI runs the full gate on `macos-latest` (arm64, blocking) and `macos-15-intel` (x64,
  non-blocking because the leg measured 318 s > 300 s; see [CI](ci.md)).
- The Intel leg builds and stages `darwin-x64`, runs all suites, checks the Mach-O x86_64 worker
  and its receipt, and packs/unpacks the artifact.
- A local Intel macOS 12.7.6 run has 42 Rust unit tests passing and one expected `CLONE_ACL`
  failure; that is why macOS 12 is a follow-up rather than part of this support claim.
- 0.3.1 shipped Apple Silicon only; current support adds Intel on macOS 13+. Desktop GUI sessions
  still require a normal app restart after replacing the package.
