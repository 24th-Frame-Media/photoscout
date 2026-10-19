#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

function run(cmd, args, cwd = root) {
  return new Promise((resolve, reject) => {
    console.log(`> ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { cwd, stdio: 'inherit', shell: isWin });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}`));
    });
  });
}

const [action = 'help', target = 'android'] = process.argv.slice(2);

async function main() {
  if (action === 'help' || action === '--help') {
    console.log(`PhotoScout Mobile CLI

Usage:
  node scripts/mobile.mjs build android       Build Android debug & release APKs
  node scripts/mobile.mjs install android     Install debug APK on connected phone/emulator via adb
  node scripts/mobile.mjs build ios           Build iOS unsigned IPA (macOS only)
`);
    return;
  }

  if (target === 'android') {
    const androidDir = path.join(root, 'android');
    const gradlew = isWin ? path.join(androidDir, 'gradlew.bat') : './gradlew';

    if (action === 'build') {
      console.log('Building Android debug APK...');
      await run(gradlew, ['assembleDebug'], androidDir);
      console.log('\nSuccess! APK created at: android/app/build/outputs/apk/debug/app-debug.apk');
    } else if (action === 'install') {
      const apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
      if (!fs.existsSync(apk)) {
        console.log('APK not found. Building first...');
        await run(gradlew, ['assembleDebug'], androidDir);
      }
      console.log('Installing to connected Android device via adb...');
      await run('adb', ['install', '-r', apk]);
      console.log('\nInstalled successfully! Launch PhotoScout on your device.');
    } else {
      console.error(`Unknown action: ${action}`);
      process.exit(1);
    }
  } else if (target === 'ios') {
    if (process.platform !== 'darwin') {
      console.log('Building iOS natively requires macOS and Xcode.');
      console.log('Note: GitHub Actions (.github/workflows/mobile.yml) builds iOS IPAs in the cloud automatically!');
      return;
    }
    const iosDir = path.join(root, 'ios');
    console.log('Building iOS unsigned app...');
    await run('xcodebuild', [
      'clean', 'build',
      '-project', 'PhotoScout.xcodeproj',
      '-scheme', 'PhotoScout',
      '-configuration', 'Release',
      '-destination', 'generic/platform=iOS',
      '-derivedDataPath', 'build',
      'CODE_SIGNING_ALLOWED=NO',
      'CODE_SIGNING_REQUIRED=NO'
    ], iosDir);
    console.log('\nSuccess! iOS build output is in ios/build');
  } else {
    console.error(`Unknown target: ${target}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
