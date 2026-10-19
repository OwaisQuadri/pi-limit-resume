# pi-limit-resume

A [Pi](https://github.com/earendil-works/pi) extension. When a usage or rate limit stops a session, it schedules a `continue` message for the time the limit resets.

## How it works

1. `after_provider_response`: on a 429 or 529, read reset headers (`retry-after`, `retry-after-ms`, `x-codex-*-reset-after-seconds`, `anthropic-ratelimit-*-reset`, `x-ratelimit-reset-*`).
2. `message_end`: if the assistant message ends with a limit error, read the reset time from the error text (`resets_at`, ISO time, "try again in ~42 min"). Take the latest candidate. With no candidate, wait 30 minutes.
3. `agent_settled`: start one timer for reset + 30 s, then send `continue`.

Provider-neutral: it reads only headers and error text, so the same code covers Codex (ChatGPT) and Claude subscriptions, and any provider with standard headers.

- Typed input cancels the timer. `/limit-resume` shows it; `/limit-resume cancel` cancels it.
- Escape (aborted run) schedules nothing.
- Stops after 8 limit hits in a row without a successful reply.
- `PI_LIMIT_RESUME_MESSAGE` changes the message text.

## Install

```sh
pi install git:github.com/OwaisQuadri/pi-limit-resume
pi -e ./src/index.ts                                      # local try
```

## Test

```sh
npm test
```

Tests use a mock Pi and mocked timers. They are not checked against live limits.
