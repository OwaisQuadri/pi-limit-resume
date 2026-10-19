const LIMIT_PATTERN =
	/usage.?limit|rate.?limit|too many requests|\b429\b|quota|limit reached|resets?(?:_at| at| in)|overloaded_error/i;

export function isLimitError(text: string | undefined): boolean {
	return !!text && LIMIT_PATTERN.test(text);
}

const UNIT_MS: Record<string, number> = { s: 1e3, sec: 1e3, second: 1e3, m: 6e4, min: 6e4, minute: 6e4, h: 36e5, hr: 36e5, hour: 36e5, d: 864e5, day: 864e5 };

function unitMs(unit: string): number | undefined {
	const lower = unit.toLowerCase();
	return UNIT_MS[lower] ?? UNIT_MS[lower.replace(/s$/, "")];
}

function parseGoDuration(value: string): number | undefined {
	const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
	if (parts.length === 0 || parts.map((p) => p[0]).join("") !== value.trim()) return undefined;
	return parts.reduce((sum, [, n, u]) => sum + Number(n) * (u === "ms" ? 1 : UNIT_MS[u]), 0);
}

function parseInstant(value: string, now: number): number | undefined {
	if (/^\d{10}(\.\d+)?$/.test(value)) return Number(value) * 1000;
	if (/^\d{13}$/.test(value)) return Number(value);
	const t = Date.parse(value);
	return Number.isNaN(t) || t < now - 864e5 ? undefined : t;
}

function isNumeric(value: string): boolean {
	return /^\d+(\.\d+)?$/.test(value);
}

export function resetFromHeaders(headers: Record<string, string>, now = Date.now()): number | undefined {
	const out: number[] = [];
	for (const [rawKey, raw] of Object.entries(headers)) {
		const key = rawKey.toLowerCase();
		const value = String(raw).trim();
		if (key === "retry-after-ms") out.push(now + Number(value));
		else if (key === "retry-after") out.push(isNumeric(value) ? now + Number(value) * 1000 : (parseInstant(value, now) ?? NaN));
		else if (/reset-after-seconds$/.test(key)) out.push(now + Number(value) * 1000);
		else if (/^anthropic-ratelimit-.*reset$/.test(key)) out.push(parseInstant(value, now) ?? NaN);
		else if (/^x-ratelimit-reset/.test(key)) {
			const d = parseGoDuration(value);
			if (d !== undefined) out.push(now + d);
			else if (isNumeric(value) && Number(value) < 1e9) out.push(now + Number(value) * 1000);
			else out.push(parseInstant(value, now) ?? NaN);
		}
	}
	const valid = out.filter((t) => Number.isFinite(t) && t > now);
	return valid.length ? Math.max(...valid) : undefined;
}

export function resetFromText(text: string, now = Date.now()): number | undefined {
	const epoch = text.match(/resets?_at["']?\s*[:=]\s*["']?(\d{10,13})/i);
	if (epoch) return parseInstant(epoch[1], now);
	const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/);
	if (iso) {
		const t = parseInstant(iso[0], now);
		if (t && t > now) return t;
	}
	const rel = text.match(/(?:in|after)\s+~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smhd])\b/i);
	if (rel) {
		const ms = unitMs(rel[2]);
		if (ms) return now + Number(rel[1]) * ms;
	}
	const secs = text.match(/resets?_in_seconds["']?\s*[:=]\s*(\d+)/i);
	if (secs) return now + Number(secs[1]) * 1000;
	return undefined;
}
