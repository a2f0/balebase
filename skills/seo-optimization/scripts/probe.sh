#!/bin/sh
# Report a host's live search and preview metadata.
#
#   probe.sh <host> [path]               page report, then site files
#   probe.sh --page <host> [path]        page report only
#   probe.sh --headers <host> <path>...  one line per path, redirects not
#                                        followed: status, X-Robots-Tag,
#                                        type, Location
#   probe.sh --links <host> [path]       internal links on the page that do
#                                        not answer 200 directly
#   probe.sh --sitemap <host>            every sitemap URL: status, canonical,
#                                        robots, duplicate titles/descriptions;
#                                        follows one level of sitemap index
#
# --links and --sitemap exit 1 when they find a problem. An unreachable host
# exits 1 and a usage error exits 2.
#
# Matching uses regular expressions over whitespace-collapsed HTML, with
# double-quoted attributes, so confirm surprising results in the raw
# response. Headers come from the final response after redirects; the first
# hop is shown separately. Every request adds a cache-busting query, and only
# HTTP and HTTPS URLs are fetched, including after redirects. Set
# SEO_PROBE_USER_AGENT to send a browser user agent; a CDN may inject scripts
# only for browsers. SEO_PROBE_SCHEME (default https) exists for tests.
set -u

usage() {
  sed -n '4,17p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
mode=full
case "${1:-}" in
  --headers) mode=headers; shift ;;
  --page) mode=page; shift ;;
  --links) mode=links; shift ;;
  --sitemap) mode=sitemap; shift ;;
  -*|"") usage ;;
esac
[ $# -ge 1 ] || usage
host=$1
shift
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bust="seo-probe=$(date +%s)"

with_bust() {
  case "$1" in
    *\?*) printf '%s&%s' "$1" "$bust" ;;
    *) printf '%s?%s' "$1" "$bust" ;;
  esac
}

# One request without following redirects. Writes <name>.body and
# <name>.headers and prints "status|location|content-type".
ua=${SEO_PROBE_USER_AGENT:-seo-probe}

# Every request goes through web(). URLs come from remote markup (og:image,
# sitemap entries, links, redirects), so only HTTP and HTTPS are allowed.
web() {
  curl --proto '=http,https' --proto-redir '=http,https' -sS -m 20 -A "$ua" "$@"
}
scheme=${SEO_PROBE_SCHEME:-https}
origin="$scheme://$host"

request() {
  web -o "$tmp/$2.body" -D "$tmp/$2.headers" \
    -w '%{http_code}|%{redirect_url}|%{content_type}' "$1" 2>/dev/null
}

# ok_html <fetch result>: true when the final response is a 200 HTML page.
ok_html() {
  case "$1" in
    200\ text/html* | *"=> 200 text/html"*) return 0 ;;
    *) return 1 ;;
  esac
}

# ok_sitemap <fetch result> <name>: true when the final response is a 200
# sitemap or sitemap index document.
ok_sitemap() {
  case "$1" in
    200\ * | *"=> 200 "*) ;;
    *) return 1 ;;
  esac
  grep -qE '<(urlset|sitemapindex)([[:space:]>]|$)' "$tmp/$2.body" 2>/dev/null
}

# fetch <url> <name>: follows redirects, keeps the final response's headers
# in <name>.headers, its body in <name>.body, and its URL in <name>.url, and
# prints "first-status [-> location] => final-status content-type".
fetch() {
  first=$(web -o /dev/null -w '%{http_code} %{redirect_url}' "$1" 2>/dev/null)
  final_url=$(web -L -o "$tmp/$2.body" -D "$tmp/$2.all" \
    -w '%{http_code} %{content_type}|%{url_effective}' "$1" 2>/dev/null)
  final=${final_url%%|*}
  printf '%s' "${final_url#*|}" >"$tmp/$2.url"
  awk '/^HTTP\//{block=""; next} {block=block $0 "\n"} END{printf "%s", block}' \
    "$tmp/$2.all" >"$tmp/$2.headers" 2>/dev/null
  first_code=${first%% *}
  location=${first#* }
  if [ -n "$location" ] && [ "$location" != "$first" ]; then
    printf '%s -> %s => %s' "$first_code" "$location" "$final"
  else
    printf '%s' "$final"
  fi
}

# Every X-Robots-Tag value, joined with " | " so duplicate lines show.
robots_tag() {
  grep -i '^x-robots-tag' "$tmp/$1.headers" 2>/dev/null | tr -d '\r' |
    sed 's/^[^:]*: *//' | awk 'NR > 1 {printf " | "} {printf "%s", $0}'
}

# Helpers over a collapsed HTML body in $body.
first() { printf '%s\n' "$body" | grep -oiE "$1" | head -n 1; }
names() { printf '%s\n' "$body" | grep -oiE "$1" | sort -u | tr '\n' ' '; }
attr() { grep -oiE "$1=\"[^\"]*\"" | sed -E 's/^[^"]*"(.*)"$/\1/'; }
content_of() {
  first "<meta[^>]+(property|name)=\"$1\"[^>]*>" | attr content
}
load_body() { body=$(tr '\n\r\t' '   ' <"$tmp/$1.body" 2>/dev/null); }
# locs <name>: the <loc> values in <name>.body, whitespace-tolerant.
locs() {
  tr '\n\r\t' '   ' <"$tmp/$1.body" 2>/dev/null | grep -oE '<loc>[^<]+</loc>' |
    sed -E 's#</?loc>##g; s/^ +//; s/ +$//' | unescape
}
# Decode the predefined XML entities in URLs from markup; &amp; goes last.
unescape() {
  sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e "s/&apos;/'/g" \
    -e 's/&#39;/'"'"'/g' -e 's/&amp;/\&/g'
}
title_of() { first '<title[^>]*>[^<]*</title>' | sed -E 's/<[^>]*>//g'; }
canonical_of() {
  first '<link[^>]+rel="canonical"[^>]*>' | attr href | unescape
}

if ! web -m 15 -o /dev/null "$origin/" 2>"$tmp/err"; then
  echo "### $host  does not respond: $(tr -d '\n' <"$tmp/err")"
  exit 1
fi

if [ "$mode" = headers ]; then
  [ $# -ge 1 ] || usage
  for path in "$@"; do
    result=$(request "$(with_bust "$origin$path")" h)
    status=${result%%|*}
    rest=${result#*|}
    location=$(printf '%s' "${rest%%|*}" | sed -E "s/[?&]$bust//")
    type=${rest#*|}
    tag=$(robots_tag h)
    printf '%s%s  %s  x-robots-tag: %s  type: %s%s\n' "$host" "$path" \
      "${status:-no response}" "${tag:-(absent)}" "${type:--}" \
      "${location:+  -> $location}"
  done
  exit 0
fi

if [ "$mode" = links ]; then
  path=${1:-/}
  page_result=$(fetch "$(with_bust "$origin$path")" page)
  if ! ok_html "$page_result"; then
    echo "### $host$path  page: ${page_result:-no response}  (cannot audit its links)"
    exit 1
  fi
  load_body page
  # Resolve relative links against the document's final URL, after redirects,
  # which may be on another host.
  final_origin=$(sed -E 's#^([a-z]+://[^/]+).*#\1#' "$tmp/page.url")
  final_host=${final_origin#*://}
  final_path=$(sed -E "s#^[a-z]+://[^/]+##; s/[?#].*//" "$tmp/page.url")
  base=${final_path%/*}/
  printf '%s\n' "$body" | grep -oiE '<a[^>]+href="[^"]*"' |
    attr href | unescape | sed 's/#.*//' | grep -v '^$' >"$tmp/hrefs"
  host_pattern=$(printf '%s' "$final_host" | sed 's/[.[\*^$]/\\&/g')
  grep -iE "^https?://$host_pattern([/?]|$)" "$tmp/hrefs" >"$tmp/links.absolute"
  grep -vE '^[a-zA-Z][a-zA-Z0-9+.-]*:|^//' "$tmp/hrefs" |
    awk -v base="$base" -v page="$final_path" '
      # Resolve a relative reference against the final document URL.
      {
        ref = $0
        if (substr(ref, 1, 1) == "?") ref = page ref
        else if (substr(ref, 1, 1) != "/") ref = base ref
        query = ""
        q = index(ref, "?")
        if (q > 0) { query = substr(ref, q); ref = substr(ref, 1, q - 1) }
        n = split(ref, parts, "/")
        out = ""
        depth = 0
        for (i = 2; i <= n; i++) {
          if (parts[i] == "." || parts[i] == "") continue
          if (parts[i] == "..") { if (depth > 0) depth--; continue }
          stack[++depth] = parts[i]
        }
        for (i = 1; i <= depth; i++) out = out "/" stack[i]
        if (out == "") out = "/"
        last = parts[n]
        if ((ref ~ /\/$/ || last == "." || last == "..") && out != "/") out = out "/"
        print out query
      }' | sed "s#^#$final_origin#" >"$tmp/links.relative"
  cat "$tmp/links.absolute" "$tmp/links.relative" | sort -u >"$tmp/links"
  total=0
  bad=0
  while IFS= read -r link; do
    total=$((total + 1))
    result=$(request "$(with_bust "$link")" link)
    status=${result%%|*}
    rest=${result#*|}
    location=${rest%%|*}
    if [ "$status" != 200 ]; then
      bad=$((bad + 1))
      echo "  ${link#"$final_origin"}  $status${location:+ -> $location}"
    fi
  done <"$tmp/links"
  [ "$final_host" = "$host" ] || echo "  (links resolved against $final_origin after a redirect)"
  echo "### $host$path  internal links in the static HTML: $total, not a direct 200: $bad"
  [ "$total" -gt 0 ] ||
    echo "  (no links in the static HTML; a client-rendered page needs a browser check)"
  [ "$bad" -eq 0 ] || exit 1
  exit 0
fi

if [ "$mode" = sitemap ]; then
  sitemap_result=$(fetch "$(with_bust "$origin/sitemap.xml")" sitemap)
  if ! ok_sitemap "$sitemap_result" sitemap; then
    echo "### $host  sitemap.xml: ${sitemap_result:-no response}  (not a sitemap document)"
    exit 1
  fi
  locs sitemap >"$tmp/urls"
  problems=0
  if grep -q '<sitemapindex' "$tmp/sitemap.body" 2>/dev/null; then
    : >"$tmp/children"
    while IFS= read -r child; do
      child_result=$(fetch "$(with_bust "$child")" child)
      if ok_sitemap "$child_result" child && grep -q '<urlset' "$tmp/child.body"; then
        locs child >>"$tmp/children"
      else
        problems=$((problems + 1))
        echo "  $child: child sitemap ${child_result:-no response}, not a urlset;"
      fi
    done <"$tmp/urls"
    mv "$tmp/children" "$tmp/urls"
  fi
  : >"$tmp/titles"
  : >"$tmp/descriptions"
  total=0
  while IFS= read -r url; do
    total=$((total + 1))
    result=$(request "$(with_bust "$url")" entry)
    status=${result%%|*}
    load_body entry
    canonical=$(canonical_of)
    robots=$(printf '%s %s' "$(robots_tag entry)" "$(content_of robots)" |
      tr '[:upper:]' '[:lower:]')
    note=""
    [ "$status" = 200 ] || note="$note status $status;"
    [ "$canonical" = "$url" ] || note="$note canonical ${canonical:-missing};"
    case " $robots " in
      *noindex* | *[\ ,:]none[\ ,]*) note="$note noindex;" ;;
    esac
    if [ -n "$note" ]; then
      problems=$((problems + 1))
      echo "  $url:$note"
    fi
    printf '%s\t%s\n' "$(title_of)" "$url" >>"$tmp/titles"
    printf '%s\t%s\n' "$(content_of description)" "$url" >>"$tmp/descriptions"
  done <"$tmp/urls"
  for kind in titles descriptions; do
    cut -f1 "$tmp/$kind" | grep -v '^$' | sort | uniq -c | awk '$1 > 1' |
      sort -rn >"$tmp/$kind.dup"
    problems=$((problems + $(wc -l <"$tmp/$kind.dup")))
    head -n 5 "$tmp/$kind.dup" | sed "s/^ */  duplicate $kind (count, text): /"
  done
  if [ "$total" -eq 0 ]; then
    problems=$((problems + 1))
    echo "  (the sitemap lists no URLs)"
  fi
  echo "### $host  sitemap URLs: $total, with problems: $problems"
  [ "$problems" -eq 0 ] || exit 1
  exit 0
fi

path=${1:-/}
page_result=$(fetch "$(with_bust "$origin$path")" page)
load_body page
title=$(title_of)
description=$(content_of description)

echo "### $host$path  [$page_result]"
page_tag=$(robots_tag page)
echo "  x-robots-tag: ${page_tag:-(absent)}"
echo "  title (${#title} chars): $title"
echo "  description (${#description} chars): $(printf '%s' "$description" | cut -c1-220)"
echo "  canonical: $(canonical_of)"
echo "  robots meta: $(content_of robots)"
echo "  lang: $(first '<html[^>]*lang="[^"]*"' | attr lang)"
echo "  theme-color: $(printf '%s\n' "$body" | grep -oiE '<meta[^>]+name="theme-color"[^>]*>' | attr content | tr '\n' ' ')"
echo "  og: $(names 'property="og:[a-z_:]+"' | sed 's/property=//g')"
echo "  og:url: $(content_of 'og:url')"
echo "  twitter:card: $(content_of 'twitter:card')"
echo "  json-ld blocks: $(printf '%s\n' "$body" | grep -oi 'application/ld+json' | wc -l | tr -d ' ')"
echo "  json-ld types (including nested): $(names '"@type": *("[A-Za-z]+"|\[[^]]*\])' | sed -E 's/"@type": *//g')"
echo "  h1 count (static HTML, before JavaScript): $(printf '%s\n' "$body" | grep -oiE '<h1[ >]' | wc -l | tr -d ' ')"

image=$(content_of 'og:image')
if [ -n "$image" ]; then
  image_result=$(fetch "$(with_bust "$image")" image)
  size=""
  if head -c 8 "$tmp/image.body" 2>/dev/null | od -An -c | grep -q 'P   N   G'; then
    size=$(od -An -tu1 -j16 -N8 "$tmp/image.body" |
      awk 'NF >= 8 {printf "%dx%d", $1*16777216+$2*65536+$3*256+$4, $5*16777216+$6*65536+$7*256+$8; exit}')
  fi
  image_tag=$(robots_tag image)
  echo "  og:image: $image [$image_result] ${size:+size $size} x-robots-tag: ${image_tag:-(absent)}"
else
  echo "  og:image: none"
fi

[ "$mode" = page ] && exit 0

robots_result=$(fetch "$(with_bust "$origin/robots.txt")" robots)
case "$robots_result" in *text/html*) robots_result="$robots_result  (HTML, not a robots file)" ;; esac
if grep -q 'BEGIN Cloudflare Managed' "$tmp/robots.body" 2>/dev/null; then
  robots_result="$robots_result  (includes Cloudflare managed content)"
elif grep -qi '^#.*content signals' "$tmp/robots.body" 2>/dev/null; then
  robots_result="$robots_result  (Cloudflare content-signals file)"
fi
if grep -v '^#' "$tmp/robots.body" 2>/dev/null | grep -qi '^content-signal:'; then
  robots_result="$robots_result  (has Content-Signal directives)"
elif [ -s "$tmp/robots.body" ] &&
  ! grep -vE '^#|^[[:space:]]*$' "$tmp/robots.body" 2>/dev/null | grep -q .; then
  robots_result="$robots_result  (comments only: no directives)"
fi
robots_txt_tag=$(robots_tag robots)
echo "  robots.txt: $robots_result  x-robots-tag: ${robots_txt_tag:-(absent)}"
case "$robots_result" in
  *HTML*) ;;
  *)
    grep -vE '^#|^[[:space:]]*$' "$tmp/robots.body" 2>/dev/null >"$tmp/directives"
    sed -n '1,15p' "$tmp/directives" | sed 's/^/    | /'
    if [ "$(wc -l <"$tmp/directives")" -gt 15 ]; then
      echo "    | ... $(grep -ci '^sitemap:' "$tmp/directives") Sitemap line(s):"
      grep -i '^sitemap:' "$tmp/directives" | tr -d '\r' | sed 's/^/    | /'
    fi
    ;;
esac
sitemap_result=$(fetch "$(with_bust "$origin/sitemap.xml")" sitemap)
case "$sitemap_result" in *text/html*) sitemap_result="$sitemap_result  (HTML, not a sitemap)" ;; esac
echo "  sitemap.xml: $sitemap_result  urls: $(grep -o '<loc>' "$tmp/sitemap.body" 2>/dev/null | wc -l | tr -d ' ')"
missing_result=$(fetch "$(with_bust "$origin/seo-probe-missing-page")" missing)
load_body missing
echo "  missing path: $missing_result  body: $(wc -c <"$tmp/missing.body" | tr -d ' ') bytes  title: $(title_of)"
nested_result=$(fetch "$(with_bust "$origin/seo-probe/missing/page")" nested)
echo "  nested missing path: $nested_result  body: $(wc -c <"$tmp/nested.body" | tr -d ' ') bytes"
error_result=$(fetch "$(with_bust "$origin/404")" error)
load_body error
error_tag=$(robots_tag error)
echo "  /404: $error_result  robots meta: $(content_of robots)  x-robots-tag: ${error_tag:-(absent)}"
http_result=$(web -m 15 -o /dev/null -D "$tmp/http.headers" \
  -w '%{http_code} %{redirect_url}' "$(with_bust "http://$host/")" 2>/dev/null |
  sed -E "s/[?&]$bust//")
case "$http_result" in
  30[178]\ https://*) http_note="redirects to HTTPS" ;;
  *) http_note="does not redirect to HTTPS" ;;
esac
http_tag=$(robots_tag http)
echo "  http:// root: $http_result  ($http_note)  x-robots-tag: ${http_tag:-(absent)}"
