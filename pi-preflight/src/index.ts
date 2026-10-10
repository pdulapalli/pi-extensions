/**
 * pi-preflight — interview → plan → execute.
 *
 *   /preflight <objective>   start: the agent interviews you (read-only) until it is confident,
 *                            then proposes a plan you can edit/approve, then executes it with a
 *                            live checklist.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_MESSAGE,
	Preflight,
	PREFLIGHT_TOOLS,
	type ReviewOutcome,
	THRESHOLD_FLAG,
	TOOL_ASK,
	TOOL_PLAN,
} from "./controller.ts";
import { markdownToPlan, planToMarkdown } from "./plan.ts";
import { approvedMessage, executionContext, interviewContext } from "./prompts.ts";
import { isSafeCommand } from "./safety.ts";
import {
	computeConfidence,
	DIMENSION_LABELS,
	DIMENSIONS,
	explainConfidence,
	isActive,
	newState,
	type PreflightState,
	questionStats,
	stepStats,
} from "./state.ts";
import { registerTools } from "./tools.ts";
import { showDocument } from "./ui/review.ts";
import { updateUi } from "./ui/widget.ts";

const SUBCOMMANDS: { name: string; description: string }[] = [
	{ name: "status", description: "Show confidence breakdown, questions and plan" },
	{ name: "review", description: "Reopen the plan review" },
	{ name: "plan", description: "Skip ahead: ask the agent to draft the plan now" },
	{ name: "edit", description: "Edit the plan (also during execution)" },
	{ name: "export", description: "Save the plan + interview record to a Markdown file" },
	{ name: "continue", description: "Nudge the agent to continue the current phase" },
	{ name: "cancel", description: "Stop preflight and restore normal tools" },
	{ name: "help", description: "Show usage" },
];

const HELP = `**/preflight <objective>** — start a preflight

The agent investigates (read-only) and interviews you in rounds of 1–4 questions, tracking a confidence score. Ambiguity, open decisions and judgment calls lower it. Once it reaches the threshold (default 85%, \`--${THRESHOLD_FLAG} <n>\`), it proposes a plan you can edit, revise or approve. After approval it executes with a live checklist.

| Command | |
|---|---|
${SUBCOMMANDS.map((c) => `| \`/preflight ${c.name}\` | ${c.description} |`).join("\n")}
`;

function statusMarkdown(s: PreflightState): string {
	const out: string[] = [];
	const q = questionStats(s);
	out.push(`**Phase:** ${s.phase} · **Threshold:** ${s.threshold}%`, "", `**Objective:** ${s.objective}`, "");
	if (s.assessment) {
		const b = computeConfidence(s.assessment);
		out.push(`## Confidence ${b.overall}%`, "", explainConfidence(b), "");
		if (s.history.length > 1) out.push(`Trend: ${s.history.join(" → ")}`, "");
		out.push("| Dimension | Score |", "|---|---|");
		for (const d of DIMENSIONS) out.push(`| ${DIMENSION_LABELS[d]} | ${s.assessment.scores[d]} |`);
		out.push("");
		if (s.assessment.summary) out.push(`_Most unclear:_ ${s.assessment.summary}`, "");
		if (s.assessment.openDecisions.length) {
			out.push("**Open decisions**", "");
			for (const d of s.assessment.openDecisions) out.push(`- ${d.topic} _(${d.impact})_`);
			out.push("");
		}
		if (s.assessment.assumptions.length) {
			out.push("**Assumptions / judgment calls**", "");
			for (const a of s.assessment.assumptions) out.push(`- ${a}`);
			out.push("");
		}
	}
	out.push(`## Questions — ${q.asked} asked · ${q.answered} answered · ${q.skipped} skipped`, "");
	for (const r of s.questions) {
		out.push(`- **${r.id} ${r.label}:** ${r.prompt}`, `  → ${r.status === "answered" ? r.answer : "_skipped_"}`);
	}
	if (s.plan) {
		const st = stepStats(s.plan);
		out.push("", `## Plan (rev ${s.planRevision}${s.userEditedPlan ? ", edited" : ""}) — ${st.done + st.skipped}/${st.total} done`, "");
		out.push(planToMarkdown(s.plan, { statusLegend: true }));
		if (s.savedPath) out.push(`_Saved to ${s.savedPath}_`);
	}
	return out.join("\n");
}

export default function preflightExtension(pi: ExtensionAPI): void {
	const pf = new Preflight(pi);

	pi.registerFlag(THRESHOLD_FLAG, {
		description: "Confidence % required before preflight proposes a plan (default 85)",
		type: "string",
		default: "85",
	});

	registerTools(pi, pf);

	// ── Session lifecycle ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => pf.restore(ctx));
	pi.on("session_tree", async (_event, ctx) => pf.restore(ctx));

	// ── Read-only enforcement during the interview ───────────────────────

	pi.on("tool_call", async (event) => {
		const s = pf.state;
		if (!s || (s.phase !== "interview" && s.phase !== "review")) return;
		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Preflight interview is read-only; this command isn't on the read-only allowlist:\n${command}\nGather information with read-only commands, or ask the user with ${TOOL_ASK}.`,
				};
			}
			return;
		}
		if (!pf.interviewTools().has(event.toolName)) {
			return {
				block: true,
				reason: `Preflight interview is read-only; "${event.toolName}" is unavailable until the plan is approved.`,
			};
		}
	});

	// ── Phase instructions ───────────────────────────────────────────────

	pi.on("before_agent_start", async () => {
		const s = pf.state;
		if (!isActive(s)) return;
		const content = s.phase === "executing" && s.plan ? executionContext(s) : interviewContext(s);
		return { message: { customType: CONTEXT_MESSAGE, content, display: false } };
	});

	// Keep only the newest phase-instruction message in context (and none once preflight ends).
	pi.on("context", async (event) => {
		const isCtx = (m: AgentMessage) => (m as { customType?: string }).customType === CONTEXT_MESSAGE;
		const count = event.messages.filter(isCtx).length;
		if (count === 0) return;
		const keepLast = isActive(pf.state);
		let seen = 0;
		return {
			messages: event.messages.filter((m) => {
				if (!isCtx(m)) return true;
				seen += 1;
				return keepLast && seen === count;
			}),
		};
	});

	// ── Command ──────────────────────────────────────────────────────────

	const nudge = (content: string) =>
		pi.sendMessage({ customType: "preflight-control", content, display: true }, { triggerTurn: true });

	async function start(objective: string, ctx: ExtensionCommandContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify("/preflight needs an interactive UI", "error");
			return;
		}
		let toolsBefore = pi.getActiveTools().filter((t) => !PREFLIGHT_TOOLS.has(t));
		if (isActive(pf.state)) {
			const ok = await ctx.ui.confirm("Replace the current preflight?", `Current objective: ${pf.state.objective}`);
			if (!ok) return;
			toolsBefore = pf.state.toolsBefore ?? toolsBefore;
		}
		await ctx.waitForIdle();
		pf.state = newState(objective, pf.threshold(), toolsBefore);
		pf.applyTools();
		pf.refresh(ctx);
		pi.sendMessage(
			{ customType: "preflight-start", content: `✈ Preflight objective:\n\n${objective}`, display: true },
			{ triggerTurn: true },
		);
	}

	async function handleReviewOutcome(outcome: ReviewOutcome) {
		const s = pf.state!;
		switch (outcome.kind) {
			case "approve":
				nudge(approvedMessage(s));
				break;
			case "revise":
				nudge(`The user requested changes to the plan:\n\n${outcome.feedback}\n\nRevise it and call ${TOOL_PLAN} again.`);
				break;
			case "interview":
				nudge(
					`The user wants more questions before planning.${outcome.note ? ` They said: "${outcome.note}"` : ""} Continue with ${TOOL_ASK}.`,
				);
				break;
			default:
				break;
		}
	}

	pi.registerCommand("preflight", {
		description: "Interview → plan → execute. /preflight <objective> | status | review | plan | edit | export | cancel",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trim().toLowerCase();
			if (p.includes(" ")) return null;
			const items = SUBCOMMANDS.filter((c) => c.name.startsWith(p)).map((c) => ({
				value: c.name,
				label: c.name,
				description: c.description,
			}));
			return items.length ? items : null;
		},
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			const [first = "", ...rest] = args.split(/\s+/);
			const sub = first.toLowerCase();
			const isSub = (name: string) => sub === name && (rest.length === 0 || name === "export");
			const s = pf.state;

			if (!args) {
				if (isActive(s)) return showDocument(ctx, "✈ Preflight status", statusMarkdown(s));
				const objective = await ctx.ui.editor("What do you want to accomplish? (preflight objective)", "");
				if (objective?.trim()) await start(objective.trim(), ctx);
				return;
			}

			if (isSub("help")) return showDocument(ctx, "✈ Preflight help", HELP);

			if (isSub("status")) {
				if (!s) return ctx.ui.notify("No preflight in this session. Start one with /preflight <objective>", "info");
				return showDocument(ctx, "✈ Preflight status", statusMarkdown(s));
			}

			if (isSub("export")) {
				if (!s?.plan) return ctx.ui.notify("No plan to export yet.", "warning");
				const path = rest.join(" ").trim();
				if (path) await pf.save(ctx, path);
				else await pf.promptSave(ctx, false);
				return;
			}

			if (isSub("cancel") || isSub("stop")) {
				if (!isActive(s)) return ctx.ui.notify("No active preflight.", "info");
				if (!ctx.isIdle()) ctx.abort();
				pf.stop(ctx, "idle");
				return ctx.ui.notify("Preflight cancelled; normal tools restored.", "info");
			}

			if (isSub("review")) {
				if (!s?.plan || !isActive(s) || s.phase === "executing") {
					return ctx.ui.notify("No plan awaiting review.", "info");
				}
				await ctx.waitForIdle();
				return handleReviewOutcome(await pf.review(ctx));
			}

			if (isSub("plan")) {
				if (!s || (s.phase !== "interview" && s.phase !== "review")) {
					return ctx.ui.notify("No preflight interview in progress.", "info");
				}
				s.forcePlan = true;
				pf.refresh(ctx);
				await ctx.waitForIdle();
				return nudge(
					`The user wants to move to planning now. Call ${TOOL_PLAN} with your best plan; record every unresolved point as an assumption or open decision.`,
				);
			}

			if (isSub("edit")) {
				if (!s?.plan || !isActive(s)) return ctx.ui.notify("No plan to edit yet.", "info");
				const before = planToMarkdown(s.plan, { statusLegend: s.phase === "executing" });
				const edited = await ctx.ui.editor("Edit the plan (Markdown checklist). Save to apply.", before);
				if (edited === undefined || edited.trim() === before.trim()) return;
				try {
					s.plan = markdownToPlan(edited);
				} catch (err) {
					return ctx.ui.notify(`Couldn't apply edit: ${(err as Error).message}`, "error");
				}
				s.userEditedPlan = true;
				pf.refresh(ctx);
				ctx.ui.notify(`Plan updated (${s.plan.steps.length} steps)`, "info");
				if (s.phase === "executing") {
					pi.sendMessage(
						{
							customType: "preflight-control",
							content: `The user edited the plan. Follow this version from now on:\n\n${planToMarkdown(s.plan, { statusLegend: true })}`,
							display: false,
						},
						{ deliverAs: ctx.isIdle() ? "nextTurn" : "steer" },
					);
				}
				return;
			}

			if (isSub("continue") || isSub("resume")) {
				if (!isActive(s)) return ctx.ui.notify("No active preflight.", "info");
				if (s.phase === "review" && s.plan) {
					await ctx.waitForIdle();
					return handleReviewOutcome(await pf.review(ctx));
				}
				await ctx.waitForIdle();
				return nudge(s.phase === "executing" ? "Continue executing the plan." : "Continue the preflight interview.");
			}

			await start(args, ctx);
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => updateUi(ctx, undefined));
}
