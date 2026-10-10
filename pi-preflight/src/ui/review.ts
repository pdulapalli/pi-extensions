/**
 * Plan review screen: scrollable rendered plan + action bar.
 */

import { type ExtensionContext, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type ReviewAction = "approve" | "edit" | "revise" | "interview" | "save" | "cancel" | "pause";

interface ActionDef {
	action: ReviewAction;
	label: string;
	key: string;
}

const ACTIONS: ActionDef[] = [
	{ action: "approve", label: "Approve & execute", key: "a" },
	{ action: "edit", label: "Edit", key: "e" },
	{ action: "revise", label: "Request changes", key: "c" },
	{ action: "interview", label: "More questions", key: "q" },
	{ action: "save", label: "Save to disk", key: "s" },
	{ action: "cancel", label: "Cancel preflight", key: "x" },
];

export interface ReviewHeader {
	revision: number;
	confidence?: number;
	threshold: number;
	savedPath?: string;
	edited: boolean;
}

export async function showReview(ctx: ExtensionContext, markdown: string, header: ReviewHeader): Promise<ReviewAction> {
	if (ctx.mode !== "tui") {
		const labels = ACTIONS.map((a) => a.label);
		const choice = await ctx.ui.select(`Review plan (revision ${header.revision}):\n\n${markdown}`, labels);
		return ACTIONS.find((a) => a.label === choice)?.action ?? "pause";
	}

	return ctx.ui.custom<ReviewAction>((tui: TUI, theme: Theme, _kb, done) => {
		const md = new Markdown(markdown, 1, 0, getMarkdownTheme());
		let selected = 0;
		let scroll = 0;
		let bodyCache: { width: number; lines: string[] } | undefined;

		// Leave room for our chrome (4 lines), pi's footer, and anything else on screen.
		const viewport = () => Math.max(6, (tui.terminal?.rows ?? 30) - 12);
		const bodyLines = (width: number) => {
			if (!bodyCache || bodyCache.width !== width) bodyCache = { width, lines: md.render(width) };
			return bodyCache.lines;
		};
		const maxScroll = (width: number) => Math.max(0, bodyLines(width).length - viewport());
		let lastWidth = 80;

		const refresh = () => tui.requestRender();

		function handleInput(data: string) {
			const max = maxScroll(lastWidth);
			const page = Math.max(1, viewport() - 2);
			if (matchesKey(data, Key.up) || data === "k") scroll = Math.max(0, scroll - 1);
			else if (matchesKey(data, Key.down) || data === "j") scroll = Math.min(max, scroll + 1);
			else if (matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - page);
			else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) scroll = Math.min(max, scroll + page);
			else if (matchesKey(data, Key.home)) scroll = 0;
			else if (matchesKey(data, Key.end)) scroll = max;
			else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")))
				selected = (selected - 1 + ACTIONS.length) % ACTIONS.length;
			else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) selected = (selected + 1) % ACTIONS.length;
			else if (matchesKey(data, Key.enter)) return done(ACTIONS[selected].action);
			else if (matchesKey(data, Key.escape)) return done("pause");
			else {
				const hit = ACTIONS.find((a) => a.key === data.toLowerCase());
				if (hit) return done(hit.action);
				return;
			}
			refresh();
		}

		function render(width: number): string[] {
			const w = Math.max(20, width);
			lastWidth = w;
			const lines: string[] = [];
			const body = bodyLines(w);
			const vp = viewport();
			scroll = Math.min(scroll, Math.max(0, body.length - vp));

			// Header
			const title = ` ✈ Preflight · Plan review · rev ${header.revision}${header.edited ? " (edited)" : ""} `;
			const conf =
				header.confidence === undefined
					? ""
					: theme.fg(header.confidence >= header.threshold ? "success" : "warning", ` ${header.confidence}% `) +
						theme.fg("dim", `/ ${header.threshold}% `);
			const fill = Math.max(0, w - visibleWidth(title) - visibleWidth(conf) - 2);
			lines.push(truncateToWidth(theme.fg("accent", "──") + theme.fg("accent", theme.bold(title)) + conf + theme.fg("accent", "─".repeat(fill)), w));

			// Action bar (at the top so it is never clipped)
			const bar = ACTIONS.map((a, i) => {
				const text = ` ${a.label} (${a.key}) `;
				if (i === selected) return theme.bg("selectedBg", theme.fg("text", theme.bold(text)));
				return theme.fg(a.action === "approve" ? "success" : a.action === "cancel" ? "error" : "muted", text);
			}).join(" ");
			lines.push(truncateToWidth(` ${bar}`, w));
			lines.push(
				truncateToWidth(
					theme.fg("dim", " ←→ select · Enter confirm · letter shortcut · ↑↓ PgUp/PgDn scroll · Esc pause (/preflight review resumes)"),
					w,
				),
			);
			lines.push(theme.fg("borderMuted", "─".repeat(w)));

			// Body
			const visible = body.slice(scroll, scroll + vp);
			for (const l of visible) lines.push(truncateToWidth(l, w));
			for (let i = visible.length; i < Math.min(vp, body.length); i++) lines.push("");

			// Scroll indicator
			const more = body.length > vp;
			const pos = more
				? theme.fg("dim", ` lines ${scroll + 1}–${Math.min(body.length, scroll + vp)} of ${body.length}${scroll + vp < body.length ? " · more below ↓" : ""}`)
				: "";
			const saved = header.savedPath ? theme.fg("success", ` saved → ${header.savedPath}`) : "";
			lines.push(truncateToWidth(theme.fg("accent", "─".repeat(2)) + pos + saved, w));
			return lines;
		}

		return {
			render,
			invalidate: () => {
				bodyCache = undefined;
				md.invalidate();
			},
			handleInput,
		};
	});
}

/** Read-only scrollable document (used by /preflight status). */
export async function showDocument(ctx: ExtensionContext, title: string, markdown: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(markdown, "info");
		return;
	}
	await ctx.ui.custom<void>((tui: TUI, theme: Theme, _kb, done) => {
		const md = new Markdown(markdown, 1, 0, getMarkdownTheme());
		let scroll = 0;
		let lastLen = 0;
		const viewport = () => Math.max(6, (tui.terminal?.rows ?? 30) - 10);
		return {
			render(width: number) {
				const w = Math.max(20, width);
				const body = md.render(w);
				lastLen = body.length;
				const vp = viewport();
				scroll = Math.min(scroll, Math.max(0, body.length - vp));
				const head = ` ${title} `;
				const lines = [
					truncateToWidth(theme.fg("accent", "──") + theme.fg("accent", theme.bold(head)) + theme.fg("accent", "─".repeat(Math.max(0, w - visibleWidth(head) - 2))), w),
					...body.slice(scroll, scroll + vp).map((l) => truncateToWidth(l, w)),
					truncateToWidth(theme.fg("dim", ` ${body.length > vp ? "↑↓ PgUp/PgDn scroll · " : ""}Esc/q close`), w),
				];
				return lines;
			},
			invalidate: () => md.invalidate(),
			handleInput(data: string) {
				const max = Math.max(0, lastLen - viewport());
				const page = Math.max(1, viewport() - 2);
				if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.enter)) return done();
				if (matchesKey(data, Key.up) || data === "k") scroll = Math.max(0, scroll - 1);
				else if (matchesKey(data, Key.down) || data === "j") scroll = Math.min(max, scroll + 1);
				else if (matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - page);
				else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) scroll = Math.min(max, scroll + page);
				else return;
				tui.requestRender();
			},
		};
	});
}
