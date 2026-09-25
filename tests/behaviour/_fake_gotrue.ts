// A stand-in for Supabase Auth (GoTrue), served over real HTTP.
//
// The application talks to GoTrue only through @supabase/supabase-js and
// @supabase/ssr, and the defects in this area live in HOW the app drives those
// libraries: which credential it hands to which endpoint, what it does with the
// error object that comes back, which cookie attributes the session is written
// with. Stubbing the libraries would stub out exactly the code under test. So
// the real libraries run, and only the network peer is replaced -- the same
// approach direct-upload.test.ts takes with Storage.
//
// It answers the way GoTrue answered when the same calls were made against the
// local Supabase stack (`supabase start`, 2026-09-24), including the parts the
// app got wrong:
//
//   POST /logout with a user UUID as the bearer
//       -> 403 {"code":"bad_jwt","message":"invalid JWT: ... invalid number of segments"}
//   password sign-in for a banned user
//       -> 400 {"code":"user_banned"}, before the access-token hook runs
//   the access-token hook refusing a profile
//       -> 403, nothing minted
//   an admin password change
//       -> every session of that user is deleted
//   POST /verify with a token_hash, for ANY type (recovery included)
//       -> a session whose amr is [{"method":"otp"}], never "recovery"
//
// Access tokens are ES256 and published on /.well-known/jwks.json, as this
// project's are, so getClaims() verifies them LOCALLY with no round trip --
// which is what makes a demoted administrator's still-unexpired token worth
// testing. Admin endpoints require the secret key as the bearer.
//
// Sessions can live as rows in `auth.sessions` of the test's own database (the
// `sessionTable` option), because that is where GoTrue keeps them: a row the
// APP deletes over its own connection is then a revoked session here too.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";

export const ANON_KEY = "fake-publishable-key";
export const SECRET_KEY = "fake-secret-key";

export type HookResult = { role: string; name?: string | null } | { error: { http_code: number; message: string } };

export type FakeUser = {
  id: string;
  email: string;
  password: string;
  appMetadata: Record<string, unknown>;
  userMetadata: Record<string, unknown>;
  bannedUntil: string | null;
  emailConfirmed: boolean;
};

export type FakeSession = {
  id: string;
  userId: string;
  refreshToken: string;
  amr: Array<{ method: string; timestamp: number }>;
};

export type Seen = { method: string; path: string; query: URLSearchParams; auth: string | null; body: Record<string, unknown> };

/** Anything with pg's `query` shape. */
export type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

type Options = {
  /** The access-token hook. Default: every user is a teacher. */
  hook?: (userId: string) => Promise<HookResult> | HookResult;
  /** Seconds until an access token expires. */
  accessTokenTtl?: number;
  /** Keep sessions as rows in `auth.sessions` of this database (see header). */
  sessionTable?: Queryable;
  /**
   * Security.UpdatePasswordRequireCurrentPassword, the project setting
   * README-deploy §2.2f turns on: PUT /user may set a new password only with
   * the correct `current_password`, unless the session came from an emailed
   * link (user.go:171-186 in v2.196.0; Session.IsRecovery() is any amr of
   * otp, magiclink or recovery, factor.go:66-72). Off by default, as GoTrue's is.
   */
  requireCurrentPassword?: boolean;
};

/** Session.IsRecovery() in GoTrue: the amr methods its current-password check exempts. */
const RECOVERY_AMR = new Set(["otp", "magiclink", "recovery"]);

const API_VERSION = { "x-supabase-api-version": "2024-01-01" };

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Create the stand-in for GoTrue's session table in the test database.
 *
 * Several test files call this concurrently, and two concurrent IF NOT EXISTS
 * creations can still collide in the catalog; losing that race means the
 * object exists, which is all this needs.
 */
export async function ensureAuthSessionsTable(c: Queryable): Promise<void> {
  const tolerate = async (sql: string) => {
    try {
      await c.query(sql);
    } catch (err) {
      if (!["23505", "42P06", "42P07"].includes(String((err as { code?: unknown }).code))) throw err;
    }
  };
  await tolerate("CREATE SCHEMA IF NOT EXISTS auth");
  await tolerate(
    "CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL, created_at timestamptz DEFAULT now())",
  );
}

/**
 * Make one statement kind fail for rows matching `condition` on `table`, for
 * the duration of `body` -- a fault scoped to this test's own rows, so test
 * files running concurrently against the same database are unaffected (a
 * table rename was not: it broke every other file using the table).
 * `condition` is SQL over NEW/OLD and must contain only test-generated values.
 */
export async function withRowFault<T>(
  c: Queryable,
  table: string,
  when: "INSERT" | "DELETE",
  condition: string,
  body: () => Promise<T>,
): Promise<T> {
  const name = `test_fault_${randomUUID().replace(/-/g, "")}`;
  const row = when === "DELETE" ? "OLD" : "NEW";
  await c.query(
    `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
     BEGIN IF ${condition} THEN RAISE EXCEPTION 'fault injected by a test'; END IF; RETURN ${row}; END $f$`,
  );
  await c.query(`CREATE TRIGGER ${name} BEFORE ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
  try {
    return await body();
  } finally {
    await c.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await c.query(`DROP FUNCTION IF EXISTS public.${name}()`);
  }
}

export async function fakeGoTrue(options: Options = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const kid = "fake-es256-key";
  const jwk = { ...(publicKey as KeyObject).export({ format: "jwk" }), kid, alg: "ES256", use: "sig" };

  const users = new Map<string, FakeUser>();
  const sessions = new Map<string, FakeSession>();
  const seen: Seen[] = [];
  /**
   * Emailed token hashes, by the users column GoTrue keeps them in: a recovery
   * email AND a magic-link email both write recovery_token (mail.go,
   * sendMagicLink); a sign-up or invite confirmation writes confirmation_token.
   */
  const hashedOtps = new Map<string, { userId: string; column: "recovery" | "confirmation"; ageSeconds: number }>();
  let settings: Record<string, unknown> = { disable_signup: true, mailer_autoconfirm: false, external: { email: true } };
  /** When set, every request except the JWKS is answered with this status (an outage). */
  let outage: number | null = null;
  /** When set, a request it returns an error for is answered with that error instead (one failing call). */
  let fault: ((r: Seen) => { status: number; code: string; message: string } | null) | null = null;
  let ttl = options.accessTokenTtl ?? 900;
  let requireCurrentPassword = options.requireCurrentPassword ?? false;
  const table = options.sessionTable;
  const hook = options.hook ?? (() => ({ role: "teacher" }));
  let url = "";

  function userJson(u: FakeUser) {
    return {
      id: u.id,
      aud: "authenticated",
      role: "authenticated",
      email: u.email,
      email_confirmed_at: u.emailConfirmed ? "2026-01-01T00:00:00Z" : null,
      phone: "",
      app_metadata: { provider: "email", providers: ["email"], ...u.appMetadata },
      user_metadata: u.userMetadata,
      banned_until: u.bannedUntil,
      identities: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      is_anonymous: false,
    };
  }

  function jwt(claims: Record<string, unknown>): string {
    const header = b64url(JSON.stringify({ alg: "ES256", kid, typ: "JWT" }));
    const payload = b64url(JSON.stringify(claims));
    const sig = sign("sha256", Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return `${header}.${payload}.${b64url(sig)}`;
  }

  function decode(token: string | null): Record<string, unknown> | null {
    const parts = token?.split(".") ?? [];
    if (parts.length !== 3) return null;
    try {
      return JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    } catch {
      return null;
    }
  }

  async function newSession(userId: string, method: string, ageSeconds = 0): Promise<FakeSession> {
    const s: FakeSession = {
      id: randomUUID(),
      userId,
      refreshToken: randomUUID().replace(/-/g, ""),
      amr: [{ method, timestamp: Math.floor(Date.now() / 1000) - ageSeconds }],
    };
    sessions.set(s.id, s);
    if (table) await table.query("INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)", [s.id, userId]);
    return s;
  }

  /** Is the session still there? A row removed from auth.sessions is revoked. */
  async function alive(s: FakeSession | undefined): Promise<boolean> {
    if (!s || !sessions.has(s.id)) return false;
    if (!table) return true;
    const { rows } = await table.query("SELECT 1 FROM auth.sessions WHERE id = $1", [s.id]);
    if (rows.length === 0) sessions.delete(s.id);
    return rows.length > 0;
  }

  async function endSessions(match: (s: FakeSession) => boolean): Promise<void> {
    for (const [sid, s] of [...sessions]) {
      if (!match(s)) continue;
      sessions.delete(sid);
      if (table) await table.query("DELETE FROM auth.sessions WHERE id = $1", [sid]);
    }
  }

  /** Mint a session for `u` through the hook, as GoTrue does on sign-in and refresh. */
  async function mint(u: FakeUser, session: FakeSession): Promise<{ status: number; body: unknown }> {
    const h = await hook(u.id);
    if ("error" in h) {
      return { status: h.error.http_code, body: { code: "unexpected_failure", message: h.error.message } };
    }
    const now = Math.floor(Date.now() / 1000);
    const access = jwt({
      aud: "authenticated",
      exp: now + ttl,
      iat: now,
      iss: `${url}/auth/v1`,
      sub: u.id,
      email: u.email,
      phone: "",
      app_metadata: userJson(u).app_metadata,
      user_metadata: u.userMetadata,
      role: "authenticated",
      aal: "aal1",
      amr: session.amr,
      session_id: session.id,
      is_anonymous: false,
      user_role: h.role,
      user_name: h.name ?? "",
      user_image: "",
    });
    return {
      status: 200,
      body: {
        access_token: access,
        token_type: "bearer",
        expires_in: ttl,
        expires_at: now + ttl,
        refresh_token: session.refreshToken,
        user: userJson(u),
      },
    };
  }

  /** The live session a bearer access token belongs to, as GET /user checks. */
  async function sessionOf(
    bearer: string | null,
  ): Promise<{ user: FakeUser; session: FakeSession } | { error: { status: number; code: string; message: string } }> {
    const claims = decode(bearer);
    if (!claims) {
      return {
        error: {
          status: 403,
          code: "bad_jwt",
          message:
            "invalid JWT: unable to parse or verify signature, token is malformed: token contains an invalid number of segments",
        },
      };
    }
    const session = sessions.get(String(claims.session_id));
    const user = users.get(String(claims.sub));
    if (!user || !(await alive(session))) {
      return { error: { status: 403, code: "session_not_found", message: "Session from session_id claim in JWT does not exist" } };
    }
    return { user, session: session! };
  }

  function send(res: ServerResponse, status: number, body?: unknown) {
    res.writeHead(status, { "content-type": "application/json", ...API_VERSION });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }

  function fail(res: ServerResponse, status: number, code: string, message: string) {
    send(res, status, { code, message });
  }

  async function handle(req: IncomingMessage, raw: string, res: ServerResponse) {
    const full = new URL(req.url ?? "/", "http://fake");
    const path = full.pathname.replace(/^\/auth\/v1/, "");
    const authHeader = req.headers.authorization ?? null;
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    let body: Record<string, unknown> = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    const request: Seen = { method: req.method ?? "", path, query: full.searchParams, auth: bearer, body };
    seen.push(request);

    if (path === "/.well-known/jwks.json") return send(res, 200, { keys: [jwk] });
    if (outage !== null) return fail(res, outage, "unexpected_failure", "service unavailable");
    const injected = fault?.(request);
    if (injected) return fail(res, injected.status, injected.code, injected.message);
    if (path === "/settings" && req.method === "GET") return send(res, 200, settings);

    // ── admin API ──────────────────────────────────────────────────────────
    if (path.startsWith("/admin/")) {
      if (bearer !== SECRET_KEY) return fail(res, 401, "no_authorization", "This endpoint requires a valid service key");
      const m = /^\/admin\/users(?:\/([^/]+))?$/.exec(path);
      if (!m) return fail(res, 404, "not_found", "no such admin route");
      const id = m[1];
      if (!id && req.method === "POST") {
        const email = String(body.email ?? "").toLowerCase();
        if ([...users.values()].some((u) => u.email === email)) {
          return fail(res, 422, "email_exists", "A user with this email address has already been registered");
        }
        const u = addUser({
          email,
          password: String(body.password ?? ""),
          appMetadata: (body.app_metadata as Record<string, unknown>) ?? {},
          userMetadata: (body.user_metadata as Record<string, unknown>) ?? {},
        });
        return send(res, 200, userJson(u));
      }
      const u = id ? users.get(id) : undefined;
      if (!u) return fail(res, 404, "user_not_found", "User not found");
      if (req.method === "GET") return send(res, 200, userJson(u));
      if (req.method === "DELETE") {
        users.delete(u.id);
        await endSessions((s) => s.userId === u.id);
        return send(res, 200, userJson(u));
      }
      if (req.method === "PUT") {
        if (typeof body.ban_duration === "string") {
          u.bannedUntil = body.ban_duration === "none" ? null : "2126-01-01T00:00:00Z";
        }
        if (typeof body.password === "string") {
          u.password = body.password;
          await endSessions((s) => s.userId === u.id);
        }
        if (body.app_metadata && typeof body.app_metadata === "object") {
          // Merged key by key; a null value deletes the key (models.User.UpdateAppMetaData).
          for (const [k, v] of Object.entries(body.app_metadata as Record<string, unknown>)) {
            if (v === null) delete u.appMetadata[k];
            else u.appMetadata[k] = v;
          }
        }
        return send(res, 200, userJson(u));
      }
      return fail(res, 405, "method_not_allowed", "method not allowed");
    }

    // ── user API ───────────────────────────────────────────────────────────
    if (path === "/token" && req.method === "POST") {
      const grant = full.searchParams.get("grant_type");
      if (grant === "password") {
        const email = String(body.email ?? "").toLowerCase();
        const u = [...users.values()].find((x) => x.email === email);
        if (!u || u.password !== body.password) return fail(res, 400, "invalid_credentials", "Invalid login credentials");
        if (!u.emailConfirmed) return fail(res, 400, "email_not_confirmed", "Email not confirmed");
        if (u.bannedUntil) return fail(res, 400, "user_banned", "User is banned");
        const s = await newSession(u.id, "password");
        const out = await mint(u, s);
        if (out.status !== 200) await endSessions((x) => x.id === s.id);
        return send(res, out.status, out.body);
      }
      if (grant === "refresh_token") {
        const s = [...sessions.values()].find((x) => x.refreshToken === body.refresh_token);
        if (!s || !(await alive(s))) {
          return fail(res, 400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
        }
        const u = users.get(s.userId)!;
        if (u.bannedUntil) return fail(res, 400, "user_banned", "User is banned");
        s.refreshToken = randomUUID().replace(/-/g, "");
        const out = await mint(u, s);
        return send(res, out.status, out.body);
      }
      return fail(res, 400, "validation_failed", `unsupported grant_type ${grant}`);
    }

    if (path === "/verify" && req.method === "POST") {
      const hash = String(body.token_hash ?? "");
      const entry = hashedOtps.get(hash);
      // verifyTokenHash (internal/api/verify.go): which column each type may
      // redeem. "email" tries confirmation_token as well as recovery_token, so
      // it also redeems a sign-up confirmation; "magiclink" and "recovery"
      // read recovery_token only.
      const redeems: Record<string, ReadonlyArray<string>> = {
        recovery: ["recovery"],
        magiclink: ["recovery"],
        email: ["recovery", "confirmation"],
        signup: ["confirmation"],
        invite: ["confirmation"],
      };
      if (!entry || !redeems[String(body.type)]?.includes(entry.column)) {
        return fail(res, 403, "otp_expired", "Email link is invalid or has expired");
      }
      hashedOtps.delete(hash);
      const u = users.get(entry.userId)!;
      // POST /verify issues every session with models.OTP, whatever the type:
      // `a.issueRefreshToken(r, w.Header(), tx, user, models.OTP, grantParams)`
      // (internal/api/verify.go:285 in v2.196.0, the local stack's version,
      // and unchanged on master). So a recovery link redeemed this way yields
      // amr [{"method":"otp"}]. Only the PKCE path (GET /verify, verify.go:191,
      // issueAuthCode with the parsed type) records "recovery" or "magiclink";
      // this stand-in does not serve it.
      const s = await newSession(u.id, "otp", entry.ageSeconds);
      const out = await mint(u, s);
      return send(res, out.status, out.body);
    }

    if (path === "/user") {
      const who = await sessionOf(bearer);
      if ("error" in who) return fail(res, who.error.status, who.error.code, who.error.message);
      if (req.method === "GET") return send(res, 200, userJson(who.user));
      if (req.method === "PUT") {
        if (typeof body.password === "string") {
          // Checked before same_password, in GoTrue's order.
          const fromEmailedLink = who.session.amr.some((a) => RECOVERY_AMR.has(a.method));
          if (requireCurrentPassword && body.password !== "" && who.user.password && !fromEmailedLink) {
            const current = body.current_password;
            if (typeof current !== "string" || current === "") {
              return fail(res, 400, "current_password_required", "Current password required when setting new password.");
            }
            if (current !== who.user.password && !fromEmailedLink) {
              return fail(res, 400, "current_password_mismatch", "Current password required when setting new password.");
            }
          }
          if (body.password === who.user.password && !fromEmailedLink) {
            return fail(res, 422, "same_password", "New password should be different from the old password.");
          }
          who.user.password = body.password;
        }
        return send(res, 200, userJson(who.user));
      }
    }

    if (path === "/logout" && req.method === "POST") {
      const who = await sessionOf(bearer);
      if ("error" in who) return fail(res, who.error.status, who.error.code, who.error.message);
      const scope = full.searchParams.get("scope") ?? "global";
      await endSessions(
        (s) =>
          s.userId === who.user.id &&
          (scope === "global" ||
            (scope === "local" && s.id === who.session.id) ||
            (scope === "others" && s.id !== who.session.id)),
      );
      res.writeHead(204, API_VERSION);
      return res.end();
    }

    return fail(res, 404, "not_found", `no route ${req.method} ${path}`);
  }

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      handle(req, raw, res).catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "unexpected_failure", message: String(err) }));
      });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  function addUser(p: Partial<FakeUser> & { email: string; password: string }): FakeUser {
    const u: FakeUser = {
      id: p.id ?? randomUUID(),
      email: p.email.toLowerCase(),
      password: p.password,
      appMetadata: p.appMetadata ?? {},
      userMetadata: p.userMetadata ?? {},
      bannedUntil: p.bannedUntil ?? null,
      emailConfirmed: p.emailConfirmed ?? true,
    };
    users.set(u.id, u);
    return u;
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = await fetch(`${url}/auth/v1${path}`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  return {
    get url() {
      return url;
    },
    users,
    seen,
    addUser,
    /** Requests to one endpoint, e.g. calls("POST", "/token"). */
    calls: (method: string, path: string) => seen.filter((s) => s.method === method && s.path === path),
    /** Live sessions (refresh tokens that still work) for a user. */
    async sessionsOf(userId: string): Promise<FakeSession[]> {
      const out: FakeSession[] = [];
      for (const s of [...sessions.values()]) if (s.userId === userId && (await alive(s))) out.push(s);
      return out;
    },
    /** Sign in over HTTP as a second device would (a phone, another browser). */
    deviceSignIn: (email: string, password: string) => post("/token?grant_type=password", { email, password }),
    /** Refresh as that device would, with the refresh token it holds. */
    deviceRefresh: (refreshToken: string) => post("/token?grant_type=refresh_token", { refresh_token: refreshToken }),
    /**
     * The token_hash in an email of this kind, as {{ .TokenHash }} renders it.
     * `ageSeconds` back-dates the resulting session's amr timestamp, standing
     * in for a link that was followed that long ago.
     */
    issueOtp(userId: string, kind: "recovery" | "magiclink" | "signup", ageSeconds = 0): string {
      const hash = createHash("sha256").update(randomUUID()).digest("hex");
      hashedOtps.set(hash, { userId, column: kind === "signup" ? "confirmation" : "recovery", ageSeconds });
      return hash;
    },
    setSettings: (s: Record<string, unknown>) => void (settings = s),
    setOutage: (status: number | null) => void (outage = status),
    /** Fail the requests `f` picks out (null: none); every other request is answered as usual. */
    setFault: (f: typeof fault) => void (fault = f),
    setAccessTokenTtl: (s: number) => void (ttl = s),
    /** Turn GoTrue's require-current-password setting on or off (see Options). */
    setRequireCurrentPassword: (on: boolean) => void (requireCurrentPassword = on),
    /** Point the app's Supabase clients at this server. Returns a restore(). */
    install(): () => void {
      const keys = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"] as const;
      const saved = keys.map((k) => process.env[k]);
      process.env.NEXT_PUBLIC_SUPABASE_URL = url;
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ANON_KEY;
      process.env.SUPABASE_SECRET_KEY = SECRET_KEY;
      return () =>
        keys.forEach((k, i) => {
          if (saved[i] === undefined) delete process.env[k];
          else process.env[k] = saved[i];
        });
    },
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

export type FakeGoTrue = Awaited<ReturnType<typeof fakeGoTrue>>;
