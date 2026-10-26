// The Lyric extension for VS Code.
//
// The parts that need no code are declared in package.json: the TextMate grammar, the snippets,
// the problem matcher. The code here is the run command, the build task provider, a status item,
// the commands the server's lenses name, and the two processes of the toolchain it starts:
// `lyric lsp`, where everything language-aware happens, and `lyric dap`, the debugger.
//
// Nothing about the language is computed here. The client starts the server, forwards the open
// buffers to it and renders what comes back — the compiler is the only thing that decides what
// is wrong with a program, and a second opinion in JavaScript would be a second answer to the
// same question.

const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

/** The terminal that runs are sent to: one, not one per invocation. */
let terminal = null;

/**
 * A terminal that is reused for as long as it lives; without the reuse VS Code collects another one
 * on every Ctrl+F5. `exitStatus` detects a terminal the user has closed.
 */
function lyricTerminal() {
    if (terminal === null || terminal.exitStatus !== undefined) {
        terminal = vscode.window.createTerminal("Lyric");
    }
    return terminal;
}

/** Quotes a path for the terminal. Spaces are the normal case, not the exception. */
function quote(path) {
    return `"${path}"`;
}

/**
 * What has to precede the command so the shell reads it as a command rather than as text.
 *
 * PowerShell needs `&`: there `"lyric" run x` is a string literal that gets printed instead of
 * executed. That already hits the default `executable: "lyric"`.
 *
 * Dropping the quoting instead is not an option: `C:\Program Files\lyric\lyric.exe` would then fail
 * on `C:\Program`.
 *
 * `vscode.env.shell` is the default shell, and `createTerminal` without `shellPath` takes exactly
 * that one, so both see the same. For cmd.exe and every POSIX shell a leading `&` is wrong, hence
 * the case distinction rather than always emitting it.
 */
function callPrefix() {
    const shell = (vscode.env.shell || "").toLowerCase();
    return /(^|[\\/])(pwsh|powershell)(\.exe)?$/.test(shell) ? "& " : "";
}

/**
 * The names the toolchain's binary goes by, in the order they are taken. Until 5.0 is released the
 * dev channel's binary is `lyric5`; it is taken where no `lyric` is — the ladder the JetBrains
 * plugin climbs. When the binary is `lyric` everywhere, `lyric5` goes.
 */
const BinaryNames = ["lyric", "lyric5"];

/** A binary's file name on this system. */
function binaryFile(name) {
    return process.platform === "win32" ? `${name}.exe` : name;
}

function isFile(candidate) {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/** Whether a bare name is found on the `PATH`, as the shell and `spawn` would look it up. */
function onPath(name) {
    const extensions = process.platform === "win32"
        ? (process.env.PATHEXT || ".EXE").split(";").filter((e) => e.length > 0)
        : [""];
    return (process.env.PATH || "").split(path.delimiter).some((dir) =>
        dir.length > 0 && extensions.some((ext) => isFile(path.join(dir, name + ext))));
}

/**
 * The toolchain: one binary, `lyric`, whose verbs are the compiler, the language server and the
 * debug adapter alike. One setting names it — the binary, or the directory that holds it, which is
 * what the JetBrains plugin's setting names.
 */
function executable() {
    const configured = (vscode.workspace.getConfiguration("lyric").get("executable", "lyric") || "lyric").trim();

    let isDirectory = false;
    try {
        isDirectory = fs.statSync(configured).isDirectory();
    } catch {
        // Not there, or a bare name: neither is a directory.
    }
    if (isDirectory) {
        const found = BinaryNames.map((name) => path.join(configured, binaryFile(name))).find(isFile);
        return found ?? path.join(configured, binaryFile(BinaryNames[0]));
    }

    // The default is a bare name, left to the PATH; a `lyric5` there stands in for a missing `lyric`.
    if (configured === BinaryNames[0]) {
        return BinaryNames.find(onPath) ?? configured;
    }
    return configured;
}

/** The settings that apply to a file — a folder of the workspace may have its own. */
function settingsFor(file) {
    return vscode.workspace.getConfiguration("lyric", file ? vscode.Uri.file(file) : undefined);
}

/** `--profile <name>` where `lyric.run.profile` names one; nothing leaves it to the toolchain. */
function profileArgs(file) {
    const profile = (settingsFor(file).get("run.profile", "") || "").trim();
    return profile.length > 0 ? ["--profile", profile] : [];
}

/**
 * The package a file belongs to: the directory of the nearest `lyric.toml` at or above it, or
 * null for a file of its own — which the toolchain builds as a script.
 */
function packageOf(file) {
    let dir = path.dirname(file);
    for (;;) {
        if (fs.existsSync(path.join(dir, "lyric.toml"))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

/** The running language client, or null when diagnostics are off or the server did not start. */
let client = null;

/**
 * The one visible answer to "is the server running". Without it a failed start is a warning
 * toast that disappears, and the user reads the silence as "no diagnostics today" with no way to
 * tell why or to retry. Clicking it restarts.
 */
let statusItem = null;

function showStatus(state, detail) {
    if (statusItem === null) {
        return;
    }

    statusItem.busy = state === "starting";
    statusItem.severity = state === "failed"
        ? vscode.LanguageStatusSeverity.Error
        : vscode.LanguageStatusSeverity.Information;

    switch (state) {
        case "starting":
            statusItem.text = "Lyric: starting";
            statusItem.detail = "the language server is coming up";
            break;
        case "running":
            statusItem.text = detail ? `Lyric ${detail}` : "Lyric";
            statusItem.detail = "language server running";
            break;
        case "failed":
            statusItem.text = "Lyric: server failed";
            statusItem.detail = "diagnostics are off; click to retry";
            break;
        case "off":
            statusItem.text = "Lyric: diagnostics off";
            statusItem.detail = "enable lyric.diagnostics.enable to start the server";
            break;
    }
}

/**
 * Restarts run STRICTLY ONE AFTER ANOTHER.
 *
 * Without the chain a stop can overtake the start it is meant to undo: `start()` resolves only
 * after the initialize handshake, and a `stop()` issued before then rejects the request that is
 * still in flight — the client reports that as "pending response rejected since connection got
 * disposed", which names the symptom and not the cause.
 */
let restarts = Promise.resolve();

/** The restart a burst of setting changes has coming. */
let restartTimer = null;

/**
 * How long the settings must be quiet before the server is restarted.
 *
 * The settings UI fires a change PER KEYSTROKE, so typing a path is a dozen of them. Restarting on
 * each one spawns and kills a process per character, and every one of those kills lands on an
 * unanswered handshake.
 */
const RestartDelayMs = 750;

/** The settings that decide what the server is and whether it runs. */
const ServerSettings = [
    "lyric.executable",
    "lyric.diagnostics.enable",
];

/**
 * Lyric 4's settings for its separate server and debugger binaries. Lyric 5 has neither, so nothing
 * reads them; package.json keeps them only to mark them deprecated where a settings file still
 * holds one.
 */
const RetiredSettings = ["lyric.languageServer", "lyric.debugAdapter"];

/**
 * Says ONCE that a retired setting is no longer read. Without it a path set for Lyric 4 looks as if
 * it still chose the server, and the user edits it in vain; repeated on every start it would be
 * noise about a line in a file.
 */
function noticeRetiredSettings(context) {
    const set = RetiredSettings.filter((name) => {
        const value = vscode.workspace.getConfiguration().inspect(name);
        return [value?.globalValue, value?.workspaceValue, value?.workspaceFolderValue]
            .some((v) => typeof v === "string" && v.trim().length > 0);
    });
    const unsaid = set.filter((name) => !context.globalState.get(`retired:${name}`));
    if (unsaid.length === 0) {
        return;
    }
    for (const name of unsaid) {
        context.globalState.update(`retired:${name}`, true);
    }

    vscode.window
        .showInformationMessage(
            `Lyric: ${unsaid.join(" and ")} ${unsaid.length === 1 ? "is" : "are"} no longer read. Lyric 5 is one binary: ` +
            "the language server is `lyric lsp` and the debugger `lyric dap`, both from lyric.executable.",
            "Open Settings"
        )
        .then((choice) => {
            if (choice === "Open Settings") {
                vscode.commands.executeCommand("workbench.action.openSettings", "lyric.executable");
            }
        });
}

function diagnosticsEnabled() {
    return vscode.workspace.getConfiguration("lyric").get("diagnostics.enable", true);
}

/**
 * Starts `lyric lsp` and connects it to every `.lyr` buffer.
 *
 * `stdio` is the transport: the server owns those two streams for its whole lifetime, which is
 * also why nothing in it may print. A failure to start is reported once, through the client's own
 * output channel, rather than as a modal — an editor that cannot find a toolchain should still be
 * usable for reading code.
 */
async function startClient() {
    const command = executable();

    const server = {
        run: { command, args: ["lsp", "--stdio"], transport: TransportKind.stdio },
        debug: { command, args: ["lsp", "--stdio"], transport: TransportKind.stdio },
    };

    // The client's id is "lyric", so it reads `lyric.trace.server` by itself and follows its changes
    // without a restart.

    const options = {
        documentSelector: [{ scheme: "file", language: "lyric" }],
        outputChannelName: "Lyric Language Server",
    };

    const starting = new LanguageClient("lyric", "Lyric Language Server", server, options);
    client = starting;
    showStatus("starting");

    // Awaited rather than left running: the caller is the restart chain, and it may only proceed to
    // the next stop once this handshake is finished.
    try {
        await starting.start();
        showStatus("running", starting.initializeResult?.serverInfo?.version);
    } catch (error) {
        if (client === starting) {
            client = null;
        }
        showStatus("failed");
        vscode.window.showWarningMessage(
            `Lyric: the language server could not be started (${command} lsp --stdio). ` +
            `Diagnostics are off; highlighting and Ctrl+F5 still work. ${error.message}`
        );
    }
}

async function stopClient() {
    const stopping = client;
    client = null;
    if (stopping === null) {
        return;
    }

    try {
        await stopping.stop();
    } catch {
        // A client that never reached the running state rejects instead of stopping. Disposing it
        // releases the process either way, and a failure to shut down cleanly must not block the
        // restart that follows.
        try {
            await stopping.dispose();
        } catch {
            // The process is gone. Nothing left to release.
        }
    }
}

/** Queues one stop-then-start behind whatever is already running. */
function restart() {
    restarts = restarts.then(async () => {
        await stopClient();
        if (diagnosticsEnabled()) {
            await startClient();
        } else {
            showStatus("off");
        }
    });
    return restarts;
}

function scheduleRestart() {
    if (restartTimer !== null) {
        clearTimeout(restartTimer);
    }
    restartTimer = setTimeout(() => {
        restartTimer = null;
        restart();
    }, RestartDelayMs);
}

/** Saves the Lyric buffers with changes: the toolchain reads the files from disk, not the editor. */
async function saveLyricBuffers() {
    const dirty = vscode.workspace.textDocuments.filter((d) => d.languageId === "lyric" && d.isDirty);
    for (const document of dirty) {
        await document.save();
    }
}

/**
 * F5 without a launch.json debugs the package of the active file, or the file where it belongs to
 * none. The adapter builds from DISK, so the dirty buffers are saved first — the same rule the run
 * command applies, for the same reason: without it the previous version runs, and under a
 * debugger that is maximally confusing.
 */
const debugConfigurationProvider = {
    async resolveDebugConfiguration(_folder, configuration) {
        // Attaching is lldb's: to a process by its id, or to the next one a program starts. Nothing
        // is built, so there is nothing to save.
        if (configuration.request === "attach") {
            if (!configuration.pid && !configuration.program) {
                vscode.window.showErrorMessage(
                    "Lyric: an attach configuration names the process (pid) or the program to wait for."
                );
                return undefined;
            }
            return configuration;
        }

        if (!configuration.program) {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== "lyric") {
                vscode.window.showErrorMessage("Lyric: no .lyr file is active to debug.");
                return undefined;
            }
            const file = editor.document.fileName;
            configuration.type = "lyric";
            configuration.request = "launch";
            configuration.name = configuration.name || "Debug";
            configuration.program = packageOf(file) ?? file;
        }

        await saveLyricBuffers();
        return configuration;
    },
};

/**
 * Every session is `lyric dap`: it builds what a launch names and hands the rest to lldb-dap.
 * `lyric.debug.lldbDap` reaches it as `LYRIC_LLDB_DAP`, the toolchain's own way to name one; VS
 * Code merges the variable into the editor's environment.
 */
const debugAdapterFactory = {
    createDebugAdapterDescriptor(session) {
        const lldbDap = (settingsFor(session.workspaceFolder?.uri.fsPath).get("debug.lldbDap", "") || "").trim();
        const options = lldbDap.length > 0 ? { env: { LYRIC_LLDB_DAP: lldbDap } } : undefined;
        return new vscode.DebugAdapterExecutable(executable(), ["dap"], options);
    },
};

/**
 * The build task: `lyric build` in the package's directory, with the problem matcher reading the
 * compiler's diagnostics into the Problems panel.
 *
 * One task per workspace folder that carries a lyric.toml — a folder without one has no package
 * to build, and offering the task there produces exactly the "no lyric.toml here" the user did not
 * ask about.
 */
function buildTask(definition, scope, cwd) {
    const task = new vscode.Task(
        definition,
        scope,
        "build",
        "lyric",
        new vscode.ShellExecution(executable(), ["build", ...profileArgs(cwd)], { cwd }),
        "$lyric"
    );
    task.group = vscode.TaskGroup.Build;
    task.detail = "lyric build — the package, its build.lyr first";
    return task;
}

const taskProvider = {
    provideTasks() {
        const tasks = [];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const manifest = vscode.Uri.joinPath(folder.uri, "lyric.toml").fsPath;
            if (fs.existsSync(manifest)) {
                tasks.push(buildTask({ type: "lyric" }, folder, folder.uri.fsPath));
            }
        }
        return tasks;
    },

    // A tasks.json entry of type "lyric" arrives here with its own definition; the execution is
    // rebuilt around it, honoring an explicit projectDir.
    resolveTask(task) {
        const scope = task.scope ?? vscode.TaskScope.Workspace;
        const folder = typeof scope === "object" ? scope.uri.fsPath : undefined;
        return buildTask(task.definition, scope, task.definition.projectDir ?? folder);
    },
};

/**
 * What a test's lens runs: `lyric test -f <name>` in the package's directory, as a task, so its
 * failures land in the Problems panel as a build's do. The server sends the package's directory
 * and the test's name; nothing about tests is known here.
 */
async function runTest(root, name) {
    const task = new vscode.Task(
        { type: "lyric", projectDir: root },
        vscode.TaskScope.Workspace,
        `test ${name}`,
        "lyric",
        new vscode.ShellExecution(executable(), ["test", ...profileArgs(root), "-f", name], { cwd: root }),
        "$lyric"
    );
    task.group = vscode.TaskGroup.Test;
    await saveLyricBuffers();
    return vscode.tasks.executeTask(task);
}

/** What the other lens runs: the same tests under the debugger, `test` in the launch. */
function debugTest(root, name) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
    return vscode.debug.startDebugging(folder, {
        type: "lyric",
        request: "launch",
        name: `Debug test ${name}`,
        program: root,
        test: name,
    });
}

/**
 * `lyric.expand` is the server's command — the client registers it from the server's capabilities
 * — and answers the module with its macros expanded. This shows that answer beside the file.
 */
async function showExpanded() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "lyric") {
        vscode.window.showErrorMessage("Lyric: no .lyr file is active.");
        return;
    }
    if (client === null) {
        vscode.window.showErrorMessage("Lyric: the language server is not running.");
        return;
    }
    const result = await vscode.commands.executeCommand("lyric.expand", editor.document.uri.toString());
    if (!result || result.refused) {
        vscode.window.showErrorMessage(`Lyric: no expansion — ${result?.refused ?? "the server gave no answer"}`);
        return;
    }
    const document = await vscode.workspace.openTextDocument({ language: "lyric", content: result.text });
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}

function activate(context) {
    statusItem = vscode.languages.createLanguageStatusItem("lyric.server", {
        language: "lyric",
    });
    statusItem.command = { command: "lyric.restartServer", title: "Restart" };
    context.subscriptions.push(statusItem);

    // Through the same chain the setting changes use, so the first start and a restart triggered
    // seconds later cannot overlap.
    restart();

    noticeRetiredSettings(context);

    // A changed path or a toggled switch has to reach a process that was started with the old one.
    // Restarting is the whole of it: the server holds no state that survives its own exit.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!ServerSettings.some((setting) => event.affectsConfiguration(setting))) {
                return;
            }
            scheduleRestart();
        })
    );

    const run = vscode.commands.registerCommand("lyric.run", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== "lyric") {
            vscode.window.showErrorMessage("Lyric: no .lyr file is active.");
            return;
        }

        // Unsaved changes are written first: the compiler reads the files from disk, not from the
        // editor buffers. Without this the previous version runs.
        await saveLyricBuffers();

        // A file of a package runs the package; a file of its own runs as a script.
        const file = editor.document.fileName;
        const root = packageOf(file);
        const shell = lyricTerminal();
        shell.show(true);
        const what = root === null ? quote(file) : `-C ${quote(root)}`;
        const profile = profileArgs(file).map((word) => ` ${quote(word)}`).join("");
        const args = settingsFor(file).get("run.arguments", []) ?? [];
        const program = args.length > 0 ? ` -- ${args.map((arg) => quote(String(arg))).join(" ")}` : "";
        shell.sendText(`${callPrefix()}${quote(executable())} run ${what}${profile}${program}`);
    });

    context.subscriptions.push(run);

    // The way out of a hung or updated server that does not cost a window reload.
    context.subscriptions.push(
        vscode.commands.registerCommand("lyric.restartServer", () => restart())
    );
    context.subscriptions.push(vscode.commands.registerCommand("lyric.runTest", runTest));
    context.subscriptions.push(vscode.commands.registerCommand("lyric.debugTest", debugTest));
    context.subscriptions.push(vscode.commands.registerCommand("lyric.showExpanded", showExpanded));

    context.subscriptions.push(vscode.tasks.registerTaskProvider("lyric", taskProvider));

    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider("lyric", debugConfigurationProvider)
    );
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory("lyric", debugAdapterFactory)
    );
}

function deactivate() {
    if (restartTimer !== null) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }

    // The terminal is ours, so it is disposed here; VS Code would otherwise leave it orphaned when
    // the extension reloads.
    if (terminal !== null) {
        terminal.dispose();
        terminal = null;
    }

    // Behind the chain rather than beside it: a restart may still be starting a client, and
    // stopping one mid-handshake is the very thing the chain exists to prevent.
    //
    // Returned rather than awaited: VS Code waits on the promise, and the server needs that time
    // for the shutdown handshake. Without it the process is killed and the exit code says the
    // client vanished, which is what a crashed editor is supposed to look like.
    return restarts.then(stopClient);
}

module.exports = { activate, deactivate };
