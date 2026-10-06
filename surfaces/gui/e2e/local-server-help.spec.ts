import { expect } from "@playwright/test";
import { test } from "./fixtures";

// Each keyless local server explains itself; llama.cpp and vLLM never say "Ollama".
const server = (name: string, title: string) => ({
  name, title, kind: "local", needs_key: false, configured: false, values: {}, suggested_models: [], recommended_model: null,
  fields: [{ key: "api_key", label: "API key (only if the server was started with one)", secret: true, required: false, help: "", placeholder: "" }],
});

for (const [name, title, says, link] of [
  ["llamacpp", "llama.cpp", "llama-server", "Install llama.cpp"],
  ["vllm", "vLLM", "NVIDIA GPU", "Install vLLM"],
] as const) {
  test(`${title}: its own help line, not Ollama's`, async ({ page }) => {
    await page.route("**/v1/providers", (route) => route.fulfill({ json: [server(name, title)] }));
    await page.goto("/");
    await page.getByTestId("account-row").click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Models & Keys" }).click();
    await page.getByTestId(`set-provider-${name}`).click();
    const form = page.locator("main");
    await expect(form).toContainText(says);
    await expect(form.getByRole("button", { name: `${link} ↗` })).toBeVisible();
    await expect(form).not.toContainText("Ollama");
  });
}
