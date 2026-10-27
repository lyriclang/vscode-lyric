// The Test Explorer.
//
// The server says which tests a file holds (`lyric/tests`: the package's directory and each test's
// name, kind and line); `lyric test --json` runs them and says how each ended. Nothing about tests
// is worked out here: a test is what the server names, and its outcome is what the toolchain says.

const childProcess = require("child_process");
const path = require("path");
const vscode = require("vscode");

/** How long the files must be quiet before the tests are asked for again. */
const RefreshDelayMs = 1000;

/** The longest text every name starts with: the one `-f` that runs them all and few others. */
function commonPrefix(names) {
    if (names.length === 0) {
        return "";
    }
    let prefix = names[0];
    for (const name of names) {
        while (!name.startsWith(prefix)) {
            prefix = prefix.slice(0, -1);
        }
    }
    return prefix;
}

/** A test's label: a function by its own name, a documentation block by the name it is run as. */
function labelOf(test) {
    return test.kind === "test" ? test.name.slice(test.name.lastIndexOf(".") + 1) : test.name;
}

/**
 * Sets up the test controller.
 *
 * `toolchain` is what the extension shares with it: `executable()`, `profileArgs(dir)`, `client()`,
 * the running language client or null, `saveLyricBuffers()` and `debugTest(root, filter)`.
 */
function createTesting(context, toolchain) {
    const controller = vscode.tests.createTestController("lyric", "Lyric");
    context.subscriptions.push(controller);

    /** What each test item stands for: the package's directory and the test's name. */
    const tests = new WeakMap();

    /** The package's directory of each package item. */
    const packages = new WeakMap();

    let refreshTimer = null;
    let refreshing = Promise.resolve();

    /**
     * Asks the server for the tests of every Lyric file of every package in the workspace.
     *
     * The server answers for a file once it has analysed the package, which an open file of it
     * starts; before that a package shows no tests rather than wrong ones.
     */
    async function discover() {
        const client = toolchain.client();
        if (client === null) {
            return;
        }

        const manifests = await vscode.workspace.findFiles("**/lyric.toml", "**/{out,node_modules,.git}/**");
        const found = [];
        for (const manifest of manifests) {
            const root = path.dirname(manifest.fsPath);
            const sources = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "{src,tests}/**/*.lyr"));
            sources.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

            const files = [];
            for (const source of sources) {
                let answer;
                try {
                    answer = await client.sendRequest("lyric/tests", { textDocument: { uri: source.toString() } });
                } catch {
                    // A server going down mid-way leaves the explorer as it was.
                    return;
                }
                if (answer?.root && answer.tests.length > 0) {
                    files.push({ uri: source, root: answer.root, tests: answer.tests });
                }
            }
            if (files.length > 0) {
                found.push({ root, files });
            }
        }

        const items = [];
        for (const { root, files } of found) {
            const pkg = controller.createTestItem(`package:${root}`, path.basename(root), vscode.Uri.file(root));
            packages.set(pkg, root);
            for (const file of files) {
                const label = path.relative(root, file.uri.fsPath).replace(/\\/g, "/");
                const fileItem = controller.createTestItem(`file:${file.uri.fsPath}`, label, file.uri);
                for (const test of file.tests) {
                    const item = controller.createTestItem(`test:${file.root}\n${test.name}`, labelOf(test), file.uri);
                    item.range = new vscode.Range(test.range.start.line, 0, test.range.start.line, 0);
                    tests.set(item, { root: file.root, name: test.name });
                    fileItem.children.add(item);
                }
                pkg.children.add(fileItem);
            }
            items.push(pkg);
        }
        controller.items.replace(items);
    }

    /** Queues one discovery behind the one that may be running. */
    function refresh() {
        refreshing = refreshing.then(discover, discover);
        return refreshing;
    }

    function scheduleRefresh() {
        if (refreshTimer !== null) {
            clearTimeout(refreshTimer);
        }
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            refresh();
        }, RefreshDelayMs);
    }

    controller.refreshHandler = () => refresh();

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.languageId === "lyric") {
                scheduleRefresh();
            }
        }),
        vscode.workspace.onDidOpenTextDocument((document) => {
            if (document.languageId === "lyric") {
                scheduleRefresh();
            }
        }),
        { dispose: () => refreshTimer !== null && clearTimeout(refreshTimer) }
    );

    /** Every test under the items asked for, minus those excluded, by package. */
    function collect(request) {
        const excluded = new Set(request.exclude ?? []);
        const byRoot = new Map();
        const visit = (item) => {
            if (excluded.has(item)) {
                return;
            }
            const test = tests.get(item);
            if (test) {
                if (!byRoot.has(test.root)) {
                    byRoot.set(test.root, []);
                }
                byRoot.get(test.root).push(item);
                return;
            }
            item.children.forEach(visit);
        };
        if (request.include) {
            request.include.forEach(visit);
        } else {
            controller.items.forEach(visit);
        }
        return byRoot;
    }

    /** The item of a test the run names, where the explorer shows it. */
    function itemOf(items, name) {
        return items.find((item) => tests.get(item).name === name);
    }

    /**
     * One `lyric test --json` in the package's directory, its lines read as they come.
     *
     * A whole package runs without a filter; a part of it with the longest text its names share —
     * `-f` takes the tests whose names hold it, so a test outside the part may run too. Its outcome
     * is reported like the others': it is true.
     */
    function runPackage(run, root, items, all, token) {
        return new Promise((resolve) => {
            const args = ["test", "--json", ...toolchain.profileArgs(root)];
            const filter = all ? "" : commonPrefix(items.map((item) => tests.get(item).name));
            if (filter.length > 0) {
                args.push("-f", filter);
            }

            const known = [];
            controller.items.forEach((pkg) => pkg.children.forEach((file) => file.children.forEach((item) => {
                if (tests.get(item)?.root === root) {
                    known.push(item);
                }
            })));

            let reported = 0;
            let errors = 0;
            let pending = "";
            const child = childProcess.spawn(toolchain.executable(), args, { cwd: root });

            const line = (text) => {
                if (text.trim().length === 0) {
                    return;
                }
                let event;
                try {
                    event = JSON.parse(text);
                } catch {
                    run.appendOutput(`${text}\r\n`);
                    return;
                }
                switch (event.type) {
                    case "test": {
                        reported += 1;
                        const item = itemOf(known, event.name);
                        if (event.message) {
                            run.appendOutput(`${event.name}: ${event.message.replace(/\r?\n/g, "\r\n")}\r\n`, undefined, item);
                        }
                        if (!item) {
                            break;
                        }
                        if (event.outcome === "passed") {
                            run.passed(item);
                        } else if (event.outcome === "skipped") {
                            run.skipped(item);
                        } else {
                            const message = new vscode.TestMessage(event.message ?? "failed");
                            message.location = new vscode.Location(item.uri, item.range);
                            run.failed(item, message);
                        }
                        break;
                    }
                    case "diagnostic":
                        if (event.severity === "error") {
                            errors += 1;
                        }
                        run.appendOutput(`${(event.rendered ?? event.message).replace(/\r?\n/g, "\r\n")}\r\n`);
                        break;
                    case "output":
                        run.appendOutput(`${event.text}\r\n`);
                        break;
                    case "ice":
                        errors += 1;
                        run.appendOutput(`${event.code}: ${event.message}\r\n`);
                        break;
                    default:
                        // 'tests' and 'summary' count what was already reported; a type this
                        // client does not know is skipped, as the schema asks.
                        break;
                }
            };

            child.stdout.on("data", (chunk) => {
                pending += chunk.toString();
                const lines = pending.split(/\r?\n/);
                pending = lines.pop();
                lines.forEach(line);
            });
            child.stderr.on("data", (chunk) => run.appendOutput(chunk.toString().replace(/\r?\n/g, "\r\n")));

            const cancel = token.onCancellationRequested(() => child.kill());
            let finished = false;
            const finish = (failure) => {
                // A process that could not start reports 'error' and may report 'close' after it.
                if (finished) {
                    return;
                }
                finished = true;
                cancel.dispose();
                line(pending);
                // Nothing ran: the tests did not build, or the toolchain did not start.
                if (reported === 0 && (errors > 0 || failure)) {
                    const said = failure ?? "the tests did not build: the output says why";
                    for (const item of items) {
                        run.errored(item, new vscode.TestMessage(said));
                    }
                }
                resolve();
            };
            child.on("error", (error) => finish(`${toolchain.executable()} could not be started: ${error.message}`));
            child.on("close", () => finish(undefined));
        });
    }

    async function runHandler(request, token) {
        await toolchain.saveLyricBuffers();
        const run = controller.createTestRun(request);
        const wholePackages = new Set();
        for (const item of request.include ?? []) {
            if (packages.has(item)) {
                wholePackages.add(packages.get(item));
            }
        }

        for (const [root, items] of collect(request)) {
            if (token.isCancellationRequested) {
                break;
            }
            items.forEach((item) => run.started(item));
            const all = !request.include || (wholePackages.has(root) && (request.exclude ?? []).length === 0);
            await runPackage(run, root, items, all, token);
        }
        run.end();
    }

    /**
     * Debugging is `lyric dap` with `test` in the launch: the tests whose names hold the text, one
     * session for each package asked for. The debugger says nothing of outcomes; the run ends with
     * the session.
     */
    async function debugHandler(request, token) {
        const run = controller.createTestRun(request, undefined, false);
        for (const [root, items] of collect(request)) {
            if (token.isCancellationRequested) {
                break;
            }
            items.forEach((item) => run.started(item));
            const filter = commonPrefix(items.map((item) => tests.get(item).name));
            const started = await toolchain.debugTest(root, filter);
            if (!started) {
                continue;
            }
            await new Promise((resolve) => {
                const ended = vscode.debug.onDidTerminateDebugSession((session) => {
                    if (session.configuration.program !== root || session.configuration.test !== filter) {
                        return;
                    }
                    ended.dispose();
                    resolve();
                });
                token.onCancellationRequested(() => vscode.debug.stopDebugging());
            });
        }
        run.end();
    }

    controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, runHandler, true);
    controller.createRunProfile("Debug", vscode.TestRunProfileKind.Debug, debugHandler, true);

    return { refresh, scheduleRefresh };
}

module.exports = { createTesting, commonPrefix };
