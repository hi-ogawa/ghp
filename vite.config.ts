import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    sortImports: {
      newlinesBetween: false,
    },
  },
  lint: {
    categories: {
      correctness: "off",
    },
    rules: {
      curly: "error",
    },
  },
  staged: {
    "*": "vp check --fix",
  },
});
