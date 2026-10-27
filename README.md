# Lyric for VS Code

Language support for [Lyric](https://github.com/lyriclang/lyric) 5: the toolchain's language
server, a run command, build tasks and a debugger. From 2.0.0 the extension speaks to Lyric 5's
one binary — `lyric lsp` and `lyric dap`; Lyric 4's `lyrls` and `lyrdbg` belong to
[Lyric-Script](https://github.com/lyriclang/lyric-script), and 1.4.0 is the release for them.

The extension knows nothing about Lyric the server does not say: it starts the toolchain,
forwards the open buffers and shows what comes back. The compiler is the only thing that decides
what is wrong with a program.

## What it does

- **Diagnostics** while you type, for the whole package — the one of the nearest `lyric.toml`;
  a file outside any package is a script of its own. A finding links to its page in the
  diagnostics reference.
- **Quick fixes** for what the compiler suggests a change for — a lint's mechanical correction, a
  deprecated name's replacement — and an `@Allow` above the declaration for a lint.
- **Formatting** (`Shift+Alt+F`) as `lyric fmt` does it, sent as the lines that change.
- **Hover**, **go to definition** — into the standard library too —, **find references** and
  **rename** across the packages of the workspace, **completion**, the **outline**, **workspace
  symbols**, **signature help**, **folding** and **inlay hints**.
- **Test lenses**: above every `@Test` and doc-test, **Run test** runs `lyric test -f <name>` in
  the package's directory as a task, its failures in the Problems panel; **Debug test** debugs
  that test.
- The **Test Explorer** lists the tests of every package in the workspace — by package and file,
  as the server names them — and runs them with `lyric test --json`: each test passed, failed
  with its panic, or skipped with its reason. A package, a file or a test runs on its own; Debug
  starts `lyric dap` with the tests. The server knows a package's tests once it has analysed it,
  which an open file of the package starts.
- **Lyric: Show the File with Its Macros Expanded** opens the module as the compiler reads it
  after its macros, beside the file.
- **Highlighting** in two layers: the TextMate grammar colors what is lexical — it is made from
  [tree-sitter-lyric](https://github.com/lyriclang/tree-sitter-lyric)'s grammar, so the two say
  the same —, and the server's **semantic tokens** color every name by what the compiler resolved
  it to.
- **Run** with `Ctrl+F5`: the package of the active file, or the file where it belongs to none.
  Of a package with several programs (`[[bin]]`) it runs the file's own where the file is one's
  entry, else the one **Lyric: Select Program** chose, else `src/main.lyr`'s, as the toolchain
  does; F5 debugs the same. The programs are what `lyric metadata` says.
- **Tasks**: a folder with a `lyric.toml` offers `lyric: build`, `check`, `test`, `fmt --check`
  and `fix`, the compiler's diagnostics in the Problems panel. In tasks.json, `"command"` names
  the verb; without it the task is the build.
- **Lyric: Select Profile** sets `lyric.run.profile` from the package's profiles — the built-in
  ones and its manifest's; a status item beside the server's shows it.
- **Snippets** for the declaration forms, a test, `match` and the loops — each checked against
  the toolchain's `check` in CI.
- A **status item** says whether the server runs and which version; clicking it after a failed
  start retries, as `Lyric: Restart Language Server` does. A toolchain older than the extension
  is written for (`5.0.0-dev.20261026`) is said once, and the server runs anyway.

## Debugging

**F5** debugs the package of the active file — or the file, where it belongs to none. The adapter,
`lyric dap`, builds what the launch names in the debug profile and hands the rest to **lldb-dap**:
breakpoints with conditions, logpoints, stepping, threads. A frame is shown by its Lyric name at
its Lyric line, a local by its Lyric name, a string as its text, an array by its elements, an
optional and an enum by what they hold.

A **panic** stops the program where it happens: the exception filter **Panic**, on by default.

```json
{
    "type": "lyric",
    "request": "launch",
    "name": "Debug the package",
    "program": "${workspaceFolder}",
    "args": []
}
```

`test` in a launch debugs the package's tests whose names hold it — what the Debug lens sets.
**Attaching** is lldb's: to a process by `pid` (`${command:pickProcess}`), or with `waitFor` to the
next one `program` starts.

The debugger needs **lldb-dap** — LLVM's, or Xcode's on macOS. `lyric dap` finds it on the
`PATH` (`lldb-dap`, `lldb-dap-<version>`) or where `LYRIC_LLDB_DAP` — or `lyric.debug.lldbDap`
— names it. On Windows it is measured, not promised.

## Setup

The extension calls one program, `lyric`, from your `PATH`. Elsewhere, point at it — the binary,
or the directory that holds it:

```json
{
  "lyric.executable": "C:/tools/lyric/lyric.exe"
}
```

Until Lyric 5.0 is released, the binary of the dev channel
([the `dev` release](https://github.com/lyriclang/lyric/releases/tag/dev)) is called `lyric5`; it
is taken on the `PATH` or in the directory named where no `lyric` is.

| Setting | What it does |
|---|---|
| `lyric.executable` | The toolchain: `lyric lsp --stdio` is the server, `lyric dap` the debugger. |
| `lyric.diagnostics.enable` | Off stops the server; highlighting and `Ctrl+F5` stay. |
| `lyric.trace.server` | `messages` or `verbose` logs the protocol to the *Lyric Language Server* output. |
| `lyric.run.profile` | `--profile` for `Ctrl+F5`, the build task and the *Run test* lens: `debug`, `release` or the manifest's. Empty leaves it to `LYRIC_PROFILE`, then `debug`. The debugger always builds `debug`. |
| `lyric.run.arguments` | The program's arguments for `Ctrl+F5`, after `--`. |
| `lyric.debug.lldbDap` | The `lldb-dap` for `lyric dap`, as `LYRIC_LLDB_DAP`. |

Lyric 4's `lyric.languageServer` and `lyric.debugAdapter` are no longer read; a settings file that
still holds one shows it struck through, and the extension says so once.

Lints are the manifest's: `[lints]` in `lyric.toml` sets them for the editor and the command line
alike. What the server offers is switched by VS Code's own settings for the language:

```json
{
  "[lyric]": {
    "editor.formatOnSave": true,
    "editor.inlayHints.enabled": "offUnlessPressed",
    "editor.codeLens": false
  }
}
```

## Installing from a release

Every release of **this repository** carries a `vscode-lyric-<version>.vsix`. The extension is
versioned on its own cadence — the toolchain it talks to lives in
[lyriclang/lyric](https://github.com/lyriclang/lyric) and releases separately. Install it with
`Extensions: Install from VSIX…` in the command palette, or:

```bash
code --install-extension vscode-lyric-<version>.vsix
```

The extension is not on the Marketplace; the release asset is the distribution.

## Installing during development

The extension has one dependency, the language client, which has to be present before VS Code
loads it:

```bash
npm install
```

Then symlink or copy this directory into `~/.vscode/extensions` and restart:

```bash
# Linux/macOS
ln -s "$PWD" ~/.vscode/extensions/vscode-lyric
```

```powershell
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.vscode\extensions\vscode-lyric" -Target "$PWD"
```

Nothing is compiled or bundled: the grammar is JSON and the extension one JavaScript file.

## What CI checks

- `scripts/check-manifest.mjs`: every path the manifest names exists, grammar and language agree
  on the scope, every key binding and menu entry points at a declared command, the commands the
  server's lenses name are registered, the server is `lyric lsp` and the debugger `lyric dap`,
  and the run command stays quoted with PowerShell's call operator.
- `grammar-sync`: `syntaxes/lyric.tmLanguage.json` is the file tree-sitter-lyric makes.
- `snippets`: each snippet, filled with its defaults, passes `lyric check` of the dev channel
  (`scripts/check-snippets.mjs`).

The server and the adapter are tested in the toolchain, against the protocol.
