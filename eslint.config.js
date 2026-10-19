import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// One config for the whole repo: eslint walks up from each workspace, so
// `eslint src` inside any package resolves to this file.
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The house rule: no `as any`, no `as unknown as T`. Fix the type.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // react/ only. exhaustive-deps is the rule that catches real React bugs.
    files: ["react/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
  },
);
