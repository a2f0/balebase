import { describe, expect, it } from "bun:test";
import {
  issueImageProblem,
  issueImageTypeAccepted,
  maxIssueImageBytes,
  maxIssueImages,
} from "./issueRules";

const png = { size: 1, type: "image/png" };

function problem(file: { size: number; type: string }) {
  return issueImageProblem([file], maxIssueImages);
}

describe("issue image rules", () => {
  it("takes a file the browser could not type, since the API reads its bytes", () => {
    expect(problem(new File([new Uint8Array([1])], "photo"))).toBeUndefined();
    expect(problem({ size: 1, type: "application/octet-stream" })).toBe(
      undefined,
    );
  });

  it("matches types without regard to case, as the API does", () => {
    expect(problem({ size: 1, type: "IMAGE/PNG" })).toBeUndefined();
    expect(problem({ size: 1, type: "Image/WebP" })).toBeUndefined();
  });

  it("refuses an empty file, which the API rejects", () => {
    expect(problem({ size: 0, type: "image/png" })).toBe(
      "Images must not be empty.",
    );
    expect(problem({ size: 0, type: "" })).toBe("Images must not be empty.");
  });

  it("refuses other formats", () => {
    for (const type of ["image/heic", "image/svg+xml", "text/plain"]) {
      expect(problem({ size: 1, type })).toBe(
        "Images must be JPEG, PNG, GIF, or WebP files.",
      );
    }
  });

  it("takes images up to exactly the size limit", () => {
    expect(problem({ size: maxIssueImageBytes, type: "image/jpeg" })).toBe(
      undefined,
    );
    expect(problem({ size: maxIssueImageBytes + 1, type: "image/jpeg" })).toBe(
      "Images must be 10 MB or smaller.",
    );
  });

  it("counts the slots an issue has left", () => {
    expect(issueImageProblem(Array(maxIssueImages).fill(png), 10)).toBe(
      undefined,
    );
    expect(issueImageProblem(Array(11).fill(png), maxIssueImages)).toBe(
      "You can attach 10 more images.",
    );
    expect(issueImageProblem([png, png], 1)).toBe(
      "You can attach 1 more image.",
    );
    expect(issueImageProblem([png], -2)).toBe("You can attach 0 more images.");
    expect(issueImageProblem([], 0)).toBeUndefined();
  });

  it("accepts the upload types the API client declares", () => {
    expect(issueImageTypeAccepted("application/octet-stream")).toBe(true);
    expect(issueImageTypeAccepted("IMAGE/GIF")).toBe(true);
    expect(issueImageTypeAccepted("")).toBe(false);
    expect(issueImageTypeAccepted("png")).toBe(false);
  });
});
