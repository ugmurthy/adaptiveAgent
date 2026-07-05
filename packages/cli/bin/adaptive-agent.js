#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { dirname, join } = require('node:path');

const packageName = resolvePlatformPackageName();
const binaryName = process.platform === 'win32' ? 'adaptive-agent.exe' : 'adaptive-agent';

runBinary(packageName, binaryName);

function resolvePlatformPackageName() {
  const packageName = {
    'darwin-arm64': '__DARWIN_ARM64_PACKAGE_NAME__',
    'darwin-x64': '__DARWIN_X64_PACKAGE_NAME__',
    'linux-arm64': '__LINUX_ARM64_PACKAGE_NAME__',
    'linux-x64': '__LINUX_X64_PACKAGE_NAME__',
    'win32-x64': '__WIN32_X64_PACKAGE_NAME__',
  }[`${process.platform}-${process.arch}`];

  if (!packageName) {
    console.error(`adaptive-agent does not support ${process.platform}-${process.arch}.`);
    process.exit(1);
  }

  return packageName;
}

function runBinary(packageName, binaryName) {
  let packageJsonPath;
  try {
    packageJsonPath = require.resolve(`${packageName}/package.json`);
  } catch {
    console.error(`Missing platform package ${packageName}. Try reinstalling the adaptive-agent npm package.`);
    process.exit(1);
  }

  const binaryPath = join(dirname(packageJsonPath), 'bin', binaryName);
  const result = spawnSync(binaryPath, process.argv.slice(2), { stdio: 'inherit' });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}
