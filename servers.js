// The language servers of the Lyric family, one per language: `lyric lsp` for Lyric 5's `.lyr`
// files and — with Lyric-Script's S12 — `lyric-script lsp` for `.lyrs` (Lyric-Script design 12,
// Ed: one extension, two servers by file extension). Each server is a process of its own with a
// status item of its own, started, restarted and stopped one after another; one that fails leaves
// the other running.

const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

/**
 * How long the settings must be quiet before a server is restarted.
 *
 * The settings UI fires a change PER KEYSTROKE, so typing a path is a dozen of them. Restarting on
 * each one spawns and kills a process per character, and every one of those kills lands on an
 * unanswered handshake.
 */
const RestartDelayMs = 750;

/**
 * One language's server.
 *
 * `spec` says which:
 * - `id`: the client's id, so it reads `<id>.trace.server` by itself and follows its changes
 *   without a restart;
 * - `language`: the language id of the buffers it serves;
 * - `title`: what its status item and its messages call it;
 * - `command()`: the toolchain binary, started as `<command> lsp --stdio`;
 * - `enabled()` and `enableSetting`: whether it runs, and the setting that says so;
 * - `settings`: the settings whose change restarts it;
 * - `restartCommand`: the command its status item runs;
 * - `middleware` and `started(client, version)`: what the extension adds to it.
 */
function createServer(context, spec) {
    /** The running language client, or null when it is off or did not start. */
    let client = null;

    /**
     * The one visible answer to "is the server running". Without it a failed start is a warning
     * toast that disappears, and the user reads the silence as "no diagnostics today" with no way
     * to tell why or to retry. Clicking it restarts.
     */
    const statusItem = vscode.languages.createLanguageStatusItem(`${spec.id}.server`, {
        language: spec.language,
    });
    statusItem.command = { command: spec.restartCommand, title: "Restart" };
    context.subscriptions.push(statusItem);

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

    function showStatus(state, detail) {
        statusItem.busy = state === "starting";
        statusItem.severity = state === "failed"
            ? vscode.LanguageStatusSeverity.Error
            : vscode.LanguageStatusSeverity.Information;

        switch (state) {
            case "starting":
                statusItem.text = `${spec.title}: starting`;
                statusItem.detail = "the language server is coming up";
                break;
            case "running":
                statusItem.text = detail ? `${spec.title} ${detail}` : spec.title;
                statusItem.detail = "language server running";
                break;
            case "failed":
                statusItem.text = `${spec.title}: server failed`;
                statusItem.detail = "diagnostics are off; click to retry";
                break;
            case "off":
                statusItem.text = `${spec.title}: diagnostics off`;
                statusItem.detail = `enable ${spec.enableSetting} to start the server`;
                break;
        }
    }

    /**
     * Starts the server and connects it to every buffer of its language.
     *
     * `stdio` is the transport: the server owns those two streams for its whole lifetime, which is
     * also why nothing in it may print. A failure to start is reported once, through the client's
     * own output channel, rather than as a modal — an editor that cannot find a toolchain should
     * still be usable for reading code.
     */
    async function start() {
        const command = spec.command();

        const server = {
            run: { command, args: ["lsp", "--stdio"], transport: TransportKind.stdio },
            debug: { command, args: ["lsp", "--stdio"], transport: TransportKind.stdio },
        };

        const options = {
            documentSelector: [{ scheme: "file", language: spec.language }],
            outputChannelName: `${spec.title} Language Server`,
            middleware: spec.middleware,
        };

        const starting = new LanguageClient(spec.id, `${spec.title} Language Server`, server, options);
        client = starting;
        showStatus("starting");

        // Awaited rather than left running: the caller is the restart chain, and it may only proceed
        // to the next stop once this handshake is finished.
        try {
            await starting.start();
            const version = starting.initializeResult?.serverInfo?.version;
            showStatus("running", version);
            spec.started?.(starting, version);
        } catch (error) {
            if (client === starting) {
                client = null;
            }
            showStatus("failed");
            vscode.window.showWarningMessage(
                `${spec.title}: the language server could not be started (${command} lsp --stdio). ` +
                `Diagnostics are off; highlighting and Ctrl+F5 still work. ${error.message}`
            );
        }
    }

    async function stop() {
        const stopping = client;
        client = null;
        if (stopping === null) {
            return;
        }

        try {
            await stopping.stop();
        } catch {
            // A client that never reached the running state rejects instead of stopping. Disposing
            // it releases the process either way, and a failure to shut down cleanly must not block
            // the restart that follows.
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
            await stop();
            if (spec.enabled()) {
                await start();
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

    // A changed path or a toggled switch has to reach a process that was started with the old one.
    // Restarting is the whole of it: the server holds no state that survives its own exit.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (spec.settings.some((setting) => event.affectsConfiguration(setting))) {
                scheduleRestart();
            }
        })
    );

    return {
        client: () => client,
        restart,

        /**
         * Stops the server for good. Behind the chain rather than beside it: a restart may still be
         * starting a client, and stopping one mid-handshake is the very thing the chain exists to
         * prevent.
         */
        shutdown() {
            if (restartTimer !== null) {
                clearTimeout(restartTimer);
                restartTimer = null;
            }
            return restarts.then(stop);
        },
    };
}

module.exports = { createServer };
