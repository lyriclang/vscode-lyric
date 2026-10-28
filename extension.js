// The Lyric extension for VS Code.
//
// The parts that need no code are declared in package.json: the TextMate grammar, the snippets,
// the problem matcher. The code here is the run command, the task provider, the status items, the
// commands the server's lenses name, the choice of program and profile from `lyric metadata`, and
// the two processes of the toolchain it starts: `lyric lsp`, where everything language-aware
// happens, and `lyric dap`, the debugger. The Test Explorer is testing.js.
//
// Nothing about the language is computed here. The client starts the server, forwards the open
// buffers to it and renders what comes back — the compiler is the only thing that decides what
// is wrong with a program, and a second opinion in JavaScript would be a second answer to the
// same question.

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");
const { createTesting } = require("./testing");

/** The Test Explorer's controller, once the extension is active. */
let testing = null;

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

function samePath(a, b) {
    const norm = (p) => path.resolve(p);
    return process.platform === "win32"
        ? norm(a).toLowerCase() === norm(b).toLowerCase()
        : norm(a) === norm(b);
}

/**
 * What `lyric metadata --json` says of a package — its programs, profiles and targets —, kept by
 * its directory for as long as its manifest is unchanged. A failure is not kept: the next ask
 * tries again, after the toolchain or the manifest was put right.
 */
const metadataCache = new Map();

function readMetadata(root) {
    let stamp;
    try {
        stamp = fs.statSync(path.join(root, "lyric.toml")).mtimeMs;
    } catch {
        return Promise.resolve(null);
    }
    const cached = metadataCache.get(root);
    if (cached && cached.stamp === stamp) {
        return cached.result;
    }

    const result = new Promise((resolve) => {
        childProcess.execFile(executable(), ["metadata", "--json"], { cwd: root, timeout: 30000, windowsHide: true },
            (error, stdout) => {
                let parsed = null;
                if (!error) {
                    try {
                        parsed = JSON.parse(stdout);
                    } catch {
                        // Not the document the schema describes: as if there were none.
                    }
                }
                if (parsed === null) {
                    metadataCache.delete(root);
                }
                resolve(parsed);
            });
    });
    metadataCache.set(root, { stamp, result });
    return result;
}

/**
 * Which of the package's programs a run or a debug session is about: null where the package has
 * one or none, or the toolchain could not say — the toolchain then decides —, undefined where the
 * choice was declined.
 *
 * The file's own program where the file is one's entry; else the one chosen for the package with
 * `Lyric: Select Program`; else the toolchain's own choice, `src/main.lyr`'s; asked only where the
 * package has none of that. `ask` asks in any case.
 */
async function programFor(root, file, ask = false) {
    const programs = (await readMetadata(root))?.programs ?? [];
    if (programs.length <= 1) {
        return null;
    }
    const key = `program:${root}`;
    if (!ask) {
        const own = programs.find((program) => samePath(program.entry, file));
        if (own) {
            return own;
        }
        const kept = programs.find((program) => program.name === extensionContext.workspaceState.get(key));
        if (kept) {
            return kept;
        }
        const main = programs.find((program) => samePath(program.entry, path.join(root, "src", "main.lyr")));
        if (main) {
            return main;
        }
    }
    const picked = await vscode.window.showQuickPick(
        programs.map((program) => ({
            label: program.name,
            description: path.relative(root, program.entry).replace(/\\/g, "/"),
            program,
        })),
        { placeHolder: "The program of the package to run and debug" }
    );
    if (!picked) {
        return undefined;
    }
    await extensionContext.workspaceState.update(key, picked.program.name);
    return picked.program;
}

/** The package of the active Lyric file, or of the first workspace folder that is one. */
function activePackage() {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === "lyric") {
        const root = packageOf(editor.document.fileName);
        if (root !== null) {
            return { root, file: editor.document.fileName };
        }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (fs.existsSync(path.join(folder.uri.fsPath, "lyric.toml"))) {
            return { root: folder.uri.fsPath, file: null };
        }
    }
    return null;
}

/** `Lyric: Select Program` — the choice `Ctrl+F5` and F5 keep for the package. */
async function selectProgram() {
    const active = activePackage();
    if (active === null) {
        vscode.window.showErrorMessage("Lyric: no package is open — a lyric.toml in the workspace, or a file of one.");
        return;
    }
    const program = await programFor(active.root, active.file ?? active.root, true);
    if (program === null) {
        vscode.window.showInformationMessage("Lyric: the package has one program; there is nothing to choose.");
    }
}

/**
 * `Lyric: Select Profile` — `lyric.run.profile` from the profiles the package has: the built-in
 * ones and its manifest's. Written where the package's folder keeps its settings.
 */
async function selectProfile() {
    const active = activePackage();
    const profiles = active === null ? [] : ((await readMetadata(active.root))?.profiles ?? []);
    const items = [
        { label: "Toolchain default", description: "LYRIC_PROFILE, then debug", value: "" },
        ...profiles.map((profile) => ({
            label: profile.name,
            description: profile.base && profile.base !== profile.name ? `from ${profile.base}` : undefined,
            value: profile.name,
        })),
    ];
    if (profiles.length === 0) {
        items.push({ label: "debug", value: "debug" }, { label: "release", value: "release" });
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "The profile Ctrl+F5, the tasks and the tests build with" });
    if (!picked) {
        return;
    }
    const uri = active ? vscode.Uri.file(active.root) : undefined;
    const target = uri && vscode.workspace.getWorkspaceFolder(uri)
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration("lyric", uri).update("run.profile", picked.value, target);
}

/** Says which profile the package builds with; clicking it chooses another. */
let profileItem = null;

function showProfile() {
    if (profileItem === null) {
        return;
    }
    const active = activePackage();
    const profile = (settingsFor(active?.root).get("run.profile", "") || "").trim();
    profileItem.text = `Profile: ${profile.length > 0 ? profile : "default"}`;
    profileItem.detail = "Ctrl+F5, the tasks and the tests";
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

/**
 * The oldest toolchain this client is written for: the first whose server names a file's tests
 * (`lyric/tests`) and whose `test` and `metadata` speak JSON. Raised when the client starts to rely
 * on something newer.
 */
const MinimumToolchain = "5.0.0-dev.20261026";

/** The extension's context, for what it remembers between sessions. */
let extensionContext = null;

/**
 * A version's parts: `5.0.0-dev.20261026+b78950e` is the numbers 5, 0, 0 and the pre-release
 * `dev`, 20261026; what follows `+` names the build and does not order. Null for a text that is no
 * version.
 */
function parseVersion(text) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec((text ?? "").trim());
    if (!match) {
        return null;
    }
    return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split(".") : [] };
}

/** Orders two versions as semantic versioning does: a release after its pre-releases. */
function compareVersions(a, b) {
    for (let i = 0; i < 3; i++) {
        if (a.core[i] !== b.core[i]) {
            return a.core[i] - b.core[i];
        }
    }
    if (a.pre.length === 0 || b.pre.length === 0) {
        return b.pre.length - a.pre.length;
    }
    for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
        const [x, y] = [a.pre[i], b.pre[i]];
        const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
        if (nx && ny && Number(x) !== Number(y)) {
            return Number(x) - Number(y);
        }
        if (nx !== ny) {
            return nx ? -1 : 1;
        }
        if (!nx && x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return a.pre.length - b.pre.length;
}

/**
 * Says once per toolchain version that it is older than the client is written for. The server
 * still runs: an older one answers most of what is asked, and refusing it would take the
 * diagnostics with the parts it lacks.
 */
function checkVersion(version) {
    const found = parseVersion(version);
    const minimum = parseVersion(MinimumToolchain);
    if (found === null || compareVersions(found, minimum) >= 0 || extensionContext === null) {
        return;
    }
    const key = `older-toolchain:${version}`;
    if (extensionContext.globalState.get(key)) {
        return;
    }
    extensionContext.globalState.update(key, true);
    vscode.window.showWarningMessage(
        `Lyric: the toolchain is ${version}; this extension is written for ${MinimumToolchain} or newer. ` +
        "The Test Explorer and the program choice may not work with it."
    );
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
        middleware: {
            // Pushed findings mean an analysis of a package ended: the tests it holds may have
            // changed with it.
            handleDiagnostics(uri, diagnostics, next) {
                next(uri, diagnostics);
                testing?.scheduleRefresh();
            },
        },
    };

    const starting = new LanguageClient("lyric", "Lyric Language Server", server, options);
    client = starting;
    showStatus("starting");

    // Awaited rather than left running: the caller is the restart chain, and it may only proceed to
    // the next stop once this handshake is finished.
    try {
        await starting.start();
        const version = starting.initializeResult?.serverInfo?.version;
        showStatus("running", version);
        checkVersion(version);
        testing?.scheduleRefresh();
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

            // A package of several programs is debugged by the entry of the one it runs: the
            // adapter builds the program that starts at a file.
            const root = packageOf(file);
            const program = root === null ? null : await programFor(root, file);
            if (program === undefined) {
                return undefined;
            }
            configuration.program = program?.entry ?? root ?? file;
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
 * The verbs offered as tasks, each run in the package's directory. Those that build take
 * `lyric.run.profile`; `fmt` and `fix` have no profile. `fmt --check` prints the files that would
 * change, one to a line, which no problem matcher reads.
 */
const TaskVerbs = {
    "build": { args: ["build"], profile: true, matcher: "$lyric", group: vscode.TaskGroup.Build, detail: "lyric build — the package, its build.lyr first" },
    "check": { args: ["check"], profile: true, matcher: "$lyric", group: vscode.TaskGroup.Build, detail: "lyric check — what build says, without making a binary" },
    "test": { args: ["test"], profile: true, matcher: "$lyric", group: vscode.TaskGroup.Test, detail: "lyric test — every test of the package" },
    "fmt --check": { args: ["fmt", "--check"], profile: false, matcher: [], detail: "lyric fmt --check — the files the formatter would change, none written" },
    "fix": { args: ["fix"], profile: false, matcher: "$lyric", detail: "lyric fix — the safe changes the findings suggest, written into the files" },
};

/**
 * A task of the package: the verb in its directory, with the problem matcher reading the compiler's
 * diagnostics into the Problems panel. A tasks.json entry without `command` is the build, as it
 * was before there were others.
 *
 * One set per workspace folder that carries a lyric.toml — a folder without one has no package
 * to build, and offering the tasks there produces exactly the "no lyric.toml here" the user did not
 * ask about.
 */
function lyricTask(definition, scope, cwd) {
    const name = definition.command ?? "build";
    const verb = TaskVerbs[name];
    if (verb === undefined) {
        return undefined;
    }
    const args = [...verb.args, ...(verb.profile ? profileArgs(cwd) : [])];
    const task = new vscode.Task(
        definition,
        scope,
        name,
        "lyric",
        new vscode.ShellExecution(executable(), args, { cwd }),
        verb.matcher
    );
    if (verb.group) {
        task.group = verb.group;
    }
    task.detail = verb.detail;
    return task;
}

const taskProvider = {
    provideTasks() {
        const tasks = [];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const manifest = vscode.Uri.joinPath(folder.uri, "lyric.toml").fsPath;
            if (fs.existsSync(manifest)) {
                for (const command of Object.keys(TaskVerbs)) {
                    tasks.push(lyricTask({ type: "lyric", command }, folder, folder.uri.fsPath));
                }
            }
        }
        return tasks;
    },

    // A tasks.json entry of type "lyric" arrives here with its own definition; the execution is
    // rebuilt around it, honoring an explicit projectDir.
    resolveTask(task) {
        const scope = task.scope ?? vscode.TaskScope.Workspace;
        const folder = typeof scope === "object" ? scope.uri.fsPath : undefined;
        return lyricTask(task.definition, scope, task.definition.projectDir ?? folder);
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
    extensionContext = context;

    statusItem = vscode.languages.createLanguageStatusItem("lyric.server", {
        language: "lyric",
    });
    statusItem.command = { command: "lyric.restartServer", title: "Restart" };
    context.subscriptions.push(statusItem);

    profileItem = vscode.languages.createLanguageStatusItem("lyric.profile", { language: "lyric" });
    profileItem.command = { command: "lyric.selectProfile", title: "Select" };
    context.subscriptions.push(profileItem);
    showProfile();
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(showProfile),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("lyric.run.profile")) {
                showProfile();
            }
            // Another toolchain may read the packages otherwise.
            if (event.affectsConfiguration("lyric.executable")) {
                metadataCache.clear();
            }
        })
    );

    testing = createTesting(context, {
        executable,
        profileArgs,
        client: () => client,
        saveLyricBuffers,
        debugTest,
    });

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

        // A file of a package runs the package — of several programs, the file's own or the one
        // chosen —; a file of its own runs as a script.
        const file = editor.document.fileName;
        const root = packageOf(file);
        let what = quote(file);
        if (root !== null) {
            const chosen = await programFor(root, file);
            if (chosen === undefined) {
                return;
            }
            what = `-C ${quote(root)}${chosen ? ` --bin ${quote(chosen.name)}` : ""}`;
        }
        const shell = lyricTerminal();
        shell.show(true);
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
    context.subscriptions.push(vscode.commands.registerCommand("lyric.selectProgram", selectProgram));
    context.subscriptions.push(vscode.commands.registerCommand("lyric.selectProfile", selectProfile));

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
