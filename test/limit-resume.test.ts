import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import limitResume from "../src/index.ts";
import { isLimitError, resetFromHeaders, resetFromText } from "../src/parse.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");

function mockPi() {
	const handlers = new Map<string, Function[]>();
	const sent: unknown[][] = [];
	const notes: string[] = [];
	const commands = new Map<string, { handler: Function }>();
	const pi = {
		on: (name: string, fn: Function) => void handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		sendUserMessage: (...args: unknown[]) => void sent.push(args),
		registerCommand: (name: string, def: { handler: Function }) => void commands.set(name, def),
	};
	const ctx = { isIdle: () => true, ui: { notify: (m: string) => void notes.push(m) } };
	const emit = (name: string, event: object) => handlers.get(name)?.forEach((fn) => fn({ type: name, ...event }, ctx));
	limitResume(pi as never);
	return { emit, sent, notes, commands, ctx };
}

function hitLimit(p: ReturnType<typeof mockPi>, errorMessage: string, headers?: Record<string, string>) {
	if (headers) p.emit("after_provider_response", { status: 429, headers });
	p.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage } });
	p.emit("agent_settled", { aborted: false });
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW }));
afterEach(() => mock.timers.reset());

test("codex: friendly message minutes", () => {
	const p = mockPi();
	hitLimit(p, "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.");
	mock.timers.tick(42 * 60_000 + 29_000);
	assert.equal(p.sent.length, 0);
	mock.timers.tick(1_000);
	assert.deepEqual(p.sent, [["continue", undefined]]);
});

test("codex: raw error body with resets_at and header beats text", () => {
	const p = mockPi();
	const resetsAt = NOW / 1000 + 3600;
	hitLimit(p, `{"error":{"type":"usage_limit_reached","resets_at":${resetsAt}}}`, { "x-codex-primary-reset-after-seconds": "7200" });
	mock.timers.tick(3600_000 + 30_000);
	assert.equal(p.sent.length, 0);
	mock.timers.tick(3600_000);
	assert.equal(p.sent.length, 1);
});

test("claude: unified reset header (epoch seconds)", () => {
	const p = mockPi();
	hitLimit(p, '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}', {
		"anthropic-ratelimit-unified-reset": String(NOW / 1000 + 5 * 3600),
		"anthropic-ratelimit-unified-status": "rejected",
	});
	mock.timers.tick(5 * 3600_000 + 30_000);
	assert.equal(p.sent.length, 1);
});

test("unknown reset falls back to 30 min", () => {
	const p = mockPi();
	hitLimit(p, "Too many requests");
	mock.timers.tick(30 * 60_000 + 30_000);
	assert.equal(p.sent.length, 1);
});

test("non-limit error schedules nothing", () => {
	const p = mockPi();
	hitLimit(p, "socket hang up");
	mock.timers.tick(864e5);
	assert.equal(p.sent.length, 0);
});

test("pi auto-retry success clears the pending reset", () => {
	const p = mockPi();
	p.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "rate limit, retry in 5s" } });
	p.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
	p.emit("agent_settled", { aborted: false });
	mock.timers.tick(864e5);
	assert.equal(p.sent.length, 0);
});

test("user input cancels; own continue does not", () => {
	const p = mockPi();
	hitLimit(p, "usage limit, try again in 1 min");
	p.emit("input", { text: "do something else", source: "interactive" });
	mock.timers.tick(864e5);
	assert.equal(p.sent.length, 0);
	hitLimit(p, "usage limit, try again in 1 min");
	mock.timers.tick(90_000);
	p.emit("input", { text: "continue", source: "extension" });
	hitLimit(p, "usage limit, try again in 1 min");
	mock.timers.tick(90_000);
	assert.equal(p.sent.length, 2);
});

test("aborted run and /limit-resume cancel do nothing", async () => {
	const p = mockPi();
	p.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "usage limit" } });
	p.emit("agent_settled", { aborted: true });
	hitLimit(p, "usage limit, try again in 1 min");
	p.emit("input", { text: "/limit-resume", source: "interactive" });
	await p.commands.get("limit-resume")!.handler("", p.ctx);
	assert.match(p.notes.at(-1)!, /at /);
	await p.commands.get("limit-resume")!.handler("cancel", p.ctx);
	mock.timers.tick(864e5);
	assert.equal(p.sent.length, 0);
});

test("gives up after 8 consecutive limits", () => {
	const p = mockPi();
	for (let i = 0; i < 9; i++) {
		hitLimit(p, "usage limit, try again in 1 min");
		mock.timers.tick(90_000);
		p.emit("input", { text: "continue", source: "extension" });
	}
	assert.equal(p.sent.length, 8);
	assert.match(p.notes.at(-1)!, /gave up/);
});

test("parsers", () => {
	assert.equal(isLimitError("overloaded"), false);
	assert.equal(resetFromHeaders({ "retry-after": "120" }, NOW), NOW + 120_000);
	assert.equal(resetFromHeaders({ "x-ratelimit-reset-requests": "1m30s" }, NOW), NOW + 90_000);
	assert.equal(resetFromHeaders({ "anthropic-ratelimit-tokens-reset": "2026-10-20T13:00:00Z" }, NOW), NOW + 3600_000);
	assert.equal(resetFromText("limit resets at 2026-10-20T14:00:00Z", NOW), NOW + 7200_000);
	assert.equal(resetFromText("try again in 2 hours", NOW), NOW + 7200_000);
	assert.equal(resetFromText("no time here", NOW), undefined);
});
