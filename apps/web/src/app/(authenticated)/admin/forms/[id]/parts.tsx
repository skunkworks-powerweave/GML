"use client";

// Client components for /admin/forms/[id].
// FormSchemaEditor — textarea + Save button (PUTs to /api/admin/forms/[id]).
// FormSchemaPreview — live read-only render of the parsed JSON; gracefully shows
// a "schema does not parse" panel on invalid JSON.

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type EditorProps = {
  formId: string;
  initialSchema: string;
  initialVersion: string;
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "ok"; version: string; at: number }
  | { kind: "err"; message: string };

export function FormSchemaEditor({ formId, initialSchema, initialVersion }: EditorProps) {
  const [text, setText] = useState(initialSchema);
  const [version, setVersion] = useState(initialVersion);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [, startTransition] = useTransition();
  const router = useRouter();

  // Track whether the textarea has been edited away from the persisted value.
  const dirty = text !== initialSchema;

  const parseError = useMemo<string | null>(() => {
    try {
      JSON.parse(text);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, [text]);

  const onSave = async () => {
    if (parseError) {
      setSave({ kind: "err", message: `JSON does not parse: ${parseError}` });
      return;
    }
    setSave({ kind: "saving" });
    try {
      const res = await fetch(`/api/admin/forms/${formId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSave({
          kind: "err",
          message: body?.message || body?.error || `HTTP ${res.status}`,
        });
        return;
      }
      const body = (await res.json()) as { ok: boolean; version: string };
      setVersion(body.version);
      setSave({ kind: "ok", version: body.version, at: Date.now() });
      startTransition(() => router.refresh());
    } catch (e) {
      setSave({ kind: "err", message: (e as Error).message });
    }
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
          Schema (raw JSON)
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: parseError ? "var(--rust)" : "var(--ink-3)",
          }}
        >
          {parseError ? `× invalid JSON` : `✓ parses · v${version}${dirty ? " · unsaved" : ""}`}
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
          disabled={save.kind === "saving" || !dirty || !!parseError}
          style={{
            padding: "8px 16px",
            background:
              save.kind === "saving" || !dirty || !!parseError
                ? "var(--paper-2)"
                : "var(--ink)",
            color:
              save.kind === "saving" || !dirty || !!parseError
                ? "var(--ink-3)"
                : "var(--paper)",
            border: "1px solid",
            borderColor:
              save.kind === "saving" || !dirty || !!parseError
                ? "var(--line)"
                : "var(--ink)",
            borderRadius: "var(--r-2)",
            fontSize: 13,
            fontWeight: 500,
            cursor:
              save.kind === "saving" || !dirty || !!parseError ? "not-allowed" : "pointer",
          }}
        >
          {save.kind === "saving" ? "Saving…" : "Save schema"}
        </button>
        <button
          type="button"
          onClick={() => setText(initialSchema)}
          disabled={!dirty || save.kind === "saving"}
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
        Saved · v{state.version}
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

type PreviewProps = {
  initialSchema: string;
};

export function FormSchemaPreview({ initialSchema }: PreviewProps) {
  // The preview is driven by a sibling editor; we listen for the editor's
  // textarea via a custom event on window. Falls back to initial schema.
  const [json, setJson] = useState(initialSchema);

  useEffect(() => {
    // We update on focus changes (after edits land). Lightweight polling of the
    // co-located textarea avoids forcing a context provider in two-component land.
    const tick = () => {
      const ta = document.querySelector<HTMLTextAreaElement>(
        "textarea[spellcheck='false']",
      );
      if (ta && ta.value !== json) setJson(ta.value);
    };
    const id = setInterval(tick, 400);
    return () => clearInterval(id);
  }, [json]);

  const { parsed, error } = useMemo(() => {
    try {
      return { parsed: JSON.parse(json) as unknown, error: null as string | null };
    } catch (e) {
      return { parsed: null, error: (e as Error).message };
    }
  }, [json]);

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
        minHeight: 540,
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
        Preview (read-only)
      </div>
      {error ? (
        <div
          style={{
            padding: 14,
            background: "var(--rust-soft)",
            border: "1px solid var(--rust)",
            borderRadius: "var(--r-2)",
            color: "var(--rust)",
            fontSize: 12,
            fontFamily: "var(--mono)",
          }}
        >
          Schema does not parse: {error}
        </div>
      ) : (
        <SchemaRenderer schema={parsed} />
      )}
    </div>
  );
}

// Renders the parsed schema in the shape the FormRunner expects:
// { title, sections: [{ title, items: [{ id, label, kind, scale?, options?, rows? }] }] }
// Unknown shapes fall back to a pretty-printed code block so admins can still
// spot-check structural changes.
function SchemaRenderer({ schema }: { schema: unknown }) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return <CodeBlock value={schema} />;
  }
  const obj = schema as {
    title?: unknown;
    description?: unknown;
    sections?: unknown;
  };
  const sections = Array.isArray(obj.sections) ? obj.sections : null;
  if (!sections) {
    // No sections array — show the JSON as code.
    return <CodeBlock value={schema} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {typeof obj.title === "string" && obj.title.length > 0 ? (
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 20, margin: 0 }}>{obj.title}</h2>
      ) : null}
      {typeof obj.description === "string" && obj.description.length > 0 ? (
        <p style={{ color: "var(--ink-3)", fontSize: 12, margin: 0 }}>{obj.description}</p>
      ) : null}
      {sections.map((s, i) => (
        <SectionBlock key={i} section={s} index={i} />
      ))}
    </div>
  );
}

function SectionBlock({ section, index }: { section: unknown; index: number }) {
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return <CodeBlock value={section} />;
  }
  const s = section as { title?: unknown; items?: unknown };
  const items = Array.isArray(s.items) ? s.items : [];
  return (
    <div
      style={{
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-2)",
        padding: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: "var(--paper-2)",
            color: "var(--ink-3)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontFamily: "var(--mono)",
            fontWeight: 600,
          }}
        >
          {index + 1}
        </span>
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>
          {typeof s.title === "string" ? s.title : `Section ${index + 1}`}
        </span>
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10 }}>
        {items.length === 0 ? (
          <li style={{ fontSize: 11, color: "var(--ink-4)" }}>(no items)</li>
        ) : (
          items.map((it, j) => <ItemRow key={j} item={it} />)
        )}
      </ul>
    </div>
  );
}

function ItemRow({ item }: { item: unknown }) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return (
      <li style={{ fontSize: 11, color: "var(--ink-3)" }}>
        <CodeBlock value={item} />
      </li>
    );
  }
  const it = item as {
    id?: unknown;
    label?: unknown;
    kind?: unknown;
    scale?: unknown;
    rows?: unknown;
    options?: unknown;
  };
  const kindLabel = typeof it.kind === "string" ? it.kind : "?";
  const scale = typeof it.scale === "number" ? it.scale : null;
  return (
    <li
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        fontSize: 12,
        color: "var(--ink-2)",
      }}
    >
      <span
        style={{
          display: "inline-block",
          minWidth: 64,
          padding: "1px 6px",
          background: "var(--paper-2)",
          borderRadius: 3,
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--ink-3)",
          textAlign: "center",
        }}
      >
        {kindLabel}
        {scale ? ` · 1-${scale}` : ""}
      </span>
      <div style={{ flex: 1 }}>
        <div>{typeof it.label === "string" ? it.label : "(no label)"}</div>
        {Array.isArray(it.options) && it.options.length > 0 ? (
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
            options: {it.options.map(String).join(" · ")}
          </div>
        ) : null}
      </div>
      <span
        style={{
          fontSize: 10,
          fontFamily: "var(--mono)",
          color: "var(--ink-4)",
        }}
      >
        {typeof it.id === "string" ? it.id : ""}
      </span>
    </li>
  );
}

function CodeBlock({ value }: { value: unknown }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: 12,
        background: "var(--paper)",
        border: "1px dashed var(--line)",
        borderRadius: "var(--r-2)",
        fontFamily: "var(--mono)",
        fontSize: 11,
        color: "var(--ink-2)",
        overflowX: "auto",
        whiteSpace: "pre-wrap",
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
