// The VS Code manifest against what lies next to it.
//
// An extension manifest is a collection of paths and identifiers pointing at other files, and VS
// Code checks none of it while loading: a wrong path simply means the colouring is missing. That
// is the same kind of silent fault as documentation nobody re-reads, and these checks are the
// same answer to it.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const contributes = manifest.contributes;

let failures = 0;
const check = (ok, message) => {
    if (!ok) {
        console.error(`FAIL: ${message}`);
        failures += 1;
    }
};

// Every path in the manifest exists. The most common fault in an extension manifest, and the
// quietest: VS Code loads the extension anyway, it just colours nothing.
const paths = [
    manifest.main,
    ...contributes.languages.map(l => l.configuration),
    ...contributes.grammars.map(g => g.path),
    ...contributes.snippets.map(s => s.path),
];
for (const p of paths) {
    check(existsSync(join(root, p)), `the manifest points at '${p}', which does not exist`);
}

// Two places name the same identifier: the manifest wires language and grammar together through
// 'scopeName'. If they differ, nothing is coloured at all, without a message.
check(contributes.grammars.length === 1, "exactly one grammar is expected");
const contributed = contributes.grammars[0];
const grammar = JSON.parse(
    readFileSync(join(root, "syntaxes", "lyric.tmLanguage.json"), "utf8"));
check(grammar.scopeName === contributed.scopeName,
    `the grammar's scopeName '${grammar.scopeName}' differs from the contributed '${contributed.scopeName}'`);
check(contributed.language === "lyric", "the grammar is not wired to the 'lyric' language");

// The extension claims the file extension the language uses.
check(contributes.languages.length === 1, "exactly one language is expected");
check(contributes.languages[0].extensions.includes(".lyr"),
    "the language does not claim '.lyr'");

// A key binding or menu entry pointing at a command that does not exist is a menu item that does
// nothing.
const declared = new Set(contributes.commands.map(c => c.command));
const mustBeDeclared = entry => {
    check(typeof entry.command === "string" && declared.has(entry.command),
        `'${entry.command}' is not a declared command`);
};
for (const binding of contributes.keybindings) mustBeDeclared(binding);
for (const items of Object.values(contributes.menus)) {
    for (const item of items) mustBeDeclared(item);
}

// The run command calls the toolchain's 'run'. The CALL LINE is checked rather than the file: a
// check scanning the whole file trips over the comments that explain it.
const code = readFileSync(join(root, "extension.js"), "utf8");
const callLines = code.split("\n").filter(line => line.includes("sendText"));
check(callLines.length === 1, "exactly one line is expected to call sendText");
const call = callLines[0] ?? "";
check(call.includes(" run "), "the call line does not run the file");

// The command is QUOTED and called with an '&' in PowerShell — both together, because each alone
// is broken. Without the quoting 'C:\Program Files\lyric\lyric.exe' fails at 'C:\Program';
// without the '&', '"lyric" run x' is a string literal in PowerShell that gets printed rather
// than executed, so the run simply did not happen.
check(call.includes("quote(executable())"), "the executable is not quoted on the call line");
check(call.includes("callPrefix()"), "the call line lost the PowerShell call operator");

// And the '&' applies to PowerShell only: in cmd.exe and every POSIX shell it would be a syntax
// error.
check(code.includes("vscode.env.shell"), "the shell is not inspected");
check(code.includes("pwsh"), "'pwsh' is not recognised as PowerShell");
check(code.includes("powershell"), "'powershell' is not recognised as PowerShell");

// The compiler reads from disk rather than from the editor buffer. Without the save the previous
// version runs, and the user looks for the fault in their program rather than in their editor.
check(code.includes("isDirty"), "the run command does not look at isDirty");
check(code.includes("save()"), "the run command does not save the buffer");

// One binary is the toolchain: the server is 'lyric lsp', the debugger 'lyric dap'. Lyric 4's
// separate tools are gone, and a client starting one of them starts nothing.
check(code.includes('args: ["lsp", "--stdio"]'), "the language server is not started as 'lyric lsp --stdio'");
check(code.includes('DebugAdapterExecutable(executable(), ["dap"]'), "the debugger is not started as 'lyric dap'");
for (const gone of ["lyrls", "lyrdbg"]) {
    check(!code.includes(gone), `the extension still names '${gone}'`);
}

// Lyric 4's settings for those tools stay declared, deprecated, so that a settings file holding one
// says why it does nothing. The code names them in the one list that announces them — reading one
// anywhere else would bring the separate binary back.
const settings = contributes.configuration.properties;
const retiredLines = code.split("\n").filter(line => line.includes("lyric.languageServer") || line.includes("lyric.debugAdapter"));
check(retiredLines.length === 1 && retiredLines[0].includes("const RetiredSettings"),
    "the retired settings are named outside RetiredSettings");
for (const retired of ["lyric.languageServer", "lyric.debugAdapter"]) {
    check(typeof settings[retired]?.markdownDeprecationMessage === "string",
        `'${retired}' is not declared deprecated`);
}

// Every setting the code reads is declared, or it is a setting nobody can find in the UI. The
// client reads `lyric.trace.server` by itself, through its id.
for (const [, key] of code.matchAll(/\.get\("([a-zA-Z.]+)"/g)) {
    check(`lyric.${key}` in settings, `the code reads 'lyric.${key}', which package.json does not declare`);
}
check(code.includes('new LanguageClient("lyric"'), "the client's id is not 'lyric', so it does not read lyric.trace.server");
check("lyric.trace.server" in settings, "'lyric.trace.server' is not declared");

// Both requests go to the one adapter: a launch builds what it names, an attach is lldb's.
check(contributes.debuggers.length === 1, "exactly one debugger is expected");
const attributes = contributes.debuggers[0].configurationAttributes;
for (const request of ["launch", "attach"]) {
    check(request in attributes, `the debugger declares no '${request}' configuration`);
}
check("test" in (attributes.launch?.properties ?? {}), "a launch cannot name a test, which the Debug lens needs");

// The server's lenses name commands the client runs: each must be registered here, or the lens
// is a button that does nothing.
for (const command of ["lyric.runTest", "lyric.debugTest"]) {
    check(declared.has(command), `'${command}' is not a declared command`);
    check(code.includes(`registerCommand("${command}"`), `'${command}' is not registered`);
}
// 'lyric.expand' is the server's, registered by the language client from its capabilities: one
// registered here too would collide with it.
check(!code.includes('registerCommand("lyric.expand"'), "'lyric.expand' is the server's command, not the client's");

// Every command the palette shows is registered, or it is an entry that does nothing.
for (const command of declared) {
    check(code.includes(`registerCommand("${command}"`), `'${command}' is declared but not registered`);
}

// Every verb a tasks.json may name is one the task provider knows: a name it does not know
// resolves to no task, silently.
const taskVerbs = contributes.taskDefinitions[0].properties.command?.enum ?? [];
check(taskVerbs.length > 0, "the task definition names no verbs");
for (const verb of taskVerbs) {
    check(code.includes(`"${verb}": {`), `the task verb '${verb}' has no entry in TaskVerbs`);
}

// The Test Explorer is a file of its own: it must exist, be what the extension loads, and ask
// the server by the request the server answers.
const testingPath = join(root, "testing.js");
check(existsSync(testingPath), "testing.js is missing");
check(code.includes('require("./testing")'), "the extension does not load testing.js");
const testing = existsSync(testingPath) ? readFileSync(testingPath, "utf8") : "";
check(testing.includes('"lyric/tests"'), "the Test Explorer does not ask the server for 'lyric/tests'");
check(testing.includes('"test", "--json"'), "the Test Explorer does not run 'lyric test --json'");

if (failures > 0) process.exit(1);
console.log("manifest checks passed");
