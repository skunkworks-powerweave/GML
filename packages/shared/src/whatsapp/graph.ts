/**
 * The Graph API version this deployment calls, and the URLs built from it.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * The WhatsApp webhook fetched media metadata from
 * `https://graph.facebook.com/v19.0/{media-id}` with the version written into
 * the URL literal. Meta's published version table gives v19.0 an expiration of
 * 2026-05-21; that was four months in the past when this file was written. The
 * deployment had been calling an expired API version and nothing anywhere said
 * so.
 *
 * It could not have been noticed from the outside. Meta does not reject a call
 * to an expired version — its versioning guide says the request is served by the
 * next-oldest usable version instead. And every failure on this path collapses
 * to the same silence: `fetchMediaUrl` returns null on any non-OK response, the
 * caller drops the media, and the webhook still answers Meta with HTTP 200. An
 * expired version, a blank access token and a revoked token are, from the
 * outside, indistinguishable from "the teacher never sent a video".
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
 * The endpoint itself — `GET /{media-id}` returning `{ url, mime_type, sha256,
 * file_size, id }` — is unchanged across every version in the table above.
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
 * A malformed override is REFUSED rather than passed through. `v25` or `25.0` or
 * an accidental trailing newline would otherwise be pasted straight into a URL
 * path, and the resulting 400 from Meta is swallowed by the `!r.ok` branch
 * upstream — another silent loss, caused this time by the mechanism meant to
 * prevent one. Falling back to the pin keeps the deployment working and says why
 * on stderr.
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
