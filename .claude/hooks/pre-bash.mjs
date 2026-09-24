#!/usr/bin/env node
// PreToolUse gate for Bash. The one hook that can actually stop something.
//
// ── WHAT THIS REPLACES ───────────────────────────────────────────────────────
//
// `scripts/block_destructive.mjs`, wired as
// `node scripts/block_destructive.mjs "$TOOL_INPUT"`. $TOOL_INPUT appears ZERO
// times in the installed Claude Code binary, so argv[2] was always the empty
// string and the only blocking hook in this project matched nothing for its
// entire life. See _lib.mjs for the verified contract; the short version is that
// the payload arrives as JSON on STDIN and a refusal is exit 2 with the reason
// on stderr.
//
// ── WHY THE PARSING IS SHAPED THE WAY IT IS ──────────────────────────────────
//
// A command string is not a command. It can be several, separated by &&, ||, ;,
// | or a newline, each one optionally prefixed with VAR=value, and it can carry
// a heredoc body that is DATA rather than anything that will execute. So the
// command is split into segments and each segment is matched on its TOKENS, not
// by searching the raw string: `git   commit` and `git -C . commit` are the same
// commit, and a substring match for "git commit" sees neither.
//
// This is deliberately a denylist, and a denylist is bounded. It is worth having
// anyway because it catches the shapes that actually occur, and it is honest
// about the rest rather than claiming to be a sandbox — which is what the two
// lists below are for, and they are meant to be kept current. The review that
// produced the C4/C5 fixes said it plainly: a docblock naming what a gate does
// NOT catch is worth more than any claim that it catches everything. The first
// version of this file made the claim while a one-token prefix — `env rm -rf x` —
// walked past every rule in it.
//
// ── THE THREE PLACES THIS KNOWINGLY OVER-MATCHES ─────────────────────────────
//
// 1. Segments are split without tracking quotes, so `echo "a && rm -rf x"` reads
//    as two segments and is refused. Tracking quotes would make `bash -c "rm -rf
//    x"` invisible, which is the worse failure, so the over-match is kept.
// 2. Destructive SQL is matched over the WHOLE command text including heredoc
//    bodies, because `psql <<'SQL' … DROP TABLE …` is the only shape a DROP
//    actually arrives in here. Prose that contains the phrase is refused too —
//    now including `DELETE FROM <word>`, which turns up in prose far more
//    readily than `DROP TABLE` does. There is a test pinning that on purpose.
// 3. An UNTERMINATED heredoc has its remainder read as COMMANDS. Real bash
//    treats those lines as data, so this is wrong about bash on purpose:
//    deciding it the other way is what made C5 a universal bypass, because
//    omitting the delimiter hid every line after it.
//
// Each of those refusals names the way out (write the text with the Write tool
// instead of through a shell), because a gate that is wrong and offers nothing
// gets disabled wholesale rather than satisfied.
//
// ── WHAT THIS STILL DOES NOT CATCH, AFTER C4/C5 AND N1/N2/N3 ─────────────────
//
// Checked by running them, not by reasoning about them. All still ALLOWED, and
// written down so the next reader does not have to rediscover them:
//
//   • Indirection through the shell's own evaluators, where the program name is
//     not a token of the command at all: `eval "rm -rf x"`, `bash -c 'rm -rf x'`,
//     `sh -lc …`, `$(echo rm) -rf x`, `echo x | xargs -I{} sh -c 'rm -rf {}'`.
//     No token match can reach inside a string. (`env -S 'rm -rf x'` IS caught,
//     but only incidentally: `-S` is consumed as one of env's flags and the
//     quoted string's first word then lands in argv[0], where unquoting finds
//     it. Do not read that as the class being handled.)
//   • Aliases, shell functions, and any wrapper script: `alias rm='rm -rf'`, or
//     `./scripts/clean.sh`, whose contents this gate never reads.
//   • A different tool for the same effect: `find -delete`, `find -exec rm`,
//     `shred`, `truncate`, `git rm -r`, `rsync --delete`, `robocopy /MIR`,
//     `python -c "shutil.rmtree(…)"`.
//   • Any wrapper program not in WRAPPERS: `chronic`, `script`, `unbuffer`,
//     `flock`, `runuser`, `su -c`.
//   • `docker container|image|network|builder prune`, `docker rm -f`,
//     `docker compose rm -v`, `kubectl delete`.
//   • SQL these patterns do not spell: `DROP INDEX`, `DROP VIEW`,
//     `DROP MATERIALIZED VIEW`, `UPDATE … SET` with no WHERE, `dropdb`,
//     `pg_restore --clean`, and any statement assembled at runtime.
//   • `gh api graphql` with a `mergePullRequest` mutation, and the GitHub REST
//     API reached with plain `curl`.
//   • A commit made by anything other than `git commit`: `git merge`,
//     `git cherry-pick`, `git revert`, `git rebase --continue`, `git am`. None of
//     them passes through the commit gate's evidence checks.
//   • I3's problem, still open in the PUSH rule. checkCommit() refuses a commit
//     redirected out of this tree; checkPush() does not, and a SYMBOLIC refspec
//     is then resolved against the wrong repository: measured,
//     `git -C ../elsewhere push origin HEAD` is ALLOWED from a feature branch
//     here even when ../elsewhere is on main, as are the `--work-tree` spelling
//     and a bare `git -C ../elsewhere push`. Named refspecs are unaffected —
//     `git -C ../elsewhere push origin main` and `--all` are both still refused —
//     so the hole is only the symbolic and bare forms. Closing it means giving
//     checkPush the same scope check checkCommit has; it is called out here
//     rather than fixed quietly because it was found outside the findings this
//     pass was scoped to.
//   • A program name assembled out of an expansion — `$TOOL -rf x`, `${R}m`,
//     `$(which rm)`. unquote() implements bash's QUOTING rules and deliberately
//     not its EXPANSIONS: resolving them means running or reading them, which a
//     gate must not do. Same class as the eval/`bash -c` bullet above.
//   • A `\`-newline inside a heredoc body whose delimiter is QUOTED (`<<'EOF'`),
//     where bash does not join lines. joinContinuations() joins them anyway.
//     That direction over-joins rather than under-joins, so it can only merge
//     text that was going to be scanned either way — but it is a difference from
//     the shell and belongs in this list.
//   • A quoted-string boundary crossing a joined line: the parser does not track
//     quoting across segments, so a line ending inside an open quote can absorb
//     the next line into an argument. Contrived, and it needs a trailing
//     backslash inside an unterminated quote to reach.
//
// And two gaps that are about FILES rather than commands:
//
//   • Hard links and junctions. `cmd /c mklink /H innocent.txt .env` followed by
//     an ordinary Write to innocent.txt replaces `.env`'s bytes, and both halves
//     pass every gate: the link creation is not a destructive command and the
//     write is not to a protected path. Verified. Closing it means resolving
//     every edit target to a file identity rather than a path, which neither
//     hook does today.
//   • checkProtectedWrites() below covers the shell spellings of a write to
//     `.env` that were open until N4's round — redirection, `tee`, `sed -i`,
//     `mv`/`cp`, `dd of=`, `truncate`. It covers those spellings and no others;
//     a script that opens the file itself is not seen.
//
// And the receipt the commit gate reads is a file anyone can write; see
// checkReceipt() for exactly what the hardening there buys and what it does not.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  PROJECT_DIR,
  allow,
  allowIfOverridden,
  appendWorkspace,
  currentBranch,
  deny,
  git,
  latestReceipt,
  readInput,
  stagedPaths,
  treeHash,
} from "./_lib.mjs";

// ─── command parsing ─────────────────────────────────────────────────────────

/** `\` before one of these keeps its special meaning inside "…" (bash 3.1.2.3). */
const DQ_ESCAPABLE = /[$`"\\\n]/;

/** ANSI-C escapes that stand for one fixed character. */
const ANSI_C_SIMPLE = {
  a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f",
  n: "\n", r: "\r", t: "\t", v: "\v",
  "\\": "\\", "'": "'", '"': '"', "?": "?",
};

/**
 * Decode the body of a `$'…'` word.
 *
 * `\x72` is `r`, which is the whole point: `$'\x72m'` is a way to write `rm`
 * that contains neither an `r` nor an `m`. Numeric escapes are decoded because
 * a gate that reads only the letters it can see is matching spelling rather
 * than meaning.
 */
function decodeAnsiC(body) {
  let out = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "\\") {
      out += body[i];
      i += 1;
      continue;
    }
    const c = body[i + 1];
    if (c === undefined) {
      out += "\\";
      break;
    }
    if (c === "x" || c === "u" || c === "U") {
      const width = c === "x" ? 2 : c === "u" ? 4 : 8;
      const hex = /^[0-9a-fA-F]+/.exec(body.slice(i + 2, i + 2 + width))?.[0];
      if (hex) {
        const point = parseInt(hex, 16);
        // Above the Unicode maximum String.fromCodePoint throws, and an
        // exception here is now a REFUSAL — correct, but a refusal that reads
        // as a hook bug. Emit nothing and keep scanning the rest of the word.
        if (point <= 0x10ffff) out += String.fromCodePoint(point);
        i += 2 + hex.length;
        continue;
      }
      out += c;
      i += 2;
      continue;
    }
    if (c >= "0" && c <= "7") {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))[0];
      out += String.fromCharCode(parseInt(oct, 8));
      i += 1 + oct.length;
      continue;
    }
    if (c === "c" && body[i + 2] !== undefined) {
      out += String.fromCharCode(body[i + 2].toUpperCase().charCodeAt(0) ^ 64);
      i += 3;
      continue;
    }
    out += Object.hasOwn(ANSI_C_SIMPLE, c) ? ANSI_C_SIMPLE[c] : c;
    i += 2;
  }
  return out;
}

/**
 * A shell word with its quoting removed, by bash's rules rather than by
 * trimming characters off the ends.
 *
 * ── N2: `$'rm'` WAS NOT `rm` ─────────────────────────────────────────────────
 *
 * This was `token.replace(/^["']|["']$/g, "")`: one quote character off each
 * end. `$'rm'` came back as `$'rm`, which is the name of no program and matched
 * no rule, so `$'rm' -rf node_modules`, `$'git' push origin main`,
 * `$'gh' pr merge 1`, `$'docker' volume prune` and `$'\x72m' -rf node_modules`
 * all ran — verified against a real shell, deleting a real directory. C4 had
 * already established that `'rm'` and `"rm"` are `rm`; ANSI-C quoting is the
 * third documented spelling and was left standing.
 *
 * What bash does, and therefore what this does:
 *
 *   'x'    literal; there are no escapes inside single quotes at all
 *   "x"    `\` is special ONLY before $ ` " \ and newline — which is why
 *          `"C:\Users\bin\git.exe"` keeps its separators and still resolves to
 *          `git`, while the unquoted form does not (and in a real shell does
 *          not run git either)
 *   $'x'   ANSI-C quoting: \xHH, \uHHHH, \UHHHHHHHH, \NNN, \cX, \n, \t, …
 *   $"x"   locale translation; the quoting rules are those of "x"
 *   \x     outside quotes `\` escapes the next character, so `\rm` and `r\m`
 *          are both `rm` — the second of which the old path also got wrong
 *
 * Concatenation falls out of walking the word instead of trimming it: `r'm'`,
 * `'r'm` and `$'r'm` are `rm` here exactly as they are in a shell.
 *
 * NOT handled, deliberately: `$(…)`, `` `…` ``, `${…}` and `$VAR` are left as
 * literal text. Expanding them means executing or resolving them, which a gate
 * must not do, so a program name assembled out of a variable is not seen. It is
 * in the list at the bottom of this file.
 */
function unquote(token = "") {
  const s = String(token);
  let out = "";
  let i = 0;
  // A program name is not 4KB long. The bound is here because this runs on
  // every Bash call and the payload is attacker-shaped by definition.
  while (i < s.length && out.length < 4096) {
    const ch = s[i];

    if (ch === "$" && s[i + 1] === '"') {
      i += 1; // $"…" is "…" with a lookup; let the quote below do the work
      continue;
    }

    if (ch === "$" && s[i + 1] === "'") {
      let j = i + 2;
      while (j < s.length && s[j] !== "'") j += s[j] === "\\" ? 2 : 1;
      out += decodeAnsiC(s.slice(i + 2, Math.min(j, s.length)));
      i = j + 1;
      continue;
    }

    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      out += end === -1 ? s.slice(i + 1) : s.slice(i + 1, end);
      i = end === -1 ? s.length : end + 1;
      continue;
    }

    if (ch === '"') {
      i += 1;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && DQ_ESCAPABLE.test(s[i + 1] ?? "")) {
          out += s[i + 1];
          i += 2;
          continue;
        }
        out += s[i];
        i += 1;
      }
      i += 1;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 < s.length) {
        out += s[i + 1];
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Arithmetic: `$(( … ))` and `(( … ))`, where `<<` means SHIFT and not a
 * redirection. The inner alternation is the unrolled-loop form, so it handles
 * one level of nested parentheses and cannot backtrack catastrophically — this
 * runs before every Bash call, on command strings of any length.
 */
const ARITHMETIC = /\$?\(\([^()]*(?:\([^()]*\)[^()]*)*\)\)/g;

/**
 * Blank the spans a heredoc opener cannot legally live in, leaving every other
 * column where it was so the delimiter can still be read off the result.
 *
 * Quoting is not tracked, so a `#` inside a string blanks the rest of that line
 * too. That can only cause an opener to be MISSED, which means its body gets
 * SCANNED AS COMMANDS — for a gate, the direction to be wrong in.
 */
function maskNonRedirection(line) {
  let masked = line.replace(ARITHMETIC, (m) => " ".repeat(m.length));
  const comment = masked.search(/(?:^|\s)#/);
  if (comment !== -1) masked = masked.slice(0, comment) + " ".repeat(masked.length - comment);
  return masked;
}

/**
 * A heredoc opener, in REDIRECTION POSITION ONLY.
 *
 * `(?<![\d<])` keeps an arithmetic shift written outside `$(( ))` out (`1<<N`),
 * and `(?!<)` keeps `<<<` out — a here-STRING carries its data inline and opens
 * no body, so there is no delimiter line to go looking for.
 */
const HEREDOC_OPENER = /(?<![\d<])<<(?!<)-?\s*(?:(["'])([^"'\s]+)\1|\\?([A-Za-z_][A-Za-z0-9_]*))/g;

/** Every heredoc delimiter opened on one line, in the order they were opened. */
function heredocDelimiters(line) {
  const out = [];
  for (const m of maskNonRedirection(line).matchAll(HEREDOC_OPENER)) out.push(m[2] ?? m[3]);
  return out;
}

/**
 * Trimmed line text -> the ascending line numbers where it occurs.
 *
 * Built once so that finding a delimiter is a lookup rather than a forward scan.
 * The scan version was quadratic in the number of openers, and the C5 fix made
 * that reachable: an UNTERMINATED opener now searches the whole remainder
 * instead of giving up, so N of them cost N²/2 line comparisons. Measured on
 * `"cat <<EOF\n".repeat(N)`: 0.6s at 5,000, 1.5s at 10,000, 4.1s at 20,000 — on
 * a hook that runs before every Bash call and is registered with a timeout it
 * must never approach. Closing one hole is not licence to open another.
 */
function lineIndex(lines) {
  const index = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const key = lines[i].trim();
    const at = index.get(key);
    if (at) at.push(i);
    else index.set(key, [i]);
  }
  return index;
}

/** The first line at or after `from` whose trimmed text is `text`, or -1. */
function firstLineAtOrAfter(index, text, from) {
  const at = index.get(text);
  if (!at) return -1;
  let lo = 0;
  let hi = at.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < at.length ? at[lo] : -1;
}

/**
 * Remove heredoc BODIES, keeping the line that introduces them.
 *
 * A heredoc body is an argument, not a command: `cat <<'EOF' > notes.md` with
 * "rm -rf" in the body runs nothing. Scanning it as a command would refuse a
 * file write, which is the kind of wrongness that gets a gate turned off.
 *
 * ── C5: TWO CHARACTERS USED TO HIDE ANYTHING AFTER THEM ─────────────────────
 *
 * The first version matched `<<WORD` ANYWHERE on a line and, when the delimiter
 * never appeared, discarded everything to the END OF INPUT. Either half alone
 * was exploitable; together they were a universal bypass:
 *
 *     echo $((1<<N))
 *     rm -rf node_modules
 *
 * `1<<N` is an arithmetic left shift — verified in real bash, which prints 8 and
 * then RUNS the rm — but it read as an opener for a delimiter named `N`, no line
 * equalled `N`, and the rm was dropped with the rest of the input. The gate
 * returned 0 and said nothing. `# cat <<EOF` in a comment did the same.
 *
 * So: the opener has to be in redirection position (see HEREDOC_OPENER), and
 * when its delimiter never arrives the remainder is SCANNED rather than dropped.
 * Scanning over-matches a genuinely unterminated heredoc — bash would treat
 * those lines as data — and that is deliberate: deciding the other way makes
 * "leave the delimiter off" a one-token bypass for every rule in this file.
 */
function stripHeredocs(text) {
  const lines = text.split(/\r?\n/);
  const index = lineIndex(lines);
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    kept.push(line);
    i += 1;

    const delimiters = heredocDelimiters(line);
    if (!delimiters.length) continue;

    // Several bodies can be opened on one line (`cat <<A <<B`); they close in
    // the order they were opened.
    let j = i;
    let closed = 0;
    for (const delimiter of delimiters) {
      const at = firstLineAtOrAfter(index, delimiter, j);
      if (at === -1) break;
      closed += 1;
      j = at + 1;
    }
    // Only skip the body when EVERY delimiter was found. Otherwise leave `i`
    // where it is, so the remainder is read as commands (C5).
    if (closed === delimiters.length) i = j;
  }
  return kept.join("\n");
}

/** The command text split into individually-executed segments. */
/**
 * Undo bash's line continuations, so a command written across lines is ONE
 * command here too.
 *
 * ── N1: A BACKSLASH AND A NEWLINE DEFEATED EVERY RULE IN THIS FILE ──────────
 *
 * segments() splits on newlines. In bash a `\` at end of line does not end the
 * command, it joins the next line onto it — so
 *
 *     rm \
 *       -rf node_modules
 *
 * is `rm -rf node_modules`, while this gate saw the two segments `rm` and
 * `-rf node_modules`, neither of which is anything. Verified against a real
 * shell on `main`: the directory was really deleted, `git \`+newline+`commit`
 * really committed (7a7d03c), and `gh \`+newline+`pr merge 1 --squash` never
 * reached the merge rule. Exactly the shape of C4 and C5 — the parser believing
 * a fragment was the whole command — and it survived the round that fixed both.
 *
 * ODD runs only. `echo a\\` + newline is an escaped backslash and then a NEW
 * command; joining there would pull the next command into an argument position
 * and hide it, which is the one direction a gate must never be wrong in. So the
 * run length decides: odd, the last `\` ate the newline; even, the newline
 * stands and the split happens.
 */
function joinContinuations(text) {
  return String(text).replace(/(\\+)(\r?\n)/g, (whole, slashes) =>
    slashes.length % 2 === 1 ? `${slashes.slice(1)} ` : whole,
  );
}

function segments(text) {
  return joinContinuations(stripHeredocs(text))
    .split(/\r?\n|&&|\|\||[;|&]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Shell keywords that can stand where a program name is expected.
 *
 * segments() splits on `;`, so `if true; then rm -rf x; fi` arrives as the
 * segment "then rm -rf x" — a keyword sitting exactly where argv[0] is read.
 */
const SHELL_KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi",
  "while", "until", "do", "done",
  "for", "select", "case", "esac", "in",
  "function", "coproc",
]);

/**
 * Programs whose job is to RUN ANOTHER PROGRAM, with the options of their own
 * that consume a separate value. `env rm -rf build` is `rm -rf build`.
 *
 * `duration` marks the ones that take a bare number before the program
 * (`timeout 5 rm -rf build`).
 */
const WRAPPERS = new Map([
  ["sudo", { valued: new Set(["-u", "-g", "-p", "-C", "-h", "-r", "-t", "--user", "--group", "--prompt", "--close-from", "--host", "--role", "--type"]) }],
  ["doas", { valued: new Set(["-u", "-C", "-a"]) }],
  ["env", { valued: new Set(["-u", "-C", "--unset", "--chdir"]) }],
  ["command", { valued: new Set() }],
  ["builtin", { valued: new Set() }],
  ["exec", { valued: new Set(["-a"]) }],
  ["nohup", { valued: new Set() }],
  ["setsid", { valued: new Set() }],
  ["nice", { valued: new Set(["-n", "--adjustment"]) }],
  ["ionice", { valued: new Set(["-c", "-n", "-p", "--class", "--classdata", "--pid"]) }],
  ["time", { valued: new Set(["-f", "-o", "--format", "--output"]) }],
  ["stdbuf", { valued: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]) }],
  ["timeout", { valued: new Set(["-s", "-k", "--signal", "--kill-after"]), duration: true }],
  ["xargs", { valued: new Set(["-n", "-P", "-I", "-d", "-s", "-E", "-a", "--max-args", "--max-procs", "--replace", "--delimiter", "--arg-file"]) }],
]);

/**
 * Consume a wrapper's OWN options, leaving the program it runs at the front.
 *
 * The loop is bounded rather than `for(;;)` only as belt-and-braces: every
 * branch already slices at least one character off, so it cannot spin.
 */
function consumeWrapperArgs(text, wrapper) {
  let rest = text;
  for (let guard = 0; guard < 64; guard += 1) {
    const word = rest.match(/^(\S+)(?:\s+|$)/);
    if (!word) break;
    const arg = word[1];

    if (arg === "--") return rest.slice(word[0].length);

    if (arg.length > 1 && arg.startsWith("-")) {
      rest = rest.slice(word[0].length);
      if (!arg.includes("=") && wrapper.valued.has(arg)) {
        const value = rest.match(/^(\S+)(?:\s+|$)/);
        if (value) rest = rest.slice(value[0].length);
      }
      continue;
    }

    const assignment = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)(?:\s+|$)/);
    if (assignment) {
      rest = rest.slice(assignment[0].length);
      continue;
    }

    if (wrapper.duration && /^\d+(?:\.\d+)?[smhd]?$/.test(arg)) {
      rest = rest.slice(word[0].length);
      continue;
    }

    break;
  }
  return rest;
}

/**
 * A segment's argv, with the noise that hides a command stripped from the
 * front: `FOO=bar sudo git commit` is a commit.
 *
 * The assignment is consumed off the STRING rather than token by token, because
 * its value can be quoted and contain spaces — and the override this gate ships
 * with is used exactly that way (`GML_GATE_SKIP='CI is down' git commit`). A
 * token-wise version of this read `CI` as the program name and let the commit
 * through unexamined, which is worse than not having the override at all.
 *
 * ── C4: A ONE-TOKEN PREFIX DEFEATED EVERY RULE IN THIS FILE ─────────────────
 *
 * This used to strip `VAR=value` and `sudo`, and nothing else. So the program
 * name of `env rm -rf build` was `env`, of `nice rm -rf build` was `nice`, and
 * of the segment `then rm -rf x` was `then`. All of them ran. The fix is not a
 * longer list of spellings for `rm` — it is reading past the words that are, by
 * definition, not the command: environment assignments, shell keywords, group
 * openers, case labels, and the handful of programs whose entire purpose is to
 * exec another one.
 */
function argvOf(segment) {
  let rest = segment.trim();
  for (let guard = 0; guard < 64; guard += 1) {
    // `(` and `{` open a group, `!` negates one; any of them can be glued to
    // the word that follows, as in `(rm -rf x)`.
    const group = rest.match(/^(?:[!({]\s*)+/);
    if (group) {
      rest = rest.slice(group[0].length);
      continue;
    }

    // `a)` / `*)` — a case label, which is where a program name goes but is not
    // one. Anchored to exclude anything containing a parenthesis, so `$(…)` and
    // a trailing `)` on a real command are left alone.
    const label = rest.match(/^[^\s()]*\)\s*/);
    if (label) {
      rest = rest.slice(label[0].length);
      continue;
    }

    const assignment = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/);
    if (assignment) {
      rest = rest.slice(assignment[0].length);
      continue;
    }

    const word = rest.match(/^(\S+)(?:\s+|$)/);
    if (!word) break;
    const head = program([word[1]]);

    if (SHELL_KEYWORDS.has(head)) {
      rest = rest.slice(word[0].length);
      // `case $x in a) …` — everything up to and including `in` is the subject
      // being matched, not a command.
      if (head === "case") rest = rest.replace(/^[\s\S]*?\bin\s+/, "");
      continue;
    }

    const wrapper = WRAPPERS.get(head);
    if (!wrapper) break;
    rest = consumeWrapperArgs(rest.slice(word[0].length), wrapper);
  }
  return rest.split(/\s+/).filter(Boolean);
}

/**
 * The bare program name, so `/usr/bin/rm`, `rm.exe`, `\rm` and `"rm"` are all
 * the same program.
 *
 * C4: the quotes used to survive, so `"rm" -rf x` was the program `"rm"`, which
 * matched no rule and ran.
 */
function program(argv) {
  return unquote((argv[0] ?? "").trim())
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "");
}

/**
 * Single-letter flags gathered across a segment, so `-fd`, `-f -d` and
 * `--force --recurse` all answer the same question. Stops at `--`, after which
 * everything is an operand.
 */
function flagsOf(args, longNames = {}) {
  const letters = new Set();
  for (const arg of args) {
    if (arg === "--") break;
    if (!arg.startsWith("-")) continue;
    if (arg.startsWith("--")) {
      const mapped = longNames[arg.split("=")[0]];
      if (mapped) letters.add(mapped);
      continue;
    }
    for (const ch of arg.slice(1)) letters.add(ch);
  }
  return letters;
}

/** git GLOBAL options that consume a value, in either `--opt=v` or `--opt v`. */
const GIT_OPTS_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env",
]);

/**
 * Recognise a git invocation and return its subcommand, seeing past the global
 * options that sit between `git` and the verb. `git -C . commit` is a commit;
 * the brief calls this out because it is the obvious way past a naive match.
 *
 * ── I3: THE OPTIONS THAT REDIRECT A COMMIT WERE THROWN AWAY ────────────────
 *
 * This captured `-C` and treated `--git-dir=X` / `--work-tree=Y` as noise, so
 * `git --git-dir=X --work-tree=Y commit` passed the scope check and committed
 * into a tree whose branch, staged paths and receipt the gate had never read.
 * The SPACE-separated spelling was worse: the value was not consumed at all, so
 * `git --git-dir X commit` parsed its subcommand as "X" and the commit gate did
 * not run — no scope check, no branch check, no receipt check, nothing.
 */
function gitInvocation(argv) {
  if (program(argv) !== "git") return null;
  let i = 1;
  const seen = { cDir: null, gitDir: null, workTree: null };
  while (i < argv.length) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);

    if (GIT_OPTS_WITH_VALUE.has(name)) {
      const glued = eq === -1 ? null : arg.slice(eq + 1);
      const value = glued ?? argv[i + 1] ?? null;
      if (name === "-C") seen.cDir = value;
      if (name === "--git-dir") seen.gitDir = value;
      if (name === "--work-tree") seen.workTree = value;
      i += glued === null ? 2 : 1;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= argv.length) return null;
  return { sub: argv[i], args: argv.slice(i + 1), ...seen };
}

/** docker's GLOBAL options that consume a value, in either spelling. */
const DOCKER_OPTS_WITH_VALUE = new Set([
  "-H", "--host", "-c", "--context", "-l", "--log-level",
  "--config", "--tlscacert", "--tlscert", "--tlskey",
]);

/**
 * A docker invocation's command GROUP and VERB, with the global options that
 * sit in front of them skipped.
 *
 * ── N3: THE SAME MISTAKE I2 FIXED FOR `gh`, LEFT STANDING FOR `docker` ──────
 *
 * The four docker rules read `argv[1]` as the group, so ONE global flag shifted
 * the words along and every one of them stopped applying:
 *
 *     docker volume prune                      refused
 *     docker -D volume prune                   ALLOWED
 *     docker --context prod volume rm pgdata   ALLOWED
 *     docker -H tcp://host volume rm data      ALLOWED
 *     docker --tls compose down -v             ALLOWED
 *
 * `-D`, `-H`, `-l`, `--config`, `--context`, `--tls*` are all in `docker --help`
 * and all legal before the group word. `--context` and `-H` are worse than the
 * rest: they aim the command at a DIFFERENT daemon, so the one spelling that
 * reaches a machine this gate knows nothing about was the spelling it waved
 * through.
 *
 * `docker-compose` (the v1 binary) has no group word — it IS the compose group.
 */
function dockerInvocation(argv) {
  const prog = program(argv);
  if (prog === "docker-compose") {
    return { group: "compose", verb: firstWord(argv.slice(1)), args: argv.slice(1) };
  }
  if (prog !== "docker") return null;

  let i = 1;
  while (i < argv.length) {
    const arg = unquote(argv[i]);
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (DOCKER_OPTS_WITH_VALUE.has(name)) {
      i += eq === -1 ? 2 : 1;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= argv.length) return null;
  const args = argv.slice(i + 1);
  return { group: unquote(argv[i]), verb: firstWord(args), args };
}

/** The first token that is not an option, so `compose -f x down` is `down`. */
function firstWord(args) {
  for (const arg of args) {
    const word = unquote(arg);
    if (!word.startsWith("-")) return word;
  }
  return "";
}

// ─── rule 0: a protected file written through a shell ────────────────────────
//
// pre-edit.mjs refuses an Edit or a Write to `.env` and has since it was
// written. Nothing refused the SHELL spellings of the same thing, so
// `echo x > .env`, `sed -i s/a/b/ .env`, `tee .env`, `mv tmp .env` and
// `cp other .env` all clobbered the file the Edit gate exists to protect —
// measured, all five ALLOWED. The project's standing rule is that `.env` is
// never touched by the agent and never staged; a rule that holds for one tool
// and not for the tool right next to it is not a rule.
//
// Reads are deliberately untouched: `cat .env`, `grep X .env` and `source .env`
// are normal and are not what this defends against.

/** `.env`, `.env.<anything>` — except the committed example. */
function isProtectedEnvTarget(token) {
  const path = unquote(token).split("\\").join("/");
  // NTFS: `.env::$DATA` is the same bytes as `.env`, and the filesystem is
  // case-insensitive. pre-edit.mjs normalises both; this has to agree with it.
  const name = (path.split("/").pop() ?? "").split(":")[0].toLowerCase();
  return /^\.env(\..+)?$/.test(name) && name !== ".env.example";
}

/** Programs whose LAST operand is a file they overwrite. */
const LAST_ARG_WRITERS = new Set(["tee", "mv", "cp", "install", "truncate"]);

function checkProtectedWrites(command) {
  for (const segment of segments(command)) {
    const argv = argvOf(segment);
    const prog = program(argv);
    let how = null;

    // `> .env` and `>> .env`, glued or spaced, with an optional fd number.
    const redirect = segment.match(/(?:^|\s)\d?>{1,2}\s*("[^"]*"|'[^']*'|\S+)/);
    if (redirect && isProtectedEnvTarget(redirect[1])) how = "a redirection";

    if (!how && LAST_ARG_WRITERS.has(prog)) {
      const operands = argv.slice(1).filter((a) => !a.startsWith("-"));
      const last = operands[operands.length - 1];
      if (last && isProtectedEnvTarget(last)) how = `\`${prog}\``;
    }

    // `sed -i` edits every file it is given, not just the last. Both spellings:
    // `--in-place` does not match a short-flag pattern, and the probe caught
    // that before this line was written rather than after.
    const inPlace = (a) => /^-[a-zA-Z]*i/.test(a) || a.split("=")[0] === "--in-place";
    if (!how && prog === "sed" && argv.some((a) => inPlace(unquote(a)))) {
      if (argv.slice(1).some((a) => !a.startsWith("-") && isProtectedEnvTarget(a))) {
        how = "`sed -i`";
      }
    }

    if (!how && prog === "dd") {
      const of = argv.find((a) => unquote(a).startsWith("of="));
      if (of && isProtectedEnvTarget(unquote(of).slice(3))) how = "`dd of=`";
    }

    if (how) {
      deny(
        `[gate: protected file] Refused — ${how} writing to a .env file.\n` +
          `  in: ${segment}\n` +
          `.env holds this deployment's real credentials and is the one file in ` +
          `this tree that no commit can restore. The Edit/Write gate has always ` +
          `refused it; the shell spellings were open until they were measured, ` +
          `and this closes them. This rule has no override.\n` +
          `Way forward: edit .env yourself, outside this session. If you are ` +
          `adding a NEW variable, put it in .env.example — which is committed, is ` +
          `not secret, and is what the env-completeness test reads.`,
      );
    }
  }
}

/** Run git for its EXIT STATUS. git() in _lib returns "" for both outcomes. */
function gitSucceeds(args) {
  try {
    const r = spawnSync("git", args, {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 10_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Refuse unless the operator has explicitly and legibly taken responsibility. */
function denyOverridable(command, rule, reason) {
  allowIfOverridden(command, rule);
  deny(reason);
}

// ─── rule 1: destructive commands ────────────────────────────────────────────

const WAY_OUT_TEXT =
  "If these words are only TEXT (a doc, a commit message, a comment), write the " +
  "file with the Write tool instead of through a shell string — this gate reads " +
  "shell arguments, not intent.";

/**
 * Destructive SQL, matched over the whole command INCLUDING heredoc bodies.
 * TRUNCATE must be followed by an identifier so that prose ("never TRUNCATE.")
 * does not trip it.
 */
const SQL_PATTERNS = [
  [/\bDROP\s+TABLE\b/i, "DROP TABLE"],
  [/\bDROP\s+DATABASE\b/i, "DROP DATABASE"],
  [/\bDROP\s+SCHEMA\b/i, "DROP SCHEMA"],
  [/\bTRUNCATE\s+(TABLE\s+)?["'`\w]/i, "TRUNCATE"],
  // I8. The shape, not the WHERE: a DELETE FROM with no WHERE empties a table,
  // but one with a WHERE nobody checked is the same loss at a smaller scale, and
  // this gate cannot tell a good predicate from a bad one. Both are refused and
  // routed to a migration, where the statement is reviewable and replayable.
  [/\bDELETE\s+FROM\s+["'`\w]/i, "DELETE FROM"],
  // I8. The PAIR, so that an additive `ALTER TABLE … ADD COLUMN` is untouched.
  // A dropped column takes its data with it and no later commit brings it back.
  [/\bALTER\s+TABLE\b(?=[\s\S]*?\bDROP\s+COLUMN\b)/i, "ALTER TABLE … DROP COLUMN"],
];

/** Destructive shell commands, matched on a segment's tokens. */
function destructiveSegment(argv) {
  const prog = program(argv);

  if (prog === "rm") {
    // C4: -R is a documented synonym for -r in both GNU and BSD rm, so `rm -Rf`,
    // `rm -R -f` and `rm -fR` are all `rm -rf`. Only lowercase r was looked for,
    // and one capital letter walked past the rule.
    const flags = flagsOf(argv.slice(1), { "--recursive": "r", "--force": "f" });
    if ((flags.has("r") || flags.has("R")) && flags.has("f")) return "rm -rf";
  }

  const d = dockerInvocation(argv);
  if (d) {
    if (d.group === "compose" && d.args.some((a) => unquote(a) === "down")) {
      const flags = flagsOf(d.args, { "--volumes": "v" });
      if (flags.has("v")) return "docker compose down -v";
    }
    if (d.group === "volume" && d.verb === "rm") return "docker volume rm";
    // I8. `prune` deletes by absence rather than by name: every volume nothing
    // currently references, which includes the database volume of any stack that
    // happens to be down. `system prune` adds images, networks and build cache,
    // and with -a --volumes it is the whole machine.
    if (d.group === "volume" && d.verb === "prune") return "docker volume prune";
    if (d.group === "system" && d.verb === "prune") return "docker system prune";
  }

  const g = gitInvocation(argv);
  if (g) {
    if (g.sub === "reset" && g.args.includes("--hard")) return "git reset --hard";
    if (g.sub === "clean") {
      const flags = flagsOf(g.args, { "--force": "f" });
      if (flags.has("f") && flags.has("d")) return "git clean -fd";
    }
    if (g.sub === "stash" && (g.args[0] === "drop" || g.args[0] === "clear")) {
      return `git stash ${g.args[0]}`;
    }
  }

  return null;
}

function checkDestructive(command) {
  // N1 again, on the SQL side: `\s` does not match a backslash, so
  // `DROP \`+newline+`TABLE x` — which bash joins into `DROP TABLE x` before psql
  // ever sees it — matched none of these patterns.
  const sql = joinContinuations(command);
  for (const [pattern, name] of SQL_PATTERNS) {
    if (pattern.test(sql)) {
      deny(
        `[gate: destructive] Refused — this command contains ${name}.\n` +
          `Data loss is not reversible by a revert, so this rule has no override.\n` +
          `Way forward: drop/rebuild schema through a numbered migration under ` +
          `packages/db/src/migrations/, and run destructive one-offs from your own ` +
          `shell where you own the consequence.\n${WAY_OUT_TEXT}`,
      );
    }
  }

  for (const segment of segments(command)) {
    const what = destructiveSegment(argvOf(segment));
    if (what) {
      const where = segment.trim() === what ? "" : `, in: ${segment}`;
      deny(
        `[gate: destructive] Refused — \`${what}\`${where}\n` +
          `This rule has no override: it exists for the operations that no later ` +
          `commit can undo.\n` +
          `Way forward: \`rm\` a specific path without -r/-f, \`git restore <path>\` ` +
          `instead of \`reset --hard\`, \`docker compose down\` without -v to keep ` +
          `volumes. If something genuinely has to be destroyed, do it yourself at a ` +
          `terminal, where you can see what you are destroying before it goes.\n` +
          `${WAY_OUT_TEXT}`,
      );
    }
  }
}

// ─── rule 6: no push to main, no force push ──────────────────────────────────

/** `git push` options that consume the NEXT argument, so it is not a refspec. */
const PUSH_OPTS_WITH_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/**
 * `git push` flags that push refs the command never names — main included, from
 * whatever branch you happen to be standing on.
 *
 * I8/I1: these carry no refspec, so the old code asked what a BARE push would
 * target, got the current branch, and allowed it from anywhere that was not
 * main. `--mirror` is worse than `--all`: it also DELETES remote refs that no
 * longer exist locally, which is a force push and a branch deletion at once.
 */
const PUSH_EVERYTHING = new Set(["--all", "--branches", "--mirror"]);

/**
 * The branch a refspec actually lands on.
 *
 * ── I1: `git push origin HEAD` PUSHED main AND WAS ALLOWED ──────────────────
 *
 * The target used to be the last `:`-separated field with `refs/heads/` removed.
 * That leaves `HEAD` as "HEAD", `@` as "@" and `heads/main` as "heads/main",
 * none of which is in PROTECTED_BRANCHES — so all three went through, and the
 * first two pushed main whenever main was checked out. A symbolic name has to be
 * RESOLVED before it is compared, and `heads/` is as much a prefix as
 * `refs/heads/`.
 */
function pushTarget(refspec) {
  const dst = refspec.replace(/^\+/, "").split(":").pop();
  const name = dst.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
  return name === "HEAD" || name === "@" || name === "" ? currentBranch() : name;
}

/** The branch a push with no refspec would land on. */
function impliedPushBranch() {
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  // "origin/main" -> "main". The remote name is the first segment and never
  // part of the branch, so stripping one segment is exact rather than greedy.
  if (upstream) return upstream.replace(/^[^/]+\//, "");
  return currentBranch();
}

function isForceFlag(arg) {
  if (arg === "-f") return true;
  if (arg.startsWith("--force")) return true; // --force, --force-with-lease, --force-if-includes
  return /^-[A-Za-z]+$/.test(arg) && arg.includes("f"); // bundled, e.g. -fu
}

function checkPush(command) {
  for (const segment of segments(command)) {
    const g = gitInvocation(argvOf(segment));
    if (!g || g.sub !== "push") continue;

    const refspecs = [];
    let sawRemote = false;
    let forced = false;

    for (let i = 0; i < g.args.length; i += 1) {
      const arg = g.args[i];
      if (PUSH_OPTS_WITH_VALUE.has(arg)) {
        i += 1;
        continue;
      }
      if (arg.startsWith("-")) {
        if (isForceFlag(arg)) forced = true;
        continue;
      }
      if (!sawRemote) {
        sawRemote = true;
        continue;
      }
      refspecs.push(unquote(arg));
    }

    // A leading "+" in a refspec is a force push spelled without a flag.
    if (refspecs.some((r) => r.startsWith("+"))) forced = true;

    if (forced) {
      deny(
        `[gate: push] Refused — this is a FORCE push.\n` +
          `Force-pushing rewrites history that other clones, and any review already ` +
          `posted on the PR, refer to by SHA. --force-with-lease is covered too: it ` +
          `narrows the race, not the rewrite. This rule has no override.\n` +
          `Way forward: move forward with commits instead — \`git revert <sha>\` to ` +
          `undo, or a fixup commit. If the branch is genuinely private and must be ` +
          `reshaped, do that before it is pushed at all.`,
      );
    }

    const everything = g.args.find((a) => PUSH_EVERYTHING.has(unquote(a).split("=")[0]));
    if (everything) {
      deny(
        `[gate: push] Refused — \`git push ${everything}\` pushes every branch ` +
          `there is, main included, from whatever branch you are standing on.\n` +
          `It names no refspec, so nothing about your current branch makes it safe. ` +
          `${everything === "--mirror" ? "--mirror also DELETES remote refs that no longer exist locally, " +
            "which is a force push and a branch deletion in one flag. " : ""}` +
          `This rule has no override.\n` +
          `Way forward: push the one branch you mean —\n` +
          `  git push -u origin <your-branch>`,
      );
    }

    const targets = refspecs.length ? refspecs.map(pushTarget) : [impliedPushBranch()];

    const protectedTarget = targets.find((t) => PROTECTED_BRANCHES.has(t));
    if (protectedTarget) {
      deny(
        `[gate: push] Refused — this pushes to \`${protectedTarget}\`` +
          `${refspecs.length ? "" : " (the branch this push resolves to)"}.\n` +
          `${protectedTarget} moves through reviewed pull requests, not direct ` +
          `pushes; a direct push is also how the merge gate gets bypassed entirely. ` +
          `This rule has no override.\n` +
          `Way forward:\n` +
          `  git push -u origin <your-branch>\n` +
          `  gh pr create --fill\n` +
          `  # then merge once the PR body carries Review-Verdict: approved`,
      );
    }
  }
}

// ─── rule 8: worktrees only under .worktrees/ ────────────────────────────────

/** `git worktree add` options that consume the NEXT argument. */
const WORKTREE_OPTS_WITH_VALUE = new Set(["-b", "-B", "--reason"]);

/**
 * Keep every worktree inside .worktrees/, and keep .worktrees/ ignored.
 *
 * The path rule is the discipline; the check-ignore call is what makes it hold.
 * A worktree checkout that git does NOT ignore is swept up wholesale by the next
 * `git add -A` — a second copy of the tree committed into the first — and the
 * path alone cannot tell you whether that is the case.
 */
function checkWorktree(command) {
  for (const segment of segments(command)) {
    const g = gitInvocation(argvOf(segment));
    if (!g || g.sub !== "worktree" || g.args[0] !== "add") continue;

    const rest = g.args.slice(1);
    let path = null;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (WORKTREE_OPTS_WITH_VALUE.has(arg)) {
        i += 1;
        continue;
      }
      if (arg.startsWith("-")) continue;
      path = unquote(arg);
      break;
    }
    if (!path) continue; // `git worktree add` with no path is git's error to report

    const normalised = path.replace(/\\/g, "/");
    if (!normalised.startsWith(".worktrees/")) {
      deny(
        `[gate: worktree] Refused — \`${path}\` is outside .worktrees/.\n` +
          `Worktrees live at .worktrees/<name> so that they are ignored by git, ` +
          `found in one place, and cleaned up as a set. A worktree beside the repo ` +
          `is invisible to everyone else and outlives whoever made it. This rule ` +
          `has no override.\n` +
          `Way forward:\n` +
          `  git worktree add .worktrees/<name> -b <name>`,
      );
    }

    if (!gitSucceeds(["check-ignore", "-q", normalised])) {
      deny(
        `[gate: worktree] Refused — \`${normalised}\` is NOT ignored by git ` +
          `(\`git check-ignore -q ${normalised}\` fails).\n` +
          `A worktree checkout that git tracks gets staged wholesale by the next ` +
          `\`git add -A\`, committing a second copy of the tree into the first.\n` +
          `Way forward: add \`.worktrees/\` to .gitignore, confirm with ` +
          `\`git check-ignore -q ${normalised}\`, then create the worktree.`,
      );
    }
  }
}

// ─── rule 7: merge only with a recorded review ───────────────────────────────

// ── ANCHORED, BECAUSE THE UNANCHORED FORM ACCEPTED ITS OWN DOCUMENTATION ─────
//
// This was `/Review-Verdict:\s*approved/i`, matching anywhere in the body. Three
// consequences, all verified:
//
//   the PR template     shipped in this same commit, explained the rule using
//                       the literal words `Review-Verdict: approved` in its
//                       prose — so every PR opened from the default template
//                       satisfied the merge gate with no review at all
//   approved-with-nits  matched, though the template said it blocks
//   prose                `do not write Review-Verdict: approved yet` matched
//
// The verdict must therefore be a LINE, not a substring: optional indentation,
// the field, the single word, nothing else, end of line. `m` so it can sit
// anywhere in the body; `i` because the word's case is not the point.
// tests/hooks/template-not-self-approving.test.mjs asserts the unedited
// template does not satisfy this.
//
// The Markdown a reviewer actually types is accepted, because the first version
// of this refused most of it: the Review section IS a bulleted list, so
// `- Review-Verdict: approved` was the natural spelling and was rejected, as
// were `**Review-Verdict:** approved`, `**Review-Verdict**: approved` and a
// trailing full stop. A gate that refuses the obvious spelling of its own
// requirement gets retyped at, not satisfied — and the person retyping cannot
// see the refusal text that would have told them why.
//
// What stays refused is anything that is not the single word: the qualified
// verdicts (`approved-with-nits`, `approved (conditional)`), the word inside a
// sentence, and a blockquoted line — `> …` is how people quote SOMEONE ELSE'S
// text, which is exactly the ambiguity this pattern exists to remove.
const VERDICT =
  /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?Review-Verdict:?(?:\*\*|__)?:?[ \t]*approved[ \t]*[.,;]?[ \t]*\r?$/im;

/**
 * The PR body, straight from gh.
 *
 * `shell` on Windows is not a convenience: Node 22 refuses to spawn a .cmd
 * without one (the 2024 argument-injection fix), and gh on Windows is often
 * installed as a .cmd shim. Nothing user-controlled is interpolated — the PR
 * number is matched as digits and everything else is a literal — so there is
 * nothing for the shell to expand.
 */
function ghPrBody(prNumber) {
  const args = ["pr", "view", ...(prNumber ? [prNumber] : []), "--json", "body"];
  try {
    const r = spawnSync("gh", args, {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      timeout: 20_000,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error) return { ok: false, why: `gh could not be run (${r.error.code ?? r.error.message})` };
    if (r.status !== 0) {
      const detail = (r.stderr ?? "").trim().split("\n")[0] || `exit ${r.status}`;
      return { ok: false, why: `gh could not read the PR (${detail})` };
    }
    const body = JSON.parse(r.stdout).body;
    return { ok: true, body: typeof body === "string" ? body : "" };
  } catch (err) {
    return { ok: false, why: `gh could not be read (${err.message})` };
  }
}

/**
 * Refuse a merge that no review vouches for.
 *
 * The verdict is read from the PR BODY rather than from gh's review state
 * because that is where this project's review actually lands — and because a
 * body is the artefact a human can be pointed at afterwards. Note what this
 * does NOT prove: that the reviewer read anything. It proves a reviewer wrote a
 * verdict down, which is the difference between a claim nobody made and a claim
 * someone is on the record for.
 */
/** gh's GLOBAL options that consume the next argument. */
const GH_OPTS_WITH_VALUE = new Set(["-R", "--repo", "--hostname"]);

/**
 * gh's positional words, with flags and their values skipped.
 *
 * ── I2: THE RULE ASKED FOR A POSITION, NOT A SUBCOMMAND ────────────────────
 *
 * The check was `argv[1] === "pr" && argv[2] === "merge"`, so a single global
 * flag in front — `gh --repo o/r pr merge 1` — shifted the words along by two
 * and the entire merge gate stopped applying. Reading POSITIONS out of a
 * flag-bearing command line is the same mistake as substring-matching
 * "git commit", which the top of this file already knows not to make.
 */
function ghWords(argv) {
  if (program(argv) !== "gh") return null;
  const words = [];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = unquote(argv[i]);
    if (GH_OPTS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    words.push(arg);
  }
  return words;
}

/** The REST route that merges a pull request, in any of gh api's spellings. */
const API_MERGE_ROUTE = /\/pulls\/\d+\/merge\/?$/;

function checkMerge(command) {
  for (const segment of segments(command)) {
    const argv = argvOf(segment);
    const words = ghWords(argv);
    if (!words) continue;

    // I2. `gh api … /pulls/<n>/merge` is the same merge with the porcelain
    // taken off, and it never touches `gh pr merge`. Refused on the ROUTE
    // rather than on the method: a GET of that path only reports whether the PR
    // is merged, and losing that to a clear refusal costs nothing next to
    // leaving the one-line bypass open.
    if (words[0] === "api") {
      if (argv.some((a) => API_MERGE_ROUTE.test(unquote(a)))) {
        deny(
          `[gate: merge] Refused — \`gh api\` against a pull request's merge route.\n` +
            `This merges the PR exactly as \`gh pr merge\` does, without passing the ` +
            `review check, which is the only reason to reach for it. This rule has ` +
            `no override.\n` +
            `Way forward: \`gh pr merge <n> --squash\` once the PR body carries ` +
            `Review-Verdict: approved.`,
        );
      }
      continue;
    }

    if (words[0] !== "pr" || words[1] !== "merge") continue;
    const args = argv.slice(1);

    if (args.includes("--admin")) {
      deny(
        `[gate: merge] Refused — \`gh pr merge --admin\`.\n` +
          `--admin exists to bypass the branch protections and required checks that ` +
          `are the entire mechanism here; a gate that allowed it would be decoration. ` +
          `This rule has no override.\n` +
          `Way forward: get the checks green and the review recorded, then merge ` +
          `without --admin.`,
      );
    }

    // The PR number is the first positional AFTER `pr merge`, so a digit that is
    // really some flag's value cannot be mistaken for one.
    const prNumber = words.slice(2).find((a) => /^\d+$/.test(a));
    const result = ghPrBody(prNumber);

    if (!result.ok) {
      // "Could not check" must not read as "fine" — a gate that fails open is
      // off exactly when the tooling is broken, which is when it is needed.
      deny(
        `[gate: merge] Refused — ${result.why}.\n` +
          `This merge needs \`Review-Verdict: approved\` in the PR body, and that ` +
          `could not be verified, so it is refused rather than assumed.\n` +
          `Way forward: \`gh auth status\` (install or authenticate gh), or pass the ` +
          `PR number explicitly: gh pr merge <n> --squash.`,
      );
    }

    if (!VERDICT.test(result.body)) {
      deny(
        `[gate: merge] Refused — PR ${prNumber ?? "(current branch)"} has no recorded ` +
          `review verdict.\n` +
          `Its body must contain the line:\n` +
          `  Review-Verdict: approved\n` +
          `An approving click is not it: the verdict is written down so that what was ` +
          `reviewed, and by whom, survives in the PR. This rule has no override.\n` +
          `Way forward: have the reviewer add that line to the PR body ` +
          `(gh pr edit ${prNumber ?? "<n>"} --body-file -), then merge.`,
      );
    }
  }
}

// ─── the commit gate (rules 2-5) ─────────────────────────────────────────────

const PROTECTED_BRANCHES = new Set(["main", "master"]);

/** Compare two filesystem paths: case-insensitively, and either separator. */
function samePath(a, b) {
  const norm = (p) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * A commit that would land somewhere this gate holds no evidence about.
 *
 * Every piece of evidence the rules below read — branch, staged paths, receipt,
 * tree fingerprint — comes from PROJECT_DIR. A commit aimed anywhere else would
 * be judged against the WRONG tree and pass on evidence that describes something
 * entirely different, which is the same category of mistake as the ledger that
 * reported "1549/1549 passing" for an app that could not serve its own login
 * page.
 *
 * I3: `-C` was checked here and `--git-dir` / `--work-tree` were not. A git
 * directory is accepted when it is <repo>/.git or the directory git itself
 * reports for this checkout — in a worktree those differ, and the real one lives
 * outside the checkout, so comparing against `.git` alone would refuse a commit
 * from every worktree this project's own workflow tells you to make.
 */
function commitScopeEscape(commit) {
  const checks = [
    ["-C", commit.cDir, (t) => samePath(t, PROJECT_DIR)],
    ["--work-tree", commit.workTree, (t) => samePath(t, PROJECT_DIR)],
    [
      "--git-dir",
      commit.gitDir,
      (t) => {
        if (samePath(t, resolve(PROJECT_DIR, ".git"))) return true;
        const own = git(["rev-parse", "--absolute-git-dir"]);
        return Boolean(own) && samePath(t, own);
      },
    ],
  ];
  for (const [flag, value, isOurs] of checks) {
    if (!value) continue;
    const target = resolve(PROJECT_DIR, unquote(value));
    if (!isOurs(target)) return { flag, value, target };
  }
  return null;
}

/** The first `git commit` in the command, or null. */
function findCommit(command) {
  for (const segment of segments(command)) {
    const g = gitInvocation(argvOf(segment));
    if (g && g.sub === "commit") return { ...g, segment };
  }
  return null;
}

function checkCommit(command) {
  const commit = findCommit(command);
  if (!commit) return;

  // ── rule 2a: the gate can only vouch for the tree it lives in ──────────────
  const elsewhere = commitScopeEscape(commit);
  if (elsewhere) {
    deny(
      `[gate: commit scope] Refused — \`git ${elsewhere.flag} ${elsewhere.value}\` ` +
        `commits into another repository (${elsewhere.target}).\n` +
        `This gate reads the branch, the staged paths and the test receipt from ` +
        `${PROJECT_DIR}, so it cannot vouch for a commit made anywhere else — and ` +
        `a receipt that describes the wrong tree is worse than no receipt, because ` +
        `it reads as evidence.\n` +
        `Way forward: run the commit from a session whose project directory IS ` +
        `that repository, so its own gate can check it.`,
    );
  }

  // ── rule 2b: no commit on a protected branch ──────────────────────────────
  const branch = currentBranch();
  if (PROTECTED_BRANCHES.has(branch)) {
    deny(
      `[gate: protected branch] Refused — committing directly to \`${branch}\`.\n` +
        `This project's discipline is one worktree per plan, reviewed as a PR; a ` +
        `commit straight to ${branch} skips the review that the merge gate exists ` +
        `to require. This rule has no override.\n` +
        `Way forward:\n` +
        `  git worktree add .worktrees/<name> -b <name>\n` +
        `  # move your work there, commit, push, open a PR\n` +
        `Your staged changes are untouched — nothing was committed.`,
    );
  }

  const staged = stagedPaths();
  checkReceipt(command, staged);
  checkTestWithCode(command, staged);
  checkMigration(command, staged);
}

// ─── rule 3: a green receipt for THIS tree ───────────────────────────────────

const RUN_TESTS = "Way forward: run `pnpm test`, then commit without changing anything in between.";

/** Code whose correctness a database-free run cannot speak to. */
function touchesRuntimeCode(staged) {
  return staged.filter((p) => /^(apps|packages)\//.test(p));
}

/**
 * Refuse a commit that is not backed by a green test run of this exact tree.
 *
 * ── WHY A FINGERPRINT AND NOT JUST A VERDICT ──────────────────────────────
 * "The tests pass" is a claim about a moment. This project shipped a ledger
 * asserting `1549/1549 passing` and `PRODUCTION LAUNCH READY` while the
 * application returned HTTP 500 on its own login page. Binding the receipt to
 * a hash of the working tree is what turns that from an assertion into
 * something checkable: edit a file after the run and the receipt stops
 * matching, which is exactly the case the claim was wrong in.
 */
/**
 * True unless the receipt says, unambiguously, that a database WAS there.
 *
 * C3(c): this was `receipt.noDb === true`, a strict compare against a field read
 * out of a JSON file, so the string "true" sailed past it and a database-free
 * run covered a change to runtime code. Anything that is not plainly false now
 * counts as "no database", because that is the direction a missing-evidence
 * question has to be answered in.
 */
function ranWithoutDatabase(value) {
  if (value === undefined || value === null || value === false) return false;
  const s = String(value).trim().toLowerCase();
  return !(s === "false" || s === "" || s === "0");
}

function checkReceipt(command, staged) {
  const rule = "commit-receipt";
  const receipt = latestReceipt();

  if (!receipt) {
    denyOverridable(
      command,
      rule,
      `[gate: commit evidence] Refused — no test receipt exists.\n` +
        `A commit here has to point at a test run, and workspace/test-receipts.jsonl ` +
        `is empty or missing.\n${RUN_TESTS}`,
    );
  }

  if (receipt.exitCode !== 0) {
    const failed = (receipt.suites ?? [])
      .filter((s) => s.ran && s.status !== 0)
      .map((s) => `${s.suite} (${s.failed ?? "?"} failing: ${(s.failing ?? []).slice(0, 3).join(", ") || "see output"})`);
    denyOverridable(
      command,
      rule,
      `[gate: commit evidence] Refused — the latest receipt says the tests failed ` +
        `(exit ${receipt.exitCode}).\n` +
        `  ${failed.join("\n  ") || "no suite detail recorded"}\n` +
        `Committing red is how 28 assertions in this repo ended up pinning defects ` +
        `in place rather than catching them.\n${RUN_TESTS}`,
    );
  }

  // ── C3(c): make a forged receipt a bigger and more specific lie ────────────
  //
  // The receipt is a plain file under workspace/, which pre-edit.mjs exempts, so
  // anything able to write a file can write one. That cannot be closed from
  // inside this hook, and pretending otherwise would be the same kind of claim
  // this layer exists to stop. RESIDUAL RISK, stated plainly: a process that can
  // write workspace/ can also read HEAD and call treeHash(), so a deliberate
  // forgery still succeeds. What the checks below buy is that an ACCIDENTAL pass
  // is no longer possible — a run where no suite executed, a receipt that
  // disagrees with itself, one carried over from another commit — and that a
  // deliberate one has to state several specific untrue things rather than one
  // vague one.
  const suites = Array.isArray(receipt.suites) ? receipt.suites : [];
  const executed = suites.filter((s) => s && s.ran === true);
  if (!executed.length) {
    denyOverridable(
      command,
      rule,
      `[gate: commit evidence] Refused — the receipt records no suite that ran ` +
        `(exit ${receipt.exitCode}, ${suites.length} suite(s) listed).\n` +
        `An exit code of 0 from a run that executed nothing is not a green run, it ` +
        `is an empty one. scripts/test-gate.mjs writes \`ran: false\` for a suite it ` +
        `skipped, and at least one suite has to say otherwise.\n${RUN_TESTS}`,
    );
  }

  // Note what is NOT required: that EVERY suite ran. test-gate.mjs legitimately
  // records `ran: false, reason: "no DATABASE_URL"`, and refusing that outright
  // would refuse every commit made without a database. The noDb rule below is
  // what handles it, and it handles it per staged path instead of wholesale.
  const contradictory = executed.filter((s) => s.status !== 0 || (s.failed ?? 0) > 0);
  if (contradictory.length) {
    denyOverridable(
      command,
      rule,
      `[gate: commit evidence] Refused — the receipt contradicts itself: exit ` +
        `${receipt.exitCode}, but a suite that ran reports otherwise.\n` +
        `  ${contradictory.map((s) => `${s.suite}: status ${s.status}, ${s.failed ?? 0} failed`).join("\n  ")}\n` +
        `test-gate.mjs takes exitCode from the WORST suite status, so this is a ` +
        `shape it cannot produce.\n${RUN_TESTS}`,
    );
  }

  // The commit the tests ran on top of. treeHash() has covered HEAD since C3(a),
  // so this is a second reading of the same fact rather than the only one — kept
  // because it turns an opaque hash mismatch into a refusal that names the two
  // commits, and because it is one more field a forgery has to get right.
  // A repository with an unborn HEAD reports "", and a receipt from one has to
  // claim "" as well; there is no history there to protect.
  const head = git(["rev-parse", "HEAD"]);
  if (String(receipt.head ?? "") !== head) {
    denyOverridable(
      command,
      rule,
      `[gate: commit evidence] Refused — the receipt was produced at a different HEAD.\n` +
        `  receipt HEAD: ${String(receipt.head ?? "(none)").slice(0, 12)} (run at ${receipt.ts})\n` +
        `  current HEAD: ${(head || "(unborn)").slice(0, 12)}\n` +
        `The tests ran against a different commit, so what they demonstrated is not ` +
        `what this commit would add to.\n${RUN_TESTS}`,
    );
  }

  const now = treeHash();
  if (receipt.treeHash !== now) {
    denyOverridable(
      command,
      rule,
      `[gate: commit evidence] Refused — stale receipt.\n` +
        `  receipt tree: ${String(receipt.treeHash).slice(0, 12)} (run at ${receipt.ts})\n` +
        `  working tree: ${now.slice(0, 12)}\n` +
        `The tree has changed since the tests ran, so the receipt describes code ` +
        `that is not what you are about to commit.\n${RUN_TESTS}`,
    );
  }

  // A run with no DATABASE_URL never executed tests/behaviour — the only tier
  // that can observe a runtime behaviour. tests/governance regex-matches source
  // text and was green for months while the app could not boot, so it is not
  // cover for a change to the code that boots.
  const runtime = touchesRuntimeCode(staged);
  if (ranWithoutDatabase(receipt.noDb) && runtime.length) {
    denyOverridable(
      command,
      rule,
      `[gate: commit evidence] Refused — green, but WITHOUT A DATABASE, and this ` +
        `commit touches runtime code:\n` +
        `  ${runtime.slice(0, 5).join("\n  ")}\n` +
        `The receipt records that tests/behaviour did not run for lack of ` +
        `DATABASE_URL. What did run (tests/governance) matches source TEXT and ` +
        `cannot observe whether any of this works.\n` +
        `Way forward: set DATABASE_URL (or TEST_DATABASE_URL) and run \`pnpm test ` +
        `behaviour\`, then commit.`,
    );
  }
}

// ─── rule 4: test with code ──────────────────────────────────────────────────

/** A file that IS a test, wherever it lives. */
function isTestPath(p) {
  return /^tests\//.test(p) || /(^|\/)__tests__\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

/** A file whose correctness something has to demonstrate. */
function needsEvidence(p) {
  if (isTestPath(p)) return false;
  return /^apps\//.test(p) || /^packages\//.test(p) || /^scripts\/[^/]+\.sh$/.test(p) || /^docker\//.test(p);
}

/**
 * Refuse code that arrives without a test in the same commit.
 *
 * ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────────
 * Every test in this project's history shipped in the same commit as the code
 * it tests, written afterwards to describe what the code already did. At least
 * 28 assertions ended up PINNING a defect in place — they assert the broken
 * behaviour, so fixing it turns them red. Requiring a test to be staged does
 * not by itself prove the test was written first; it makes the absence of one
 * visible at the only moment anyone is looking.
 */
function checkTestWithCode(command, staged) {
  const uncovered = staged.filter(needsEvidence);
  if (!uncovered.length) return;
  if (staged.some((p) => /^tests\//.test(p))) return;

  denyOverridable(
    command,
    "test-with-code",
    `[gate: test with code] Refused — code is staged with nothing under tests/ ` +
      `beside it:\n` +
      `  ${uncovered.slice(0, 8).join("\n  ")}\n` +
      `EVIDENCE PER ARTEFACT — each artefact has one kind of evidence that counts:\n` +
      `  .ts/.tsx in apps|packages  -> a tests/behaviour test that EXECUTES it\n` +
      `  scripts/*.sh               -> a tests/scripts test that RUNS it\n` +
      `  docker/**                  -> a tests/integration check against a booted stack\n` +
      `  an edit to tests/governance -> a MUTATION check quoted in the PR: break the\n` +
      `                                thing on purpose and show the test goes red\n` +
      `A tests/governance assertion is not evidence for any of the above: it matches ` +
      `source TEXT, and it was green for months while the app could not serve its own ` +
      `login page.\n` +
      `Way forward: stage the test in this commit. If it genuinely needs none — a ` +
      `rename, a comment — say so: GML_GATE_SKIP='<why>' git commit …`,
  );
}

// ─── rule 5: a schema change needs a migration ───────────────────────────────

const SCHEMA_DIR = /^packages\/db\/src\/schema\//;
const NUMBERED_MIGRATION = /^packages\/db\/src\/migrations\/\d{4}_[^/]*\.sql$/;
const POST_MIGRATION = /^packages\/db\/src\/migrations\/_post\//;
const JOURNAL_PATH = "packages/db/src/migrations/meta/_journal.json";

/** Paths this commit ADDS, as opposed to edits. */
function addedPaths() {
  const out = git(["diff", "--cached", "--name-only", "--diff-filter=A"]);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

/**
 * A schema edit with no migration beside it is a database that drifts.
 *
 * ── WHY _post/ DOES NOT COUNT ─────────────────────────────────────────────
 * packages/db/src/migrations/ has two lanes. drizzle-kit GENERATES the numbered
 * ones and records each in meta/_journal.json, which is what the migrate
 * container replays to decide what has already run. `_post/` is the hand-written
 * raw-SQL lane (grants, RLS, storage policies) and appears in no journal, so a
 * change parked there runs on whatever schedule the operator remembers. A schema
 * change covered only by a _post file therefore has no recorded relationship to
 * the schema it is supposed to accompany.
 *
 * The migration must be ADDED, not edited: rewriting a migration that has
 * already run changes the file a deployed database will never replay, which
 * diverges the code from the database silently.
 */
function checkMigration(command, staged) {
  if (!staged.some((p) => SCHEMA_DIR.test(p))) return;

  const added = addedPaths();
  const newMigration = added.find((p) => NUMBERED_MIGRATION.test(p));
  const journal = staged.includes(JOURNAL_PATH);
  if (newMigration && journal) return;

  const editedMigration = staged.find((p) => NUMBERED_MIGRATION.test(p) && !added.includes(p));
  const post = staged.filter((p) => POST_MIGRATION.test(p));

  const notes = [];
  if (editedMigration) {
    notes.push(
      `  NOTE: ${editedMigration} is staged as an EDIT to an existing migration. ` +
        `A migration that has already run is history; editing it changes nothing in ` +
        `a deployed database and diverges it from the journal. Add a new one.`,
    );
  }
  if (post.length) {
    notes.push(
      `  NOTE: ${post[0]} is in the _post/ lane, which does NOT satisfy this rule. ` +
        `drizzle-kit generates the numbered migrations and records them in ` +
        `_journal.json; _post/ is the hand-written raw-SQL lane, is in no journal, ` +
        `and drifts from it.`,
    );
  }

  denyOverridable(
    command,
    "schema-migration",
    `[gate: schema] Refused — packages/db/src/schema/** is staged without the ` +
      `migration that carries it.\n` +
      `  ${newMigration ? "ok     " : "MISSING"} a NEW numbered migration ` +
      `packages/db/src/migrations/NNNN_*.sql\n` +
      `  ${journal ? "ok     " : "MISSING"} ${JOURNAL_PATH}\n` +
      (notes.length ? `${notes.join("\n")}\n` : "") +
      `Way forward: \`pnpm --filter @gml/db generate\` (drizzle-kit writes both the ` +
      `SQL and the journal entry), review the SQL, then stage both with the schema.`,
  );
}

// ─── entry point ─────────────────────────────────────────────────────────────

/**
 * The command this run was asked about, kept where the error path can reach it.
 *
 * The override has to work even when a rule threw, so the reason has to be
 * readable off the command string at that point.
 */
let observedCommand = "";

function main() {
  const input = readInput();

  // I4: this line was `input.tool_name`, and readInput() returns whatever
  // JSON.parse gives back — `null` is valid JSON, so a literal `null` payload
  // threw "Cannot read properties of null (reading 'tool_name')". The line below
  // it already used `?.`; this one did not, and the difference cost the gate 12
  // recorded crashes in one 33-minute session.
  if (input?.tool_name && input.tool_name !== "Bash") allow();

  const command = input?.tool_input?.command;
  if (typeof command !== "string" || !command.trim()) allow();
  observedCommand = command;

  checkProtectedWrites(command);
  checkDestructive(command);
  checkPush(command);
  checkMerge(command);
  checkWorktree(command);
  checkCommit(command);
}

try {
  main();
} catch (err) {
  // ── I4: THE GATE WAS SILENTLY OPEN, AND A TEST HELD IT THAT WAY ───────────
  //
  // This used to log and fall through to allow(). workspace/gate-errors.log in
  // this worktree holds 16 TypeErrors: 12 from 2026-09-23 between 22:50:06 and
  // 23:23:05, and FOUR more at 23:57:10, 23:58:26, 23:59:00 and 23:59:47 while
  // this was being fixed. Sixteen Bash calls went through unexamined, with
  // nothing on stderr and nothing in the transcript. (Three places said "three
  // more" and "fifteen" — counted once, written three times, wrong in all
  // three; `wc -l workspace/gate-errors.log` settles it.) Worse, tests/hooks/pre-bash.test.mjs asserted exit 0 for the
  // payload that caused them, so the suite was GREEN BECAUSE OF the crash.
  //
  // THE DECISION: an internal error now REFUSES. A gate that fails open on its
  // own bug is off exactly when something is wrong and quiet about being off,
  // which is the defect this whole layer was built to remove — the previous six
  // hooks enforced nothing for the life of the project and nobody noticed,
  // because nothing ever said so. The cost is real and is paid deliberately: a
  // bug here stops Bash work. That is the point. A stopped session gets fixed in
  // minutes; a silently open gate lasted 33 of them and would have lasted longer
  // if the log had not been read.
  //
  // Two things keep the cost bounded. The refusal names the error and where it
  // was recorded, so the bug is diagnosable from the refusal alone. And the
  // override still works, so a broken gate cannot brick a session outright —
  // at the usual price, a reason written down where the PR can quote it.
  appendWorkspace(
    "gate-errors.log",
    `${new Date().toISOString()}\tpre-bash\t${err?.stack?.split("\n")[0] ?? err}`,
  );
  allowIfOverridden(observedCommand, "gate-internal-error");
  deny(
    `[gate: internal error] Refused — the gate itself failed, so it could not judge ` +
      `this command.\n` +
      `  ${err?.stack?.split("\n")[0] ?? err}\n` +
      `Recorded in workspace/gate-errors.log. This refuses rather than allowing ` +
      `because a gate that fails open on its own bug is off precisely when something ` +
      `is wrong: 12 crashes on 2026-09-23 let 12 Bash calls through unexamined and ` +
      `unseen, and the test that should have caught it was passing because of them.\n` +
      `Way forward: fix the hook — or, if you need to move now, take the hatch and ` +
      `say why:\n` +
      `  GML_GATE_SKIP='<why>' <your command>`,
  );
}
allow();
