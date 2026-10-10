/**
 * Preflight state model and confidence math.
 *
 * Pure module (no pi imports) so it can be unit tested directly.
 */

export type Phase = "idle" | "interview" | "review" | "executing" | "done";

export const DIMENSIONS = ["goal", "scope", "constraints", "successCriteria", "approach"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<Dimension, string> = {
	goal: "Goal",
	scope: "Scope",
	constraints: "Constraints",
	successCriteria: "Success criteria",
	approach: "Approach",
};

/** Relative importance of each dimension. Sums to 1. */
export const DIMENSION_WEIGHTS: Record<Dimension, number> = {
	goal: 0.25,
	scope: 0.2,
	constraints: 0.15,
	successCriteria: 0.2,
	approach: 0.2,
};

export type Impact = "low" | "medium" | "high";

/** Confidence points subtracted per unresolved decision, by impact. */
export const DECISION_PENALTY: Record<Impact, number> = { low: 2, medium: 5, high: 10 };
/** Confidence points subtracted per unconfirmed assumption / judgment call. */
export const ASSUMPTION_PENALTY = 2;
/** Upper bound on the total ambiguity penalty. */
export const MAX_PENALTY = 50;
/** Overall confidence can never exceed the weakest dimension by more than this. */
export const WEAKEST_LINK_MARGIN = 25;

export const DEFAULT_THRESHOLD = 85;

export interface OpenDecision {
	topic: string;
	impact: Impact;
}

export interface Assessment {
	scores: Record<Dimension, number>;
	openDecisions: OpenDecision[];
	assumptions: string[];
	summary?: string;
}

export interface ConfidenceBreakdown {
	/** Weighted average of dimension scores. */
	base: number;
	decisionPenalty: number;
	assumptionPenalty: number;
	/** Total penalty actually applied (after MAX_PENALTY cap). */
	penalty: number;
	/** Weakest-link ceiling (min dimension + margin). */
	ceiling: number;
	overall: number;
	/** Dimensions sorted from weakest to strongest. */
	ranked: { dimension: Dimension; score: number }[];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function computeConfidence(a: Assessment): ConfidenceBreakdown {
	const scores = DIMENSIONS.map((d) => ({ dimension: d, score: clamp(Number(a.scores[d]) || 0, 0, 100) }));
	const base = scores.reduce((sum, s) => sum + s.score * DIMENSION_WEIGHTS[s.dimension], 0);
	const decisionPenalty = a.openDecisions.reduce((sum, d) => sum + (DECISION_PENALTY[d.impact] ?? 0), 0);
	const assumptionPenalty = a.assumptions.length * ASSUMPTION_PENALTY;
	const penalty = Math.min(MAX_PENALTY, decisionPenalty + assumptionPenalty);
	const ranked = [...scores].sort((x, y) => x.score - y.score);
	const ceiling = (ranked[0]?.score ?? 0) + WEAKEST_LINK_MARGIN;
	const overall = Math.round(clamp(Math.min(base - penalty, ceiling), 0, 100));
	return {
		base: Math.round(base),
		decisionPenalty,
		assumptionPenalty,
		penalty,
		ceiling,
		overall,
		ranked,
	};
}

export function explainConfidence(b: ConfidenceBreakdown): string {
	const parts = [`base ${b.base}`];
	if (b.decisionPenalty) parts.push(`−${b.decisionPenalty} open decisions`);
	if (b.assumptionPenalty) parts.push(`−${b.assumptionPenalty} assumptions`);
	if (b.decisionPenalty + b.assumptionPenalty > b.penalty) parts.push(`(penalty capped at ${b.penalty})`);
	let text = `${b.overall}% (${parts.join(" ")})`;
	if (b.base - b.penalty > b.ceiling) {
		const weakest = b.ranked[0];
		text += `, capped at ${b.ceiling} by weakest dimension ${DIMENSION_LABELS[weakest.dimension]} (${weakest.score})`;
	}
	return text;
}

export interface QuestionRecord {
	id: string;
	round: number;
	label: string;
	prompt: string;
	why?: string;
	dimension?: Dimension;
	status: "answered" | "skipped";
	answer?: string;
	wasCustom?: boolean;
}

export type StepStatus = "pending" | "in_progress" | "done" | "blocked" | "skipped";

export interface PlanStep {
	title: string;
	details?: string;
	verify?: string;
	status: StepStatus;
	note?: string;
}

export interface Plan {
	title: string;
	summary: string;
	steps: PlanStep[];
	assumptions: string[];
	risks: string[];
	outOfScope: string[];
	extraSections: { heading: string; body: string }[];
}

export interface PreflightState {
	version: 1;
	phase: Phase;
	objective: string;
	threshold: number;
	assessment?: Assessment;
	confidence?: number;
	/** Confidence after each assessment, oldest first. */
	history: number[];
	questions: QuestionRecord[];
	rounds: number;
	plan?: Plan;
	planRevision: number;
	userEditedPlan: boolean;
	savedPath?: string;
	/** User explicitly allowed planning below the threshold. */
	forcePlan: boolean;
	/** Active tools before preflight started; restored afterwards. */
	toolsBefore?: string[];
	startedAt: string;
}

export function newState(objective: string, threshold: number, toolsBefore: string[]): PreflightState {
	return {
		version: 1,
		phase: "interview",
		objective,
		threshold,
		history: [],
		questions: [],
		rounds: 0,
		planRevision: 0,
		userEditedPlan: false,
		forcePlan: false,
		toolsBefore,
		startedAt: new Date().toISOString(),
	};
}

export function isActive(s: PreflightState | undefined): s is PreflightState {
	return !!s && (s.phase === "interview" || s.phase === "review" || s.phase === "executing");
}

export function questionStats(s: PreflightState) {
	const answered = s.questions.filter((q) => q.status === "answered").length;
	const skipped = s.questions.filter((q) => q.status === "skipped").length;
	return {
		asked: s.questions.length,
		answered,
		skipped,
		open: s.assessment?.openDecisions.length ?? 0,
		openHigh: s.assessment?.openDecisions.filter((d) => d.impact === "high").length ?? 0,
	};
}

export function stepStats(plan: Plan | undefined) {
	const steps = plan?.steps ?? [];
	const count = (st: StepStatus) => steps.filter((s) => s.status === st).length;
	const done = count("done");
	const skipped = count("skipped");
	return {
		total: steps.length,
		done,
		skipped,
		blocked: count("blocked"),
		inProgress: count("in_progress"),
		finished: steps.length > 0 && done + skipped === steps.length,
	};
}

export function slugify(text: string, max = 50): string {
	const full = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (full.length <= max) return full || "plan";
	// Cut at a word boundary rather than mid-word.
	const cut = full.slice(0, max + 1);
	const boundary = cut.lastIndexOf("-");
	return (boundary > 0 ? cut.slice(0, boundary) : full.slice(0, max)) || "plan";
}
