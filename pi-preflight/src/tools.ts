/**
 * Model-facing tools: preflight_ask, preflight_plan, preflight_step.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { type Preflight, type ReviewOutcome, TOOL_ASK, TOOL_PLAN, TOOL_STEP } from "./controller.ts";
import { approvedMessage, statusLine } from "./prompts.ts";
import {
	computeConfidence,
	DIMENSION_LABELS,
	DIMENSIONS,
	type Dimension,
	explainConfidence,
	type PlanStep,
	type QuestionRecord,
	type StepStatus,
	stepStats,
} from "./state.ts";
import { type AskAnswer, type AskQuestion, askQuestions } from "./ui/questionnaire.ts";

// ── Schemas ──────────────────────────────────────────────────────────────

const score = (description: string) => Type.Integer({ minimum: 0, maximum: 100, description });

const AssessmentSchema = Type.Object(
	{
		scores: Type.Object(
			{
				goal: score("How clearly you understand WHAT the user wants and WHY."),
				scope: score("How clearly the boundaries are defined: what's in and what's out."),
				constraints: score("How well you know the technical, compatibility, style, time and other constraints."),
				successCriteria: score("How clearly you both know what 'done and correct' looks like."),
				approach: score("How confident you are in HOW to do it, given what you found in the codebase."),
			},
			{ description: "Honest 0–100 scores per dimension. 100 = nothing left to clarify." },
		),
		openDecisions: Type.Array(
			Type.Object({
				topic: Type.String({ description: "The unresolved decision, phrased as a choice." }),
				impact: StringEnum(["low", "medium", "high"] as const, {
					description: "How much getting it wrong would change the outcome.",
				}),
			}),
			{ description: "Every decision that is still open. Each one lowers confidence." },
		),
		assumptions: Type.Array(Type.String(), {
			description:
				"Judgment calls you would currently have to make on the user's behalf without confirmation. Each one lowers confidence.",
		}),
		summary: Type.Optional(Type.String({ description: "One line: what is still most unclear." })),
	},
	{ description: "Your current, honest assessment of how well you understand the request." },
);

const AskParams = Type.Object({
	assessment: AssessmentSchema,
	questions: Type.Array(
		Type.Object({
			label: Type.String({ description: "Short tab label, 1–3 words (e.g. 'Auth method')." }),
			prompt: Type.String({ description: "The full question." }),
			why: Type.String({ description: "Which uncertainty this resolves. Shown to the user." }),
			dimension: StringEnum(DIMENSIONS, { description: "The dimension this question mainly raises." }),
			options: Type.Array(
				Type.Object({
					label: Type.String(),
					description: Type.Optional(Type.String({ description: "Trade-offs or implications." })),
				}),
				{ maxItems: 6, description: "2–5 concrete choices. Empty for a free-text question." },
			),
			recommended: Type.Optional(Type.Integer({ minimum: 0, description: "0-based index of your recommended option." })),
			allowOther: Type.Optional(Type.Boolean({ description: "Allow a typed answer (default true)." })),
		}),
		{ minItems: 1, maxItems: 4, description: "1–4 high-leverage questions for this round." },
	),
});

const PlanParams = Type.Object({
	assessment: AssessmentSchema,
	plan: Type.Object({
		title: Type.String({ description: "Short plan title." }),
		summary: Type.String({ description: "2–5 sentences: the approach and key decisions." }),
		steps: Type.Array(
			Type.Object({
				title: Type.String({ description: "Imperative, specific step (one line)." }),
				details: Type.Optional(Type.String({ description: "What exactly to do; files, functions, commands." })),
				verify: Type.Optional(Type.String({ description: "How to check this step is done correctly." })),
			}),
			{ minItems: 1, description: "Ordered, independently verifiable steps." },
		),
		assumptions: Type.Optional(Type.Array(Type.String())),
		risks: Type.Optional(Type.Array(Type.String())),
		outOfScope: Type.Optional(Type.Array(Type.String())),
	}),
});

const STEP_STATUSES = ["pending", "in_progress", "done", "blocked", "skipped"] as const;

const StepParams = Type.Object({
	action: StringEnum(["update", "add"] as const, { description: "update a step's status, or add a new step." }),
	step: Type.Optional(Type.Integer({ minimum: 1, description: "1-based step number (update)." })),
	status: Type.Optional(StringEnum(STEP_STATUSES, { description: "New status (update)." })),
	note: Type.Optional(Type.String({ description: "What you did / verified, or why it's blocked." })),
	title: Type.Optional(Type.String({ description: "Title of the new step (add)." })),
	details: Type.Optional(Type.String({ description: "Details of the new step (add)." })),
	verify: Type.Optional(Type.String({ description: "Verification for the new step (add)." })),
	after: Type.Optional(Type.Integer({ minimum: 0, description: "Insert after this step number (add; default: end)." })),
});

// ── Helpers ──────────────────────────────────────────────────────────────

const text = (t: string) => [{ type: "text" as const, text: t }];

function argConfidence(args: { assessment?: Static<typeof AssessmentSchema> }): number | undefined {
	try {
		const a = args.assessment;
		if (!a?.scores) return undefined;
		return computeConfidence({ scores: a.scores, openDecisions: a.openDecisions ?? [], assumptions: a.assumptions ?? [] })
			.overall;
	} catch {
		return undefined;
	}
}

function confText(theme: Theme, pct: number | undefined, threshold: number): string {
	if (pct === undefined) return "";
	return theme.fg(pct >= threshold ? "success" : "warning", ` ${pct}%`);
}

function outcomeResult(pf: Preflight, outcome: ReviewOutcome) {
	switch (outcome.kind) {
		case "approve":
			return { content: text(approvedMessage(pf.state!)), details: { outcome: "approve" } };
		case "revise":
			return {
				content: text(
					`The user requested changes to the plan:\n\n${outcome.feedback}\n\nRevise the plan accordingly and call ${TOOL_PLAN} again with an updated assessment. Use ${TOOL_ASK} first only if the feedback raises new questions.`,
				),
				details: { outcome: "revise" },
			};
		case "interview":
			return {
				content: text(
					`The user wants more questions before planning.${outcome.note ? ` They said: "${outcome.note}"` : ""}\nContinue the interview with ${TOOL_ASK}, targeting what's still unclear. ${statusLine(pf.state!)}`,
				),
				details: { outcome: "interview" },
			};
		case "cancel":
			return {
				content: text("The user cancelled the preflight. Stop here; do not start the work."),
				details: { outcome: "cancel" },
				terminate: true,
			};
		case "pause":
			return {
				content: text(
					"The user paused plan review to reply in chat. Stop now and wait for their message. (They can reopen the review with /preflight review.)",
				),
				details: { outcome: "pause" },
				terminate: true,
			};
	}
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerTools(pi: ExtensionAPI, pf: Preflight): void {
	pi.registerTool({
		name: TOOL_ASK,
		label: "Preflight ask",
		description:
			"Preflight interview: report your current confidence assessment and ask the user 1–4 high-leverage clarifying questions (shown as an interactive questionnaire). Only available during a preflight interview.",
		promptSnippet: "Ask the user batched clarifying questions during a preflight interview",
		parameters: AskParams,
		exposure: "model-only",
		defaultActive: false,
		executionMode: "sequential",
		annotations: { readOnlyHint: true },

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = pf.state;
			if (!s || (s.phase !== "interview" && s.phase !== "review")) {
				throw new Error("No preflight interview is in progress. The user starts one with /preflight <objective>.");
			}
			if (!ctx.hasUI) throw new Error("preflight_ask needs an interactive UI.");
			s.phase = "interview";

			const before = pf.applyAssessment(params.assessment);
			s.rounds += 1;
			pf.refresh(ctx);

			const questions: AskQuestion[] = params.questions.map((q) => ({
				label: q.label,
				prompt: q.prompt,
				why: q.why,
				dimensionLabel: DIMENSION_LABELS[q.dimension as Dimension],
				options: q.options,
				recommended:
					q.recommended !== undefined && q.recommended < q.options.length ? q.recommended : undefined,
				allowOther: q.allowOther !== false || q.options.length === 0,
			}));

			const record = (answers: (AskAnswer | undefined)[], markUnansweredSkipped: boolean) => {
				const recorded: QuestionRecord[] = [];
				params.questions.forEach((q, i) => {
					const a = answers[i];
					if (!a && !markUnansweredSkipped) return;
					const rec: QuestionRecord = {
						id: `Q${s.questions.length + 1}`,
						round: s.rounds,
						label: q.label,
						prompt: q.prompt,
						why: q.why,
						dimension: q.dimension as Dimension,
						status: a?.kind === "answer" ? "answered" : "skipped",
						answer: a?.kind === "answer" ? a.text : undefined,
						wasCustom: a?.kind === "answer" ? a.wasCustom : undefined,
					};
					s.questions.push(rec);
					recorded.push(rec);
				});
				pf.refresh(ctx);
				return recorded;
			};

			const formatAnswers = (recs: QuestionRecord[]) =>
				recs
					.map(
						(r) =>
							`${r.id} [${r.label}] ${r.prompt}\n→ ${r.status === "answered" ? `${r.answer}${r.wasCustom ? " (typed by user)" : ""}` : "(skipped — the user is unsure or wants you to decide)"}`,
					)
					.join("\n");

			while (true) {
				const res = await askQuestions(ctx, questions, {
					round: s.rounds,
					confidence: before.overall,
					threshold: s.threshold,
				});

				if (!res.cancelled) {
					const recs = record(res.answers, true);
					const skipped = recs.filter((r) => r.status === "skipped");
					return {
						content: text(
							[
								`Round ${s.rounds} answers:`,
								formatAnswers(recs),
								"",
								skipped.length
									? `Skipped: ${skipped.map((r) => r.id).join(", ")}. Treat these as unresolved: record an assumption (it lowers confidence) or, if critical, re-ask in a different, easier form.`
									: "",
								`Confidence before these answers: ${explainConfidence(before)}; threshold ${s.threshold}%.`,
								`Re-assess with these answers in your next ${TOOL_ASK} or ${TOOL_PLAN} call. If you are now at or above ${s.threshold}%, call ${TOOL_PLAN}.`,
							]
								.filter(Boolean)
								.join("\n"),
						),
						details: { round: s.rounds, confidence: before.overall, threshold: s.threshold, records: recs },
					};
				}

				const choice = await ctx.ui.select("Interview paused — what next?", [
					"Back to the questions",
					"Skip ahead to the plan",
					"Pause — I'll reply in chat",
					"Cancel preflight",
				]);
				if (choice === "Back to the questions") continue;

				if (choice === "Skip ahead to the plan") {
					const recs = record(res.answers, true);
					s.forcePlan = true;
					pf.refresh(ctx);
					return {
						content: text(
							`${formatAnswers(recs)}\n\nThe user wants to skip ahead. Call ${TOOL_PLAN} now with your best plan; record every unresolved point as an assumption or open decision so the user can see it in review.`,
						),
						details: { round: s.rounds, confidence: before.overall, threshold: s.threshold, records: recs },
					};
				}

				if (choice === "Cancel preflight") {
					pf.stop(ctx, "idle");
					return {
						content: text("The user cancelled the preflight. Stop here; do not start the work."),
						details: { round: s.rounds, cancelled: true, records: [] },
						terminate: true,
					};
				}

				// Pause (or dismissed dialog)
				const recs = record(res.answers, false);
				return {
					content: text(
						`${recs.length ? `${formatAnswers(recs)}\n\n` : ""}The user paused the interview to reply in chat. Stop now and wait for their message.`,
					),
					details: { round: s.rounds, paused: true, records: recs },
					terminate: true,
				};
			}
		},

		renderCall(args, theme) {
			const qs = (args.questions ?? []) as { label?: string }[];
			const labels = qs.map((q) => q?.label).filter(Boolean).join(", ");
			const pct = argConfidence(args);
			return new Text(
				theme.fg("toolTitle", theme.bold("✈ preflight ask ")) +
					theme.fg("muted", `${qs.length} question${qs.length === 1 ? "" : "s"}`) +
					(labels ? theme.fg("dim", ` (${labels})`) : "") +
					confText(theme, pct, pf.state?.threshold ?? 85),
				0,
				0,
			);
		},

		renderResult(result, _opts, theme) {
			const d = result.details as { records?: QuestionRecord[]; paused?: boolean; cancelled?: boolean } | undefined;
			if (!d?.records) {
				const c = result.content[0];
				return new Text(c?.type === "text" ? c.text : "", 0, 0);
			}
			const lines = d.records.map((r) =>
				r.status === "answered"
					? `${theme.fg("success", "✓")} ${theme.fg("accent", r.label)}: ${r.wasCustom ? theme.fg("muted", "“") + r.answer + theme.fg("muted", "”") : r.answer}`
					: `${theme.fg("warning", "↷")} ${theme.fg("accent", r.label)}: ${theme.fg("dim", "skipped")}`,
			);
			if (d.paused) lines.push(theme.fg("warning", "Paused — waiting for your reply"));
			if (d.cancelled) lines.push(theme.fg("error", "Preflight cancelled"));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: TOOL_PLAN,
		label: "Preflight plan",
		description:
			"Preflight: submit the plan for user review once confidence reaches the threshold (or the user asked to skip ahead). Blocks while the user reviews, edits, approves or requests changes. On approval, execution mode starts.",
		promptSnippet: "Submit a preflight plan for the user to review, edit and approve",
		parameters: PlanParams,
		exposure: "model-only",
		defaultActive: false,
		executionMode: "sequential",
		annotations: { readOnlyHint: true },

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = pf.state;
			if (!s || (s.phase !== "interview" && s.phase !== "review")) {
				throw new Error("No preflight interview is in progress. The user starts one with /preflight <objective>.");
			}
			if (!ctx.hasUI) throw new Error("preflight_plan needs an interactive UI.");

			const b = pf.applyAssessment(params.assessment);
			pf.refresh(ctx);

			if (!s.forcePlan) {
				let gate: { title: string; body: string } | undefined;
				if (b.overall < s.threshold) {
					const weakest = b.ranked
						.slice(0, 2)
						.map((r) => `${DIMENSION_LABELS[r.dimension]} ${r.score}`)
						.join(", ");
					const open = s.assessment!.openDecisions.map((d) => `\u2022 ${d.topic} (${d.impact})`).join("\n");
					const assumptions = s.assessment!.assumptions.map((a) => `\u2022 ${a}`).join("\n");
					gate = {
						title: `Confidence is ${b.overall}%, below your ${s.threshold}% threshold`,
						body: [
							`Score: ${explainConfidence(b)}`,
							`Weakest: ${weakest}`,
							open && `Open decisions:\n${open}`,
							assumptions && `Assumptions the agent would make for you:\n${assumptions}`,
							"Review the plan anyway?",
						]
							.filter(Boolean)
							.join("\n\n"),
					};
				} else if (s.questions.length === 0) {
					gate = {
						title: "No questions asked yet",
						body: `The agent rates itself ${b.overall}% confident without asking you anything. Review the plan anyway?`,
					};
				}
				if (gate) {
					const ok = await ctx.ui.confirm(gate.title, gate.body);
					if (!ok) {
						return {
							content: text(
								`The user declined to review a plan yet; they want the interview to continue. Use ${TOOL_ASK} to target the weakest areas and open decisions. ${statusLine(s)}`,
							),
							details: { outcome: "gated", confidence: b.overall },
						};
					}
					s.forcePlan = true;
				}
			}

			const steps: PlanStep[] = params.plan.steps.map((st) => ({
				title: st.title,
				details: st.details,
				verify: st.verify,
				status: "pending" as StepStatus,
			}));
			s.plan = {
				title: params.plan.title,
				summary: params.plan.summary,
				steps,
				assumptions: params.plan.assumptions ?? s.assessment?.assumptions ?? [],
				risks: params.plan.risks ?? [],
				outOfScope: params.plan.outOfScope ?? [],
				extraSections: [],
			};
			s.planRevision += 1;
			s.userEditedPlan = false;

			const outcome = await pf.review(ctx);
			return outcomeResult(pf, outcome);
		},

		renderCall(args, theme) {
			const plan = args.plan as { title?: string; steps?: unknown[] } | undefined;
			const pct = argConfidence(args);
			return new Text(
				theme.fg("toolTitle", theme.bold("✈ preflight plan ")) +
					theme.fg("text", plan?.title ?? "") +
					theme.fg("dim", plan?.steps ? ` · ${plan.steps.length} steps` : "") +
					confText(theme, pct, pf.state?.threshold ?? 85),
				0,
				0,
			);
		},

		renderResult(result, _opts, theme) {
			const outcome = (result.details as { outcome?: string } | undefined)?.outcome;
			const label: Record<string, string> = {
				approve: theme.fg("success", "✓ Approved — executing"),
				revise: theme.fg("warning", "✎ Changes requested"),
				interview: theme.fg("warning", "? Back to questions"),
				gated: theme.fg("warning", "Below threshold — continuing interview"),
				cancel: theme.fg("error", "✗ Preflight cancelled"),
				pause: theme.fg("muted", "Paused — waiting for your reply"),
			};
			return new Text(outcome ? (label[outcome] ?? outcome) : "", 0, 0);
		},
	});

	pi.registerTool({
		name: TOOL_STEP,
		label: "Preflight step",
		description:
			"Preflight execution: update the status of a plan step (in_progress, done, blocked, skipped) or add a newly discovered step. Drives the user's live checklist.",
		promptSnippet: "Update the preflight execution checklist",
		parameters: StepParams,
		exposure: "model-only",
		defaultActive: false,
		executionMode: "sequential",
		annotations: { readOnlyHint: true },

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = pf.state;
			if (!s || s.phase !== "executing" || !s.plan) throw new Error("No approved preflight plan is being executed.");
			const steps = s.plan.steps;
			let changed: number;

			if (params.action === "add") {
				if (!params.title?.trim()) throw new Error("title is required to add a step.");
				const at = Math.min(steps.length, Math.max(0, params.after ?? steps.length));
				steps.splice(at, 0, {
					title: params.title.trim(),
					details: params.details,
					verify: params.verify,
					status: "pending",
					note: params.note,
				});
				changed = at + 1;
			} else {
				if (!params.step || params.step > steps.length) {
					throw new Error(`step must be between 1 and ${steps.length}.`);
				}
				if (!params.status) throw new Error("status is required to update a step.");
				const step = steps[params.step - 1];
				step.status = params.status as StepStatus;
				if (params.note !== undefined) step.note = params.note;
				changed = params.step;
			}

			const st = stepStats(s.plan);
			const snapshot = structuredClone(s.plan);
			if (st.finished) {
				pf.stop(ctx, "done");
				ctx.ui.notify(`✈ Preflight complete — all ${st.total} steps done`, "info");
				return {
					content: text(
						`All ${st.total} steps are complete. Preflight is finished. Give the user a concise summary of what was done and how it was verified, and mention anything they should follow up on.`,
					),
					details: { plan: snapshot, changed, action: params.action, finished: true },
				};
			}

			pf.refresh(ctx);
			const next = steps.findIndex((x) => x.status === "pending" || x.status === "in_progress");
			return {
				content: text(
					`${params.action === "add" ? `Added step ${changed}` : `Step ${changed} → ${params.status}`}. Progress: ${st.done + st.skipped}/${st.total}${st.blocked ? `, ${st.blocked} blocked` : ""}.${next >= 0 ? ` Next: step ${next + 1}: ${steps[next].title}` : ""}`,
				),
				details: { plan: snapshot, changed, action: params.action, finished: false },
			};
		},

		renderCall(args, theme) {
			const icon: Record<string, string> = {
				in_progress: theme.fg("accent", "▶"),
				done: theme.fg("success", "✓"),
				blocked: theme.fg("error", "!"),
				skipped: theme.fg("dim", "–"),
				pending: theme.fg("muted", "○"),
			};
			const body =
				args.action === "add"
					? `${theme.fg("success", "+")} ${args.title ?? ""}`
					: `${icon[args.status ?? ""] ?? ""} step ${args.step ?? "?"} ${theme.fg("muted", args.status ?? "")}`;
			return new Text(
				theme.fg("toolTitle", theme.bold("✈ ")) + body + (args.note ? theme.fg("dim", ` — ${args.note}`) : ""),
				0,
				0,
			);
		},

		renderResult(result, _opts, theme) {
			const d = result.details as { plan?: { steps: PlanStep[] }; finished?: boolean; changed?: number } | undefined;
			if (!d?.plan) {
				const c = result.content[0];
				return new Text(c?.type === "text" ? c.text : "", 0, 0);
			}
			const st = stepStats({ ...d.plan, title: "", summary: "", assumptions: [], risks: [], outOfScope: [], extraSections: [] });
			const step = d.changed ? d.plan.steps[d.changed - 1] : undefined;
			const progress = theme.fg("muted", `${st.done + st.skipped}/${st.total}`);
			if (d.finished) return new Text(theme.fg("success", theme.bold(`✓ Preflight complete — ${st.total}/${st.total} steps`)), 0, 0);
			return new Text(`${progress} ${theme.fg("dim", step ? step.title : "")}`, 0, 0);
		},
	});
}
