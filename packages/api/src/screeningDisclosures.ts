/**
 * The disclosures and authorization a person reads and signs before Balebase
 * orders a Checkr report. The form shows exactly this text and the signed PDF
 * records it with this version, so change the version with any wording change.
 * The wording is a plain-language draft for counsel and Checkr to review
 * before production use; Checkr reviews the flow before credentialing it.
 */
export const screeningDisclosureVersion = "2026-10-19";

export interface DisclosureSection {
  paragraphs: string[];
  title: string;
}

export interface StateNotice extends DisclosureSection {
  /** The state lets the person ask for a free copy of the report. */
  offersCopy: boolean;
}

export const summaryOfRightsUrl =
  "https://files.consumerfinance.gov/f/documents/bcfp_consumer-rights-summary_2018-09.pdf";

const newYorkArticle23AUrl =
  "https://www.nysenate.gov/legislation/laws/COR/A23-A";

export function screeningDisclosures(organizationName: string) {
  return {
    authorization: {
      paragraphs: [
        "I acknowledge that I received and read the Disclosure Regarding Background Investigation, A Summary of Your Rights Under the Fair Credit Reporting Act, and any state notices shown to me, and that I could save or print them.",
        `I authorize ${organizationName} to obtain a consumer report about me from Checkr, Inc. for employment purposes, for this background check. I authorize courts, law enforcement agencies, motor vehicle departments, past employers, schools, and other sources Checkr contacts to release information about me to Checkr for this report.`,
        "I certify that the information I provided is true and complete.",
        "This authorization covers this background check only. An electronic copy of it is as valid as the original.",
      ],
      title: "Authorization",
    },
    disclosure: {
      paragraphs: [
        `${organizationName} may obtain information about you from a consumer reporting agency for employment purposes. As a result, you may be the subject of a consumer report, which may include information about your character, general reputation, personal characteristics, and mode of living.`,
        `Depending on the searches ${organizationName} orders, the report may include criminal records, sex offender registry and watchlist searches, verification of your Social Security number, driving records, and verification of your employment or education history.`,
        "The consumer reporting agency is Checkr, Inc. (checkr.com), which prepares the report. You can contact Checkr to learn what is in your file and to dispute information you believe is inaccurate or incomplete.",
        `You may ask ${organizationName} in writing, within a reasonable time, whether it ordered a report about you, and for a complete and accurate description of the nature and scope of any investigation.`,
      ],
      title: "Disclosure Regarding Background Investigation",
    },
    electronicRecords: {
      paragraphs: [
        `You agree to receive these documents and to sign this authorization electronically. You can ask ${organizationName} for paper copies or to sign on paper instead, and you can withdraw this agreement at any time before you submit.`,
        "To read and keep these documents you need a web browser and a way to save or print PDF files.",
      ],
      title: "Electronic records and signature",
    },
    stateNotices: stateNotices(organizationName),
    summaryOfRights: {
      paragraphs: [
        "The Consumer Financial Protection Bureau publishes A Summary of Your Rights Under the Fair Credit Reporting Act. Open and read it before you continue; you can save or print it.",
        "Among other rights, you must be told if information in your file has been used against you, you can find out what is in your file, and you can dispute incomplete or inaccurate information.",
      ],
      title: "A Summary of Your Rights Under the Fair Credit Reporting Act",
    },
    version: screeningDisclosureVersion,
  };
}

export type ScreeningDisclosures = ReturnType<typeof screeningDisclosures>;

/**
 * A fingerprint of the exact wording a form showed, organization name
 * included, so a submission authorizes only what the person read.
 */
export async function disclosureFingerprint(disclosures: ScreeningDisclosures) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(disclosures)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** States with a notice, for the work location and where the person lives. */
export function requiredStateNotices(
  workState: string,
  residenceState: string,
) {
  const notices = stateNotices("");
  return [...new Set([workState, residenceState])]
    .filter((state) => state in notices)
    .sort();
}

function stateNotices(organizationName: string): Record<string, StateNotice> {
  return {
    CA: {
      offersCopy: true,
      paragraphs: [
        "Under California Civil Code section 1786.22, you can review the file Checkr keeps about you. With reasonable identification, you can see it in person during normal business hours, get a copy by mail, or get a summary by telephone after identifying yourself in writing. Someone of your choosing may come with you if they show reasonable identification.",
        "Checkr has trained staff to explain the information in your file, including any coded information.",
        "Checkr's privacy practices are available at checkr.com.",
      ],
      title: "California notice",
    },
    MN: {
      offersCopy: true,
      paragraphs: [
        "Under Minnesota law, you can ask Checkr in writing for a complete and accurate disclosure of the nature and scope of any investigative consumer report about you. Checkr must answer within five business days of your request or of the report's completion, whichever is later.",
      ],
      title: "Minnesota notice",
    },
    NY: {
      offersCopy: false,
      paragraphs: [
        `You can ask ${organizationName || "the employer"} whether it requested an investigative consumer report about you and, if so, for a copy of the report and the name and address of Checkr.`,
        `Article 23-A of the New York Correction Law limits how employers may consider criminal convictions. Read it at ${newYorkArticle23AUrl}.`,
      ],
      title: "New York notice",
    },
    OK: {
      offersCopy: true,
      paragraphs: [
        "Under Oklahoma law, you may ask for a free copy of any consumer report about you.",
      ],
      title: "Oklahoma notice",
    },
    WA: {
      offersCopy: false,
      paragraphs: [
        `If ${organizationName || "the employer"} requests an investigative consumer report, you can ask in writing for a complete and accurate disclosure of its nature and scope, and for a written summary of your rights under the Washington Fair Credit Reporting Act.`,
      ],
      title: "Washington notice",
    },
  };
}
