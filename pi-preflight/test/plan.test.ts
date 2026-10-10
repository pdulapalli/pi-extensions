import assert from "node:assert/strict";
import { test } from "node:test";
import { exportMarkdown, markdownToPlan, PlanParseError, planToMarkdown } from "../src/plan.ts";
import { newState, type Plan } from "../src/state.ts";

const plan: Plan = {
	title: "Add OAuth login",
	summary: "Use the existing auth module.\n\nKeep sessions server-side.",
	steps: [
		{ title: "Add provider config", details: "Edit src/auth/config.ts\nAdd GitHub provider", verify: "unit tests pass", status: "done", note: "added" },
		{ title: "Wire callback route", status: "in_progress" },
		{ title: "Write e2e test", status: "blocked", note: "no test creds" },
		{ title: "Update docs", status: "skipped" },
		{ title: "Ship", status: "pending" },
	],
	assumptions: ["GitHub only for now"],
	risks: ["Callback URL differs per env"],
	outOfScope: ["SAML"],
	extraSections: [{ heading: "Rollout", body: "Behind a flag." }],
};

test("markdown round-trip preserves the plan", () => {
	const md = planToMarkdown(plan, { statusLegend: true });
	assert.deepEqual(markdownToPlan(md), plan);
});

test("parses a hand-written plan", () => {
	const md = `# My plan

Some context.

## Steps
1. First thing
   more detail
   Verify: it works
2) Second thing

## Out of scope
- Not this
- Nor this,
  continued
`;
	const p = markdownToPlan(md);
	assert.equal(p.title, "My plan");
	assert.equal(p.summary, "Some context.");
	assert.deepEqual(
		p.steps.map((s) => [s.title, s.status, s.details, s.verify]),
		[
			["First thing", "pending", "more detail", "it works"],
			["Second thing", "pending", undefined, undefined],
		],
	);
	assert.deepEqual(p.outOfScope, ["Not this", "Nor this, continued"]);
});

test("plain bullets count as steps when there's no checklist", () => {
	const p = markdownToPlan("# T\n\n## Steps\n- one\n- two\n");
	assert.deepEqual(p.steps.map((s) => s.title), ["one", "two"]);
});

test("checklist without a Steps heading still parses", () => {
	const p = markdownToPlan("# T\n\nIntro\n- [ ] a thing\n- [x] another\n");
	assert.deepEqual(p.steps.map((s) => [s.title, s.status]), [["a thing", "pending"], ["another", "done"]]);
	assert.equal(p.summary, "Intro");
});

test("headings inside code fences don't start sections", () => {
	const p = markdownToPlan("# T\n\n## Steps\n- [ ] a\n  ```\n  ## not a heading\n  ```\n");
	assert.equal(p.steps.length, 1);
	assert.match(p.steps[0].details ?? "", /## not a heading/);
});

test("rejects a plan with no steps", () => {
	assert.throws(() => markdownToPlan("# T\n\nJust prose."), PlanParseError);
});

test("export includes the interview record", () => {
	const s = newState("Add login", 85, []);
	s.plan = plan;
	s.assessment = { scores: { goal: 90, scope: 90, constraints: 90, successCriteria: 90, approach: 90 }, openDecisions: [], assumptions: [] };
	s.questions.push({ id: "Q1", round: 1, label: "Provider", prompt: "Which provider?", status: "answered", answer: "GitHub" });
	const md = exportMarkdown(s);
	assert.match(md, /## Preflight record/);
	assert.match(md, /\*\*Q1 · Provider\*\* — Which provider\?/);
	assert.match(md, /> GitHub/);
	assert.match(md, /Confidence:\*\* 90%/);
});

test("checkbox items typed under another section become steps", () => {
	const md = `${planToMarkdown(plan)}- [ ] 6. Final smoke test\n  Verify: curl works\n`;
	const p = markdownToPlan(md);
	assert.equal(p.steps.length, 6);
	assert.deepEqual([p.steps[5].title, p.steps[5].verify], ["Final smoke test", "curl works"]);
	assert.deepEqual(p.extraSections, plan.extraSections);
	assert.deepEqual(markdownToPlan(planToMarkdown(p)), p); // stable after the move
});
