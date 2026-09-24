// A Postgres that answers every query with "no rows".
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// Some defects live on the path a script takes when a row it expects is NOT
// there. That path is reachable without a database at all: all it needs is a
// server that speaks enough of the wire protocol for node-postgres to connect,
// run a query and get back an empty result. This is that server, and nothing
// more. It records the text of every statement it is sent, so a test can prove
// the code under test really did reach the query it claims to be testing (and
// did not, say, INSERT something it should not have).
//
// It is NOT a database. It has no tables, it returns zero columns and zero rows
// for everything, and it accepts any credentials. Use it only for "the row is
// absent" paths; anything that needs data back belongs in a real-Postgres test
// behind needsDatabase().
//
// Protocol coverage (PostgreSQL frontend/backend protocol v3):
//   startup      SSLRequest -> 'N', StartupMessage -> AuthenticationOk + ReadyForQuery
//   extended     Parse/Bind/Describe/Execute answered on Sync (or Flush)
//   simple       Query -> empty RowDescription + CommandComplete + ReadyForQuery
//   Terminate    closes the socket

import { createServer, type AddressInfo, type Socket } from "node:net";

export type FakePg = {
  /** A DATABASE_URL pointing at this server. */
  url: string;
  /** Every SQL statement received, in arrival order. */
  queries: string[];
  close(): Promise<void>;
};

const SSL_REQUEST_CODE = 80877103;

function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}

function int16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n, 0);
  return b;
}

function cstr(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
}

/** One backend message: type byte, Int32 length (self-inclusive), body. */
function msg(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([Buffer.from(type, "ascii"), int32(body.length + 4), body]);
}

const READY = msg("Z", Buffer.from("I", "ascii"));
/** A RowDescription with zero fields: a result set that has no columns. */
const NO_COLUMNS = msg("T", int16(0));
const SELECT_0 = msg("C", cstr("SELECT 0"));

export async function startFakePg(): Promise<FakePg> {
  const queries: string[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => undefined);

    let buf = Buffer.alloc(0);
    let started = false;
    let pending: Buffer[] = [];

    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          // Startup-phase messages have no type byte.
          if (buf.length < 8) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          const code = buf.readInt32BE(4);
          buf = buf.subarray(len);
          if (code === SSL_REQUEST_CODE) {
            sock.write("N");
            continue;
          }
          started = true;
          sock.write(Buffer.concat([msg("R", int32(0)), READY]));
          continue;
        }

        if (buf.length < 5) return;
        const type = String.fromCharCode(buf[0]!);
        const len = buf.readInt32BE(1);
        if (buf.length < 1 + len) return;
        const body = buf.subarray(5, 1 + len);
        buf = buf.subarray(1 + len);

        switch (type) {
          case "P": {
            // Parse: statement name \0, query text \0, param types.
            const nameEnd = body.indexOf(0);
            const textEnd = body.indexOf(0, nameEnd + 1);
            queries.push(body.subarray(nameEnd + 1, textEnd).toString("utf8"));
            pending.push(msg("1"));
            break;
          }
          case "B":
            pending.push(msg("2"));
            break;
          case "D":
            pending.push(NO_COLUMNS);
            break;
          case "E":
            pending.push(SELECT_0);
            break;
          case "C":
            pending.push(msg("3"));
            break;
          case "H":
            sock.write(Buffer.concat(pending));
            pending = [];
            break;
          case "S":
            sock.write(Buffer.concat([...pending, READY]));
            pending = [];
            break;
          case "Q": {
            const text = body.subarray(0, Math.max(0, body.indexOf(0))).toString("utf8");
            queries.push(text);
            sock.write(Buffer.concat([NO_COLUMNS, SELECT_0, READY]));
            break;
          }
          case "X":
            sock.end();
            return;
          default:
            // Anything else is outside what this fake claims to support. Fail
            // loudly in the client rather than hang it.
            sock.write(
              msg(
                "E",
                Buffer.concat([
                  Buffer.from("S", "ascii"), cstr("ERROR"),
                  Buffer.from("C", "ascii"), cstr("0A000"),
                  Buffer.from("M", "ascii"), cstr(`fake-pg: unsupported message '${type}'`),
                  Buffer.from([0]),
                ]),
              ),
            );
            sock.write(READY);
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `postgres://fake:fake@127.0.0.1:${port}/fake`,
    queries,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
