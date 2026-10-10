/**
 * Shared preflight runtime: state, persistence, tool gating, review flow, saving.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exportMarkdown, markdownToPlan, planToMarkdown } from "./plan.ts";
import { READ_ONLY_BUILTINS } from "./safety.ts";
import {
	type Assessment,
	type ConfidenceBreakdown,
	computeConfidence,
	DEFAULT_THRESHOLD,
	isActive,
	type PreflightState,
	slugify,
} from "./state.ts";
import { showReview } from "./ui/review.ts";
import { hideWidget, updateUi } from "./ui/widget.ts";

export const STATE_ENTRY = "preflight-state";
export const CONTEXT_MESSAGE = "preflight-context";
export const TOOL_ASK = "preflight_ask";
export const TOOL_PLAN = "preflight_plan";
export const TOOL_STEP = "preflight_step";
export const PREFLIGHT_TOOLS = new Set([TOOL_ASK, TOOL_PLAN, TOOL_STEP]);
export const THRESHOLD_FLAG = "preflight-threshold";

export type ReviewOutcome =
	| { kind: "approve" }
	| { kind: "revise"; feedback: string }
	| { kind: "interview"; note?: string }
	| { kind: "cancel" }
	| { kind: "pause" };

export class Preflight {
	state: PreflightState | undefined;

	constructor(private readonly pi: ExtensionAPI) {}

	// ── Config ────────────────────────────────────────────────────────────

	threshold(): number {
		const raw = this.pi.getFlag(THRESHOLD_FLAG);
		const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
		return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : DEFAULT_THRESHOLD;
	}

	// ── Persistence ───────────────────────────────────────────────────────

	persist(): void {
		this.pi.appendEntry(STATE_ENTRY, this.state ?? null);
	}

	/** Rebuild from the active branch (branch-aware: abandoned branches are ignored). */
	restore(ctx: ExtensionContext): void {
		const previous = this.state;
		let restored: PreflightState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			const e = entry as { type: string; customType?: string; data?: unknown };
			if (e.type === "custom" && e.customType === STATE_ENTRY) {
				restored = (e.data as PreflightState | null) ?? undefined;
			}
		}
		this.state = restored ? structuredClone(restored) : undefined;
		if (isActive(this.state)) this.applyTools();
		else if (isActive(previous) && previous.toolsBefore) this.pi.setActiveTools(previous.toolsBefore);
		updateUi(ctx, this.state);
	}

	refresh(ctx: ExtensionContext): void {
		this.persist();
		updateUi(ctx, this.state);
		void this.syncSavedFile(ctx);
	}

	// ── Tool gating ───────────────────────────────────────────────────────

	baseTools(): string[] {
		return (this.state?.toolsBefore ?? this.pi.getActiveTools()).filter((t) => !PREFLIGHT_TOOLS.has(t));
	}

	/** Read-only tools available during the interview. */
	interviewTools(): Set<string> {
		const all = this.pi.getAllTools();
		const registered = new Set(all.map((t) => t.name));
		const annotatedReadOnly = new Set(all.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name));
		const allowed = new Set(this.baseTools().filter((t) => READ_ONLY_BUILTINS.has(t) || annotatedReadOnly.has(t)));
		// Make sure the basic read-only explorers are there even if the user had them off.
		for (const t of ["read", "grep", "find", "ls"]) if (registered.has(t)) allowed.add(t);
		allowed.add(TOOL_ASK);
		allowed.add(TOOL_PLAN);
		return allowed;
	}

	applyTools(): void {
		const s = this.state;
		if (!s) return;
		if (s.phase === "interview" || s.phase === "review") this.pi.setActiveTools([...this.interviewTools()]);
		else if (s.phase === "executing") this.pi.setActiveTools([...this.baseTools(), TOOL_STEP]);
		else this.pi.setActiveTools(this.baseTools());
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────

	stop(ctx: ExtensionContext, phase: "idle" | "done"): void {
		if (!this.state) return;
		this.state.phase = phase;
		if (this.state.toolsBefore) this.pi.setActiveTools(this.state.toolsBefore);
		this.refresh(ctx);
	}

	applyAssessment(assessment: Assessment): ConfidenceBreakdown {
		const s = this.state!;
		const normalized: Assessment = {
			scores: assessment.scores,
			openDecisions: assessment.openDecisions ?? [],
			assumptions: assessment.assumptions ?? [],
			summary: assessment.summary,
		};
		const b = computeConfidence(normalized);
		s.assessment = normalized;
		s.confidence = b.overall;
		if (s.history[s.history.length - 1] !== b.overall || s.history.length === 0) s.history.push(b.overall);
		return b;
	}

	// ── Review ────────────────────────────────────────────────────────────

	async review(ctx: ExtensionContext): Promise<ReviewOutcome> {
		const s = this.state!;
		s.phase = "review";
		this.applyTools();
		this.refresh(ctx);

		while (true) {
			const markdown = planToMarkdown(s.plan!);
			hideWidget(ctx); // the review header already shows confidence; give the plan the space
			const action = await showReview(ctx, markdown, {
				revision: s.planRevision,
				confidence: s.confidence,
				threshold: s.threshold,
				savedPath: s.savedPath,
				edited: s.userEditedPlan,
			});
			updateUi(ctx, s);

			switch (action) {
				case "edit": {
					const edited = await ctx.ui.editor("Edit the plan (Markdown checklist). Save to apply.", markdown);
					if (edited === undefined || edited.trim() === markdown.trim()) break;
					try {
						s.plan = markdownToPlan(edited);
						s.userEditedPlan = true;
						this.refresh(ctx);
						ctx.ui.notify(`Plan updated (${s.plan.steps.length} steps)`, "info");
					} catch (err) {
						ctx.ui.notify(`Couldn't apply edit: ${(err as Error).message}`, "error");
					}
					break;
				}
				case "save":
					await this.promptSave(ctx, false);
					break;
				case "approve": {
					if (!s.savedPath) await this.promptSave(ctx, true);
					s.phase = "executing";
					this.applyTools();
					this.refresh(ctx);
					return { kind: "approve" };
				}
				case "revise": {
					const feedback = await ctx.ui.editor("What should change in the plan?", "");
					if (!feedback?.trim()) break;
					s.phase = "interview";
					this.refresh(ctx);
					return { kind: "revise", feedback: feedback.trim() };
				}
				case "interview": {
					const note = await ctx.ui.input("What still feels unclear? (optional)", "e.g. how we roll this out");
					s.phase = "interview";
					s.forcePlan = false;
					this.refresh(ctx);
					return { kind: "interview", note: note?.trim() || undefined };
				}
				case "cancel": {
					const ok = await ctx.ui.confirm(
						"Cancel preflight?",
						"The plan stays in the session history and normal tools are restored.",
					);
					if (!ok) break;
					this.stop(ctx, "idle");
					return { kind: "cancel" };
				}
				case "pause":
					this.refresh(ctx);
					return { kind: "pause" };
			}
		}
	}

	// ── Saving ────────────────────────────────────────────────────────────

	defaultSavePath(): string {
		const s = this.state!;
		const date = s.startedAt.slice(0, 10);
		return `.pi/preflight/${date}-${slugify(s.plan?.title || s.objective)}.md`;
	}

	/** Ask where to save. `offerSkip` adds a "keep in session only" choice (used on approval). */
	async promptSave(ctx: ExtensionContext, offerSkip: boolean): Promise<void> {
		const def = this.defaultSavePath();
		const SKIP = "Keep in session only";
		const DEFAULT = `Save to ${def}`;
		const CUSTOM = "Save to a custom path…";
		const options = offerSkip ? [SKIP, DEFAULT, CUSTOM] : [DEFAULT, CUSTOM];
		const choice = await ctx.ui.select(offerSkip ? "Plan approved. Save a copy to disk?" : "Save plan to disk", options);
		if (!choice || choice === SKIP) return;
		let path = def;
		if (choice === CUSTOM) {
			const input = await ctx.ui.input("Save plan to (relative to project or absolute; empty = default):", def);
			if (input === undefined) return;
			path = input.trim() || def;
		}
		await this.save(ctx, path);
	}

	async save(ctx: ExtensionContext, path: string, opts: { confirmOverwrite?: boolean } = {}): Promise<string | undefined> {
		const s = this.state;
		if (!s?.plan) {
			ctx.ui.notify("No plan to save yet.", "warning");
			return undefined;
		}
		const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);
		const display = relative(ctx.cwd, abs).startsWith("..") ? abs : relative(ctx.cwd, abs);
		if ((opts.confirmOverwrite ?? true) && existsSync(abs) && display !== s.savedPath && ctx.hasUI) {
			const ok = await ctx.ui.confirm("File exists", `Overwrite ${display}?`);
			if (!ok) return undefined;
		}
		try {
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, exportMarkdown(s), "utf8");
		} catch (err) {
			ctx.ui.notify(`Failed to save plan: ${(err as Error).message}`, "error");
			return undefined;
		}
		s.savedPath = display;
		this.persist();
		updateUi(ctx, s);
		ctx.ui.notify(`Plan saved → ${display}`, "info");
		return display;
	}

	/** Once saved, keep the file in sync with plan edits and step progress. */
	private async syncSavedFile(ctx: ExtensionContext): Promise<void> {
		const s = this.state;
		if (!s?.plan || !s.savedPath) return;
		try {
			const abs = isAbsolute(s.savedPath) ? s.savedPath : resolve(ctx.cwd, s.savedPath);
			await writeFile(abs, exportMarkdown(s), "utf8");
		} catch {
			// Best effort; the session copy is authoritative.
		}
	}
}
