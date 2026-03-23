import { type Logger } from "winston";
import {
  Carrier,
  type CarrierTrackInput,
  type TrackInfo,
  type TrackEvent,
  type TrackEventStatus,
  TrackEventStatusCode,
  type Location,
  type ContactInfo,
} from "../../core";
import { rootLogger } from "../../logger";
import { NotFoundError } from "../../core/errors";
import { DateTime } from "luxon";
import { JSDOM } from "jsdom";
import { type CarrierUpstreamFetcher } from "../../carrier-upstream-fetcher/CarrierUpstreamFetcher";

const carrierLogger = rootLogger.child({
  carrierId: "kr.epost",
});
const FETCH_RETRY_DELAYS_MS = [300, 600, 1000] as const;

class KoreaPost extends Carrier {
  readonly carrierId = "kr.epost";

  public async track(input: CarrierTrackInput): Promise<TrackInfo> {
    return await new KoreaPostTrackScraper(
      this.upstreamFetcher,
      input.trackingNumber
    ).track();
  }
}

class KoreaPostTrackScraper {
  private readonly logger: Logger;

  constructor(
    readonly upstreamFetcher: CarrierUpstreamFetcher,
    readonly trackingNumber: string
  ) {
    this.logger = carrierLogger.child({ trackingNumber });
  }

  public async track(): Promise<TrackInfo> {
    const queryString = new URLSearchParams({
      sid1: this.trackingNumber,
    }).toString();
    const response = await this.fetchTraceResponse(
      `https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?${queryString}`
    );
    const traceResponseHtmlText = await response.text();
    this.logger.debug("traceResponseHtmlText", {
      html: traceResponseHtmlText,
    });

    const dom = new JSDOM(traceResponseHtmlText);
    const { document } = dom.window;

    const eventTrs = document.querySelectorAll("#processTable > tbody > tr");
    if (eventTrs.length < 1) {
      throw new NotFoundError();
    }

    const events: TrackEvent[] = [];
    for (const event of eventTrs) {
      events.push(this.parseEvent(event));
    }

    const senderAndRecipient = this.parseSenderAndRecipient(document);

    return {
      events,
      ...senderAndRecipient,
      carrierSpecificData: new Map(),
    };
  }

  private async fetchTraceResponse(url: string): Promise<Response> {
    const maxAttempts = FETCH_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.upstreamFetcher.fetch(url);
      } catch (error) {
        if (!this.shouldRetryFetchError(error) || attempt === maxAttempts) {
          this.logger.error("epost upstream fetch failed", {
            attempt,
            maxAttempts,
            trackingNumber: this.trackingNumber,
            causeCode: this.getFetchErrorCauseCode(error),
            error,
          });
          throw error;
        }

        const retryDelayMs = FETCH_RETRY_DELAYS_MS[attempt - 1];
        this.logger.warn("epost upstream fetch retry", {
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          retryDelayMs,
          trackingNumber: this.trackingNumber,
          causeCode: this.getFetchErrorCauseCode(error),
          error,
        });
        await this.sleep(retryDelayMs);
      }
    }

    throw new Error("unreachable");
  }

  private shouldRetryFetchError(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error);
    const causeCode = this.getFetchErrorCauseCode(error);

    return (
      causeCode === "ECONNRESET" ||
      causeCode === "ETIMEDOUT" ||
      message.includes("fetch failed")
    );
  }

  private getFetchErrorCauseCode(error: unknown): string | null {
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

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private parseEvent(tr: Element): TrackEvent {
    const tds = tr.querySelectorAll("td");
    const date = tds[0].textContent?.replace(/\s+/g, " ")?.trim() ?? null;
    const time = tds[1].textContent?.replace(/\s+/g, " ")?.trim() ?? null;
    const location = tds[2].textContent?.replace(/\s+/g, " ")?.trim() ?? null;
    const status = tds[3].textContent?.replace(/\s+/g, " ")?.trim() ?? null;

    // 되도록 원본 텍스트 유지 (접수는 제외)
    const statusDescription =
      status?.startsWith("접수 소포 물품 사진") === true
        ? "접수"
        : status ?? "";

    return {
      status: this.parseStatus(status),
      time: this.parseTime(date, time),
      location: this.parseLocation(location),
      contact: null,
      description: `${statusDescription} - ${location ?? ""}`,
      carrierSpecificData: new Map(),
    };
  }

  private parseStatus(status: string | null): TrackEventStatus {
    if (status === null) {
      this.logger.warn("status null");
      return {
        code: TrackEventStatusCode.Unknown,
        name: null,
        carrierSpecificData: new Map(),
      };
    }

    switch (status) {
      case "운송장출력":
      case "접수":
      case "접수 마감 후 접수(익일발송)":
        return {
          code: TrackEventStatusCode.InformationReceived,
          name: status,
          carrierSpecificData: new Map(),
        };
      case "발송":
      case "도착":
        return {
          code: TrackEventStatusCode.InTransit,
          name: status,
          carrierSpecificData: new Map(),
        };
    }
    // NOTE: text가 "접수 소포 물품 사진 //<![CDATA[" 형식이면 "접수"로 변경하기 위함
    if (status.startsWith("접수 소포 물품 사진")) {
      return {
        code: TrackEventStatusCode.InformationReceived,
        name: "접수",
        carrierSpecificData: new Map(),
      };
    }
    if (status.includes("배달준비")) {
      return {
        code: TrackEventStatusCode.OutForDelivery,
        name: "배달준비",
        carrierSpecificData: new Map(),
      };
    }
    if (status.includes("배달완료")) {
      return {
        code: TrackEventStatusCode.Delivered,
        name: "배달완료",
        carrierSpecificData: new Map(),
      };
    }
    if (status.includes("신청취소")) {
      return {
        code: TrackEventStatusCode.Exception,
        name: "신청취소",
        carrierSpecificData: new Map(),
      };
    }
    if (status.includes("접수취소")) {
      return {
        code: TrackEventStatusCode.Exception,
        name: "접수취소",
        carrierSpecificData: new Map(),
      };
    }
    if (status.includes("미배달")) {
      return {
        code: TrackEventStatusCode.AttemptFail,
        name: "미배달",
        carrierSpecificData: new Map(),
      };
    }
    if (status.includes("인수완료")) {
      return {
        code: TrackEventStatusCode.AtPickup,
        name: "인수완료",
        carrierSpecificData: new Map(),
      };
    }
    if (status.includes("집하완료")) {
      return {
        code: TrackEventStatusCode.InTransit,
        name: "집하완료",
        carrierSpecificData: new Map(),
      };
    }

    this.logger.warn("Unexpected status code", {
      status,
    });

    return {
      code: TrackEventStatusCode.Unknown,
      name: status,
      carrierSpecificData: new Map(),
    };
  }

  private parseTime(date: string | null, time: string | null): DateTime | null {
    if (date === null) {
      this.logger.warn("date or time null");
      return null;
    }
    if (time === null) {
      this.logger.warn("date or time null");
      return null;
    }

    const result = DateTime.fromFormat(`${date} ${time}`, "yyyy.MM.dd HH:mm", {
      zone: "Asia/Seoul",
    });

    if (!result.isValid) {
      this.logger.warn("time parse error", {
        inputTime: time,
        invalidReason: result.invalidReason,
      });
      return result;
    }

    return result;
  }

  private parseLocation(location: string | null): Location | null {
    if (location === null) {
      this.logger.warn("location null");
      return null;
    }

    return {
      name: location,
      countryCode: null,
      postalCode: null,
      carrierSpecificData: new Map(),
    };
  }

  private parseSenderAndRecipient(document: Document): {
    sender: ContactInfo | null;
    recipient: ContactInfo | null;
  } {
    try {
      const tds =
        document
          .querySelector("table.table_col > tbody")
          ?.querySelectorAll("td") ?? [];

      return {
        sender: this.parseContactInfo(tds[0] ?? null),
        recipient: this.parseContactInfo(tds[1] ?? null),
      };
    } catch (e) {
      this.logger.warn("parseSenderAndRecipient error", {
        error: e,
      });
      return {
        sender: null,
        recipient: null,
      };
    }
  }

  private parseContactInfo(element: HTMLElement | null): ContactInfo | null {
    if (element === null) {
      return null;
    }
    const contactInfoHtml = element.innerHTML;
    const contactInfoBrIndex = contactInfoHtml.indexOf("<br>");

    let name = contactInfoHtml;
    if (contactInfoBrIndex !== -1) {
      name = contactInfoHtml.substring(0, contactInfoBrIndex);
    }
    return {
      name: name.replace(/\s+/g, " ")?.trim(),
      location: null,
      phoneNumber: null,
      carrierSpecificData: new Map(),
    };
  }
}

export { KoreaPost };
