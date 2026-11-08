"""Run with python -m unittest discover -s tests -p test_vkcs_worker.py."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace as Resource
import unittest
from unittest.mock import Mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WORKER = Path(__file__).resolve().parents[1] / "src-tauri/src/vkcs_worker.py"
spec = importlib.util.spec_from_file_location("vkcs_worker", WORKER)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class MappingTest(unittest.TestCase):
    def test_service_shapes_and_mutations(self):
        conn = Mock()
        conn.compute.servers.return_value = [Resource(id="vm", name="test", status="ACTIVE",
            availability_zone="zone", flavor={"original_name": "small"},
            addresses={"first": [{"addr": "10.0.0.1"}], "second": [{"addr": "203.0.113.1"}]})]
        server = worker.execute(conn, ["server", "list"])[0]
        self.assertEqual(server["Networks"], "first=10.0.0.1, second=203.0.113.1")
        self.assertEqual(server["Flavor"], "small")
        conn.compute.flavors.return_value = [Resource(id="f", name="small", ram=2048, vcpus=2)]
        self.assertEqual(worker.execute(conn, ["flavor", "list"])[0]["RAM"], 2048)
        conn.network.subnets.return_value = [Resource(id="s", name="private", network_id="n", cidr="10.0.0.0/24")]
        self.assertEqual(worker.execute(conn, ["subnet", "list"])[0]["network_id"], "n")
        conn.network.security_groups.return_value = [Resource(id="g", name="default", description=None)]
        self.assertEqual(worker.execute(conn, ["security", "group", "list"])[0]["description"], "")
        conn.network.security_group_rules.return_value = [Resource(security_group_id="g", direction="ingress",
            port_range_min=80, port_range_max=90, protocol="tcp", remote_ip_prefix="0.0.0.0/0",
            remote_group_id=None, description=None)]
        self.assertEqual(worker.execute(conn, ["security", "group", "rule", "list", "--long"])[0]["port_range"], "80:90")
        conn.identity.projects.return_value = [Resource(id="p", name="project")]
        self.assertEqual(worker.execute(conn, ["project", "list"]), [{"id": "p", "name": "project"}])
        conn.identity.get_project.return_value = Resource(id="p", name="project")
        self.assertEqual(worker.execute(conn, ["project", "show", "p"])["name"], "project")
        conn.identity.role_assignments.return_value = [Resource(role={"id": "role"}, user={}, group={"id": "group"})]
        self.assertEqual(worker.execute(conn, ["role", "assignment", "list", "--project", "p"]),
                         [{"Role": "role", "Type": "group", "User": "group"}])
        conn.identity.role_assignments.assert_called_once_with(**{"scope.project.id": "p"})
        worker.execute(conn, ["server", "start", "vm"])
        worker.execute(conn, ["server", "stop", "vm"])
        worker.execute(conn, ["server", "reboot", "--soft", "vm"])
        conn.compute.start_server.assert_called_once_with("vm")
        conn.compute.stop_server.assert_called_once_with("vm")
        conn.compute.reboot_server.assert_called_once_with("vm", reboot_type="SOFT")


class WorkerIntegrationTest(unittest.TestCase):
    def test_session_reuse_scope_and_reauthentication(self):
        scopes, tokens, requests = [], [], []
        state = {"reject": False, "deny_own_projects": False, "deny_network": False}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, value, status=200, token=None):
                body = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                if token:
                    self.send_header("X-Subject-Token", token)
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                scopes.append(payload["auth"]["scope"]["project"])
                token = f"test-token-{len(scopes)}"
                self.reply({"token": {
                    "expires_at": "2099-01-01T00:00:00Z", "issued_at": "2026-01-01T00:00:00Z",
                    "methods": ["password"], "user": {"id": "user"},
                    "project": {"id": "selected-project", "name": "selected"},
                    "catalog": [{"id": "identity", "type": "identity", "name": "keystone",
                                 "endpoints": [{"id": "identity-public", "interface": "public",
                                                "region": "test", "url": base + "/v3"}]},
                                {"id": "network", "type": "network", "name": "neutron",
                                 "endpoints": [{"id": "public", "interface": "public",
                                                "region": "test", "url": base}]}],
                }}, 201, token)

            def do_GET(self):
                requests.append(self.path)
                if self.path.rstrip("/") == "/v3":
                    return self.reply({"version": {"id": "v3.14", "status": "stable",
                                                  "links": [{"rel": "self", "href": base + "/v3/"}]}})
                tokens.append(self.headers.get("X-Auth-Token"))
                if self.path.rstrip("/") == "/v3/projects":
                    return self.reply({"error": {"message": "Global project list requires admin"}}, 403)
                if self.path.rstrip("/") == "/v3/users/user/projects":
                    if state["deny_own_projects"]:
                        return self.reply({"error": {"message": "User projects forbidden"}}, 403)
                    return self.reply({"projects": [{"id": "selected-project", "name": "My project"}], "links": {"next": None}})
                if state["reject"]:
                    state["reject"] = False
                    return self.reply({"NeutronError": {"message": "expired"}}, 401)
                if self.path.startswith("/v2.0/networks"):
                    if state["deny_network"]:
                        return self.reply({"NeutronError": {"message": "Forbidden"}}, 403)
                    return self.reply({"networks": [{"id": "net", "name": "private", "description": ""}]})
                if self.path.startswith("/v2.0/floatingips"):
                    return self.reply({"floatingips": [{"id": "ip", "fixed_ip_address": "10.0.0.1",
                                                        "floating_ip_address": "203.0.113.1"}]})
                self.reply({"error": "Unexpected path"}, 501)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        base = f"http://127.0.0.1:{server.server_port}"
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / "clouds.yaml"
            config.write_text(json.dumps({"clouds": {"test": {
                "region_name": "test", "auth_type": "v3password",
                "auth": {"auth_url": base + "/v3", "username": "test", "password": "fake-secret",
                         "user_domain_name": "Default", "project_name": "wrong-project",
                         "project_domain_name": "Default"}}}}))
            env = {k: v for k, v in os.environ.items() if not k.startswith("OS_")}
            env["OS_CLIENT_CONFIG_FILE"] = str(config)
            proc = subprocess.Popen([sys.executable, "-u", str(WORKER)], env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, encoding="utf-8")
            try:
                def query(args):
                    proc.stdin.write(json.dumps({"cloud": "test", "project_id": "selected-project", "args": args}) + "\n")
                    proc.stdin.flush()
                    return json.loads(proc.stdout.readline())

                self.assertEqual(query(["network", "list"])["result"][0]["id"], "net")
                self.assertEqual(query(["floating", "ip", "list"])["result"][0]["fixed_ip_address"], "10.0.0.1")
                self.assertEqual(query(["token", "issue", "-c", "id", "-f", "value"])["result"], "test-token-1")
                self.assertEqual(len(scopes), 1, "subsequent queries must reuse authentication")
                self.assertEqual(scopes[0], {"id": "selected-project"})
                self.assertEqual(query(["project", "show", "selected-project"])["result"],
                                 {"id": "selected-project", "name": "selected"})
                self.assertNotIn("/v3/projects/selected-project", requests,
                                 "the scoped project name is available from the session without another API request")
                self.assertEqual(query(["project", "list"])["result"],
                                 [{"id": "selected-project", "name": "My project"}])
                self.assertIn("/v3/projects", requests)
                self.assertIn("/v3/users/user/projects", requests)
                self.assertEqual(len(scopes), 1, "project-list fallback must reuse the authenticated session")
                state["deny_own_projects"] = True
                self.assertEqual(query(["project", "list"])["status"], 403,
                                 "a genuine denial of the user's projects must remain an error")
                state["deny_own_projects"] = False
                state["deny_network"] = True
                self.assertEqual(query(["network", "list"])["status"], 403,
                                 "project-list fallback must not mask unrelated permission failures")
                state["deny_network"] = False
                state["reject"] = True
                self.assertIn("result", query(["network", "list"]))
                self.assertEqual(len(scopes), 2, "401 must invalidate and renew the session token")
                error = query(["unsupported"])
                self.assertEqual(error["error"], "OpenStack SDK: ValueError")
                self.assertNotIn("fake-secret", json.dumps(error))
                proc.stdin.close()
                proc.wait(timeout=10)
                self.assertEqual(proc.returncode, 0)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                proc.stdout.close()
                proc.stderr.close()


if __name__ == "__main__":
    unittest.main()
