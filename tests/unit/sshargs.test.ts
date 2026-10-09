import { describe, expect, it } from "vitest";
import { sshTarget } from "../../src/modules/sshargs";

const t = (cmd: string) => sshTarget(cmd.split(" ").filter(Boolean));

describe("ssh arguments for the resource bar", () => {
  it("destination with the options it needs, others dropped", () => {
    expect(t("deploy@198.51.100.11")).toEqual(["deploy@198.51.100.11"]);
    expect(t("-p 2222 -i ~/.ssh/id -J bastion -A -o ServerAliveInterval=30 ops@192.0.2.1"))
      .toEqual(["-p", "2222", "-i", "~/.ssh/id", "-J", "bastion", "ops@192.0.2.1"]);
  });
  it("options after the destination, as OpenSSH reads them", () => {
    expect(t("ops@host.example.com -p 20202")).toEqual(["-p", "20202", "ops@host.example.com"]);
    expect(t("host.example.com -l ops -v")).toEqual(["-l", "ops", "host.example.com"]);
  });
  it("values attached to the option and grouped flags", () => {
    expect(t("ops@host.example.com -p20202")).toEqual(["-p", "20202", "ops@host.example.com"]);
    expect(t("-4vp2222 -lops host.example.com")).toEqual(["-p", "2222", "-l", "ops", "host.example.com"]);
    expect(t("-vi ~/.ssh/id host.example.com")).toEqual(["-i", "~/.ssh/id", "host.example.com"]);
  });
  it("a value is never taken for the destination", () => {
    expect(t("-o ProxyJump=bastion -P tag -L 8080:localhost:80 host.example.com")).toEqual(["host.example.com"]);
  });
  it("a remote command is not an interactive session", () => {
    expect(t("host.example.com uptime")).toBeNull();
    expect(t("host.example.com -p 2222 uptime")).toBeNull();
    expect(t("host.example.com -- -p")).toBeNull();
  });
  it("no destination or a missing value: nothing", () => {
    expect(t("")).toBeNull();
    expect(t("-v")).toBeNull();
    expect(t("host.example.com -p")).toBeNull();
    expect(t("-- host.example.com")).toEqual(["host.example.com"]);
  });
});
