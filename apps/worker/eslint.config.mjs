// Spec 166 — minimal ESLint config for @gml/worker.
//
// Flat config (ESLint 9 style) that wires @typescript-eslint's
// recommended rule set so a bare `pnpm --filter @gml/worker lint`
// surfaces basic TS issues. The Next.js eslint-config-next preset
// used by the web app would be overkill here (no React, no JSX),
// so we keep the worker's lint surface scoped to the TS rules.
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
