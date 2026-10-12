import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "data/", "backups/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Komentoriviltä ajettavat apuskriptit (gmail-auth.js, gmail-test.js).
  { files: ["*.js"], languageOptions: { globals: { console: "readonly", process: "readonly" } } },
  {
    rules: {
      // Tietokantarivit ja ulkoisten kirjastojen virheet käsitellään monin paikoin any-tyyppisinä.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }]
    }
  }
);
