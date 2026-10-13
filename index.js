// dsh-auto-retry -- periodic auto-retry for unfinished agent turns in DeepSeek Harness.
//
// Every CHECK_INTERVAL_MS (10 minutes) the plugin looks at each live session's
// recorded last error. When a session ended a turn with a retryable API error
// (network drop, 502, timeout, ...) it sends "continue" into the chat through
// agent.followup(), the same DSH API dsh-auto-continue uses.
//
// Fatal errors (insufficient_quota, invalid_api_key, auth/billing family) are
// never retried; a completed successful turn resets the counter for that
// session. After MAX_ATTEMPTS consecutive retries per session the plugin stops
// and posts "auto-retry: stopped after 30 attempts" (ASCII fallback) /
// "auto-retry: stopped after 30 attempts" into the chat.

import { randomUUID } from "node:crypto";

export const name = "dsh-auto-retry";
export const inject = ["agents"];

// --- tunables -------------------------------------------------------------
const CHECK_INTERVAL_MS = 600000; // 10 minutes
const MAX_ATTEMPTS = 30;
const STOP_TEXT = "auto-retry: stopped after 30 attempts";
const RETRY_TEXT = "continue";
const STOP_TEXTS = [
  "auto-retry: \u043e\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d \u043f\u043e\u0441\u043b\u0435 30 \u043f\u043e\u043f\u044b\u0442\u043e\u043a",
  STOP_TEXT
];

// never retry these (case-insensitive substring match over code/message)
const FATAL_PATTERNS = [
  "insufficient_quota",
  "invalid_api_key"
];

// --- helpers --------------------------------------------------------------
function fatalHaystack(failure) {
  return `${failure?.code ?? ""} ${failure?.message ?? ""}`.toLowerCase();
}

function isFatalFailure(failure) {
  const haystack = fatalHaystack(failure);
  return FATAL_PATTERNS.some((pattern) => haystack.includes(pattern));
}

function parseFailureFacts(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const code = typeof value.code === "string" && value.code.trim() !== "" ? value.code : undefined;
  const message = typeof value.message === "string" && value.message.trim() !== "" ? value.message : undefined;
  const status = typeof value.status === "number" && Number.isFinite(value.status) ? value.status : undefined;
  if (code === undefined && message === undefined && status === undefined) return undefined;
  return {
    code: code ?? "UNKNOWN",
    message: message ?? code ?? `HTTP ${status}`,
    ...(status !== undefined ? { status } : {})
  };
}

function readReasonKind(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const kind = value.kind;
  return typeof kind === "string" && kind.trim() !== "" ? kind : undefined;
}

function createUserMessage(input) {
  return {
    ...input,
    role: "user",
    id: randomUUID()
  };
}

// --- engine ---------------------------------------------------------------
class AutoRetryRunner {
  constructor(ctx) {
    this.ctx = ctx;
    this.states = new Map();
    this.disposed = false;
    this.timer = setInterval(() => {
      try {
        this.check();
      } catch (error) {
        console.error(`[auto-retry] check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, CHECK_INTERVAL_MS);
    // do not hold the event loop open just for the checker
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.disposeEvents = ctx.on("session/event", (session, event) => {
      try {
        this.onSessionEvent(session, event);
      } catch (error) {
        console.error(`[auto-retry] session event failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    console.info("[auto-retry] started (interval 600000ms, max 30 consecutive attempts)");
  }

  log(message) {
    console.info(`[auto-retry] ${message}`);
  }

  state(sessionId) {
    let state = this.states.get(sessionId);
    if (state === undefined) {
      state = { attempts: 0, lastError: null, running: false, stopped: false, lastTurn: undefined };
      this.states.set(sessionId, state);
    }
    return state;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.disposeEvents?.();
    this.states.clear();
  }

  onSessionEvent(session, event) {
    if (session?.header?.origin === "subagent") return;
    const sessionId = session?.id;
    if (typeof sessionId !== "string" || sessionId === "") return;
    const state = this.state(sessionId);
    if (event.type === "turn/start") {
      state.running = true;
      return;
    }
    if (event.type === "turn/end") {
      state.running = false;
      const kind = readReasonKind(event.data?.reason);
      if (kind === "error") {
        const failure = parseFailureFacts(event.data.reason.error);
        if (failure !== undefined) {
          if (isFatalFailure(failure)) {
            state.lastError = null;
            state.attempts = 0;
            state.stopped = false;
            this.log(`fatal error ${sessionId} (${failure.code}): not retrying`);
            return;
          }
          state.lastError = failure;
          state.lastTurn = event.data.turn;
          return;
        }
        state.lastError = null;
        return;
      }
      if (kind === "completed") {
        // full answer arrived: reset the counter and touch nothing
        state.lastError = null;
        state.attempts = 0;
        state.stopped = false;
        return;
      }
      if (kind === "interrupted" || kind === "aborted") {
        // user-driven stop: leave any pending error alone, reset the streak
        state.attempts = 0;
        state.stopped = false;
        return;
      }
      return;
    }
  }

  // periodic sweep: one pass over every session with a pending error
  check() {
    if (this.disposed) return;
    for (const [sessionId, state] of this.states) {
      if (state.lastError === null || state.stopped) continue;
      if (state.running) {
        this.log(`skip ${sessionId}: turn already running`);
        continue;
      }
      if (isFatalFailure(state.lastError)) {
        state.lastError = null;
        continue;
      }
      state.attempts += 1;
      if (state.attempts >= MAX_ATTEMPTS) {
        state.stopped = true;
        state.lastError = null;
        this.log(`session ${sessionId}: giving up after ${state.attempts} attempts`);
        this.send(sessionId, STOP_TEXTS);
        continue;
      }
      this.log(`session ${sessionId}: retry ${state.attempts}/${MAX_ATTEMPTS} after ${state.lastError.code}`);
      this.send(sessionId, [RETRY_TEXT]);
      state.lastError = null;
    }
  }

  // send the first accepted text into the chat through agent.followup()
  send(sessionId, texts) {
    const agent = this.ctx.agents.get(sessionId);
    if (agent === undefined) {
      this.log(`skip ${sessionId}: no live agent`);
      return;
    }
    for (const text of texts) {
      try {
        const message = createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "user" }
        });
        agent.followup(message);
        this.log(`sent "${text}" to ${sessionId}`);
        return;
      } catch (error) {
        console.error(`[auto-retry] send failed ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

// --- entry ------------------------------------------------------------
export function apply(ctx) {
  let disposeEngine;
  ctx.inject(["agents"], (engineCtx) => {
    disposeEngine?.();
    const runner = new AutoRetryRunner(engineCtx);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      runner.dispose();
    };
    disposeEngine = dispose;
    engineCtx.effect(() => dispose);
  });
  ctx.effect(() => () => {
    const dispose = disposeEngine;
    disposeEngine = undefined;
    dispose?.();
  });
}

export default { name, apply };
