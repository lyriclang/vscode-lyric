// The commands about a package besides building and running it: making one, its dependencies, its
// documentation and public surface, the toolchain's settings and its explanations.
//
// Each is a verb of the toolchain (spec 14) called as it is: what the verb writes, refuses or says
// is the answer, shown as it comes. Nothing here edits a manifest or decides what a name may be.

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

/** The scheme of the read-only pages the commands show: an explanation, the environment. */
const Scheme = "lyric-page";

/** Escapes a cell of a Markdown table. */
function cell(text) {
    return String(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * Sets up the commands.
 *
 * `toolchain` is what the extension shares with them: `executable()`, `profileArgs(dir)`,
 * `readMetadata(root)`, `activePackage()` and `samePath(a, b)`.
 */
function createCommands(context, toolchain) {
    const output = vscode.window.createOutputChannel("Lyric");
    context.subscriptions.push(output);

    // The pages by their URI; a page shown again is the newer text.
    const pages = new Map();
    const changed = new vscode.EventEmitter();
    context.subscriptions.push(changed, vscode.workspace.registerTextDocumentContentProvider(Scheme, {
        onDidChange: changed.event,
        provideTextDocumentContent: (uri) => pages.get(uri.toString()) ?? "",
    }));

    /** Shows Markdown as a preview beside the editor — the source where the preview is not there. */
    async function showPage(name, markdown) {
        const uri = vscode.Uri.from({ scheme: Scheme, path: `/${name}.md` });
        pages.set(uri.toString(), markdown);
        changed.fire(uri);
        try {
            await vscode.commands.executeCommand("markdown.showPreviewToSide", uri);
        } catch {
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        }
    }

    /**
     * Calls the toolchain and waits for it, under a progress notification. What it prints goes to
     * the output channel; a failure is said with the toolchain's first line about it.
     */
    function call(title, args, cwd) {
        output.appendLine(`> ${toolchain.executable()} ${args.join(" ")}${cwd ? `   (in ${cwd})` : ""}`);
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Lyric: ${title}` }, () =>
            new Promise((resolve) => {
                childProcess.execFile(toolchain.executable(), args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
                    (error, stdout, stderr) => {
                        if (stdout) {
                            output.append(stdout);
                        }
                        if (stderr) {
                            output.append(stderr);
                        }
                        if (error) {
                            const said = (stderr || stdout || "").split(/\r?\n/).find((line) => line.trim().length > 0)
                                ?? (error.code === "ENOENT" ? `${toolchain.executable()} was not found` : error.message);
                            vscode.window.showErrorMessage(`Lyric: ${title} failed — ${said}`, "Show Output").then((choice) => {
                                if (choice) {
                                    output.show(true);
                                }
                            });
                        }
                        resolve({ ok: !error, stdout: stdout ?? "" });
                    });
            }));
    }

    /**
     * The package a command is about: the active file's, else the one package of the workspace,
     * else the one chosen from them.
     */
    async function choosePackage() {
        const active = vscode.window.activeTextEditor;
        if (active && active.document.languageId === "lyric") {
            const own = toolchain.activePackage();
            if (own?.file) {
                return own.root;
            }
        }
        const manifests = await vscode.workspace.findFiles("**/lyric.toml", "**/{out,node_modules,.git}/**");
        const roots = manifests.map((manifest) => path.dirname(manifest.fsPath)).sort();
        if (roots.length === 0) {
            vscode.window.showErrorMessage("Lyric: no package is open — a lyric.toml in the workspace, or a file of one.");
            return undefined;
        }
        if (roots.length === 1) {
            return roots[0];
        }
        const picked = await vscode.window.showQuickPick(
            roots.map((root) => ({ label: path.basename(root), description: vscode.workspace.asRelativePath(root), root })),
            { placeHolder: "The package" }
        );
        return picked?.root;
    }

    /** Asks whether the package is a program or a library: `--lib` or nothing. */
    async function chooseKind() {
        const picked = await vscode.window.showQuickPick([
            { label: "Program", description: "src/main.lyr", args: [] },
            { label: "Library", description: "src/lib.lyr", args: ["--lib"] },
        ], { placeHolder: "What the package is" });
        return picked?.args;
    }

    /** `lyric new <name>`: a directory and a package in it, then opened where the person says. */
    async function newPackage() {
        const parents = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
            openLabel: "Create the package here",
        });
        if (!parents || parents.length === 0) {
            return;
        }
        const name = await vscode.window.showInputBox({
            prompt: "The package's name — its directory is named so",
            placeHolder: "my_app",
        });
        if (!name) {
            return;
        }
        const kind = await chooseKind();
        if (!kind) {
            return;
        }
        const parent = parents[0].fsPath;
        const result = await call(`new ${name}`, ["new", name, ...kind], parent);
        if (!result.ok) {
            return;
        }
        const dir = vscode.Uri.file(path.join(parent, name));
        const choice = await vscode.window.showInformationMessage(
            `Lyric: ${result.stdout.trim() || `created ${name}`}`, "Open", "Add to Workspace");
        if (choice === "Open") {
            await vscode.commands.executeCommand("vscode.openFolder", dir);
        } else if (choice === "Add to Workspace") {
            vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: dir });
        }
    }

    /** `lyric init`: a package in a folder that is there, named after it. */
    async function initPackage() {
        const candidates = (vscode.workspace.workspaceFolders ?? [])
            .filter((folder) => !fs.existsSync(path.join(folder.uri.fsPath, "lyric.toml")));
        let dir;
        if (candidates.length === 1) {
            dir = candidates[0].uri.fsPath;
        } else if (candidates.length > 1) {
            dir = (await vscode.window.showWorkspaceFolderPick({ placeHolder: "The folder to make a package of" }))?.uri.fsPath;
        } else {
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                openLabel: "Make a package here",
            });
            dir = picked?.[0]?.fsPath;
        }
        if (!dir) {
            return;
        }
        const kind = await chooseKind();
        if (!kind) {
            return;
        }
        const result = await call("init", ["init", ...kind], dir);
        if (result.ok) {
            vscode.window.showInformationMessage(`Lyric: ${result.stdout.trim() || "the package is made"}`);
        }
    }

    /** `lyric add <name>` with `--path`, or `--git` and at most one of `--tag`, `--branch`, `--rev`. */
    async function addDependency() {
        const root = await choosePackage();
        if (!root) {
            return;
        }
        const source = await vscode.window.showQuickPick([
            { label: "Directory", description: "--path: a package on this machine", value: "path" },
            { label: "Git repository", description: "--git: a package read from git", value: "git" },
        ], { placeHolder: "Where the dependency is read from" });
        if (!source) {
            return;
        }

        const where = [];
        let suggested = "";
        if (source.value === "path") {
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                defaultUri: vscode.Uri.file(path.dirname(root)),
                openLabel: "The dependency's directory",
            });
            if (!picked || picked.length === 0) {
                return;
            }
            where.push("--path", picked[0].fsPath);
            suggested = path.basename(picked[0].fsPath);
        } else {
            const url = await vscode.window.showInputBox({ prompt: "The repository's URL", placeHolder: "https://github.com/owner/geo.git" });
            if (!url) {
                return;
            }
            where.push("--git", url);
            suggested = path.basename(url.replace(/\/+$/, "")).replace(/\.git$/, "");
            const revision = await vscode.window.showQuickPick([
                { label: "Default branch", value: null },
                { label: "Tag", value: "--tag" },
                { label: "Branch", value: "--branch" },
                { label: "Commit", value: "--rev" },
            ], { placeHolder: "Which revision" });
            if (!revision) {
                return;
            }
            if (revision.value !== null) {
                const value = await vscode.window.showInputBox({ prompt: `The ${revision.label.toLowerCase()}` });
                if (!value) {
                    return;
                }
                where.push(revision.value, value);
            }
        }

        const name = await vscode.window.showInputBox({
            prompt: "The dependency's name in [dependencies]",
            value: suggested,
        });
        if (!name) {
            return;
        }
        const result = await call(`add ${name}`, ["add", name, ...where], root);
        if (result.ok) {
            vscode.window.showInformationMessage(`Lyric: ${result.stdout.trim() || `added ${name}`}`);
        }
    }

    /** The package's own entry in what `lyric metadata` says of its graph. */
    async function ownEntry(root) {
        const metadata = await toolchain.readMetadata(root);
        return {
            metadata,
            own: metadata?.packages?.find((pkg) => pkg.path && toolchain.samePath(pkg.path, root)),
        };
    }

    /** `lyric remove <name>`, of the dependencies `lyric metadata` names. */
    async function removeDependency() {
        const root = await choosePackage();
        if (!root) {
            return;
        }
        const { own } = await ownEntry(root);
        const names = own?.dependencies ?? [];
        let name;
        if (names.length > 0) {
            name = await vscode.window.showQuickPick(names, { placeHolder: "The dependency to remove" });
        } else {
            name = await vscode.window.showInputBox({ prompt: "The dependency to remove" });
        }
        if (!name) {
            return;
        }
        const result = await call(`remove ${name}`, ["remove", name], root);
        if (result.ok) {
            vscode.window.showInformationMessage(`Lyric: ${result.stdout.trim() || `removed ${name}`}`);
        }
    }

    /** `lyric update`: the packages read from git, all or those chosen. */
    async function updateDependencies() {
        const root = await choosePackage();
        if (!root) {
            return;
        }
        const { metadata } = await ownEntry(root);
        const fromGit = (metadata?.packages ?? []).filter((pkg) => pkg.git);
        let names = [];
        if (fromGit.length > 1) {
            const picked = await vscode.window.showQuickPick(
                fromGit.map((pkg) => ({ label: pkg.name, description: pkg.git.url ?? String(pkg.git) })),
                { canPickMany: true, placeHolder: "The packages to read anew — none chosen is all of them" }
            );
            if (!picked) {
                return;
            }
            names = picked.map((item) => item.label);
        }
        const result = await call("update", ["update", ...names], root);
        if (result.ok) {
            vscode.window.showInformationMessage(`Lyric: ${result.stdout.trim().split(/\r?\n/).pop() || "the packages are read anew"}`);
        }
    }

    /** The codes of the findings at the cursor that the toolchain's catalog explains. */
    function codesAtCursor() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return [];
        }
        const position = editor.selection.active;
        return vscode.languages.getDiagnostics(editor.document.uri)
            .filter((diagnostic) => diagnostic.source === "lyric" && diagnostic.range.contains(position))
            .map((diagnostic) => typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code)
            .filter((code) => typeof code === "string" && code.length > 0);
    }

    /**
     * `lyric explain <code>`: what a code or a lint means, with a wrong and a right program, shown
     * beside the editor — the catalog of the toolchain that is installed, offline.
     */
    async function explain(code) {
        if (typeof code !== "string" || code.length === 0) {
            const here = [...new Set(codesAtCursor())];
            if (here.length === 1) {
                code = here[0];
            } else if (here.length > 1) {
                code = await vscode.window.showQuickPick(here, { placeHolder: "The finding to explain" });
            } else {
                code = await vscode.window.showInputBox({ prompt: "A diagnostic code or a lint", placeHolder: "LYR-CLI0003" });
            }
        }
        if (!code) {
            return;
        }
        const result = await call(`explain ${code}`, ["explain", code.trim()]);
        if (!result.ok) {
            return;
        }
        // The first line names the code and what it is about: the page's heading.
        const text = result.stdout.replace(/\r\n/g, "\n");
        await showPage(`explain-${code.trim()}`, text.replace(/^([^\n]*)/, "# $1\n"));
    }

    /**
     * `lyric env --json`: every setting a build of the package reads, its value and where it comes
     * from, with the profile `lyric.run.profile` names.
     */
    async function showEnvironment() {
        const root = await choosePackage();
        if (!root) {
            return;
        }
        const result = await call("env", ["env", "--json", ...toolchain.profileArgs(root)], root);
        if (!result.ok) {
            return;
        }
        let document;
        try {
            document = JSON.parse(result.stdout);
        } catch {
            vscode.window.showErrorMessage("Lyric: env said something other than its JSON document.");
            return;
        }
        const rows = (document.settings ?? []).map((setting) =>
            `| ${cell(setting.name)} | \`${cell(setting.value)}\` | ${cell(setting.origin)} |`);
        await showPage(`env-${path.basename(root)}`, [
            `# The environment of ${path.basename(root)}`,
            "",
            "What a build of the package here reads, and where each setting comes from: the command line is over the environment, the environment over `lyric.toml`, that over the default.",
            "",
            "| Setting | Value | From |",
            "|---|---|---|",
            ...rows,
            "",
        ].join("\n"));
    }

    /** `lyric doc`: the package's reference under out/doc/, opened in the browser. */
    async function buildDocumentation() {
        const root = await choosePackage();
        if (!root) {
            return;
        }
        const result = await call("doc", ["doc"], root);
        if (!result.ok) {
            return;
        }
        const index = path.join(root, "out", "doc", "index.html");
        const choice = await vscode.window.showInformationMessage(`Lyric: ${result.stdout.trim().split(/\r?\n/).pop()}`, "Open in Browser");
        if (choice && fs.existsSync(index)) {
            await vscode.env.openExternal(vscode.Uri.file(index));
        }
    }

    /**
     * `lyric api --diff <rev>` as a task: the breaking changes against a revision of the package's
     * repository, then the compatible ones — the toolchain's report, in the terminal.
     */
    async function checkApi() {
        const root = await choosePackage();
        if (!root) {
            return;
        }
        const revision = await vscode.window.showInputBox({
            prompt: "The git revision to compare the public surface with",
            placeHolder: "a tag, a branch or a commit — v1.2.0",
        });
        if (!revision) {
            return;
        }
        const task = new vscode.Task(
            { type: "lyric", projectDir: root },
            vscode.TaskScope.Workspace,
            `api --diff ${revision}`,
            "lyric",
            new vscode.ShellExecution(toolchain.executable(), ["api", "--diff", revision], { cwd: root }),
            []
        );
        return vscode.tasks.executeTask(task);
    }

    /** `lyric clean`: the package's out/ removed. */
    async function clean() {
        const root = await choosePackage();
        if (!root) {
            return;
        }
        const result = await call("clean", ["clean"], root);
        if (result.ok) {
            vscode.window.showInformationMessage(`Lyric: ${result.stdout.trim() || "out/ is removed"}`);
        }
    }

    /** A finding the catalog has a page for offers its explanation, beside its quick fixes. */
    const explainActions = {
        provideCodeActions(document, _range, actionContext) {
            const actions = [];
            for (const diagnostic of actionContext.diagnostics) {
                if (diagnostic.source !== "lyric" || typeof diagnostic.code !== "object" || !diagnostic.code.target) {
                    continue;
                }
                const code = String(diagnostic.code.value);
                const action = new vscode.CodeAction(`Explain ${code}`, vscode.CodeActionKind.QuickFix);
                action.command = { command: "lyric.explain", title: `Explain ${code}`, arguments: [code] };
                action.diagnostics = [diagnostic];
                actions.push(action);
            }
            return actions;
        },
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("lyric.newPackage", newPackage),
        vscode.commands.registerCommand("lyric.initPackage", initPackage),
        vscode.commands.registerCommand("lyric.addDependency", addDependency),
        vscode.commands.registerCommand("lyric.removeDependency", removeDependency),
        vscode.commands.registerCommand("lyric.updateDependencies", updateDependencies),
        vscode.commands.registerCommand("lyric.explain", explain),
        vscode.commands.registerCommand("lyric.showEnvironment", showEnvironment),
        vscode.commands.registerCommand("lyric.buildDocumentation", buildDocumentation),
        vscode.commands.registerCommand("lyric.checkApi", checkApi),
        vscode.commands.registerCommand("lyric.clean", clean),
        vscode.languages.registerCodeActionsProvider({ language: "lyric" }, explainActions, {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
        })
    );
}

module.exports = { createCommands };
