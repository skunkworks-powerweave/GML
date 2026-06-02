// Spec 166 — minimal ESLint config for @gml/db.
//
// Flat config (ESLint 9 style) wiring @typescript-eslint's
// recommended rule set. The package contains schema files,
// migration scripts, and a retention job — pure TypeScript, no
// React, no JSX — so the @typescript-eslint recommended set is
// exactly the right surface (no eslint-config-next noise about
// missing react-hooks rules etc.).
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: { ...tsPlugin.configs.recommended.rules },
  },
];
