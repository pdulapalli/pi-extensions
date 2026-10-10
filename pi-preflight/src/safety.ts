/**
 * Read-only enforcement for the interview phase.
 */

/** Built-in tools that never modify anything. */
export const READ_ONLY_BUILTINS = new Set(["read", "grep", "find", "ls", "bash"]);

const MUTATING_PATTERNS: RegExp[] = [
	/\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred|install|unlink)\b/,
	/\bsed\b[^|;&]*\s-i/,
	/\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|update|upgrade|ci|link|publish|run|exec|dlx|x)\b/,
	/\bnpx\b|\bbunx\b/,
	/\bpip3?\s+(install|uninstall)\b/,
	/\b(apt|apt-get|brew|dnf|yum|pacman)\s+(install|remove|uninstall|purge|update|upgrade)\b/,
	/\bgit\s+(add|commit|push|pull|fetch|merge|rebase|reset|checkout|switch|restore|clean|stash|cherry-pick|revert|tag|init|clone|rm|mv|apply|am)\b/,
	/\bgit\s+branch\s+-[dDmM]\b/,
	/\b(sudo|su|doas)\b/,
	/\b(kill|pkill|killall|reboot|shutdown|halt)\b/,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/,
	/\b(docker|podman|kubectl)\s+(run|rm|rmi|stop|kill|exec|apply|delete|create)\b/,
	/\bcurl\b[^|;&]*\s(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s|-F\s|-o\s|-O\b|--output)/i,
	/\bwget\b(?![^|;&]*-O\s*-)/,
	/\b(vim?|nvim|nano|emacs|code|subl)\b/,
	/\bxargs\b/,
	/\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/,
	/\beval\b|\bexec\b/,
];

const SAFE_PREFIXES: RegExp[] = [
	/^(cat|head|tail|less|more|grep|egrep|fgrep|rg|ag|find|fd|ls|eza|exa|tree|pwd|echo|printf|wc|sort|uniq|cut|tr|diff|cmp|file|stat|du|df|which|whereis|type|command|env|printenv|uname|whoami|id|date|uptime|ps|jq|yq|awk|sed|bat|basename|dirname|realpath|readlink|nl|column|comm|sha\d*sum|md5sum|md5|shasum|true|test|\[)\b/,
	/^git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|ls-tree|ls-remote|rev-parse|describe|blame|shortlog|grep|cat-file|tag\s+(-l|--list))\b/,
	/^(npm|pnpm|yarn)\s+(ls|list|view|info|why|outdated|audit|explain|config\s+get)\b/,
	/^(node|python3?|ruby|go|rustc|cargo|java|deno|bun|tsc)\s+(--version|-v|-V|version)\b/,
	/^(cargo\s+(tree|metadata)|go\s+(list|env|doc|version))\b/,
	/^curl\s/,
	/^wget\s.*-O\s*-/,
	/^cd\s/,
];

/** Split a shell command line into simple segments on ;, &&, ||, and |. */
function segments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\||\n/)
		.map((s) => s.trim().replace(/^\(+|\)+$/g, "").trim())
		.filter(Boolean);
}

export function isSafeCommand(command: string): boolean {
	// Command substitution (even inside double quotes) must itself be safe.
	if (/\$\(|`/.test(command)) {
		const inner = [...command.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)].map((m) => m[1] ?? m[2]);
		if (inner.length === 0 || !inner.every((c) => isSafeCommand(c))) return false;
	}
	// Ignore quoted strings so `grep "rm -rf" x` isn't flagged, and allow discarding output.
	const stripped = command
		.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
		.replace(/\d*>>?\s*\/dev\/null/g, "")
		.replace(/\d*>&\d/g, "");
	if (/>/.test(stripped)) return false; // any remaining output redirection writes a file
	if (MUTATING_PATTERNS.some((p) => p.test(stripped))) return false;
	const parts = segments(stripped);
	if (parts.length === 0) return false;
	return parts.every((part) => {
		const withoutEnv = part.replace(/^(\w+=\S*\s+)+/, "");
		return SAFE_PREFIXES.some((p) => p.test(withoutEnv));
	});
}
