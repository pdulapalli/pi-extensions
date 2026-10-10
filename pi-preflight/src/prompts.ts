/**
 * Model-facing instructions for each phase.
 */

import { planToMarkdown } from "./plan.ts";
import {
	computeConfidence,
	DECISION_PENALTY,
	ASSUMPTION_PENALTY,
	DIMENSION_LABELS,
	explainConfidence,
	type PreflightState,
	questionStats,
} from "./state.ts";

export function statusLine(s: PreflightState): string {
	const q = questionStats(s);
	const conf = s.assessment ? explainConfidence(computeConfidence(s.assessment)) : "not yet assessed";
	return `Confidence: ${conf}. Threshold: ${s.threshold}%. Questions: ${q.asked} asked, ${q.answered} answered, ${q.skipped} skipped. Open decisions: ${q.open}.`;
}

function qaDigest(s: PreflightState, limit = 40): string {
	if (!s.questions.length) return "(none yet)";
	const recent = s.questions.slice(-limit);
	return recent
		.map((q) => `- ${q.id} [${q.label}] ${q.prompt}\n  → ${q.status === "answered" ? q.answer : "(skipped by user)"}`)
		.join("\n");
}

export function interviewContext(s: PreflightState): string {
	const weakest = s.assessment
		? computeConfidence(s.assessment)
				.ranked.slice(0, 2)
				.map((r) => `${DIMENSION_LABELS[r.dimension]} (${r.score})`)
				.join(", ")
		: "unknown";
	return `[PREFLIGHT · INTERVIEW PHASE]
Objective (from the user):
${s.objective}

You are running a preflight interview. Do NOT start the work yet. Your job is to understand the request well enough that the plan is right the first time. You are in READ-ONLY mode: you may inspect files and run read-only commands, but must not modify anything.

How to run the interview:
1. Investigate first. Use read-only tools to learn what you can from the codebase and environment. Never ask the user something you could find out yourself; use what you found to ask sharper questions (e.g. "X already uses Y — should the new Z follow that pattern?").
2. Assess honestly. Every preflight_ask / preflight_plan call carries your assessment: 0–100 scores for goal, scope, constraints, successCriteria and approach; every unresolved open decision (with impact); and every assumption or judgment call you would otherwise have to make on the user's behalf. Ambiguity, judgment calls and open decisions LOWER confidence: the extension subtracts ${DECISION_PENALTY.high}/${DECISION_PENALTY.medium}/${DECISION_PENALTY.low} points per high/medium/low open decision and ${ASSUMPTION_PENALTY} per assumption, and overall confidence can't exceed your weakest dimension by more than 25. List them all rather than hiding them. Do not inflate scores.
3. Ask high-leverage questions with preflight_ask: 1–4 per round, targeting the weakest dimensions and highest-impact open decisions. Prefer concrete options (2–5) and mark a recommended option when you have a sensible default; the user can always type their own answer or skip. Never ask interview questions in plain text.
4. Stop when confident. Once overall confidence reaches ${s.threshold}%, call preflight_plan. Don't ask questions for the sake of it. If the user asks to skip ahead, call preflight_plan with your best plan and record the gaps as assumptions.

Current status: ${statusLine(s)}
Weakest dimensions: ${weakest}

Answers so far:
${qaDigest(s)}`;
}

export function executionContext(s: PreflightState): string {
	return `[PREFLIGHT · EXECUTING APPROVED PLAN]
Objective (from the user):
${s.objective}

The user approved this plan (it may include their edits — it supersedes any earlier draft). Follow it; ask before deviating materially.

${planToMarkdown(s.plan!, { statusLegend: true })}
Rules:
- Before starting a step call preflight_step { action: "update", step: N, status: "in_progress" }.
- When a step is finished AND verified, call preflight_step with status "done" (add a short note on what you did/verified).
- If you cannot proceed, mark it "blocked" with a note explaining why, then ask the user.
- If you discover necessary extra work, add it with preflight_step { action: "add", title, ... } instead of silently doing it.
- Work through the steps in order without stopping for confirmation unless blocked.

Interview record (decisions the user already made):
${qaDigest(s, 30)}`;
}

export function approvedMessage(s: PreflightState): string {
	return `Plan APPROVED by the user${s.userEditedPlan ? " (they edited it — follow this version exactly)" : ""}. Preflight is now in execution mode: write tools are re-enabled and preflight_step is available.

${planToMarkdown(s.plan!, { statusLegend: true })}
Begin executing now, starting with step 1. Call preflight_step to mark each step in_progress before you start it and done once verified.`;
}
