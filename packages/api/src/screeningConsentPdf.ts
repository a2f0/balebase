import { productName } from "@balebase/ui/brand";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  type DisclosureSection,
  type ScreeningDisclosures,
  summaryOfRightsUrl,
} from "./screeningDisclosures";
import {
  addTextPages,
  formatUtcTimestamp,
  type PdfLine,
} from "./shared/pdfText";

export interface ScreeningConsent {
  consentId: string;
  copyRequested: boolean;
  email: string;
  ipAddress: string | null;
  organizationName: string;
  requirementTitle: string;
  residenceState: string;
  signatureName: string;
  signedAt: string;
  stateNotices: string[];
  userAgent: string | null;
  workCity: string | null;
  workState: string;
}

/**
 * The signed authorization as a PDF: every disclosure the person was shown,
 * then the electronic signature and how it was made. It is uploaded to Checkr
 * as the candidate's consent document and kept in Balebase. It holds no
 * Social Security number, birth date, or license number.
 */
export async function buildScreeningConsentPdf(
  consent: ScreeningConsent,
  disclosures: ScreeningDisclosures,
) {
  const document = await PDFDocument.create();
  document.setTitle(`Background check authorization: ${consent.signatureName}`);
  document.setProducer(productName);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const location = [consent.workCity, consent.workState]
    .filter(Boolean)
    .join(", ");
  const lines: PdfLine[] = [
    { bold: true, size: 18, text: "Background check authorization" },
    { gap: 6, size: 10, text: `${consent.organizationName} · ${productName}` },
    { bold: true, gap: 18, size: 12, text: consent.requirementTitle },
    { size: 9, text: `Consent ID: ${consent.consentId}` },
    { size: 9, text: `Disclosure version: ${disclosures.version}` },
    { size: 9, text: `Work location: ${location}` },
    ...section(disclosures.summaryOfRights),
    { size: 10, text: `Provided as ${summaryOfRightsUrl}` },
    ...section(disclosures.disclosure),
    ...consent.stateNotices.flatMap((state) => {
      const notice = disclosures.stateNotices[state];
      return notice ? section(notice) : [];
    }),
    ...section(disclosures.electronicRecords),
    ...section(disclosures.authorization),
    { bold: true, gap: 18, size: 12, text: "Electronic signature" },
    {
      size: 10,
      text: `Signed by ${consent.signatureName} <${consent.email}>, typed as an electronic signature after agreeing to sign electronically.`,
    },
    { size: 9, text: `Signed: ${formatUtcTimestamp(consent.signedAt)}` },
    { size: 9, text: `IP address: ${consent.ipAddress ?? "Unknown"}` },
    { size: 9, text: `Device: ${consent.userAgent ?? "Unknown"}` },
    { size: 9, text: `State of residence: ${consent.residenceState}` },
    {
      size: 9,
      text: `State notices acknowledged: ${consent.stateNotices.join(", ") || "None"}`,
    },
    {
      size: 9,
      text: `Free copy of the report requested: ${consent.copyRequested ? "Yes" : "No"}`,
    },
  ];
  addTextPages(document, lines, font, bold);
  return document.save();
}

function section({ paragraphs, title }: DisclosureSection): PdfLine[] {
  return [
    { bold: true, gap: 18, size: 12, text: title },
    ...paragraphs.map((text) => ({ gap: 4, size: 10, text })),
  ];
}
