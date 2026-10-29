import { afterEach, expect, it } from "bun:test";
import { route } from "@balebase/validators/route";
import { z } from "zod";
import { ApiError } from "./ApiError";
import { endpoint } from "./endpoint";
import { Transport } from "./transport";

const sent: { init: RequestInit; url: string }[] = [];
let reply = () => Response.json({ ok: true });
const transport = new Transport({
  baseUrl: "https://api.test",
  fetch: async (url, init) => {
    sent.push({ init, url });
    return reply();
  },
});

afterEach(() => {
  sent.length = 0;
  reply = () => Response.json({ ok: true });
});

const contract = {
  update: route({
    method: "PATCH",
    path: "/api/things/:id/parts/:partId",
    query: z.object({ tag: z.array(z.string()).optional(), view: z.string() }),
    body: z.object({ name: z.string() }),
    response: z.object({ ok: z.boolean() }),
  }),
  list: route({
    method: "GET",
    path: "/api/things",
    query: z.object({ cursor: z.string().optional() }),
    response: z.object({}),
  }),
  link: route({
    credentials: "omit",
    method: "GET",
    path: "/api/links/:token",
    response: z.object({}),
  }),
  form: route({
    method: "POST",
    path: "/api/forms",
    body: "form",
    response: "empty",
  }),
  file: route({
    method: "POST",
    path: "/api/files",
    body: "file",
    response: "empty",
  }),
  remove: route({
    method: "DELETE",
    path: "/api/things",
    response: z.object({}),
  }),
  download: route({ method: "GET", path: "/api/file", response: "file" }),
};

const endpoints = {
  update: endpoint<typeof contract.update>({
    method: "PATCH",
    path: "/api/things/:id/parts/:partId",
    body: "json",
    response: "json",
  }),
  list: endpoint<typeof contract.list>({
    method: "GET",
    path: "/api/things",
    response: "json",
  }),
  link: endpoint<typeof contract.link>({
    method: "GET",
    path: "/api/links/:token",
    credentials: "omit",
    response: "json",
  }),
  form: endpoint<typeof contract.form>({
    method: "POST",
    path: "/api/forms",
    body: "form",
    response: "empty",
  }),
  file: endpoint<typeof contract.file>({
    method: "POST",
    path: "/api/files",
    body: "file",
    response: "empty",
  }),
  remove: endpoint<typeof contract.remove>({
    method: "DELETE",
    path: "/api/things",
    response: "json",
  }),
  download: endpoint<typeof contract.download>({
    method: "GET",
    path: "/api/file",
    response: "file",
  }),
};

it("rejects an endpoint that disagrees with its contract", () => {
  // @ts-expect-error The contract's method is PATCH.
  endpoint<typeof contract.update>({ ...endpoints.update, method: "PUT" });
  // @ts-expect-error The contract's path names `:partId`.
  endpoint<typeof contract.update>({ ...endpoints.update, path: "/api/x" });
  // @ts-expect-error The contract sends cookies to this route.
  endpoint<typeof contract.list>({ ...endpoints.list, credentials: "omit" });
  // @ts-expect-error The contract's body is JSON.
  endpoint<typeof contract.update>({ ...endpoints.update, body: "form" });
});

it("fills path parameters, the query, and a JSON body", async () => {
  const result = await transport.call(endpoints.update, {
    body: { name: "Pump" },
    params: { id: "a/b", partId: "7" },
    query: { tag: ["x", "y"], view: "full" },
  });
  expect(result).toEqual({ ok: true });
  expect(sent[0]?.url).toBe(
    "https://api.test/api/things/a%2Fb/parts/7?tag=x&tag=y&view=full",
  );
  expect(sent[0]?.init).toEqual({
    body: '{"name":"Pump"}',
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
});

it("sends no cookies to a route its path token authorizes", async () => {
  await transport.call(endpoints.link, { params: { token: "t" } });
  expect(sent[0]?.init.credentials).toBe("omit");
});

it("leaves out query values that are unset", () => {
  expect(transport.url(endpoints.list, { query: { cursor: undefined } })).toBe(
    "https://api.test/api/things",
  );
  expect(transport.url(endpoints.list)).toBe("https://api.test/api/things");
});

it("sends a form as is and a file with its own type", async () => {
  const form = new FormData();
  form.set("file", new File(["x"], "a.txt"));
  await transport.call(endpoints.form, { body: form });
  expect(sent[0]?.init.body).toBe(form);
  expect(sent[0]?.init.headers).toBeUndefined();

  const image = new Blob(["png"], { type: "image/png" });
  await transport.call(endpoints.file, { body: image });
  expect(sent[1]?.init.body).toBe(image);
  expect(sent[1]?.init.headers).toEqual({ "Content-Type": "image/png" });
});

it("returns nothing for 204, and the response itself for a download", async () => {
  reply = () => new Response(null, { status: 204 });
  expect(await transport.call(endpoints.remove)).toBeUndefined();

  reply = () => new Response("bytes", { headers: { "X-Revision": "3" } });
  const response = await transport.call(endpoints.download);
  expect(response.headers.get("X-Revision")).toBe("3");
  expect(await response.text()).toBe("bytes");
});

it("throws the API's message and code, keeping the response", async () => {
  reply = () =>
    Response.json(
      { code: "UPGRADE_REQUIRED", error: "Upgrade to Pro.", seats: 3 },
      { headers: { "Retry-After": "5" }, status: 402 },
    );
  const error = await transport
    .call(endpoints.form, { body: new FormData() })
    .catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    code: "UPGRADE_REQUIRED",
    message: "Upgrade to Pro.",
    status: 402,
  });
  expect((error as ApiError).response.headers.get("Retry-After")).toBe("5");

  reply = () => new Response("<html>", { status: 502 });
  expect(
    await transport
      .call(endpoints.remove)
      .catch((cause: Error) => cause.message),
  ).toBe("Request failed with status 502.");
});
