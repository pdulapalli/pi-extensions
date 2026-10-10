/**
 * Batched interview questionnaire (1–4 questions, tabbed).
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface AskOption {
	label: string;
	description?: string;
}

export interface AskQuestion {
	label: string;
	prompt: string;
	why?: string;
	dimensionLabel?: string;
	options: AskOption[];
	recommended?: number;
	allowOther: boolean;
}

export type AskAnswer = { kind: "answer"; text: string; wasCustom: boolean } | { kind: "skip" };

export interface AskResult {
	cancelled: boolean;
	answers: (AskAnswer | undefined)[];
}

export interface AskHeader {
	round: number;
	confidence?: number;
	threshold: number;
}

type RowKind = "option" | "other" | "skip";
interface Row {
	kind: RowKind;
	label: string;
	description?: string;
	optionIndex?: number;
}

function rowsFor(q: AskQuestion): Row[] {
	const rows: Row[] = q.options.map((o, i) => ({
		kind: "option",
		label: o.label,
		description: o.description,
		optionIndex: i,
	}));
	if (q.allowOther) rows.push({ kind: "other", label: "Type your own answer…" });
	rows.push({ kind: "skip", label: "Skip — not sure / decide later" });
	return rows;
}

export async function askQuestions(ctx: ExtensionContext, questions: AskQuestion[], header: AskHeader): Promise<AskResult> {
	if (ctx.mode === "tui") return askTui(ctx, questions, header);
	return askDialogs(ctx, questions);
}

/** Fallback for RPC clients: one dialog per question. */
async function askDialogs(ctx: ExtensionContext, questions: AskQuestion[]): Promise<AskResult> {
	const answers: (AskAnswer | undefined)[] = [];
	for (const q of questions) {
		const rows = rowsFor(q);
		const labels = rows.map((r, i) =>
			r.kind === "option" && q.recommended === r.optionIndex ? `${r.label} (recommended)` : rows[i].label,
		);
		const choice = await ctx.ui.select(q.prompt, labels);
		if (choice === undefined) return { cancelled: true, answers };
		const row = rows[labels.indexOf(choice)];
		if (row.kind === "skip") answers.push({ kind: "skip" });
		else if (row.kind === "other") {
			const text = await ctx.ui.input(q.prompt, "Your answer");
			if (text === undefined) return { cancelled: true, answers };
			answers.push(text.trim() ? { kind: "answer", text: text.trim(), wasCustom: true } : { kind: "skip" });
		} else answers.push({ kind: "answer", text: row.label, wasCustom: false });
	}
	return { cancelled: false, answers };
}

function askTui(ctx: ExtensionContext, questions: AskQuestion[], header: AskHeader): Promise<AskResult> {
	return ctx.ui.custom<AskResult>((tui: TUI, theme: Theme, _kb, done) => {
		const isMulti = questions.length > 1;
		const submitTab = questions.length;
		const answers: (AskAnswer | undefined)[] = questions.map(() => undefined);
		const cursor: number[] = questions.map((q) => (q.recommended !== undefined ? q.recommended : 0));
		let tab = 0;
		let inputMode = false;
		let cache: { width: number; lines: string[] } | undefined;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		const refresh = () => {
			cache = undefined;
			tui.requestRender();
		};
		const allAnswered = () => answers.every((a) => a !== undefined);
		const finish = (cancelled: boolean) => done({ cancelled, answers });

		const advance = () => {
			if (!isMulti) return finish(false);
			const nextUnanswered = answers.findIndex((a, i) => a === undefined && i > tab);
			const firstUnanswered = answers.findIndex((a) => a === undefined);
			tab = nextUnanswered >= 0 ? nextUnanswered : firstUnanswered >= 0 ? firstUnanswered : submitTab;
			refresh();
		};

		editor.onSubmit = (value) => {
			const text = value.trim();
			answers[tab] = text ? { kind: "answer", text, wasCustom: true } : { kind: "skip" };
			inputMode = false;
			editor.setText("");
			advance();
		};

		const choose = (row: Row) => {
			if (row.kind === "other") {
				inputMode = true;
				const prev = answers[tab];
				editor.setText(prev?.kind === "answer" && prev.wasCustom ? prev.text : "");
				refresh();
				return;
			}
			answers[tab] = row.kind === "skip" ? { kind: "skip" } : { kind: "answer", text: row.label, wasCustom: false };
			advance();
		};

		function handleInput(data: string) {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					tab = (tab + 1) % (questions.length + 1);
					return refresh();
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					tab = (tab - 1 + questions.length + 1) % (questions.length + 1);
					return refresh();
				}
			}

			if (matchesKey(data, Key.escape)) return finish(true);

			if (tab === submitTab) {
				if (matchesKey(data, Key.enter) && allAnswered()) finish(false);
				return;
			}

			const rows = rowsFor(questions[tab]);
			if (matchesKey(data, Key.up)) {
				cursor[tab] = Math.max(0, cursor[tab] - 1);
				return refresh();
			}
			if (matchesKey(data, Key.down)) {
				cursor[tab] = Math.min(rows.length - 1, cursor[tab] + 1);
				return refresh();
			}
			if (/^[1-9]$/.test(data)) {
				const idx = Number(data) - 1;
				if (idx < rows.length) {
					cursor[tab] = idx;
					choose(rows[idx]);
				}
				return;
			}
			if (matchesKey(data, Key.enter)) choose(rows[cursor[tab]]);
		}

		function render(width: number): string[] {
			if (cache && cache.width === width) return cache.lines;
			const w = Math.max(10, width);
			const lines: string[] = [];
			const wrap = (prefix: string, text: string) => {
				const pw = visibleWidth(prefix);
				const wrapped = wrapTextWithAnsi(text, Math.max(1, w - pw));
				wrapped.forEach((l, i) => lines.push(truncateToWidth((i === 0 ? prefix : " ".repeat(pw)) + l, w)));
			};

			// Header
			const conf =
				header.confidence === undefined
					? theme.fg("dim", "confidence not yet assessed")
					: theme.fg(header.confidence >= header.threshold ? "success" : "warning", `${header.confidence}%`) +
						theme.fg("dim", ` / ${header.threshold}% confidence`);
			const title = ` ✈ Preflight · Round ${header.round} `;
			lines.push(
				truncateToWidth(
					theme.fg("accent", "──") + theme.fg("accent", theme.bold(title)) + conf + " " +
						theme.fg("accent", "─".repeat(Math.max(0, w - visibleWidth(title) - visibleWidth(conf) - 3))),
					w,
				),
			);

			// Tabs
			if (isMulti) {
				const parts: string[] = [];
				questions.forEach((q, i) => {
					const a = answers[i];
					const box = a === undefined ? "□" : a.kind === "skip" ? "↷" : "■";
					const text = ` ${box} ${q.label} `;
					const color = a === undefined ? "muted" : a.kind === "skip" ? "warning" : "success";
					parts.push(i === tab ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text));
				});
				const submit = " ✓ Submit ";
				parts.push(
					tab === submitTab
						? theme.bg("selectedBg", theme.fg("text", submit))
						: theme.fg(allAnswered() ? "success" : "dim", submit),
				);
				wrap(" ", parts.join(" "));
			}
			lines.push("");

			if (tab === submitTab) {
				wrap(" ", theme.fg("accent", theme.bold("Review answers")));
				lines.push("");
				questions.forEach((q, i) => {
					const a = answers[i];
					const value =
						a === undefined
							? theme.fg("warning", "(unanswered)")
							: a.kind === "skip"
								? theme.fg("warning", "(skipped)")
								: theme.fg("text", a.wasCustom ? `“${a.text}”` : a.text);
					wrap(" ", `${theme.fg("muted", `${q.label}: `)}${value}`);
				});
				lines.push("");
				wrap(
					" ",
					allAnswered()
						? theme.fg("success", "Enter to submit")
						: theme.fg("warning", "Answer or skip every question to submit"),
				);
			} else {
				const q = questions[tab];
				const rows = rowsFor(q);
				wrap(" ", theme.fg("text", theme.bold(q.prompt)));
				const meta = [q.dimensionLabel, q.why].filter(Boolean).join(" — ");
				if (meta) wrap(" ", theme.fg("dim", theme.italic(`why: ${meta}`)));
				lines.push("");
				rows.forEach((row, i) => {
					const selected = i === cursor[tab];
					const current = answers[tab];
					const isChosen =
						(row.kind === "skip" && current?.kind === "skip") ||
						(row.kind === "option" && current?.kind === "answer" && !current.wasCustom && current.text === row.label) ||
						(row.kind === "other" && current?.kind === "answer" && current.wasCustom);
					const prefix = selected ? theme.fg("accent", " › ") : "   ";
					const rec = row.kind === "option" && row.optionIndex === q.recommended ? theme.fg("success", " (recommended)") : "";
					const check = isChosen ? theme.fg("success", " ✓") : "";
					const color = selected ? "accent" : row.kind === "option" ? "text" : "muted";
					wrap(prefix, theme.fg(color, `${i + 1}. ${row.label}`) + rec + check);
					if (row.description) wrap("      ", theme.fg("muted", row.description));
				});
				if (inputMode) {
					lines.push("");
					wrap(" ", theme.fg("muted", "Your answer (Enter to submit, Esc to go back):"));
					for (const l of editor.render(Math.max(1, w - 2))) lines.push(truncateToWidth(` ${l}`, w));
				}
			}

			lines.push("");
			if (!inputMode) {
				const help = isMulti
					? "←→/Tab switch question · ↑↓ move · 1-9/Enter choose · Esc pause"
					: "↑↓ move · 1-9/Enter choose · Esc pause";
				wrap(" ", theme.fg("dim", help));
			}
			lines.push(theme.fg("accent", "─".repeat(w)));
			cache = { width, lines };
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cache = undefined;
			},
			handleInput,
			// Propagate focus so IME candidate windows track the inline editor's cursor.
			get focused() {
				return editor.focused;
			},
			set focused(value: boolean) {
				editor.focused = value;
			},
		};
	});
}
