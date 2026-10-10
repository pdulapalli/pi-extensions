/**
 * Persistent tracker widget shown above the editor, plus footer status.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	computeConfidence,
	DIMENSION_LABELS,
	isActive,
	type PlanStep,
	type PreflightState,
	questionStats,
	stepStats,
} from "../state.ts";

const WIDGET_KEY = "preflight";
const MAX_STEP_LINES = 8;

function bar(theme: Theme, pct: number, threshold: number, width = 20): string {
	const filled = Math.round((pct / 100) * width);
	const mark = Math.min(width - 1, Math.round((threshold / 100) * width));
	let out = "";
	for (let i = 0; i < width; i++) {
		const ch = i < filled ? "█" : i === mark ? "┆" : "░";
		out += theme.fg(i < filled ? (pct >= threshold ? "success" : "warning") : "dim", ch);
	}
	return out;
}

function oneLine(text: string, max = 60): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function stepLine(theme: Theme, step: PlanStep, n: number): string {
	switch (step.status) {
		case "done":
			return `${theme.fg("success", "✓")} ${theme.fg("dim", theme.strikethrough(`${n}. ${step.title}`))}`;
		case "skipped":
			return `${theme.fg("dim", "–")} ${theme.fg("dim", theme.strikethrough(`${n}. ${step.title}`))}`;
		case "in_progress":
			return `${theme.fg("accent", "▶")} ${theme.fg("accent", theme.bold(`${n}. ${step.title}`))}`;
		case "blocked":
			return `${theme.fg("error", "!")} ${theme.fg("error", `${n}. ${step.title}`)}${step.note ? theme.fg("muted", ` — ${step.note}`) : ""}`;
		default:
			return `${theme.fg("muted", "○")} ${theme.fg("text", `${n}. ${step.title}`)}`;
	}
}

export function buildWidgetLines(s: PreflightState, theme: Theme): string[] {
	const lines: string[] = [];
	const phaseLabel = s.phase === "executing" ? "Executing" : s.phase === "review" ? "Plan review" : "Interview";
	const head = `${theme.fg("accent", theme.bold("✈ Preflight"))} ${theme.fg("muted", "·")} ${theme.fg("accent", phaseLabel)}`;

	if (s.phase === "executing" && s.plan) {
		const st = stepStats(s.plan);
		lines.push(`${head}  ${theme.fg("text", `${st.done + st.skipped}/${st.total} done`)}${st.blocked ? theme.fg("error", `  ${st.blocked} blocked`) : ""}  ${theme.fg("dim", oneLine(s.plan.title, 50))}`);
		const steps = s.plan.steps;
		// Window: collapse leading finished steps so the active area stays visible.
		const firstOpen = steps.findIndex((x) => x.status !== "done" && x.status !== "skipped");
		let start = 0;
		if (steps.length > MAX_STEP_LINES && firstOpen > 0) start = Math.min(firstOpen, steps.length - MAX_STEP_LINES + 1);
		if (start > 0) lines.push(`  ${theme.fg("success", "✓")} ${theme.fg("dim", `${start} earlier step${start === 1 ? "" : "s"} done`)}`);
		const budget = MAX_STEP_LINES - (start > 0 ? 1 : 0);
		const shown = steps.slice(start, start + budget);
		shown.forEach((step, i) => lines.push(`  ${stepLine(theme, step, start + i + 1)}`));
		const rest = steps.length - start - shown.length;
		if (rest > 0) lines.push(`  ${theme.fg("dim", `… ${rest} more`)}`);
		return lines;
	}

	lines.push(`${head}  ${theme.fg("dim", oneLine(s.objective))}`);
	const q = questionStats(s);
	if (s.assessment) {
		const b = computeConfidence(s.assessment);
		const trend = s.history.length > 1 ? theme.fg("dim", `  ${s.history.slice(-4).join(" → ")}`) : "";
		lines.push(
			`  ${theme.fg("muted", "Confidence")} ${bar(theme, b.overall, s.threshold)} ${theme.fg(b.overall >= s.threshold ? "success" : "warning", theme.bold(`${b.overall}%`))}${theme.fg("dim", ` / ${s.threshold}%`)}${trend}`,
		);
		const weakest = b.ranked
			.slice(0, 2)
			.map((r) => `${DIMENSION_LABELS[r.dimension]} ${r.score}`)
			.join(" · ");
		lines.push(`  ${theme.fg("muted", "Weakest   ")} ${theme.fg("text", weakest)}`);
	} else {
		lines.push(`  ${theme.fg("muted", "Confidence")} ${theme.fg("dim", "investigating…")}`);
	}
	const openText = q.open
		? theme.fg(q.openHigh ? "warning" : "text", `${q.open} open decision${q.open === 1 ? "" : "s"}${q.openHigh ? ` (${q.openHigh} high)` : ""}`)
		: theme.fg("dim", "no open decisions");
	lines.push(
		`  ${theme.fg("muted", "Questions ")} ${theme.fg("text", `${q.asked} asked`)} ${theme.fg("dim", "·")} ${theme.fg("success", `${q.answered} answered`)} ${theme.fg("dim", "·")} ${theme.fg(q.skipped ? "warning" : "dim", `${q.skipped} skipped`)} ${theme.fg("dim", "·")} ${openText}`,
	);
	return lines;
}

/** Temporarily hide the tracker (e.g. while a full-height screen is open). updateUi() restores it. */
export function hideWidget(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export function updateUi(ctx: ExtensionContext, s: PreflightState | undefined): void {
	if (!ctx.hasUI) return;
	if (!isActive(s)) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(WIDGET_KEY, undefined);
		return;
	}
	const snapshot = structuredClone(s);
	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
		render: (width: number) => buildWidgetLines(snapshot, theme).map((l) => truncateToWidth(l, width)),
		invalidate: () => {},
	}));
	const theme = ctx.ui.theme;
	if (s.phase === "executing") {
		const st = stepStats(s.plan);
		ctx.ui.setStatus(WIDGET_KEY, theme.fg("accent", `✈ ${st.done + st.skipped}/${st.total}`));
	} else {
		const pct = s.assessment ? computeConfidence(s.assessment).overall : undefined;
		ctx.ui.setStatus(WIDGET_KEY, theme.fg(pct !== undefined && pct >= s.threshold ? "success" : "warning", `✈ ${pct ?? "–"}%`));
	}
}
