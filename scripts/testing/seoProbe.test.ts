import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Runs the seo-optimization skill's probe against local fixture servers, so
// its parsing, redirect, and failure handling are checked without a network.
const probe = fileURLToPath(
  new URL("../../skills/seo-optimization/scripts/probe.sh", import.meta.url),
);

type Server = ReturnType<typeof Bun.serve>;
let site: Server;
let shell: Server;
let indexed: Server;
let siteHost = "";
let shellHost = "";
let indexedHost = "";

function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function page(
  title: string,
  canonical: string,
  extra = "",
  body = "<h1>Example</h1>",
) {
  return new Response(
    `<!doctype html><html lang="en"><head><title>${title}</title>
<meta name="description" content="A fixture page for the probe.">
<link rel="canonical" href="${canonical}">${extra}</head>
<body>${body}</body></html>`,
    { headers: { "content-type": "text/html" } },
  );
}

function redirect(location: string, status = 301, headers = {}) {
  return new Response(null, { status, headers: { location, ...headers } });
}

function siteResponse(path: string): Response {
  const origin = `http://${siteHost}`;
  switch (path) {
    case "/":
      return page(
        "Probe Fixture - Example",
        `${origin}/`,
        `<meta property="og:title" content="Probe Fixture">
<meta property="og:url" content="${origin}/">
<meta property="og:image" content="${origin}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#000000">
<script type="application/ld+json">{"@type": "WebSite"}</script>`,
        `<h1>Example</h1><a href="/about/">About</a><a href="docs">Docs</a>
<a href="https://external.example/">External</a><a href="/old">Old</a>`,
      );
    case "/about/":
      return page("About - Example", `${origin}/about/`);
    case "/dup/":
      return page("About - Example", `${origin}/about/`);
    case "/docs":
    case "/guide/child":
      return page("Docs - Example", `${origin}${path}`);
    case "/old":
      return redirect("/about/");
    case "/guide":
      return redirect("/guide/", 307, { "x-robots-tag": "noindex" });
    case "/guide/":
      return page(
        "Guide - Example",
        `${origin}/guide/`,
        "",
        '<a href="child">Child</a><a href="../about/">About</a>',
      );
    case "/og-image.png":
      return new Response(png(1200, 630), {
        headers: { "content-type": "image/png" },
      });
    case "/robots.txt":
      return new Response(
        `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
        { headers: { "content-type": "text/plain" } },
      );
    case "/sitemap.xml":
      return new Response(
        `<?xml version="1.0"?><urlset>${["/", "/about/", "/dup/", "/gone/"]
          .map((entry) => `<url><loc>${origin}${entry}</loc></url>`)
          .join("")}</urlset>`,
        { headers: { "content-type": "application/xml" } },
      );
    case "/404":
      return page("Not found", "", '<meta name="robots" content="noindex">');
    default:
      return new Response("<title>Not found</title>", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
  }
}

// A sitemap index with one valid child sitemap and one that is missing.
function indexedResponse(path: string): Response {
  const origin = `http://${indexedHost}`;
  const xml = (body: string) =>
    new Response(`<?xml version="1.0"?>${body}`, {
      headers: { "content-type": "application/xml" },
    });
  switch (path) {
    case "/":
      return page("Indexed - Example", `${origin}/`);
    case "/sitemap.xml":
      return xml(
        `<sitemapindex><sitemap><loc>${origin}/pages.xml</loc></sitemap>` +
          `<sitemap><loc>${origin}/missing.xml</loc></sitemap></sitemapindex>`,
      );
    case "/pages.xml":
      return xml(`<urlset><url><loc>${origin}/</loc></url></urlset>`);
    default:
      return new Response("Not found", { status: 404 });
  }
}

beforeAll(() => {
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => siteResponse(new URL(request.url).pathname),
  });
  siteHost = `127.0.0.1:${site.port}`;
  // A single-page fallback: every path answers the same HTML shell.
  shell = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response('<html><body><div id="root"></div></body></html>', {
        headers: { "content-type": "text/html" },
      }),
  });
  shellHost = `127.0.0.1:${shell.port}`;
  indexed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => indexedResponse(new URL(request.url).pathname),
  });
  indexedHost = `127.0.0.1:${indexed.port}`;
});

afterAll(() => {
  site.stop(true);
  shell.stop(true);
  indexed.stop(true);
});

async function run(...args: string[]) {
  const child = Bun.spawn(["sh", probe, ...args], {
    env: { ...process.env, SEO_PROBE_SCHEME: "http" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("reports a page's metadata and the site files", async () => {
  const { stdout, exitCode } = await run(siteHost);
  const origin = `http://${siteHost}`;

  expect(exitCode).toBe(0);
  expect(stdout).toContain("title (23 chars): Probe Fixture - Example");
  expect(stdout).toContain(`canonical: ${origin}/`);
  expect(stdout).toContain("x-robots-tag: (absent)");
  expect(stdout).toContain("twitter:card: summary_large_image");
  expect(stdout).toContain('json-ld types (including nested): "WebSite"');
  expect(stdout).toContain("h1 count (static HTML, before JavaScript): 1");
  expect(stdout).toContain(
    `og:image: ${origin}/og-image.png [200 image/png] size 1200x630`,
  );
  expect(stdout).toContain("robots.txt: 200 text/plain");
  expect(stdout).toContain(`| Sitemap: ${origin}/sitemap.xml`);
  expect(stdout).toContain("sitemap.xml: 200 application/xml  urls: 4");
  expect(stdout).toMatch(/missing path: 404 text\/html .*title: Not found/);
  expect(stdout).toContain("/404: 200 text/html  robots meta: noindex");
  expect(stdout).toContain("http:// root: 200   (does not redirect to HTTPS)");
});

test("reads headers from the final response after a redirect", async () => {
  const { stdout } = await run("--page", siteHost, "/guide");
  const [heading, robots] = stdout.split("\n");

  expect(heading).toContain(`307 -> http://${siteHost}/guide/`);
  expect(heading).toContain("=> 200 text/html");
  // The redirect carries noindex; the page it lands on does not.
  expect(robots).toBe("  x-robots-tag: (absent)");
});

test("prints one header line per path without following redirects", async () => {
  const { stdout } = await run("--headers", siteHost, "/guide", "/");

  expect(stdout).toBe(
    `${siteHost}/guide  307  x-robots-tag: noindex  type: -  -> http://${siteHost}/guide/\n` +
      `${siteHost}/  200  x-robots-tag: (absent)  type: text/html\n`,
  );
});

test("resolves relative links against the final document URL", async () => {
  const { stdout, exitCode } = await run("--links", siteHost, "/guide");

  expect(exitCode).toBe(0);
  expect(stdout).toContain(
    "internal links in the static HTML: 2, not a direct 200: 0",
  );
});

test("reports internal links that redirect and ignores external ones", async () => {
  const { stdout, exitCode } = await run("--links", siteHost, "/");

  expect(exitCode).toBe(1);
  expect(stdout).toContain(`/old  301 -> http://${siteHost}/about/`);
  expect(stdout).toContain(
    "internal links in the static HTML: 3, not a direct 200: 1",
  );
});

test("fails a link audit when the page itself does not load", async () => {
  const { stdout, exitCode } = await run("--links", siteHost, "/missing");

  expect(exitCode).toBe(1);
  expect(stdout).toContain(
    `### ${siteHost}/missing  page: 404 text/html  (cannot audit its links)`,
  );
});

test("follows a sitemap index and reports a missing child sitemap", async () => {
  const { stdout, exitCode } = await run("--sitemap", indexedHost);
  const origin = `http://${indexedHost}`;

  expect(exitCode).toBe(1);
  expect(stdout).toContain(`${origin}/missing.xml: child sitemap 404`);
  expect(stdout).toContain("sitemap URLs: 1, with problems: 1");
});

test("checks every sitemap URL and reports duplicates", async () => {
  const { stdout, exitCode } = await run("--sitemap", siteHost);
  const origin = `http://${siteHost}`;

  expect(exitCode).toBe(1);
  expect(stdout).toContain(`${origin}/dup/: canonical ${origin}/about/;`);
  expect(stdout).toContain(`${origin}/gone/: status 404; canonical missing;`);
  expect(stdout).toContain("duplicate titles (count, text): 2 About - Example");
  expect(stdout).toContain("sitemap URLs: 4, with problems: 2");
});

test("flags HTML answers from a single-page fallback", async () => {
  const full = await run(shellHost);
  expect(full.stdout).toContain("(HTML, not a robots file)");
  expect(full.stdout).toContain("(HTML, not a sitemap)");

  const sitemap = await run("--sitemap", shellHost);
  expect(sitemap.exitCode).toBe(1);
  expect(sitemap.stdout).toContain("(not a sitemap document)");

  const links = await run("--links", shellHost, "/");
  expect(links.stdout).toContain("(no links in the static HTML;");
});

test("stops when the host does not respond", async () => {
  const closed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const host = `127.0.0.1:${closed.port}`;
  closed.stop(true);

  const { stdout, exitCode } = await run(host);
  expect(exitCode).toBe(1);
  expect(stdout).toContain(`### ${host}  does not respond:`);
});

test("rejects missing arguments", async () => {
  const { stderr, exitCode } = await run();
  expect(exitCode).toBe(2);
  expect(stderr).toContain("probe.sh --sitemap <host>");
});
