import { describe, expect, it } from "bun:test";
import type { DomainClaim } from "@balebase/validators/inbox";
import { memoryStorage, testBindings } from "../testing/bindings";
import { toD1 } from "../testing/d1";
import { createTestDatabase } from "../testing/database";
import { seedAccount } from "../testing/seed";
import { testApp } from "../testing/session";
import { handleEmail } from "./email";
import { inbox } from "./inbox";
import { inboxRouting } from "./mailboxes";

function fixture(inboundDomain = "inbox.balebase.com", afterPut?: () => void) {
  const database = createTestDatabase();
  const org = seedAccount(database, { id: "owner" }).organizationId;
  seedAccount(database, { id: "other" });
  seedAccount(database, { id: "root", role: "admin" });
  const storage = memoryStorage(new Map(), afterPut ? { afterPut } : {});
  const bindings = testBindings({
    DB: toD1(database),
    STORAGE: storage.bucket,
    INBOUND_EMAIL_DOMAIN: inboundDomain,
  });
  let records: string[][] = [];
  let error: Error | undefined;
  const names: string[] = [];
  const routing = inboxRouting(async (name) => {
    names.push(name);
    if (error) throw error;
    return records;
  });
  function request(
    path: string,
    method = "GET",
    body?: object,
    userId = "owner",
    role = "owner",
  ) {
    const app = testApp(
      { "/api/inbox/routing": routing, "/api/inbox": inbox },
      {
        organizationId: `org_${userId}`,
        organizationRole: role,
        userId,
        role: userId === "root" ? "admin" : "user",
      },
    );
    return app.request(
      `/api/inbox${path.replace(/^\/(?=\?|$)/, "")}`,
      {
        method,
        ...(body
          ? {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }
          : {}),
      },
      bindings,
    );
  }
  async function deliver(to: string) {
    let rejection: string | undefined;
    const raw = new Blob([
      "From: sender@example.org\r\nTo: privacy@balebase.com\r\nSubject: Test delivery\r\n\r\nTest body",
    ]);
    await handleEmail(
      {
        to,
        from: "sender@example.org",
        raw: raw.stream(),
        rawSize: raw.size,
        setReject: (reason: string) => {
          rejection = reason;
        },
      } as unknown as ForwardableEmailMessage,
      bindings,
    );
    return rejection;
  }
  const claim = async (user = "owner") =>
    (await (
      await request(
        "/routing/domains",
        "POST",
        { domain: "Tearleads.com" },
        user,
      )
    ).json()) as DomainClaim;
  const verify = (id: string, user = "owner") =>
    request(`/routing/domains/${id}/verify`, "POST", undefined, user);
  const bind = (address: string, user = "owner") =>
    request("/routing/mailboxes", "POST", { name: "Legal", address }, user);
  return {
    database,
    bindings,
    storage,
    bind,
    claim,
    verify,
    names,
    deliver,
    org,
    request,
    publish: (next: string[][]) => {
      records = next;
    },
    dnsError: (next: Error) => {
      error = next;
    },
  };
}

describe("verified inbound domains", () => {
  it("verifies only the requesting organization's exact TXT value without reserving pending names", async () => {
    const f = fixture();
    const other = await f.claim("other");
    const owner = await f.claim();
    expect(await f.claim()).toEqual(owner);
    expect(owner.recordName).toBe("_balebase-verification.tearleads.com");
    expect(owner.recordValue).not.toBe(other.recordValue);
    expect((await f.bind("legal@tearleads.com")).status).toBe(409);
    expect((await f.verify(owner.id, "other")).status).toBe(404);
    f.publish([["wrong"], [`${owner.recordValue}suffix`]]);
    expect((await f.verify(owner.id)).status).toBe(409);
    f.publish([[owner.recordValue.slice(0, 12), owner.recordValue.slice(12)]]);
    expect((await f.verify(other.id, "other")).status).toBe(409);
    expect((await f.verify(owner.id)).status).toBe(200);
    expect((await f.verify(owner.id)).status).toBe(200);
    f.publish([[other.recordValue]]);
    expect((await f.verify(other.id, "other")).status).toBe(409);
    expect(new Set(f.names)).toEqual(new Set([owner.recordName]));
    expect((await f.bind("legal@base.tearleads.com")).status).toBe(409);
    expect((await f.bind("legal@tearleads.com", "other")).status).toBe(409);
    expect(
      f.database
        .query(
          "SELECT action FROM activity_events WHERE action = 'organization.inbound_domain_verified'",
        )
        .all(),
    ).toHaveLength(1);
  });
  it("distinguishes missing TXT records from DNS outages and leaves the claim pending", async () => {
    const f = fixture();
    const claim = await f.claim();
    f.dnsError(Object.assign(new Error(), { code: "ENOTFOUND" }));
    expect((await f.verify(claim.id)).status).toBe(409);
    f.dnsError(new Error("resolver unavailable"));
    expect((await f.verify(claim.id)).status).toBe(503);
    expect((await f.bind("legal@tearleads.com")).status).toBe(409);
  });
  it("delivers forwarded and exact envelopes to the named inbox; disabling the binding preserves its mail", async () => {
    const f = fixture();
    const owner = await f.claim();
    f.publish([[owner.recordValue]]);
    await f.verify(owner.id);
    const bound = await f.bind("LEGAL@Tearleads.com");
    expect(bound.status).toBe(201);
    const { id, forwardingAddress } = (await bound.json()) as {
      id: string;
      forwardingAddress: string;
    };
    expect(forwardingAddress).toMatch(
      /^inbox\+[0-9a-f-]{36}@inbox\.balebase\.com$/,
    );
    expect((await f.bind("legal@tearleads.com")).status).toBe(409);
    expect(await f.deliver(forwardingAddress)).toBeUndefined();
    expect(await f.deliver("legal@tearleads.com")).toBeUndefined();
    expect(await f.deliver("nobody@tearleads.com")).toBe("Unknown recipient");
    expect(
      await f.deliver(forwardingAddress.replace("@inbox.", "@inbox-staging.")),
    ).toBe("Unknown recipient");
    expect(
      await f.deliver(`upload+${f.org}@inbox.balebase.com`),
    ).toBeUndefined();
    const listing = (await (await f.request(`/?mailbox=${id}`)).json()) as {
      emails: { id: string }[];
    };
    expect(listing.emails).toHaveLength(2);
    expect(
      await (await f.request(`/?email=${listing.emails[0]?.id}`)).json(),
    ).toMatchObject({ mailboxId: id, address: "legal@tearleads.com" });
    expect(
      await (
        await f.request(
          `/?email=${listing.emails[0]?.id}`,
          "GET",
          undefined,
          "other",
        )
      ).json(),
    ).toMatchObject({ mailboxId: null, emails: [] });
    expect(await (await f.request("/")).json()).toMatchObject({
      emails: [{ to: `upload+${f.org}@inbox.balebase.com` }],
    });
    expect(
      (await f.request(`/?mailbox=${id}`, "GET", undefined, "other")).status,
    ).toBe(404);
    expect(
      (await f.request(`/${listing.emails[0]?.id}`, "GET", undefined, "other"))
        .status,
    ).toBe(404);
    expect(
      (await f.request(`/routing/domains/${owner.id}`, "DELETE")).status,
    ).toBe(409);
    expect((await f.request(`/routing/mailboxes/${id}`, "DELETE")).status).toBe(
      204,
    );
    expect(
      (await f.request(`/routing/domains/${owner.id}`, "DELETE")).status,
    ).toBe(204);
    expect(await f.deliver(forwardingAddress)).toBe("Unknown recipient");
    expect(await f.deliver("legal@tearleads.com")).toBe("Unknown recipient");
    expect(await (await f.request(`/?mailbox=${id}`)).json()).toMatchObject({
      mailboxes: [{ connected: false }],
      emails: listing.emails,
    });
  });
  it("rejects a delivery disconnected while its message was being stored", async () => {
    let disconnect = () => {};
    const f = fixture("inbox.balebase.com", () => disconnect());
    const bound = await f.bind("privacy@balebase.com", "root");
    const { id, forwardingAddress } = (await bound.json()) as {
      id: string;
      forwardingAddress: string;
    };
    disconnect = () => {
      f.database
        .query(
          "UPDATE inbound_mailboxes SET disconnected_at = 'now' WHERE id = ?",
        )
        .run(id);
    };
    expect(await f.deliver(forwardingAddress)).toBe("Unknown recipient");
    expect(f.database.query("SELECT id FROM inbound_emails").all()).toEqual([]);
    expect(f.storage.stored.size).toBe(0);
  });

  it("keeps committed R2 bytes when D1 loses its batch response", async () => {
    const f = fixture();
    const bound = await f.bind("privacy@balebase.com", "root");
    const { forwardingAddress } = (await bound.json()) as {
      forwardingAddress: string;
    };
    f.bindings.DB = toD1(f.database, {
      afterQuery(event) {
        if (
          event.method === "batch" &&
          event.sql.includes("INSERT INTO inbound_emails")
        )
          throw new Error("Lost D1 response");
      },
    });
    expect(await f.deliver(forwardingAddress)).toBeUndefined();
    expect(
      f.database.query("SELECT id FROM inbound_emails").all(),
    ).toHaveLength(1);
    expect(
      f.database.query("SELECT id FROM deleted_object_cleanup").all(),
    ).toHaveLength(0);
    expect(f.storage.stored.size).toBe(1);
  });
  it.each(["inbox.balebase.com", "inbox-staging.balebase.com"])(
    "protects platform and legacy addresses on %s",
    async (domain) => {
      const f = fixture(domain);
      expect(
        (await f.request("/routing", "GET", undefined, "owner", "member"))
          .status,
      ).toBe(403);
      for (const name of ["balebase.com", "auth.balebase.com", domain]) {
        expect(
          (await f.request("/routing/domains", "POST", { domain: name }))
            .status,
        ).toBe(403);
        expect((await f.bind(`privacy@${name}`)).status).toBe(403);
      }
      expect((await f.bind(`upload+anything@${domain}`, "root")).status).toBe(
        403,
      );
      expect((await f.bind(`inbox+anything@${domain}`, "root")).status).toBe(
        403,
      );
      const platform =
        domain === "inbox.balebase.com" ? "balebase.com" : domain;
      for (const address of [`legal@${platform}`, `privacy@${platform}`]) {
        expect((await f.bind(address, "root")).status).toBe(201);
        expect(await f.deliver(address)).toBeUndefined();
      }
      expect(
        f.database
          .query(
            "SELECT DISTINCT mailbox_id FROM inbound_emails WHERE organization_id = 'org_root'",
          )
          .all(),
      ).toHaveLength(2);
      f.database
        .query("UPDATE organization SET deletedAt = ? WHERE id = 'org_root'")
        .run(new Date().toISOString());
      expect(await f.deliver(`legal@${platform}`)).toBe("Unknown recipient");
    },
  );
});
