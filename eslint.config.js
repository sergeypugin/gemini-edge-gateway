import globals from "globals";

export default [
  {
    files: ["src/**/*.js", "public/**/*.js", "test/**/*.js", "scripts/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    rules: {
      "no-constant-binary-expression": "error",
      "no-undef": "error",
      "no-unreachable": "error",
    },
  },
];
