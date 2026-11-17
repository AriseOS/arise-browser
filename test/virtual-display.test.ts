import assert from "node:assert/strict";
import test from "node:test";
import {
  FINGERPRINT_NAME,
  VirtualDisplayManager,
  buildDockerRunArgs,
  imageBuildDir,
  parseFingerprintSeed,
} from "../src/virtual-display/manager.js";

function envOf(args: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  args.forEach((arg, i) => {
    if (arg === "-e") {
      const [key, ...rest] = args[i + 1].split("=");
      env[key] = rest.join("=");
    }
  });
  return env;
}

test("parseFingerprintSeed accepts 1..2147483647 and empty input", () => {
  assert.equal(parseFingerprintSeed(undefined), undefined);
  assert.equal(parseFingerprintSeed(""), undefined);
  assert.equal(parseFingerprintSeed(" 1987654321 "), 1987654321);
  assert.equal(parseFingerprintSeed("1"), 1);
  assert.equal(parseFingerprintSeed("2147483647"), 2147483647);
  for (const bad of ["0", "-5", "12abc", "1.5", "007", "2147483648", "1e3"]) {
    assert.throws(() => parseFingerprintSeed(bad), /invalid fingerprint seed/, bad);
  }
});

test("plain virtual display keeps the Google Chrome image and no fingerprint env", () => {
  const manager = new VirtualDisplayManager({});
  const config = manager.config;
  assert.equal(config.containerName, "arise-neko");
  assert.equal(config.imageName, "arise-neko");
  assert.equal(imageBuildDir(config), "deploy/neko");
  const args = buildDockerRunArgs(config);
  assert.equal(args.at(-1), "arise-neko");
  assert.ok(!Object.keys(envOf(args)).some((k) => k.startsWith("ARISE_FP_")));
});

test("fingerprint mode uses its own image, container, volume and passes the seed", () => {
  const manager = new VirtualDisplayManager({
    fingerprintSeed: 1000,
    fingerprintTimezone: "America/Los_Angeles",
    fingerprintLang: "en-US",
  });
  const config = manager.config;
  assert.equal(config.containerName, FINGERPRINT_NAME);
  assert.equal(config.imageName, FINGERPRINT_NAME);
  assert.equal(imageBuildDir(config), "deploy/neko-fp");

  const args = buildDockerRunArgs(config);
  assert.equal(args.at(-1), FINGERPRINT_NAME);
  assert.ok(args.includes(`${FINGERPRINT_NAME}-profile:/home/neko/.config/arise-chrome`));
  const env = envOf(args);
  assert.equal(env.ARISE_FP_SEED, "1000");
  assert.equal(env.ARISE_FP_TIMEZONE, "America/Los_Angeles");
  assert.equal(env.ARISE_FP_LANG, "en-US");
  // CDP stays on loopback
  assert.ok(args.includes("127.0.0.1:9222:9223"));
});

test("explicit names win over fingerprint defaults; undefined values do not", () => {
  const manager = new VirtualDisplayManager({
    fingerprintSeed: 7,
    containerName: "custom",
    imageName: undefined,
  });
  assert.equal(manager.config.containerName, "custom");
  assert.equal(manager.config.imageName, FINGERPRINT_NAME);
  const env = envOf(buildDockerRunArgs(manager.config));
  assert.equal(env.ARISE_FP_SEED, "7");
  assert.equal(env.ARISE_FP_TIMEZONE, undefined);
});

test("invalid fingerprint options are rejected", () => {
  assert.throws(() => new VirtualDisplayManager({ fingerprintSeed: 0 }), /invalid fingerprint seed/);
  assert.throws(() => new VirtualDisplayManager({ fingerprintSeed: 1.5 }), /invalid fingerprint seed/);
  assert.throws(
    () => new VirtualDisplayManager({ fingerprintSeed: 1, fingerprintTimezone: "UTC; rm -rf /" }),
    /invalid fingerprint timezone/,
  );
  assert.throws(
    () => new VirtualDisplayManager({ fingerprintSeed: 1, fingerprintLang: "en US" }),
    /invalid fingerprint language/,
  );
  assert.throws(
    () => new VirtualDisplayManager({ fingerprintTimezone: "UTC" }),
    /require a fingerprint seed/,
  );
});
