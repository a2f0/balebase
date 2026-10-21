import { expect, it } from "bun:test";
import { routes } from "./routes";

const all = Object.entries(routes).flatMap(([area, entries]) =>
  Object.entries(entries).map(([name, route]) => ({ area, name, route })),
);

it("names each route once, under the API's path space", () => {
  const keys = all.map(({ route }) => `${route.method} ${route.path}`);
  expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
  for (const { area, name, route } of all) {
    expect(`${area}.${name} ${route.path}`).toMatch(
      /^\S+ \/api(\/(:[A-Za-z]+|[a-z0-9-]+))+$/,
    );
  }
});
