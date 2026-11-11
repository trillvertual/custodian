import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      ".impeccable/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["tsconfig.eslint.json"],
        tsconfigRootDir: root,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "react-hooks": reactHooks,
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-dupe-class-members": "off",
      "no-redeclare": "off",
      "no-promise-executor-return": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/no-for-in-array": "error",
      "@typescript-eslint/no-unsafe-enum-comparison": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",
      "react-hooks/rules-of-hooks": "error",
    },
  },
];
