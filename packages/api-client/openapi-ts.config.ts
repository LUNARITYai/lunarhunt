import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../contracts/openapi.json",
  output: "src",
  plugins: ["@hey-api/client-fetch"],
});
