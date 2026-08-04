import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../api/openapi/v1/openapi.yaml",
  output: {
    path: "src/api/generated",
    clean: true,
  },
});
