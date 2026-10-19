import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isLimitError, resetFromHeaders, resetFromText } from "./parse.ts";

const MESSAGE = process.env.PI_LIMIT_RESUME_MESSAGE ?? "continue";
const BUFFER_MS = 30_000;
const FALLBACK_MS = 30 * 60_000;
const MAX_ATTEMPTS = 8;

export default function limitResume(pi: ExtensionAPI): void {
	let headerReset: number | undefined;
	let pendingReset: number | undefined;
	let scheduledAt: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let attempts = 0;
	let isSelfSent = false;

	const cancel = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		scheduledAt = undefined;
		pendingReset = undefined;
	};

	pi.on("after_provider_response", (event) => {
		if (event.status === 429 || event.status === 529) headerReset = resetFromHeaders(event.headers);
	});

	pi.on("message_end", (event) => {
		const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string };
		if (msg.role !== "assistant") return;
		if (msg.stopReason !== "error" || !isLimitError(msg.errorMessage)) {
			if (msg.stopReason !== "error") attempts = 0;
			pendingReset = undefined;
			headerReset = undefined;
			return;
		}
		const now = Date.now();
		const candidates = [headerReset, resetFromText(msg.errorMessage ?? "", now)].filter((t): t is number => !!t && t > now);
		pendingReset = candidates.length ? Math.max(...candidates) : now + FALLBACK_MS;
		headerReset = undefined;
	});

	pi.on("agent_settled", (event, ctx: ExtensionContext) => {
		if (event.aborted || pendingReset === undefined) return;
		const reset = pendingReset;
		cancel();
		if (++attempts > MAX_ATTEMPTS) {
			attempts = 0;
			ctx.ui.notify(`limit-resume: gave up after ${MAX_ATTEMPTS} attempts`, "warning");
			return;
		}
		scheduledAt = reset + BUFFER_MS;
		timer = setTimeout(() => {
			timer = undefined;
			scheduledAt = undefined;
			isSelfSent = true;
			pi.sendUserMessage(MESSAGE, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		}, Math.max(0, scheduledAt - Date.now()));
		ctx.ui.notify(`limit-resume: will send "${MESSAGE}" at ${new Date(scheduledAt).toLocaleTimeString()} (/limit-resume cancel)`, "info");
	});

	pi.on("input", (event) => {
		if (event.text.startsWith("/limit-resume")) return;
		if (isSelfSent) isSelfSent = false;
		else cancel();
	});

	pi.registerCommand("limit-resume", {
		description: "Show or cancel the scheduled continue: /limit-resume [cancel]",
		handler: async (args, ctx) => {
			if (args.trim() === "cancel") {
				cancel();
				attempts = 0;
				ctx.ui.notify("limit-resume: cancelled", "info");
				return;
			}
			ctx.ui.notify(scheduledAt ? `limit-resume: "${MESSAGE}" at ${new Date(scheduledAt).toLocaleTimeString()}` : "limit-resume: nothing scheduled", "info");
		},
	});

	pi.on("session_shutdown", cancel);
}
