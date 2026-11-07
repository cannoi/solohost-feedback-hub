import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/admin-app-selector.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(source, { window });

test("shared app selector lists only approved active registry apps with name and ID", () => {
  const apps = [
    { app_id: "active-app", app_name: "Active App", status: "active", integration_status: "approved", approval_status: "approved" },
    { app_id: "pending-app", app_name: "Pending App", status: "active", integration_status: "pending", approval_status: "pending" },
    { app_id: "paused-app", app_name: "Paused App", status: "paused", integration_status: "approved", approval_status: "approved" },
    { app_id: "disabled-app", app_name: "Disabled App", status: "active", integration_status: "disabled", approval_status: "approved" },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(window.SHFAAppSelector.options(apps))), [{
    app_id: "active-app",
    app_name: "Active App",
    label: "Active App (active-app)",
  }]);
  assert.equal(window.SHFAAppSelector.selectedValue(apps, "pending-app"), "");
  assert.equal(window.SHFAAppSelector.selectedValue(apps, "missing-app"), "");
});

test("shared app selector synchronizes both forms and clears ineligible selections", () => {
  const apps = [{ app_id: "app-one", app_name: "App One", status: "active", integration_status: "approved" }];
  const updateForm = { value: "" }, notificationForm = { value: "" };
  assert.equal(window.SHFAAppSelector.synchronize([updateForm, notificationForm], apps, "app-one"), "app-one");
  assert.equal(updateForm.value, "app-one");
  assert.equal(notificationForm.value, "app-one");
  assert.equal(window.SHFAAppSelector.synchronize([updateForm, notificationForm], apps, "removed-app"), "");
  assert.equal(updateForm.value, "");
  assert.equal(notificationForm.value, "");
});
