import { describe, expect, it } from "bun:test";
import { ApiError } from "@balebase/api-client";
import type { AuditTemplate } from "@balebase/validators/audits";
import { api } from "../shared/apiClient";
import { apiUrl } from "../shared/config";
import { installFetch } from "../testing/fetch";
import {
  appendIssueImageSelection,
  uploadIssueImagesSequentially,
} from "./auditIssueImages";

const respond = installFetch();

describe("audit template API", () => {
  it("saves and copies a template against the version it was read at", async () => {
    const bodies: unknown[] = [];
    // An older version is open: the copy names it as its source.
    const template = { ...exampleTemplate(), currentVersion: 3, version: 2 };
    respond(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ template });
    });

    await api.audits.updateTemplate(template);
    await api.audits.copyTemplate(template);
    const saved = {
      definition: template.definition,
      description: template.description,
      expectedCurrentVersion: 3,
      name: template.name,
    };
    expect(bodies).toEqual([saved, { ...saved, sourceVersion: 2 }]);
  });
});

describe("audit issue API", () => {
  it("keeps images selected across multiple picker passes", () => {
    const first = new File([new Uint8Array([1])], "first.png", {
      type: "image/png",
    });
    const second = new File([new Uint8Array([2])], "second.png", {
      type: "image/png",
    });

    const firstSelection = appendIssueImageSelection([], [first]);
    expect(firstSelection).toEqual([first]);
    if (typeof firstSelection === "string") throw new Error(firstSelection);
    expect(appendIssueImageSelection(firstSelection, [second])).toEqual([
      first,
      second,
    ]);
    const sameFirstFile = new File([new Uint8Array([1])], "first.png", {
      lastModified: first.lastModified,
      type: "image/png",
    });
    expect(
      appendIssueImageSelection(firstSelection, [sameFirstFile, second]),
    ).toEqual([first, second]);

    const nineExisting = Array.from(
      { length: 9 },
      (_, index) =>
        new File([new Uint8Array([index])], `${index}.png`, {
          type: "image/png",
        }),
    );
    expect(appendIssueImageSelection(nineExisting, [first, second])).toBe(
      "You can attach 1 more image.",
    );
  });

  it("selects untyped images for the API to check, but not empty ones", () => {
    const untyped = new File([new Uint8Array([1])], "photo");
    const uppercase = new File([new Uint8Array([2])], "photo.png", {
      type: "IMAGE/PNG",
    });
    expect(appendIssueImageSelection([], [untyped, uppercase])).toEqual([
      untyped,
      uppercase,
    ]);

    const empty = new File([], "empty.png", { type: "image/png" });
    expect(appendIssueImageSelection([untyped], [empty])).toBe(
      "Images must not be empty.",
    );
  });

  it("preserves rate-limit responses and backs off across repeated 429s", async () => {
    const file = new File([new Uint8Array([1])], "panel.png", {
      type: "image/png",
    });
    const calls: string[] = [];
    const waits: number[] = [];
    respond(async (url) => {
      calls.push(url.href);
      if (calls.length <= 3) {
        return Response.json(
          { error: "busy" },
          { headers: { "Retry-After": "1" }, status: 429 },
        );
      }
      return Response.json({ image: {} });
    });

    const failures = await uploadIssueImagesSequentially(
      "issue/id",
      [file],
      api.audits.uploadIssueImage,
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    );

    expect(failures).toEqual([]);
    expect(calls).toEqual([
      `${apiUrl}/api/audits/issues/issue%2Fid/images?filename=panel.png`,
      `${apiUrl}/api/audits/issues/issue%2Fid/images?filename=panel.png`,
      `${apiUrl}/api/audits/issues/issue%2Fid/images?filename=panel.png`,
      `${apiUrl}/api/audits/issues/issue%2Fid/images?filename=panel.png`,
    ]);
    expect(waits).toEqual([1_000, 2_000, 4_000]);
  });

  it("stops retrying an image after a bounded 429 backoff window", async () => {
    const file = new File([new Uint8Array([1])], "panel.png", {
      type: "image/png",
    });
    let calls = 0;
    const waits: number[] = [];
    const busy = new ApiError(
      new Response(null, { headers: { "Retry-After": "1" }, status: 429 }),
      { error: "busy" },
    );

    const failures = await uploadIssueImagesSequentially(
      "issue/id",
      [file],
      async () => {
        calls += 1;
        throw busy;
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    );

    expect(failures).toEqual([busy]);
    expect(calls).toBe(10);
    expect(waits).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000, 10_000, 10_000,
    ]);
  });
});

function exampleTemplate(): AuditTemplate {
  return {
    createdAt: "2026-08-24T12:00:00.000Z",
    currentVersion: 2,
    definition: {
      sections: [
        {
          id: "section-1",
          items: [
            {
              id: "item-1",
              prompt: "Question",
              required: true,
              responseType: "check",
            },
          ],
          title: "Section",
        },
      ],
      version: 1,
    },
    description: "Description",
    id: "template/id",
    name: "Shared form",
    savedAt: "2026-08-24T13:00:00.000Z",
    savedBy: {
      email: "admin@example.com",
      id: "admin-id",
      name: "Admin",
    },
    scope: "global",
    status: "draft",
    updatedAt: "2026-08-24T13:00:00.000Z",
    version: 2,
  };
}
