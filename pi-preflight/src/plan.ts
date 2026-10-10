/**
 * Plan <-> Markdown round-tripping, plus the export document.
 *
 * The Markdown form is what the user edits, so the parser is deliberately forgiving:
 * - `# Title`, then free-text summary until the first `## ` heading
 * - `## Steps`: checklist items `- [ ] 1. Title`, with indented continuation lines.
 *   `Verify:` / `Note:` continuation lines map to fields; anything else is details.
 *   Plain numbered items (`1. Title`) are also accepted.
 * - `## Assumptions`, `## Risks`, `## Out of scope`: bullet lists
 * - Any other `## Section` is preserved verbatim.
 */

import {
	computeConfidence,
	DIMENSION_LABELS,
	DIMENSIONS,
	type Plan,
	type PlanStep,
	type PreflightState,
	type StepStatus,
} from "./state.ts";

const STATUS_MARK: Record<StepStatus, string> = {
	pending: " ",
	in_progress: "~",
	done: "x",
	blocked: "!",
	skipped: "-",
};

const MARK_STATUS: Record<string, StepStatus> = {
	" ": "pending",
	"": "pending",
	"~": "in_progress",
	x: "done",
	X: "done",
	"!": "blocked",
	"-": "skipped",
};

export function planToMarkdown(plan: Plan, opts: { statusLegend?: boolean } = {}): string {
	const out: string[] = [];
	out.push(`# ${plan.title.trim() || "Plan"}`, "");
	if (plan.summary.trim()) out.push(plan.summary.trim(), "");

	out.push("## Steps", "");
	if (opts.statusLegend) {
		out.push("<!-- [ ] pending  [~] in progress  [x] done  [!] blocked  [-] skipped -->", "");
	}
	plan.steps.forEach((step, i) => {
		out.push(`- [${STATUS_MARK[step.status]}] ${i + 1}. ${step.title.trim()}`);
		if (step.details?.trim()) {
			for (const line of step.details.trim().split("\n")) out.push(`  ${line}`.trimEnd());
		}
		if (step.verify?.trim()) out.push(`  Verify: ${step.verify.trim()}`);
		if (step.note?.trim()) out.push(`  Note: ${step.note.trim()}`);
	});
	out.push("");

	const list = (heading: string, items: string[]) => {
		if (!items.length) return;
		out.push(`## ${heading}`, "");
		for (const item of items) out.push(`- ${item.trim()}`);
		out.push("");
	};
	list("Assumptions", plan.assumptions);
	list("Risks", plan.risks);
	list("Out of scope", plan.outOfScope);

	for (const section of plan.extraSections) {
		out.push(`## ${section.heading}`, "", section.body.trim(), "");
	}
	return `${out.join("\n").trimEnd()}\n`;
}

type SectionKind = "steps" | "assumptions" | "risks" | "outOfScope" | "extra";

function classifyHeading(heading: string): SectionKind {
	const h = heading.toLowerCase().replace(/[^a-z ]/g, "").trim();
	if (/^(steps|plan|checklist|tasks|todo|todos)$/.test(h)) return "steps";
	if (/^assumptions?$/.test(h)) return "assumptions";
	if (/^risks?( and mitigations)?$/.test(h)) return "risks";
	if (/^(out of scope|non goals|nongoals|not in scope)$/.test(h)) return "outOfScope";
	return "extra";
}

const STEP_CHECKBOX = /^\s*[-*+]\s+\[([ xX~!-]?)\]\s+(?:\d+[.)]\s+)?(.+?)\s*$/;
const STEP_NUMBERED = /^\s*\d+[.)]\s+(.+?)\s*$/;
const STEP_BULLET = /^\s*[-*+]\s+(.+?)\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;

function parseSteps(lines: string[]): PlanStep[] {
	const steps: PlanStep[] = [];
	let current: PlanStep | undefined;
	const detailLines: string[] = [];
	// Only treat plain bullets as steps if no checkbox/numbered items exist at all.
	const hasStructured = lines.some((l) => STEP_CHECKBOX.test(l) || STEP_NUMBERED.test(l));

	const flush = () => {
		if (current) {
			const details = detailLines.join("\n").trim();
			if (details) current.details = details;
			steps.push(current);
		}
		current = undefined;
		detailLines.length = 0;
	};

	for (const raw of lines) {
		if (/^\s*<!--.*-->\s*$/.test(raw)) continue;
		const isTopLevel = !/^( {2,}|\t)/.test(raw);
		const checkbox = raw.match(STEP_CHECKBOX);
		const numbered = isTopLevel ? raw.match(STEP_NUMBERED) : null;
		const bullet = !hasStructured && isTopLevel ? raw.match(STEP_BULLET) : null;

		if (checkbox && isTopLevel) {
			flush();
			current = { title: checkbox[2], status: MARK_STATUS[checkbox[1]] ?? "pending" };
			continue;
		}
		if (numbered || bullet) {
			flush();
			current = { title: (numbered ?? bullet)![1], status: "pending" };
			continue;
		}
		if (!current) continue;
		const line = raw.trim();
		const verify = line.match(/^verify:\s*(.*)$/i);
		const note = line.match(/^note:\s*(.*)$/i);
		if (verify) current.verify = verify[1];
		else if (note) current.note = note[1];
		else detailLines.push(raw.replace(/^( {2,4}|\t)/, "").trimEnd());
	}
	flush();
	return steps;
}

function parseList(lines: string[]): string[] {
	const items: string[] = [];
	for (const raw of lines) {
		const m = raw.match(BULLET);
		if (m && !/^\s{2,}/.test(raw)) {
			if (m[1].trim()) items.push(m[1].trim());
		} else if (raw.trim() && items.length) {
			items[items.length - 1] += ` ${raw.trim()}`;
		} else if (raw.trim()) {
			items.push(raw.trim());
		}
	}
	return items;
}

/**
 * Pull top-level checkbox items (and their indented continuation lines) out of a non-step section.
 * A `- [ ] ...` item is unambiguously a step, even if the user typed it at the end of Assumptions.
 */
function extractCheckboxItems(lines: string[]): { stepLines: string[]; rest: string[] } {
	const stepLines: string[] = [];
	const rest: string[] = [];
	let inStep = false;
	for (const line of lines) {
		const topLevel = !/^( {2,}|\t)/.test(line);
		if (topLevel && STEP_CHECKBOX.test(line)) inStep = true;
		else if (topLevel && line.trim()) inStep = false;
		(inStep ? stepLines : rest).push(line);
	}
	return { stepLines, rest };
}

export class PlanParseError extends Error {}

export function markdownToPlan(markdown: string): Plan {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	let title = "";
	const summary: string[] = [];
	const sections: { heading: string; lines: string[] }[] = [];
	let inFence = false;

	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		const h1 = !inFence && line.match(/^#\s+(.+?)\s*#*\s*$/);
		const h2 = !inFence && line.match(/^##\s+(.+?)\s*#*\s*$/);
		if (h1 && !title && sections.length === 0) {
			title = h1[1];
			continue;
		}
		if (h2) {
			sections.push({ heading: h2[1], lines: [] });
			continue;
		}
		if (sections.length) sections[sections.length - 1].lines.push(line);
		else summary.push(line);
	}

	const plan: Plan = {
		title: title || "Plan",
		summary: summary.join("\n").trim(),
		steps: [],
		assumptions: [],
		risks: [],
		outOfScope: [],
		extraSections: [],
	};

	for (const section of sections) {
		const kind = classifyHeading(section.heading);
		if (kind === "steps") plan.steps.push(...parseSteps(section.lines));
		else {
			const { stepLines, rest } = extractCheckboxItems(section.lines);
			plan.steps.push(...parseSteps(stepLines));
			if (kind === "extra") {
				plan.extraSections.push({ heading: section.heading, body: rest.join("\n").trim() });
			} else plan[kind].push(...parseList(rest));
		}
	}

	// No "## Steps" heading? Fall back to checklist items anywhere in the summary.
	if (plan.steps.length === 0) {
		const fallback = parseSteps(summary.filter((l) => STEP_CHECKBOX.test(l) || STEP_NUMBERED.test(l)));
		if (fallback.length) {
			plan.steps = fallback;
			plan.summary = summary
				.filter((l) => !STEP_CHECKBOX.test(l) && !STEP_NUMBERED.test(l))
				.join("\n")
				.trim();
		}
	}

	if (plan.steps.length === 0) {
		throw new PlanParseError('No steps found. Add a "## Steps" section with items like "- [ ] 1. Do the thing".');
	}
	return plan;
}

/** Full export document: the plan plus the interview record. */
export function exportMarkdown(state: PreflightState): string {
	if (!state.plan) throw new Error("No plan to export yet.");
	const out: string[] = [planToMarkdown(state.plan, { statusLegend: state.phase === "executing" }).trimEnd(), ""];
	out.push("---", "", "## Preflight record", "");
	out.push(`- **Objective:** ${state.objective.replace(/\n+/g, " ")}`);
	if (state.assessment) {
		const b = computeConfidence(state.assessment);
		out.push(`- **Confidence:** ${b.overall}% (threshold ${state.threshold}%)`);
		out.push(
			`- **Dimensions:** ${DIMENSIONS.map((d) => `${DIMENSION_LABELS[d]} ${state.assessment!.scores[d]}`).join(" · ")}`,
		);
		if (state.assessment.openDecisions.length) {
			out.push(
				`- **Open decisions:** ${state.assessment.openDecisions.map((d) => `${d.topic} (${d.impact})`).join("; ")}`,
			);
		}
	}
	out.push(`- **Started:** ${state.startedAt}`);
	out.push(`- **Exported:** ${new Date().toISOString()}`);
	out.push("");

	if (state.questions.length) {
		out.push(`### Interview (${state.questions.length} questions)`, "");
		for (const q of state.questions) {
			const dim = q.dimension ? ` · ${DIMENSION_LABELS[q.dimension]}` : "";
			out.push(`**${q.id} · ${q.label}${dim}** — ${q.prompt}`, "");
			out.push(q.status === "answered" ? `> ${q.answer ?? ""}` : "> _(skipped)_", "");
		}
	}
	return `${out.join("\n").trimEnd()}\n`;
}
