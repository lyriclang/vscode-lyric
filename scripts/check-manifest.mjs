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

// The run command calls the driver and not a tool: the driver is the one command that compiles
// AND runs. Were the extension to call 'lyrc', the user would get a .lyrbc rather than a run;
// were it to call 'lyrvm', it would fail on a source file.
// The CALL LINE is checked rather than the file: comments beside it name the tools explicitly to
// explain why they are not it, and a check scanning the whole file trips over the explanation.
const code = readFileSync(join(root, "extension.js"), "utf8");
const callLines = code.split("\n").filter(line => line.includes("sendText"));
check(callLines.length === 1, "exactly one line is expected to call sendText");
const call = callLines[0] ?? "";
check(call.includes(" run "), "the call line does not run the file");
check(!call.includes("lyrc"), "the call line names 'lyrc' — the driver is the one to call");
check(!call.includes("lyrvm"), "the call line names 'lyrvm' — the driver is the one to call");

// The command is QUOTED and called with an '&' in PowerShell — both together, because each alone
// is broken. Without the quoting 'C:\Program Files\lyric\lyric.exe' fails at 'C:\Program';
// without the '&', '"lyric" run x' is a string literal in PowerShell that gets printed rather
// than executed, so the run simply did not happen.
check(call.includes("quote(executable)"), "the executable is not quoted on the call line");
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

if (failures > 0) process.exit(1);
console.log("manifest checks passed");
