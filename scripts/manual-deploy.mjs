#!/usr/bin/env node
/**
 * 手动部署：把最新的静态文件直接推上服务器，不经过 GitHub Actions。
 *
 * 做的事和 .github/workflows/deploy.yml 里的 "Deploy static files" 步骤完全一致——
 * 脚本直接从 deploy.yml 里抽取，保证两边不会走样。
 *
 * 用法：
 *   node scripts/manual-deploy.mjs                     # 用 build 步骤产出的 site.tar.gz
 *   node scripts/manual-deploy.mjs --build             # 先本地构建再部署
 *
 * 环境变量：
 *   SSH_HOST      服务器地址（默认 47.102.100.110）
 *   SSH_USER      登录用户（默认 admin）
 *   SSH_KEY       私钥路径（默认 ~/.ssh/id_ed25519）
 *   DOMAIN        站点域名（默认 zhiaifree.cn）
 *   OIL_PRICE_FORCE=1  部署前强制重抓一次油价
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yaml = require(
  path.join(
    ROOT,
    "node_modules/.pnpm/js-yaml@4.1.0/node_modules/js-yaml/index.js",
  ),
);

const SSH_HOST = process.env.SSH_HOST || "47.102.100.110";
const SSH_USER = process.env.SSH_USER || "admin";
const SSH_KEY = process.env.SSH_KEY || path.join(homedir(), ".ssh", "id_ed25519");
const DOMAIN = process.env.DOMAIN || "zhiaifree.cn";
const REMOTE_DIR = "~/blog";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw r.error;
  return r;
}

function step(label, fn) {
  process.stdout.write(`\n▶ ${label}\n`);
  const r = fn();
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.error(`✗ ${label} 失败（exit ${r.status}）`);
    process.exit(r.status ?? 1);
  }
  return r;
}

if (process.argv.includes("--build")) {
  step("本地构建", () =>
    run("node", ["node_modules/astro/astro.js", "build"], {
      cwd: ROOT,
      stdio: "inherit",
      timeout: 600000,
    }),
  );
}

// 打包 dist
step("打包 dist", () => {
  const r = run("tar", ["czf", path.join(ROOT, "site.tar.gz"), "-C", path.join(ROOT, "dist"), "."], {
    cwd: ROOT,
  });
  if (r.status !== 0) throw new Error("tar 打包失败");
  const size = readFileSync(path.join(ROOT, "site.tar.gz")).length;
  console.log(`site.tar.gz ${(size / 1024 / 1024).toFixed(2)} MB`);
  return r;
});

// 取出 deploy.yml 里的部署脚本
const doc = yaml.load(
  readFileSync(path.join(ROOT, ".github/workflows/deploy.yml"), "utf8"),
);
const deployStep = doc.jobs.deploy.steps.find(
  (s) => s.name === "Deploy static files",
);
if (!deployStep) throw new Error("deploy.yml 里找不到 Deploy static files 步骤");

const script = `export DOMAIN=${DOMAIN}\n${deployStep.with.script}`;
const sshArgs = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-i", SSH_KEY,
  `${SSH_USER}@${SSH_HOST}`,
];

step("上传 site.tar.gz 到服务器", () => {
  const r = run("scp", [...sshArgs.slice(0, -1), "site.tar.gz", `${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/`], {
    cwd: ROOT,
  });
  if (r.status !== 0) throw new Error("scp 失败");
  return r;
});

step("上传并执行部署脚本", () => {
  const put = run("ssh", [...sshArgs.slice(0, -1), "cat > /tmp/deploy.sh"], {
    input: script,
  });
  if (put.status !== 0) throw new Error("上传脚本失败");
  const r = run("ssh", [...sshArgs.slice(0, -1), "bash /tmp/deploy.sh"], {
    timeout: 600000,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r;
});

step("校验线上版本", () => {
  const r = run(
    "curl",
    ["-sS", "--max-time", "15", `https://${DOMAIN}/`],
    { encoding: "utf8" },
  );
  const ok = r.stdout?.includes("data-oil-price");
  console.log(
    ok
      ? `✓ https://${DOMAIN}/ 已是新版本`
      : `✗ https://${DOMAIN}/ 仍不是新版本`,
  );
  if (!ok) process.exit(1);
  return r;
});

console.log("\n部署完成。");
