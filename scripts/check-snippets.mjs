// The snippets against the toolchain: node scripts/check-snippets.mjs <lyric> [<argument>...]
//
// A snippet is Lyric the editor writes for the user, and nothing loads it until someone types its
// prefix — the 'for' snippet once wrote 'for item in items {', which never parsed. Here each one,
// its placeholders filled with their defaults, is put where it belongs — a declaration at the top
// of a file, anything else in the body of 'main', beside the names it presumes — and the
// toolchain's 'check' must take every file without an error.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// the toolchain, and what it is called with before the verb: a wrapper may stand in for it
const [lyric, ...before] = process.argv.slice(2);
if (!lyric) {
    console.error("usage: node scripts/check-snippets.mjs <lyric> [<argument>...]");
    process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snippets = JSON.parse(readFileSync(join(root, "snippets", "lyric.json"), "utf8"));

/** The snippet as typed and left alone: every placeholder its default, every tab stop empty. */
const filled = body => body.join("\n")
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    .replace(/\$\{\d+\}/g, "")
    .replace(/\$\d+/g, "");

/** What a snippet's defaults name, given a meaning so that 'check' judges the snippet alone. */
const Declared = "struct Type {\n}\n";
const Bound = "    let value = 0;\n    let items = [1, 2];\n    let condition = false;\n";

// a directory with no lyric.toml above it: each file is a script of its own
const scratch = mkdtempSync(join(tmpdir(), "lyric-snippets-"));

let failures = 0;
let index = 0;
for (const [name, snippet] of Object.entries(snippets)) {
    const code = filled(snippet.body);
    const text = /^fn main\(/.test(code)
        ? code + "\n"
        : /^(@|fn |struct |class |enum |interface |extend |import )/.test(code)
            ? `${Declared}\n${code}\n\nfn main(): void {\n}\n`
            : `fn main(): void {\n${Bound}${code.split("\n").map(l => "    " + l).join("\n")}\n}\n`;
    const file = join(scratch, `s${index++}.lyr`);
    writeFileSync(file, text);
    try {
        execFileSync(lyric, [...before, "check", file], { stdio: "pipe" });
        console.log(`ok    ${name}`);
    } catch (error) {
        failures++;
        console.error(`FAIL  ${name}\n${text}${error.stderr?.toString() ?? error.message}`);
    }
}

if (failures > 0) process.exit(1);
console.log("every snippet checks");
