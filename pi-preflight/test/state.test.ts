import assert from "node:assert/strict";
import { test } from "node:test";
import { type Assessment, computeConfidence, slugify, stepStats } from "../src/state.ts";

const scores = (n: number) => ({ goal: n, scope: n, constraints: n, successCriteria: n, approach: n });
const assess = (over: Partial<Assessment> = {}): Assessment => ({
	scores: scores(90),
	openDecisions: [],
	assumptions: [],
	...over,
});

test("uniform scores with no ambiguity = that score", () => {
	assert.equal(computeConfidence(assess()).overall, 90);
});

test("open decisions and assumptions lower confidence", () => {
	const b = computeConfidence(
		assess({ openDecisions: [{ topic: "a", impact: "high" }, { topic: "b", impact: "low" }], assumptions: ["x", "y"] }),
	);
	assert.equal(b.decisionPenalty, 12);
	assert.equal(b.assumptionPenalty, 4);
	assert.equal(b.overall, 90 - 16);
});

test("penalty is capped", () => {
	const many = Array.from({ length: 20 }, (_, i) => ({ topic: `d${i}`, impact: "high" as const }));
	const b = computeConfidence(assess({ scores: scores(100), openDecisions: many }));
	assert.equal(b.penalty, 50);
	assert.equal(b.overall, 50);
});

test("weakest dimension caps overall", () => {
	const b = computeConfidence(assess({ scores: { ...scores(100), successCriteria: 40 } }));
	assert.equal(b.ranked[0].dimension, "successCriteria");
	assert.equal(b.overall, 65); // 40 + 25, even though the weighted base is 88
});

test("scores are clamped to 0..100", () => {
	assert.equal(computeConfidence(assess({ scores: scores(250) })).overall, 100);
	assert.equal(computeConfidence(assess({ scores: scores(-5) })).overall, 0);
});

test("stepStats", () => {
	const plan = {
		title: "t", summary: "", assumptions: [], risks: [], outOfScope: [], extraSections: [],
		steps: [
			{ title: "a", status: "done" as const },
			{ title: "b", status: "skipped" as const },
		],
	};
	assert.equal(stepStats(plan).finished, true);
	plan.steps.push({ title: "c", status: "blocked" as never });
	assert.equal(stepStats(plan).finished, false);
	assert.equal(stepStats(plan).blocked, 1);
});

test("slugify", () => {
	assert.equal(slugify("Add OAuth login to the Dashboard!"), "add-oauth-login-to-the-dashboard");
	assert.equal(slugify("!!!"), "plan");
});

test("slugify cuts long titles at a word boundary", () => {
	const s = slugify("Add input validation and JSON-file persistence to the todo API");
	assert.equal(s, "add-input-validation-and-json-file-persistence-to");
	assert.ok(s.length <= 50);
	assert.equal(slugify("x".repeat(80)).length, 50);
});
