# Configuration reference

Every configuration key, and **which component row owns it**.

---

## Where configuration lives

In DSH's configuration editor, find the corresponding `dsh-ops/shell`, `dsh-ops/file`, `dsh-ops/background` or `dsh-ops/ptc` row, adjust `config`, then save; unknown configuration keys cause errors naming the key.

The bundle declares four independently toggled components. On first installation, the first two are enabled by default:

| Row `name` | Component | Default |
| --- | --- | --- |
| `dsh-ops/shell` | Terminal and shell | On |
| `dsh-ops/file` | Rust file tools | On |
| `dsh-ops/background` | Background tasks | Off |
| `dsh-ops/ptc` | Native PTC batches | Off |

---

## 🔴 Which key belongs to which component

The table below gives the **owning component** for each key. Putting a key on a row that does not own it is rejected by configuration validation, which names the offending key.

| Key | Type | Default | Owning component |
| --- | --- | --- | --- |
| `configUpdateVersion` | non-negative integer | `0` | any (migration marker) |
| `serverName` | string, `[A-Za-z0-9_-]{1,32}` | `fastctx` | legacy compatibility |
| `binaryPath` | string path | — | background / ptc |
| `bashPath` | string path | — | shell |
| `enableShellTools` | boolean | `true` | background |
| `publishBashTool` | boolean | `true` | shell |
| `promptPolicy` | boolean | `true` | all |
| `extraGuidance` | string | empty | all |
| `toolCallTimeoutMs` | positive integer (ms) | `300000` | background |
| `fileBudgets` | object, see below | bounded defaults | file |
| `required` | boolean | `false` | all |
| `shellPolicy` | `advise` \| `deny-host-shell` | `advise` | shell |
| `deniedHostTools` | string array | `[pwsh, bash, pwsh_persistent]` | shell |
| `allowSystemShellFallback` | boolean | `false` | shell |

---

## Examples

The `dsh-ops/shell` row:

```yaml
config:
  promptPolicy: true
  publishBashTool: true
  shellPolicy: advise
  allowSystemShellFallback: false
  # bashPath: 'C:\tools\bash.exe'   # honoured in danger-full-access only; see bashPath below
```

The `dsh-ops/background` row (its market row is disabled by default):

```yaml
config:
  promptPolicy: true
  enableShellTools: true
  required: false
  toolCallTimeoutMs: 300000
  # binaryPath: 'C:\tools\fastctx.exe'
  # Managed update metadata; do not remove after the first startup self-check
  # configUpdateVersion: 1
```

---

## Key by key

- `enableShellTools`: deployment switch for the background component; enabling it still requires session `danger-full-access` to publish the four background tools. The file component never publishes command tools.
- `publishBashTool`: publish `ops_bash` using current session policy; restricted modes require the host sandbox, full access uses the host subprocess service.
- `promptPolicy`: whether to inject the component's runtime guidance; use `extraGuidance` to append instructions.
- `toolCallTimeoutMs`: FastCtx RPC wait timeout; it does not mean server-side work has terminated. Ceiling `2147483647`.
- `fileBudgets`: independent native file limits. All four file definitions declare the configured timeout; the host also starts a timer at invocation entry and awaits subprocess close and managed-range exit. Read-only workers receive a shorter cooperative deadline, reserving up to 1000 ms for startup/settlement. The provider has a further 1000 ms termination grace; this is not an absolute wall-clock guarantee for blocking OS calls. Caller cancellation/unload is separate from a worker's soft budget stop. `replace` uses the host deadline and retains unknown-effect errors after interruption; the read-only scan/output contract does not make replacement publication resumable.

### `fileBudgets` defaults and ranges

```yaml
fileBudgets:
  timeoutMs: 30000
  maxVisitedEntries: 100000
  maxReadBytes: 268435456
  maxFileBytes: 33554432
  maxOutputBytes: 98304
  maxLineBytes: 4096
```

| Key | Unit / range | Meaning |
| --- | --- | --- |
| `timeoutMs` | integer ms, 50–600000 | Total host invocation deadline; initial default 30 seconds |
| `maxVisitedEntries` | integer, 1–1000000 | Root plus enumerated entries, including excluded names and directories; distinct from the existing 100k ordinary-file cap |
| `maxReadBytes` | integer bytes, 1–9007199254740991 | Actual logical body bytes read across files, including invalid UTF-8 and growth probes |
| `maxFileBytes` | integer bytes, 1–33554432 | Handle size precheck plus a bounded growth probe; oversize files remain excluded from grep |
| `maxOutputBytes` | integer bytes, 8192–98304 | Final JSON value **and** JSON-serialized text-render array, including escaping and host sandbox metadata |
| `maxLineBytes` | integer bytes, 16–16384 | Retained source-text preview per result; UTF-8 boundaries are preserved |

These are initial bounded defaults, not fixed performance claims. Native JSON gets
half of `(maxOutputBytes - 2048)` to reserve wrapper/escaping headroom, with an
additional 1 KiB reserved inside it for result metadata. Direct worker callers
default to 48 KiB native output; internal `file_budget` accepts 2048–98304 bytes
and timeout 0–600000 ms (zero requests immediate soft stop). The model-facing
arguments do not expose this transport field.

Long paths that cannot fit even one position return `OUTPUT_LIMIT`, rather than
a successful empty page repeating the same offset. Search pages stopped by
deadline/read/entry budgets do not provide a resumable `nextOffset`; narrow the
scope or deliberately change the component budget. Ordinary page/output stops
advance by the number of returned items (hex uses 16-byte rows). Enumeration remains eager until the
directory-handle work, so an enumeration budget may stop before any file results.

The existing 128 KiB stdout capture ceiling is retained. Budgets cover the value
and the tool's text-render array; additional protocol envelopes owned by callers
are outside this byte unit. The worker's bounded diagnostics also fit its JSON
budget. Full reads validate all accepted bytes; same-size concurrent file writes
are not a snapshot guarantee.

### Other configuration keys

- `required`: whether to reject activation when the runtime is unavailable.
- `shellPolicy`: defaults to `advise`; `deny-host-shell` rejects host shells in `deniedHostTools` (default `[pwsh, bash, pwsh_persistent]`). This also disables third-layer pwsh; enable cautiously.
- `allowSystemShellFallback`: defaults to `false`. Without a bundled/provisioned bash, do not discover system PATH or well-known installations; background commands cannot bypass this through FastCtx discovery either. Explicit `true` opts into an unpinned system bash that the operator must trust and maintain. Explicit `bashPath` is a separate operator selection, not an automatic fallback. See the update configuration modification area in the [usage guide](usage.md) for the first-start migration.
- `shellPolicy` is independent: `deny-host-shell` masks/refuses host tools; disabling fallback constrains the plugin's bash resolver, not the host's own `pwsh`, and is not a filesystem sandbox.
- `binaryPath` / `bashPath`: optional explicit paths; unavailable paths cause an error rather than silently switching executors. Usually no configuration is needed.
- `bashPath` **works only in `danger-full-access`.** In read-only and workspace-write, `ops_bash` runs only the pinned MSYS whose IPC compatibility proxies were verified (the bundled payload or `dsh-ops provision-shells --bash`); any other `msys-2.0.dll`, including your own Git for Windows, returns `EXECUTOR_UNAVAILABLE` by design and is never run unconfined. Do not point `bashPath` at your own Git Bash to work around a restricted-mode problem. Check a selection with `dsh-ops ladder --config <file>`, which reports `restricted: yes/no` for the resolved bash. See [Troubleshooting](troubleshooting.md#ops_bash-cannot-run-a-custom-bashpath-or-git-for-windows-in-restricted-modes).
- `deniedHostTools`: the host tool names refused by the `deny-host-shell` policy.
- `serverName`: the legacy FastCtx server identity, kept for existing deployment rows; server instructions are no longer published as a separate prompt section.
- `configUpdateVersion`: completion marker for the one-time configuration migration. Do not remove it, or the self-check runs again.

---

## Prompt registration

Prompts are registered as independent runtime sections, **not written to AGENTS.md**: shell OFF withdraws bash/pwsh routing; file OFF withdraws native file guidance; background OFF withdraws background tools and owned-job guidance. The file component uses its independent Rust worker; FastCtx is retained only by the disabled background component. Four native file tools and `ops_bash` are added by default; duplicate foreground `ops_run` is not published. These changes reduce fixed declaration costs. The Minimal preset overrides additional system sections; PTC mode calls the underlying tools through the SDK with unchanged permission gates.

---

## See also

- [Usage](usage.md) — install, update, remove, CLI
- [Component reference](component-reference.md) — components and tools
- [Troubleshooting](troubleshooting.md) — errors and diagnosis
