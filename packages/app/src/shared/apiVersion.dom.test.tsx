import { expect, it } from "bun:test";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { balebase } from "../balebase";
import { configureHost } from "../host";
import { installDom } from "../testing/dom";
import { useApiVersion } from "./apiVersion";

const { mount } = installDom({ url: "http://localhost:5173/" });

function Version() {
  return <p>{useApiVersion() ?? "unknown"}</p>;
}

/** Records a response naming `version`, as every API request does. */
function answered(version: string) {
  balebase().apiVersion.record(
    new Response(null, { headers: { "API-Version": version } }),
  );
}

it("shows the version the latest API response named", async () => {
  // A fresh SDK, which no other file's requests have answered.
  configureHost({});
  expect(renderToString(<Version />)).toBe("<p>unknown</p>");
  const { container } = await mount(<Version />);
  expect(container.textContent).toBe("unknown");
  await act(async () => answered("41"));
  expect(container.textContent).toBe("41");
  await act(async () => answered("42"));
  expect(container.textContent).toBe("42");
  expect(renderToString(<Version />)).toBe("<p>42</p>");
});
