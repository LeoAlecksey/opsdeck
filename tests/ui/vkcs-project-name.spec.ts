import { test, expect } from "./fixtures";

const project = "11111111-2222-3333-4444-555555555555";
test.use({ demo: { overrides: {
  vkcs_status: { found: true, cloud: "vk-prod", clouds: ["vk-prod"], project_id: project,
    projects: [], error: "", config_path: "/demo/clouds.yaml", version: "", bin: "openstack" },
  vkcs_project: { id: project, name: "Production cloud", parent: "", description: "" },
} } });

test("legacy selection resolves and shows project name without fetching the project list", async ({ app, page }) => {
  await app.view("vkcs");
  await expect(page.locator(".vkcs-project")).toHaveValue(project);
  await expect(page.locator(".vkcs-project option:checked")).toHaveText("Production cloud");
  expect(await app.calls("vkcs_project")).toHaveLength(1);
  expect(await app.calls("vkcs_projects")).toHaveLength(0);
  await expect(page.locator(".vkcs-body")).toContainText("app-1");
});
