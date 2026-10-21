import { afterEach, expect, it } from "bun:test";
import { route } from "@balebase/validators/route";
import { z } from "zod";
import { ApiError } from "./ApiError";
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

const update = route({
  method: "PATCH",
  path: "/api/things/:id/parts/:partId",
  query: z.object({ tag: z.array(z.string()).optional(), view: z.string() }),
  body: z.object({ name: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

it("fills path parameters, the query, and a JSON body", async () => {
  const result = await transport.call(update, {
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

it("leaves out query values that are unset", () => {
  const list = route({
    method: "GET",
    path: "/api/things",
    query: z.object({ cursor: z.string().optional() }),
    response: z.object({}),
  });
  expect(transport.url(list, { query: { cursor: undefined } })).toBe(
    "https://api.test/api/things",
  );
  expect(transport.url(list)).toBe("https://api.test/api/things");
});

it("sends a form as is and a file with its own type", async () => {
  const form = new FormData();
  form.set("file", new File(["x"], "a.txt"));
  await transport.call(
    route({
      method: "POST",
      path: "/api/forms",
      body: "form",
      response: "empty",
    }),
    { body: form },
  );
  expect(sent[0]?.init.body).toBe(form);
  expect(sent[0]?.init.headers).toBeUndefined();

  const image = new Blob(["png"], { type: "image/png" });
  await transport.call(
    route({
      method: "POST",
      path: "/api/files",
      body: "file",
      response: "empty",
    }),
    { body: image },
  );
  expect(sent[1]?.init.body).toBe(image);
  expect(sent[1]?.init.headers).toEqual({ "Content-Type": "image/png" });
});

it("returns nothing for 204, and the response itself for a download", async () => {
  const remove = route({
    method: "DELETE",
    path: "/api/things",
    response: z.object({}),
  });
  reply = () => new Response(null, { status: 204 });
  expect(await transport.call(remove)).toBeUndefined();

  const download = route({
    method: "GET",
    path: "/api/file",
    response: "file",
  });
  reply = () => new Response("bytes", { headers: { "X-Revision": "3" } });
  const response = await transport.call(download);
  expect(response.headers.get("X-Revision")).toBe("3");
  expect(await response.text()).toBe("bytes");
});

it("throws the API's message and code, keeping the response", async () => {
  const get = route({ method: "GET", path: "/api/thing", response: "empty" });
  reply = () =>
    Response.json(
      { code: "UPGRADE_REQUIRED", error: "Upgrade to Pro.", seats: 3 },
      { headers: { "Retry-After": "5" }, status: 402 },
    );
  const error = await transport.call(get).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    body: { seats: 3 },
    code: "UPGRADE_REQUIRED",
    message: "Upgrade to Pro.",
    status: 402,
  });
  expect((error as ApiError).response.headers.get("Retry-After")).toBe("5");

  reply = () => new Response("<html>", { status: 502 });
  expect(await transport.call(get).catch((cause: Error) => cause.message)).toBe(
    "Request failed with status 502.",
  );
});
