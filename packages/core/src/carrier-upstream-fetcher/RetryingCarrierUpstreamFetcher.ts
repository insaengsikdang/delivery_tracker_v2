import {
  CarrierUpstreamFetcher,
  type CarrierUpstreamFetcherInitInput,
} from "./CarrierUpstreamFetcher";
import { rootLogger } from "../logger";

const RETRY_DELAYS_MS = [300, 600, 1000] as const;

const retryLogger = rootLogger.child({
  component: "RetryingCarrierUpstreamFetcher",
});

function getErrorCauseCode(error: unknown): string | null {
  if (
    error !== null &&
    typeof error === "object" &&
    "cause" in error &&
    error.cause !== null &&
    typeof error.cause === "object" &&
    "code" in error.cause &&
    typeof error.cause.code === "string"
  ) {
    return error.cause.code;
  }
  return null;
}

function isRetryableError(error: unknown): boolean {
  const causeCode = getErrorCauseCode(error);
  if (causeCode === "ECONNRESET" || causeCode === "ETIMEDOUT") {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("fetch failed");
}

class RetryingCarrierUpstreamFetcher extends CarrierUpstreamFetcher {
  constructor(input: CarrierUpstreamFetcherInitInput) {
    super(input);
  }

  public async fetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      try {
        return await super.fetch(input, init);
      } catch (error) {
        if (!isRetryableError(error)) throw error;

        retryLogger.warn("fetch failed, retrying", {
          attempt: i + 1,
          nextAttempt: i + 2,
          maxAttempts: RETRY_DELAYS_MS.length + 1,
          retryDelayMs: RETRY_DELAYS_MS[i],
          causeCode: getErrorCauseCode(error),
          error,
        });

        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[i]));
      }
    }

    return await super.fetch(input, init);
  }
}

export { RetryingCarrierUpstreamFetcher };
