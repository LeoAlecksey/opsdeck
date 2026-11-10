"""Private JSON-lines SDK bridge. Credentials and responses never go to logs."""
import contextlib
import json
import logging
import sys


def connect(request):
    from openstack.config import OpenStackConfig
    from openstack.connection import Connection

    loader = OpenStackConfig()
    loader._cache_auth = False
    options = dict(cloud=request["cloud"], api_timeout=45)
    if request["project_id"]:
        options["project_id"] = request["project_id"]
        # A configured project_name otherwise takes precedence over project_id.
        options["project_name"] = None
    config = loader.get_one_cloud(**options)
    config._cache_auth = False  # session credentials must remain in memory
    return Connection(config=config)


def execute(conn, args):
    # Return the existing CLI-shaped contract consumed by vkcs.rs.
    if args == ["server", "list"]:
        rows = []
        for s in conn.compute.servers(details=True):
            addresses = []
            for name, entries in (s.addresses or {}).items():
                addresses.append(name + "=" + ", ".join(e["addr"] for e in entries))
            flavor = s.flavor or {}
            rows.append(dict(ID=s.id, Name=s.name, Status=s.status,
                             **{"Availability Zone": s.availability_zone or "",
                                "Flavor": flavor.get("id", flavor.get("original_name", "")),
                                "Networks": ", ".join(addresses)}))
        return rows
    if args == ["flavor", "list"]:
        return [dict(ID=f.id, Name=f.name, RAM=f.ram, VCPUs=f.vcpus)
                for f in conn.compute.flavors(details=True)]
    if args == ["floating", "ip", "list"]:
        return [dict(id=f.id, fixed_ip_address=f.fixed_ip_address or "",
                     floating_ip_address=f.floating_ip_address or "") for f in conn.network.ips()]
    if args == ["network", "list"]:
        return [dict(id=n.id, name=n.name, description=n.description or "") for n in conn.network.networks()]
    if args == ["subnet", "list"]:
        return [dict(id=s.id, name=s.name, network_id=s.network_id, cidr=s.cidr) for s in conn.network.subnets()]
    if args == ["security", "group", "list"]:
        return [dict(id=g.id, name=g.name, description=g.description or "") for g in conn.network.security_groups()]
    if args == ["security", "group", "rule", "list", "--long"]:
        rows = []
        for r in conn.network.security_group_rules():
            lo, hi = r.port_range_min, r.port_range_max
            ports = "" if lo is None else str(lo) if lo == hi else f"{lo}:{hi}"
            rows.append(dict(security_group_id=r.security_group_id, direction=r.direction,
                             protocol=r.protocol or "", port_range=ports,
                             remote_ip_prefix=r.remote_ip_prefix or "",
                             remote_group_id=r.remote_group_id or "", description=r.description or ""))
        return rows
    if args == ["project", "list"]:
        from openstack.exceptions import ForbiddenException

        try:
            projects = list(conn.identity.projects())
        except ForbiddenException:
            # Match OSC ListProject: non-admin users may list their own
            # projects even when the global /projects collection is forbidden.
            user_id = conn.session.get_user_id()
            if not user_id:
                raise
            projects = list(conn.identity.user_projects(user_id))
        return [dict(id=p.id, name=p.name) for p in projects]
    if args[:2] == ["project", "show"] and len(args) == 3:
        get_access = getattr(conn.session.auth, "get_access", None)
        if get_access is not None:
            access = get_access(conn.session)
            if access.project_id == args[2] and access.project_name:
                return dict(id=access.project_id, name=access.project_name)
        p = conn.identity.get_project(args[2])
        return dict(id=p.id, name=p.name)
    if args[:3] == ["role", "assignment", "list"]:
        rows = []
        for r in conn.identity.role_assignments(**{"scope.project.id": args[4]}):
            user, group = r.user or {}, r.group or {}
            rows.append(dict(Role=(r.role or {}).get("id", ""),
                             Type="user" if user else "group",
                             User=user.get("id", "") or group.get("id", "")))
        return rows
    if args == ["token", "issue", "-c", "id", "-f", "value"]:
        return conn.authorize()
    if args[:2] == ["server", "start"]:
        conn.compute.start_server(args[2])
        return ""
    if args[:2] == ["server", "stop"]:
        conn.compute.stop_server(args[2])
        return ""
    if args[:3] == ["server", "reboot", "--soft"]:
        conn.compute.reboot_server(args[3], reboot_type="SOFT")
        return ""
    raise ValueError("Unsupported SDK operation")


def main():
    logging.disable(logging.CRITICAL)
    conn = None
    output = sys.stdout
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                if conn is None:
                    conn = connect(request)
                result = execute(conn, request["args"])
            response = {"result": result}
        except Exception as exc:
            # Exception strings can contain request headers, URLs and credentials.
            error = ("В Python-окружении выбранного CLI не хватает OpenStack SDK; установите openstacksdk"
                     if isinstance(exc, ImportError) else "OpenStack SDK: " + type(exc).__name__)
            response = {"error": error,
                        "status": getattr(exc, "status_code", None)}
        output.write(json.dumps(response) + "\n")
        output.flush()
    if conn is not None:
        conn.close()


if __name__ == "__main__":
    main()
