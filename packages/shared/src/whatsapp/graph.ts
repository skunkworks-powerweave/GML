/**
 * The Graph API version this deployment calls, and the URLs built from it.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * The WhatsApp webhook built its media-metadata URL as
 * `https://graph.facebook.com/v19.0/{media-id}`, with the version written into
 * the URL literal. Meta's published version table gives v19.0 an expiration of
 * 2026-05-21, four months before this file was written. That is the code the
 * webhook would run; whether any deployment has actually made the call is not
 * established — docs/verification.md records that the ingest path has never
 * been exercised with a real Meta delivery.
 *
 * WHAT AN EXPIRED PIN ACTUALLY DOES, which is less dramatic than the first
 * version of this comment claimed. Meta's versioning guide, read at the source:
 *
 *   "For APIs, once a version is no longer usable, any calls made to it will be
 *    defaulted to the next oldest, usable version."
 *
 *   https://developers.facebook.com/docs/graph-api/guides/versioning
 *
 * So the call does not FAIL. It is served by v20.0 until that expires today
 * (2026-09-24), then by v21.0, and so on — silently, and changing underneath the
 * code at each expiry. No media is lost to it. The defect is that the code is
 * written against one version's behaviour and served by another's, with the
 * substitution invisible and unscheduled.
 *
 * An earlier revision of this block said every failure on this path "collapses
 * to the same silence" and that a blank or revoked token was indistinguishable
 * from no video at all. That was wrong: route.ts records
 * `whatsapp.media.url_failed` when `fetchMediaUrl` returns null and
 * `whatsapp.media.fetch_failed` when `downloadMediaBytes` does. The expired
 * version was the one case that left no trace — precisely BECAUSE it does not
 * fail.
 *
 * So the version lives here, in one place, with a test that fails before it
 * expires (tests/governance/test_173_graph_api_version_pin.test.mjs).
 *
 * ── THE PINNING POLICY ───────────────────────────────────────────────────────
 *
 * Pin the newest version whose expiry Meta has PUBLISHED, not the newest version
 * outright. As of 2026-09-24 the table reads:
 *
 *   v26.0  released 2026-07-29  expires TBD      <- newest, no committed window
 *   v25.0  released 2026-02-18  expires 2028-07-29  <- pinned
 *   v24.0  released 2025-10-08  expires 2028-02-18
 *   v23.0  released 2025-05-29  expires 2027-10-08
 *   v22.0  released 2025-01-21  expires 2027-05-20
 *   v21.0  released 2024-10-02  expires 2027-01-21
 *   v20.0  released 2024-05-21  expires 2026-09-24  <- expires today
 *   v19.0  released 2024-01-23  expires 2026-05-21  <- was pinned, expired
 *
 *   https://developers.facebook.com/docs/graph-api/changelog/versions
 *
 * Two reasons for "newest with a published expiry" rather than "newest":
 *
 *   1. A published date is a committed support window that can be checked. "TBD"
 *      is not a commitment, and a governance test cannot assert anything about
 *      it — pinning v26.0 would silently disarm the canary that exists to stop
 *      this defect recurring.
 *   2. v25.0 still leaves 22 months of runway, which is longer than the interval
 *      at which this repository has historically been looked at.
 *
 * NOT VERIFIED HERE, and worth stating plainly: no call has been made against
 * v25.0 from this deployment, because that needs live Meta credentials which
 * this repository does not have. What is verified is the URL this code builds.
 * The endpoint itself — `GET /{media-id}` returning `{ messaging_product, url,
 * mime_type, sha256, file_size, id }` — carries no version-gated notes in Meta's
 * Cloud API media reference, and no release from v19.0 to v26.0 lists a change
 * to it. That is reasoning from the changelogs across the eight versions in the
 * table above, not a measurement; it does not extend to Meta's full version
 * history, which predates the WhatsApp Cloud API.
 */

/** The pinned version. Changing this line is the whole of a version bump. */
export const DEFAULT_GRAPH_API_VERSION = "v25.0";

/** Meta's version strings are `v<major>.<minor>`, always. */
const VERSION_SHAPE = /^v\d+\.\d+$/;

/**
 * An environment bag, without depending on Node's type definitions.
 *
 * ── WHY NOT `NodeJS.ProcessEnv` ──────────────────────────────────────────────
 *
 * The first version of this file typed the parameter as `NodeJS.ProcessEnv` and
 * defaulted it to `process.env`. `packages/shared` declares no `@types/node`
 * dependency and no other file in it referenced a Node global, so this was the
 * first — and CI rejected it on a clean install:
 *
 *   error TS2503: Cannot find namespace 'NodeJS'.
 *   error TS2591: Cannot find name 'process'.
 *
 * It typechecked on the machine it was written on, where `@types/node` happens
 * to be reachable through the pnpm store, which is exactly the shape of defect
 * this branch keeps finding: green locally, red on the platform CI runs.
 *
 * Adding `@types/node` to this package would have silenced it and been wrong.
 * `packages/shared` is imported by `apps/web`, including by code that reaches
 * the browser, where there is no `process` to speak of. A shared package that
 * asserts a Node runtime in its TYPES is claiming something about every consumer
 * of it. So the dependency is dropped rather than declared.
 */
export type EnvLike = Record<string, string | undefined>;

/**
 * The ambient environment if there is one, and an empty bag if there is not.
 *
 * Reached through `globalThis` rather than the bare `process` identifier so that
 * this module neither needs Node's types nor throws in a runtime without it —
 * a browser bundle, a Worker, an edge runtime. Callers that want determinism
 * pass their own bag, which is what every test here does.
 */
function ambientEnv(): EnvLike {
  return (globalThis as { process?: { env?: EnvLike } }).process?.env ?? {};
}

/**
 * The version to call, from the environment or the pin.
 *
 * `WHATSAPP_GRAPH_API_VERSION` exists so that an expiry can be survived by
 * setting one variable and restarting, rather than by shipping code — the
 * situation this file was written in response to is exactly the one where you
 * want that option.
 *
 * A malformed override is REFUSED rather than passed through. `v25` or `25.0`
 * would otherwise be pasted straight into a URL path, Meta would reject it, and
 * `!r.ok` upstream would turn that into a dropped video. The audit log WOULD
 * record it — as a bare `whatsapp.media.url_failed` with nothing pointing at the
 * variable that caused it, which is a loss that looks like a Meta outage. Falling
 * back to the pin keeps the deployment working and names the variable on stderr.
 * (A trailing newline is trimmed first and so never reaches this check.)
 *
 * The check is of SHAPE, not of MEMBERSHIP, and that has a consequence worth
 * knowing: `v19.0` passes it. An operator can set an expired version here and
 * recreate the original defect, and the date canary in test_173 will not see it,
 * because the canary reads the pin out of this file's source rather than out of
 * the environment. That is the price of letting the override name a version
 * newer than the table the test transcribes — which is the override's whole
 * purpose on the day the pin expires.
 */
export function graphApiVersion(env: EnvLike = ambientEnv()): string {
  const override = env.WHATSAPP_GRAPH_API_VERSION?.trim();
  if (!override) return DEFAULT_GRAPH_API_VERSION;
  if (!VERSION_SHAPE.test(override)) {
    console.error(
      `[whatsapp] WHATSAPP_GRAPH_API_VERSION="${override}" is not of the form vNN.N — ` +
        `ignoring it and using ${DEFAULT_GRAPH_API_VERSION}. ` +
        `See https://developers.facebook.com/docs/graph-api/changelog/versions`,
    );
    return DEFAULT_GRAPH_API_VERSION;
  }
  return override;
}

/**
 * The Graph URL for one media object's metadata.
 *
 * `GET /{media-id}` answers with a short-lived `url` to download the bytes from;
 * it does not return the bytes. The id is percent-encoded because it arrives
 * from an inbound webhook payload and is therefore not this code's to trust.
 * Encoded, every id stays one path segment on `graph.facebook.com` — `/`, `?`,
 * `#`, `@`, a full URL and CRLF included. The exception is the id `..`, which
 * `encodeURIComponent` leaves alone and URL normalisation resolves to the Graph
 * root: same host, so no credential goes anywhere else, and Graph answers
 * non-OK. That is byte-identical to the behaviour before this module existed.
 *
 * THROWS `URIError` on a lone UTF-16 surrogate, because `encodeURIComponent`
 * does. The one caller today, `fetchMediaUrl`, wraps it in a try/catch. A new
 * caller must do the same, or validate the id first.
 *
 * RUNTIME: the environment is read through `globalThis.process`, which exists on
 * Node. If the webhook route were ever moved to `runtime = "edge"`, the override
 * would stop being read and this would fall back to the pin — safely, but with
 * nothing to say so.
 *
 * Meta also accepts an optional `phone_number_id` query parameter here, which
 * scopes the lookup: "the request will only be processed if the business phone
 * number ID included in the query matches the ID of the business phone number
 * that the media was uploaded on." That would give `WHATSAPP_PHONE_NUMBER_ID` —
 * currently read by nothing in this repository — a real use on the inbound path.
 * Deliberately not wired up in this change, which is about the version pin; it
 * is a behaviour change to the fetch and belongs in its own commit with its own
 * test.
 */
export function mediaMetadataUrl(
  mediaId: string,
  env: EnvLike = ambientEnv(),
): string {
  return `https://${GRAPH_HOST}/${graphApiVersion(env)}/${encodeURIComponent(mediaId)}`;
}

/**
 * Split out so that the governance test's "no version in a URL literal" rule can
 * be enforced on this file too, rather than exempting the one file most likely
 * to reacquire the defect.
 */
const GRAPH_HOST = "graph.facebook.com";
