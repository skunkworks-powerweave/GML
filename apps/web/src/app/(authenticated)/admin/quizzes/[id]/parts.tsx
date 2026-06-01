"use client";

// Client-side editor for /admin/quizzes/[id].
// JSON textarea + Save button. On Save, invokes the `saveQuizSchema` server
// action and shows inline status. Mirrors the spec 073 form-schema editor.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveQuizSchema, type SaveQuizResult } from "./actions";

type Props = {
  quizId: string;
  initialJson: string;
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "ok"; questionCount: number; at: number }
  | { kind: "err"; message: string };

export function QuizSchemaEditor({ quizId, initialJson }: Props) {
  const [text, setText] = useState(initialJson);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const dirty = text !== initialJson;

  const parseError = useMemo<string | null>(() => {
    try {
      JSON.parse(text);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, [text]);

  const onSave = () => {
    if (parseError) {
      setSave({ kind: "err", message: `JSON does not parse: ${parseError}` });
      return;
    }
    setSave({ kind: "saving" });
    startTransition(async () => {
      const result: SaveQuizResult = await saveQuizSchema(quizId, text);
      if (!result.ok) {
        setSave({
          kind: "err",
          message: result.message || result.error,
        });
        return;
      }
      setSave({ kind: "ok", questionCount: result.questionCount, at: Date.now() });
      router.refresh();
    });
  };

  return (
    <div
      style={{
        background: "var(--card-hi)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-3)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--ink-3)",
          }}
        >
          Quiz JSON
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: parseError ? "var(--rust)" : "var(--ink-3)",
          }}
        >
          {parseError ? `× invalid JSON` : `✓ parses${dirty ? " · unsaved" : ""}`}
        </div>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        style={{
          width: "100%",
          minHeight: 480,
          padding: 12,
          background: "var(--paper)",
          color: "var(--ink)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-2)",
          fontFamily: "var(--mono)",
          fontSize: 12,
          lineHeight: 1.55,
          resize: "vertical",
          outline: "none",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          onClick={onSave}
          disabled={isPending || !dirty || !!parseError}
          style={{
            padding: "8px 16px",
            background:
              isPending || !dirty || !!parseError ? "var(--paper-2)" : "var(--ink)",
            color:
              isPending || !dirty || !!parseError ? "var(--ink-3)" : "var(--paper)",
            border: "1px solid",
            borderColor:
              isPending || !dirty || !!parseError ? "var(--line)" : "var(--ink)",
            borderRadius: "var(--r-2)",
            fontSize: 13,
            fontWeight: 500,
            cursor: isPending || !dirty || !!parseError ? "not-allowed" : "pointer",
          }}
        >
          {save.kind === "saving" || isPending ? "Saving…" : "Save quiz"}
        </button>
        <button
          type="button"
          onClick={() => setText(initialJson)}
          disabled={!dirty || isPending}
          style={{
            padding: "8px 14px",
            background: "transparent",
            color: !dirty ? "var(--ink-4)" : "var(--ink-3)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2)",
            fontSize: 12,
            cursor: !dirty ? "not-allowed" : "pointer",
          }}
        >
          Discard
        </button>
        <SaveStatus state={save} />
      </div>
    </div>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  if (state.kind === "ok") {
    return (
      <span
        style={{
          fontSize: 11,
          color: "var(--lichen)",
          fontFamily: "var(--mono)",
          marginLeft: "auto",
        }}
      >
        Saved · {state.questionCount} questions
      </span>
    );
  }
  if (state.kind === "err") {
    return (
      <span
        style={{
          fontSize: 11,
          color: "var(--rust)",
          fontFamily: "var(--mono)",
          marginLeft: "auto",
          maxWidth: 360,
          textAlign: "right",
        }}
        title={state.message}
      >
        {state.message}
      </span>
    );
  }
  return null;
}
