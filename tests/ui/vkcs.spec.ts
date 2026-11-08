import { test, expect } from "./fixtures";

const PROD = "11111111-2222-3333-4444-555555555555";
const STAGE = "22222222-3333-4444-5555-666666666666";

test.describe("VK Cloud", () => {
  test.beforeEach(async ({ app }) => { await app.view("vkcs"); });

  test("restores saved project without fetching projects on startup", async ({ app, page }) => {
    await expect(page.locator(".vkcs-body")).toContainText("app-1");
    await expect(page.locator(".vkcs-project")).toHaveValue(PROD);
    await expect(page.locator(".vkcs-project option:checked")).toHaveText("prod");
    expect(await app.calls("vkcs_project")).toHaveLength(0);
    expect(await app.calls("vkcs_projects")).toHaveLength(0);
    await page.locator(".vkcs [data-a=projects-refresh]").click();
    await app.called("vkcs_projects");
    await expect(page.locator(".vkcs-project")).toHaveValue(PROD);
  });

  test("repeated refresh waits for the same request", async ({ app, page }) => {
    await expect(page.locator(".vkcs-body")).toContainText("4.0 GB");
    const before = (await app.calls("vkcs_server_list")).length;
    await page.evaluate(() => {
      const w = window as any;
      w.__DEMO_OVERRIDES.vkcs_server_list = () => new Promise((resolve) => { w.__finishServerList = () => resolve([]); });
    });
    await page.locator(".vkcs [data-a=refresh]").click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__finishServerList)).toBe("function");
    await page.locator(".vkcs [data-a=refresh]").click();
    await page.evaluate(() => (window as any).__finishServerList());
    await expect(page.locator(".vkcs-body")).toContainText("В проекте нет машин");
    expect(await app.calls("vkcs_server_list")).toHaveLength(before + 1);
  });

  test("late project replies cannot restore a previous cloud", async ({ app, page }) => {
    await expect(page.locator(".vkcs-body")).toContainText("app-1");
    await page.evaluate(() => {
      const w = window as any;
      w.__DEMO_OVERRIDES.vkcs_projects = ({ cloud }: { cloud: string }) => cloud === "vk-stage"
        ? new Promise((resolve) => { w.__finishProjects = () => resolve([{ id: "22222222-3333-4444-5555-666666666666", name: "old-project" }]); })
        : [{ id: "11111111-2222-3333-4444-555555555555", name: "prod" }];
    });
    await page.locator(".vkcs-cloud").selectOption("vk-stage");
    await expect(page.locator(".vkcs-project")).toBeDisabled();
    await expect(page.locator(".vkcs-body")).not.toContainText("app-1");
    await expect.poll(() => page.evaluate(() => typeof (window as any).__finishProjects)).toBe("function");
    await page.locator(".vkcs-cloud").selectOption("vk-prod");
    await expect(page.locator(".vkcs-body")).toContainText("app-1");
    await page.evaluate(async () => { (window as any).__finishProjects(); await new Promise(requestAnimationFrame); });
    await expect(page.locator(".vkcs-cloud")).toHaveValue("vk-prod");
    await expect(page.locator(".vkcs-project")).toHaveValue(PROD);
    await expect(page.locator(".vkcs-project")).not.toContainText("old-project");
    expect((await app.calls("vkcs_use_project")).at(-1)!.args).toEqual({ id: PROD });
  });

  test("late enrichment of machines cannot repaint a different project", async ({ app, page }) => {
    await expect(page.locator(".vkcs-body")).toContainText("4.0 GB");
    await page.evaluate(() => {
      const w = window as any;
      w.__DEMO_OVERRIDES.vkcs_instance_maps = () => new Promise((resolve) => {
        w.__finishMaps = () => resolve({ flavors: {}, floating: {} });
      });
    });
    await page.locator(".vkcs [data-a=refresh]").click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__finishMaps)).toBe("function");
    await page.locator(".vkcs-project").selectOption(STAGE);
    await expect(page.locator(".vkcs-body")).toContainText("В проекте нет машин");
    await page.evaluate(async () => { (window as any).__finishMaps(); await new Promise(requestAnimationFrame); });
    await expect(page.locator(".vkcs-body")).toContainText("В проекте нет машин");
    await expect(page.locator(".vkcs-body")).not.toContainText("app-1");
    expect((await app.calls("vkcs_use_project")).at(-1)!.args).toEqual({ id: STAGE });
  });

  test("a failed refresh labels cached data and recovers on retry", async ({ app, page }) => {
    await expect(page.locator(".vkcs-body")).toContainText("4.0 GB");
    await page.evaluate(() => {
      (window as any).__DEMO_OVERRIDES.vkcs_server_list = () => { throw new Error("CLI timeout"); };
    });
    await page.locator(".vkcs [data-a=refresh]").click();
    await expect(page.locator(".vkcs-body .err")).toContainText("Показаны последние загруженные данные");
    await expect(page.locator(".vkcs-body")).toContainText("app-1");
    await expect(page.locator(".vkcs-body .err")).toContainText("CLI timeout");
    await app.override("vkcs_server_list", []);
    await page.locator(".vkcs [data-a=refresh]").click();
    await expect(page.locator(".vkcs-body")).toContainText("В проекте нет машин");
    await expect(page.locator(".vkcs-body .err")).toHaveCount(0);
  });

  test("a failed project list clears old resources and can be retried", async ({ app, page }) => {
    await expect(page.locator(".vkcs-body")).toContainText("app-1");
    await page.evaluate(() => {
      (window as any).__DEMO_OVERRIDES.vkcs_projects = () => { throw new Error("projects forbidden"); };
    });
    const before = (await app.calls("vkcs_server_list")).length;
    await page.locator(".vkcs-cloud").selectOption("vk-stage");
    await expect(page.locator(".vkcs-body .err")).toContainText("projects forbidden");
    await expect(page.locator(".vkcs-body")).not.toContainText("app-1");
    await expect(page.locator(".vkcs-project")).toBeDisabled();
    expect(await app.calls("vkcs_server_list")).toHaveLength(before);
    await app.override("vkcs_projects", [{ id: STAGE, name: "stage" }]);
    await page.locator(".vkcs [data-a=refresh]").click();
    await expect(page.locator(".vkcs-project")).toHaveValue(STAGE);
    await expect(page.locator(".vkcs-body")).toContainText("В проекте нет машин");
    await expect(page.locator(".vkcs-err")).toBeHidden();
  });

  test("saving a new selection waits for the old save and wins on disk", async ({ app, page }) => {
    await expect(page.locator(".vkcs-body")).toContainText("4.0 GB");
    await page.evaluate(() => {
      const w = window as any;
      w.__DEMO_OVERRIDES.vkcs_use_project = ({ id }: { id: string }) => id.startsWith("2222")
        ? new Promise((resolve) => { w.__finishSave = () => { w.__savedProject = id; resolve(null); }; })
        : (w.__savedProject = id, null);
    });
    await page.locator(".vkcs-project").selectOption(STAGE);
    await expect.poll(() => page.evaluate(() => typeof (window as any).__finishSave)).toBe("function");
    await page.locator(".vkcs-project").selectOption(PROD);
    await page.evaluate(() => (window as any).__finishSave());
    await expect(page.locator(".vkcs-body")).toContainText("app-1");
    await expect.poll(() => page.evaluate(() => (window as any).__savedProject)).toBe(PROD);
  });

  test("empty rules and subnets finish loading with zero counts", async ({ app, page }) => {
    await app.override("vkcs_sec_group_rules", []);
    await page.locator('.vkcs-tabs [data-t="sg"]').click();
    await expect(page.locator(".vkcs-group summary")).toContainText("правил 0");
    await expect(page.locator(".vkcs-body .skeleton-row")).toHaveCount(0);
    await app.override("vkcs_subnets", []);
    await page.locator('.vkcs-tabs [data-t="net"]').click();
    await expect(page.locator(".vkcs-group summary")).toContainText("подсетей 0");
    await expect(page.locator(".vkcs-body .skeleton-row")).toHaveCount(0);
  });

  test("partial failures keep the list and explicitly mark missing details", async ({ app, page }) => {
    await expect(page.locator(".vkcs-body")).toContainText("app-1");
    await page.evaluate(() => {
      const overrides = (window as any).__DEMO_OVERRIDES;
      overrides.vkcs_sec_group_rules = () => { throw new Error("rules forbidden"); };
      overrides.vkcs_subnets = () => { throw new Error("subnets unavailable"); };
    });
    // A new context has no cache, including data prefetched at startup.
    await page.locator(".vkcs-project").selectOption(STAGE);
    await expect(page.locator(".vkcs-body")).toContainText("В проекте нет машин");
    await page.locator('.vkcs-tabs [data-t="sg"]').click();
    await expect(page.locator(".vkcs-body .err")).toContainText("rules forbidden");
    await expect(page.locator(".vkcs-group summary")).toContainText("web");
    await expect(page.locator(".vkcs-group summary")).toContainText("правил ?");
    await expect(page.locator(".vkcs-body .skeleton-row")).toHaveCount(0);
    await page.locator('.vkcs-tabs [data-t="net"]').click();
    await expect(page.locator(".vkcs-body .err")).toContainText("subnets unavailable");
    await expect(page.locator(".vkcs-group summary")).toContainText("ext-net");
    await expect(page.locator(".vkcs-group summary")).toContainText("подсетей ?");
    await expect(page.locator(".vkcs-body .skeleton-row")).toHaveCount(0);
    await app.override("vkcs_subnets", []);
    await page.locator(".vkcs [data-a=refresh]").click();
    await expect(page.locator(".vkcs-group summary")).toContainText("подсетей 0");
    await expect(page.locator(".vkcs-body .err")).toHaveCount(0);
  });

  test("failed machine enrichment is visible and cannot become a successful cache entry", async ({ app, page }) => {
    await expect(page.locator(".vkcs-body")).toContainText("app-1");
    await app.override("vkcs_server_list", [{ id: "s1", name: "partial-vm", status: "RUNNING", zone: "", platform: "f1", cores: 0, memory: 0, core_fraction: 100, preemptible: false, internal_ip: "10.0.0.1", public_ip: "", subnet_id: "" }]);
    await page.evaluate(() => {
      (window as any).__DEMO_OVERRIDES.vkcs_instance_maps = () => { throw new Error("flavors forbidden"); };
    });
    await page.locator(".vkcs-project").selectOption(STAGE);
    await expect(page.locator(".vkcs-body .err")).toContainText("flavors forbidden");
    await expect(page.locator(".vkcs-body")).toContainText("partial-vm");
    await page.locator('.vkcs-tabs [data-t="ip"]').click();
    await page.locator('.vkcs-tabs [data-t="vm"]').click();
    await expect(page.locator(".vkcs-body .err")).toContainText("flavors forbidden");
  });

  test("instances show state, flavor and addresses; SSH opens a tab", async ({ app, page }) => {
    expect((await app.called("vkcs_server_list")).args).toEqual({ cloud: "vk-prod", projectId: PROD });
    const rows = page.locator(".vkcs-body tbody tr");
    await expect(rows).toHaveCount(2);
    const app1 = rows.filter({ hasText: "app-1" });
    await expect(app1).toContainText("RUNNING");
    await expect(app1).toContainText("Standard-2-4 · 2 vCPU · 4.0 GB");
    await expect(app1).toContainText("203.0.113.7");

    await app1.locator("[data-a=ssh]").click();
    await expect.poll(async () => ((await app.calls("pty_spawn")).at(-1)?.args as any)?.req?.args).toEqual(["203.0.113.7"]);
  });

  test("stopping a machine asks first and only then calls the cloud", async ({ app, page }) => {
    const app1 = page.locator(".vkcs-body tbody tr").filter({ hasText: "app-1" });
    await app1.locator("[data-a=stop]").click();
    await expect(page.locator("dialog.ask")).toContainText("настоящая машина");
    await page.locator("dialog.ask button[value=cancel]").click();
    expect(await app.calls("vkcs_instance_op")).toHaveLength(0);

    await app1.locator("[data-a=stop]").click();
    await page.locator("dialog.ask button[value=ok]").click();
    expect((await app.called("vkcs_instance_op")).args).toMatchObject({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", op: "stop", cloud: "vk-prod" });
  });

  test("networks, security groups, addresses, access and billing link", async ({ app, page }) => {
    await page.locator('.vkcs-tabs [data-t="net"]').click();
    await expect(page.locator(".vkcs-group summary").first()).toContainText("подсетей 2");
    await expect(page.locator(".vkcs-body")).toContainText("10.0.0.0/24");

    await page.locator('.vkcs-tabs [data-t="sg"]').click();
    await expect(page.locator(".vkcs-group summary").first()).toContainText("правил 3");
    await expect(page.locator(".vkcs-body tbody tr").first()).toContainText("входящее");

    await page.locator('.vkcs-tabs [data-t="ip"]').click();
    await expect(page.locator(".vkcs-body tbody tr").nth(1)).toContainText("нет (платный простой)");

    await page.locator('.vkcs-tabs [data-t="iam"]').click();
    await expect(page.locator(".vkcs-body")).toContainText("deploy@example.com");

    await page.locator('.vkcs-tabs [data-t="bill"]').click();
    await expect(page.locator(".vkcs-body")).toContainText("1234,56");
    await expect(page.locator(".vkcs-body")).toContainText("mcs0123456789");
    expect(await app.calls("vkcs_billing_report")).toHaveLength(0);
    await page.locator("[data-a=bill-report-load]").click();
    await expect(page.locator(".vkcs-body")).toContainText("Cloud Servers");
    await expect(page.locator(".vkcs-body")).toContainText("45,00");
    await page.locator("[data-a=billing-web]").click();
    expect((await app.called("open_external")).args).toEqual({ url: "https://msk.cloud.vk.ru/" });
  });

  test("another project is read on its own; cloud switch is saved", async ({ app, page }) => {
    await page.locator(".vkcs-project").selectOption("22222222-3333-4444-5555-666666666666");
    await expect.poll(async () => ((await app.calls("vkcs_server_list")).at(-1)!.args as any).projectId).toBe("22222222-3333-4444-5555-666666666666");
    expect((await app.called("vkcs_use_project")).args).toEqual({ id: "22222222-3333-4444-5555-666666666666" });
  });
});

test.describe("VK Cloud without the CLI", () => {
  test.use({
    demo: {
      overrides: {
        vkcs_status: {
          found: false, version: "", cloud: "", clouds: [], project_id: "", bin: "openstack", config_path: "",
          error: "openstack не найден — установите python-openstackclient (pip install python-openstackclient) или укажите путь к файлу кнопкой ниже",
        },
      },
    },
  });

  test("the section explains what to install and asks the cloud for nothing", async ({ app, page }) => {
    await app.view("vkcs");
    await expect(page.locator(".vkcs-err")).toContainText("openstack не найден");
    await expect(page.locator(".vkcs-body")).toContainText("не хранит ни паролей");
    expect(await app.calls("vkcs_clouds")).toHaveLength(0);
    expect(await app.calls("vkcs_server_list")).toHaveLength(0);

    await expect(page.locator(".vkcs-nobin")).toBeVisible();
    await page.locator("[data-a=vkcs-path]").click();
    await page.locator("dialog.ask input").fill("~/bin/openstack");
    await page.locator("dialog.ask button[value=ok]").click();
    expect((await app.called("vkcs_set_path")).args).toEqual({ path: "~/bin/openstack" });
  });
});
