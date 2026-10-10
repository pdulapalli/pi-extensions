import assert from "node:assert/strict";
import { test } from "node:test";
import { isSafeCommand } from "../src/safety.ts";

const safe = [
	"ls -la",
	"cat package.json",
	"rg -n 'TODO' src | head -20",
	"git status && git log --oneline -5",
	"grep \"rm -rf\" scripts/*.sh",
	"find . -name '*.ts' -not -path './node_modules/*'",
	"npm ls --depth=0",
	"ls nonexistent 2>/dev/null || echo none",
	"cd src && ls",
	"echo $(pwd)",
	"sed -n '1,20p' file.txt",
	"jq .version package.json",
	"node --version",
];
const unsafe = [
	"rm -rf dist",
	"echo hi > file.txt",
	"cat a >> b",
	"git commit -m x",
	"git checkout main",
	"npm install lodash",
	"npx something",
	"sed -i 's/a/b/' file",
	"find . -name '*.tmp' -delete",
	"find . -exec rm {} \\;",
	"echo $(rm -rf /)",
	"echo \"$(touch x)\"",
	"curl -X POST https://example.com",
	"python script.py",
	"bash -c 'ls'",
	"ls | xargs rm",
	"mkdir foo",
	"sudo ls",
];

for (const cmd of safe) test(`safe: ${cmd}`, () => assert.equal(isSafeCommand(cmd), true));
for (const cmd of unsafe) test(`unsafe: ${cmd}`, () => assert.equal(isSafeCommand(cmd), false));
