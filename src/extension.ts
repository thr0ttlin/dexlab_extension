import * as vscode from 'vscode';
import * as fs from 'fs';
import { rename } from "fs/promises";
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { spawn } from 'child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_FILE = 'dexlab.config.json';
const DEXS_BUNDLE_VERSION = 100;

const DEFAULT_BAKSMALI_URL =
  'https://github.com/baksmali/smali/releases/download/3.0.9/baksmali-3.0.9-fat-release.jar';

const DEFAULT_DEX2JAR_URL =
  'https://github.com/pxb1988/dex2jar/releases/download/v2.4/dex-tools-v2.4.zip';

// GitHub release API for DexRunner APK
const DEXRUNNER_RELEASE_API =
  'https://api.github.com/repos/thr0ttlin/dexrunner/releases/latest';

// ADB broadcast action constants
const DEXRUNNER_PKG = 'com.thr0ttlin.dexrunner';
const BROADCAST_ACTION_LOAD       = `${DEXRUNNER_PKG}.action.LOAD_BUNDLE`;
const BROADCAST_ACTION_RUN        = `${DEXRUNNER_PKG}.action.RUN_BUNDLE`;
const BROADCAST_ACTION_SET_SECRET = `${DEXRUNNER_PKG}.action.SET_SECRET`;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface ProjectConfig {
  pkg: string;
  sourceRoot: string;
  javaVersion: string;
  androidSdkVersion: string;
  androidSdkRoot: string;
  javaHome: string;
  baksmaliUrl: string;
  dex2jarUrl: string;
  /** Path to APK/APKM/APKS/XAPK used as the compilation target */
  targetApk: string;
  /** Remote path on device where bundles are pushed */
  deployPath: string;
  /** ADB device serial (empty = first connected device) */
  adbSerial: string;
  /** Human-readable name of this POC, used in bundle metadata */
  namePOC: string;
  authorPOC: string;
  /** Entry class for the bundle (e.g. "payload.Payload") */
  entryClass: string;
  /** Entry method for the bundle (e.g. "run") */
  entryMethod: string;
  /** HMAC-SHA256 signing secret for .dexs bundles */
  bundleSecret: string;
}

interface ProjectContext {
  root: string;
  configPath: string;
  config: ProjectConfig;
}

interface DexsBundleMeta {
  version: number;
  namePOC: string;
  authorPOC: string;
  entryFile: string;
  entryPoint: string;
  method: string;
  classes: number;
  dexes: number;
  date: string;
  signature: string; // HMAC-SHA256 hex of the meta fields (excl. signature itself)
}

// ---------------------------------------------------------------------------
// Output channel
// ---------------------------------------------------------------------------

let output: vscode.OutputChannel;

// ---------------------------------------------------------------------------
// Activation / deactivation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('DEXLab');

  context.subscriptions.push(
    output,

    // Palette-visible commands (only these two)
    vscode.commands.registerCommand('dexlab.createTemplate',         createTemplateWorkspace),
    vscode.commands.registerCommand('dexlab.createTemplateByTarget', createTemplateByTargetWorkspace),

    // Context-menu–only commands (registered but not shown in palette via package.json)setSecretCommand
    vscode.commands.registerCommand('dexlab.buildAndRun',        (uri?: vscode.Uri) => buildAndRunCommand(uri)),
    vscode.commands.registerCommand('dexlab.build',              (uri?: vscode.Uri) => buildCommand(uri)),
    vscode.commands.registerCommand('dexlab.clean',              (uri?: vscode.Uri) => cleanCommand(uri)),
    vscode.commands.registerCommand('dexlab.downloadBaksmali',   (uri?: vscode.Uri) => downloadBaksmaliCommand(uri)),
    vscode.commands.registerCommand('dexlab.downloadDex2jar',    (uri?: vscode.Uri) => downloadDex2jarCommand(uri)),
    vscode.commands.registerCommand('dexlab.disassemble',        (uri?: vscode.Uri) => disassembleCommand(uri)),
    vscode.commands.registerCommand('dexlab.prepareTarget',      (uri?: vscode.Uri) => prepareTargetCommand(uri)),
    vscode.commands.registerCommand('dexlab.bundle',             (uri?: vscode.Uri) => bundleCommand(uri)),
    vscode.commands.registerCommand('dexlab.deploy',             (uri?: vscode.Uri) => deployCommand(uri)),
    vscode.commands.registerCommand('dexlab.run',                (uri?: vscode.Uri) => runOnDeviceCommand(uri)),
    vscode.commands.registerCommand('dexlab.setSecret',          (uri?: vscode.Uri) => setSecretCommand(uri)),
    vscode.commands.registerCommand('dexlab.installDexRunner',   (uri?: vscode.Uri) => installDexRunnerCommand(uri)),
  );
}

export function deactivate() {}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function defaultConfig(): ProjectConfig {
  return {
    pkg: 'payload',
    sourceRoot: 'src/java',
    javaVersion: '21',
    androidSdkVersion: '36',
    androidSdkRoot: '',
    javaHome: '',
    baksmaliUrl: DEFAULT_BAKSMALI_URL,
    dex2jarUrl: DEFAULT_DEX2JAR_URL,
    targetApk: '',
    deployPath: '/sdcard/Android/data/com.thr0ttlin.dexrunner/files/DEXLab/',
    adbSerial: '',
    namePOC: 'MyPOC',
    authorPOC: 'thr0ttlin',
    entryClass: 'payload.Payload',
    entryMethod: 'run',
    bundleSecret: generateSecret(),
  };
}

function generateSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

function pickString(raw: any, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = raw?.[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return fallback;
}

function normalizeConfig(raw: any): ProjectConfig {
  const base = defaultConfig();
  return {
    pkg:              pickString(raw, ['pkg'],                                            base.pkg),
    sourceRoot:       pickString(raw, ['sourceRoot', 'source_root', 'src'],               base.sourceRoot),
    javaVersion:      pickString(raw, ['javaVersion', 'java_version'],                    base.javaVersion),
    androidSdkVersion:pickString(raw, ['androidSdkVersion', 'android_sdk_version'],       base.androidSdkVersion),
    androidSdkRoot:   pickString(raw, ['androidSdkRoot', 'android_sdk_root'],             base.androidSdkRoot),
    javaHome:         pickString(raw, ['javaHome', 'java_home'],                          base.javaHome),
    baksmaliUrl:      pickString(raw, ['baksmaliUrl', 'url_baksmali_jar'],                base.baksmaliUrl),
    dex2jarUrl:       pickString(raw, ['dex2jarUrl', 'url_dex2jar'],                      base.dex2jarUrl),
    targetApk:        pickString(raw, ['targetApk', 'target_apk'],                        base.targetApk),
    deployPath:       pickString(raw, ['deployPath', 'deploy_path'],                      base.deployPath),
    adbSerial:        pickString(raw, ['adbSerial', 'adb_serial'],                        base.adbSerial),
    namePOC:          pickString(raw, ['namePOC', 'name_poc'],                            base.namePOC),
    authorPOC:        pickString(raw, ['authorPOC', 'author_poc'],                        base.authorPOC),
    entryClass:       pickString(raw, ['entryClass', 'entry_class'],                      base.entryClass),
    entryMethod:      pickString(raw, ['entryMethod', 'entry_method'],                    base.entryMethod),
    bundleSecret:     pickString(raw, ['bundleSecret', 'bundle_secret'],                  raw?.bundleSecret ?? generateSecret()),
  };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function ensureOutputVisible() { output.show(true); }

function showError(message: string) {
  output.appendLine(`ERROR: ${message}`);
  void vscode.window.showErrorMessage(message);
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function readJsonFile<T = any>(p: string): Promise<T> {
  return JSON.parse(await fsp.readFile(p, 'utf8')) as T;
}

async function writeJsonFile(p: string, value: unknown): Promise<void> {
  await fsp.writeFile(p, JSON.stringify(value, null, 2) + os.EOL, 'utf8');
}

async function collectFilesRecursive(dir: string, extension: string): Promise<string[]> {
  const result: string[] = [];
  if (!(await exists(dir))) return result;

  async function walk(current: string): Promise<void> {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && full.toLowerCase().endsWith(extension.toLowerCase())) {
        result.push(full);
      }
    }
  }

  await walk(dir);
  result.sort();
  return result;
}

// ---------------------------------------------------------------------------
// Project context resolution
// ---------------------------------------------------------------------------

async function findProjectRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    if (await exists(path.join(current, CONFIG_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function resolveProjectContext(uri?: vscode.Uri): Promise<ProjectContext> {
  let startDir: string | undefined;

  if (uri) {
    const stat = await fsp.stat(uri.fsPath).catch(() => null);
    startDir = stat?.isDirectory() ? uri.fsPath : path.dirname(uri.fsPath);
  } else {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('Open a workspace first, or run from the config file context menu.');
    startDir = folder.uri.fsPath;
  }

  const root = await findProjectRoot(startDir);
  if (!root) throw new Error(`Cannot find ${CONFIG_FILE} above: ${startDir}`);

  const configPath = path.join(root, CONFIG_FILE);
  const raw = await readJsonFile(configPath).catch(() => ({}));
  return { root, configPath, config: normalizeConfig(raw) };
}

// ---------------------------------------------------------------------------
// Build directory management
// ---------------------------------------------------------------------------

async function ensureBuildDirs(root: string): Promise<void> {
  await Promise.all([
    fsp.mkdir(path.join(root, 'build', 'classes'),   { recursive: true }),
    fsp.mkdir(path.join(root, 'build', 'dex'),       { recursive: true }),
    fsp.mkdir(path.join(root, 'build'), { recursive: true }),
    fsp.mkdir(path.join(root, 'tools'),     { recursive: true }),
    fsp.mkdir(path.join(root, 'build', 'smali'),     { recursive: true }),
  ]);
}

async function cleanBuild(root: string): Promise<void> {
  await fsp.rm(path.join(root, 'build'), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

function runProcess(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    output.appendLine('');
    output.appendLine(`> ${command} ${args.join(' ')}`);

    const shell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(command);
    const child = spawn(command, args, { cwd, shell, env: process.env });

    child.stdout.on('data', (d) => output.append(d.toString()));
    child.stderr.on('data', (d) => output.append(d.toString()));
    child.on('error',  reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Tool path resolution
// ---------------------------------------------------------------------------

function resolveJavaBin(cfg: ProjectConfig, tool: 'java' | 'javac' | 'jar'): string {
  const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
  return cfg.javaHome.trim() ? path.join(cfg.javaHome.trim(), 'bin', exe) : exe;
}

function resolveAdb(cfg: ProjectConfig): string {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  if (cfg.androidSdkRoot.trim()) {
    return path.join(cfg.androidSdkRoot.trim(), 'platform-tools', exe);
  }
  const envRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  return envRoot ? path.join(envRoot, 'platform-tools', exe) : exe;
}

function adbArgs(cfg: ProjectConfig, ...args: string[]): string[] {
  return cfg.adbSerial.trim() ? ['-s', cfg.adbSerial.trim(), ...args] : [...args];
}

async function resolveSdkRoot(cfg: ProjectConfig): Promise<string> {
  if (cfg.androidSdkRoot.trim()) return cfg.androidSdkRoot.trim();
  const envRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (!envRoot) throw new Error('ANDROID_SDK_ROOT / ANDROID_HOME is not set.');
  return envRoot;
}

async function resolveAndroidJar(cfg: ProjectConfig): Promise<string> {
  const sdkRoot = await resolveSdkRoot(cfg);
  const androidJar = path.join(sdkRoot, 'platforms', `android-${cfg.androidSdkVersion}`, 'android.jar');
  if (!(await exists(androidJar))) throw new Error(`android.jar not found: ${androidJar}`);
  return androidJar;
}

function parseVersionParts(v: string): number[] {
  return v.split(/[._-]/).map(x => parseInt(x, 10)).filter(n => isFinite(n));
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = parseVersionParts(a), pb = parseVersionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

async function resolveLatestBuildToolsVersion(sdkRoot: string): Promise<string> {
  const dir = path.join(sdkRoot, 'build-tools');
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
  const versions = entries.filter(e => e.isDirectory()).map(e => e.name);
  if (!versions.length) throw new Error(`No Android build-tools found in: ${dir}`);
  versions.sort(compareVersionsDesc);
  return versions[0];
}

async function resolveD8(cfg: ProjectConfig): Promise<string> {
  const sdkRoot = await resolveSdkRoot(cfg);
  const version = await resolveLatestBuildToolsVersion(sdkRoot);
  const exe = process.platform === 'win32' ? 'd8.bat' : 'd8';
  const d8 = path.join(sdkRoot, 'build-tools', version, exe);
  if (!(await exists(d8))) throw new Error(`d8 not found: ${d8}`);
  return d8;
}

// ---------------------------------------------------------------------------
// Download helper (with redirect following)
// ---------------------------------------------------------------------------

async function downloadFile(url: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  async function fetchUrl(currentUrl: string, redirects: number): Promise<void> {
    if (redirects > 10) throw new Error('Too many redirects.');
    const lib = currentUrl.startsWith('https:') ? https : http;

    await new Promise<void>((resolve, reject) => {
      const req = lib.get(currentUrl, { headers: { 'User-Agent': 'DEXLab-VSCode' } }, (res) => {
        const code = res.statusCode ?? 0;

        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          resolve(fetchUrl(new URL(res.headers.location, currentUrl).toString(), redirects + 1));
          return;
        }

        if (code >= 400) {
          res.resume();
          reject(new Error(`HTTP ${code} from ${currentUrl}`));
          return;
        }

        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      });
      req.on('error', reject);
    });
  }

  await fetchUrl(url, 0);
}

// ---------------------------------------------------------------------------
// ZIP extraction helper (pure Node, no native deps)
// ---------------------------------------------------------------------------

/**
 * Minimal ZIP reader — extracts only stored/deflated entries matching a predicate.
 * Works for APK / APKM / APKS / XAPK / dex-tools ZIP.
 */
async function extractZip(
  zipPath: string,
  destDir: string,
  filter: (entryName: string) => boolean,
  flattenToDir = false,
): Promise<string[]> {
  const buf = await fsp.readFile(zipPath);
  const written: string[] = [];

  // Locate End-of-Central-Directory record
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error(`Not a valid ZIP: ${zipPath}`);

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdEntries = buf.readUInt16LE(eocdOffset + 10);

  let pos = cdOffset;
  for (let e = 0; e < cdEntries; e++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;

    const compression = buf.readUInt16LE(pos + 10);
    const compSize    = buf.readUInt32LE(pos + 20);
    const uncompSize  = buf.readUInt32LE(pos + 24);
    const nameLen     = buf.readUInt16LE(pos + 28);
    const extraLen    = buf.readUInt16LE(pos + 30);
    const commentLen  = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const entryName   = buf.toString('utf8', pos + 46, pos + 46 + nameLen);

    pos += 46 + nameLen + extraLen + commentLen;

    if (!filter(entryName) || entryName.endsWith('/')) continue;

    // Read local file header to get actual data offset
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const localNameLen  = buf.readUInt16LE(localOffset + 26);
    const dataOffset    = localOffset + 30 + localNameLen + localExtraLen;

    const compressed = buf.slice(dataOffset, dataOffset + compSize);
    let data: Buffer;

    if (compression === 0) {
      data = compressed;
    } else if (compression === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      output.appendLine(`  [skip] unsupported compression ${compression}: ${entryName}`);
      continue;
    }

    if (data.length !== uncompSize) {
      output.appendLine(`  [warn] size mismatch for ${entryName}`);
    }

    const destName = flattenToDir ? path.basename(entryName) : entryName;
    const destPath = path.join(destDir, destName);
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.writeFile(destPath, data);
    written.push(destPath);
  }

  return written;
}

// ---------------------------------------------------------------------------
// Tool download / resolution
// ---------------------------------------------------------------------------

async function downloadBaksmali(root: string, cfg: ProjectConfig): Promise<string> {
  const jar = path.join(root, 'tools', 'baksmali.jar');
  if (!(await exists(jar))) {
    output.appendLine(`Downloading baksmali from: ${cfg.baksmaliUrl}`);
    await downloadFile(cfg.baksmaliUrl, jar);
  }
  return jar;
}

/**
 * Downloads dex-tools ZIP, extracts d2j-dex2jar script and its libs,
 * returns path to the d2j-dex2jar shell/bat script.
 */
async function downloadAndResolveDex2jar(root: string, cfg: ProjectConfig): Promise<string> {
  const toolsDir  = path.join(root, 'tools', 'dex2jar');
  const scriptExt = process.platform === 'win32' ? '.bat' : '.sh';
  const script    = path.join(toolsDir, `d2j-dex2jar${scriptExt}`);

  if (await exists(script)) return script;

  const zipPath = path.join(root, 'tools', 'dex-tools.zip');
  output.appendLine(`Downloading dex2jar from: ${cfg.dex2jarUrl}`);
  await downloadFile(cfg.dex2jarUrl, zipPath);

  output.appendLine('Extracting dex2jar...');
  await fsp.mkdir(toolsDir, { recursive: true });

  // The ZIP contains a top-level folder like "dex-tools-v2.4/" — flatten one level
  const tmpDir = path.join(root, 'tools', 'dex2jar-tmp');
  await fsp.mkdir(tmpDir, { recursive: true });

  await extractZip(zipPath, tmpDir, () => true, false);

  // Find the extracted top-level folder
  const entries = await fsp.readdir(tmpDir, { withFileTypes: true });
  const subDir  = entries.find(e => e.isDirectory());
  if (!subDir) throw new Error('dex2jar ZIP had unexpected structure (no subdirectory).');

  const extracted = path.join(tmpDir, subDir.name);
  // Copy contents to toolsDir
  await copyDirRecursive(extracted, toolsDir);
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.rm(zipPath, { force: true });

  // Make scripts executable on POSIX
  if (process.platform !== 'win32') {
    const scripts = await collectFilesRecursive(toolsDir, '.sh');
    for (const s of scripts) {
      await fsp.chmod(s, 0o755).catch(() => undefined);
    }
  }

  if (!(await exists(script))) throw new Error(`d2j-dex2jar not found after extraction: ${script}`);
  return script;
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath  = path.join(src,  entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Build pipeline
// ---------------------------------------------------------------------------

async function compileJava(root: string, cfg: ProjectConfig): Promise<string> {
  const sourceRoot = path.join(root, cfg.sourceRoot);
  if (!(await exists(sourceRoot))) throw new Error(`Source root not found: ${sourceRoot}`);

  const javaFiles = await collectFilesRecursive(sourceRoot, '.java');
  if (!javaFiles.length) throw new Error(`No .java files found under: ${sourceRoot}`);

  const androidJar    = await resolveAndroidJar(cfg);
  const libsDir       = path.join(root, 'libs');
  const externalJars  = await collectFilesRecursive(libsDir, '.jar');
  const classesDir    = path.join(root, 'build', 'classes');
  const toolsDir      = path.join(root, 'tools');

  await fsp.mkdir(classesDir, { recursive: true });
  await fsp.mkdir(toolsDir,   { recursive: true });

  const sourceListFile = path.join(toolsDir, 'javac-sources.txt');
  await fsp.writeFile(sourceListFile, javaFiles.map(f => `"${f}"`).join(os.EOL), 'utf8');

  const classpath = [androidJar, ...externalJars].join(path.delimiter);
  const javac     = resolveJavaBin(cfg, 'javac');

  await runProcess(javac, [
    '--release', cfg.javaVersion,
    '-encoding', 'UTF-8',
    '-classpath', classpath,
    '-d', classesDir,
    `@${sourceListFile}`,
  ], root);

  return classesDir;
}

async function packageJar(root: string, cfg: ProjectConfig): Promise<string> {
  const classesDir   = path.join(root, 'build', 'classes');
  if (!(await exists(classesDir))) throw new Error('Classes directory does not exist.');

  const artifactsDir = path.join(root, 'build');
  await fsp.mkdir(artifactsDir, { recursive: true });

  const jarPath = path.join(artifactsDir, `${cfg.pkg}.jar`);
  await fsp.rm(jarPath, { force: true }).catch(() => undefined);

  await runProcess(resolveJavaBin(cfg, 'jar'), ['cf', jarPath, '-C', classesDir, '.'], root);
  return jarPath;
}

async function convertJarToDex(root: string, cfg: ProjectConfig, jarPath: string): Promise<string> {
  const d8         = await resolveD8(cfg);
  const androidJar = await resolveAndroidJar(cfg);
  const dexDir     = path.join(root, 'build', 'dex');

  await fsp.rm(dexDir,  { recursive: true, force: true });
  await fsp.mkdir(dexDir, { recursive: true });

  await runProcess(d8, ['--output', dexDir, '--classpath', androidJar, jarPath], root);
  await rename(`${dexDir}/classes.dex`, `${dexDir}/payload.dex`);
  return dexDir;
}

async function buildProject(root: string, cfg: ProjectConfig): Promise<void> {
  output.appendLine(`Building project at: ${root}`);
  await fsp.rm(path.join(root, 'build'), { recursive: true, force: true }).catch(() => undefined);
  await ensureBuildDirs(root);

  await compileJava(root, cfg);
  const jarPath = await packageJar(root, cfg);
  const dexDir  = await convertJarToDex(root, cfg, jarPath);

  output.appendLine(`Jar: ${jarPath}`);
  output.appendLine(`Dex: ${dexDir}`);
}

// ---------------------------------------------------------------------------
// DEX disassembly
// ---------------------------------------------------------------------------

async function disassembleDexFiles(root: string, cfg: ProjectConfig): Promise<void> {
  const baksmaliJar = await downloadBaksmali(root, cfg);
  const androidJar  = await resolveAndroidJar(cfg);
  const java        = resolveJavaBin(cfg, 'java');

  const dexDir   = path.join(root, 'build', 'dex');
  const smaliDir = path.join(root, 'build', 'smali');
  await fsp.rm(smaliDir, { recursive: true, force: true });
  await fsp.mkdir(smaliDir, { recursive: true });

  const dexFiles = await collectFilesRecursive(dexDir, '.dex');
  if (!dexFiles.length) throw new Error(`No .dex files in: ${dexDir}`);

  for (const dexFile of dexFiles) {
    const outDir = path.join(smaliDir, path.basename(dexFile, '.dex'));
    await fsp.mkdir(outDir, { recursive: true });
    await runProcess(java, [
      '-jar', baksmaliJar, 'disassemble',
      dexFile, '--output', outDir, '--classpath', androidJar,
    ], root);
  }
}

// ---------------------------------------------------------------------------
// .dexs bundle packaging
// ---------------------------------------------------------------------------

/**
 * Count total classes across all .dex files by scanning the DEX magic + class_defs_size field.
 * DEX format: magic[8] + checksum[4] + SHA1[20] + file_size[4] + header_size[4] + endian[4]
 *             + link_size[4] + link_off[4] + map_off[4] + string_ids_size[4] + ...
 *             + type_ids_size[4] + ... + class_defs_size at offset 96
 */
async function countClassesInDex(dexFile: string): Promise<number> {
  try {
    const fd  = await fsp.open(dexFile, 'r');
    const buf = Buffer.alloc(4);
    await fd.read(buf, 0, 4, 96); // class_defs_size at offset 96
    await fd.close();
    return buf.readUInt32LE(0);
  } catch {
    return 0;
  }
}

function computeBundleSignature(meta: Omit<DexsBundleMeta, 'signature'>, secret: string): string {
  // Sort keys alphabetically — must match BundleManager.buildSignaturePayload() on Android
  const sorted: any = {};
  for (const k of Object.keys(meta).sort()) sorted[k] = (meta as any)[k];
  const payload = JSON.stringify(sorted);
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Creates a .dexs bundle (ZIP) containing all DEX files from build/dex
 * plus a config.json with metadata and an HMAC-SHA256 signature.
 *
 * Bundle layout:
 *   config.json
 *   payload.dex
 *   classes.dex   <- target
 *   classes2.dex  <- target
 *   ...
 */
async function packDexsBundle(root: string, cfg: ProjectConfig): Promise<string> {
  const dexDir       = path.join(root, 'build', 'dex');
  const targetDexDir = path.join(root, 'libs', 'dex-target');
  const artifactsDir = path.join(root, 'build');
  await fsp.mkdir(artifactsDir, { recursive: true });

  const dexFiles = await collectFilesRecursive(dexDir, '.dex');
  if (!dexFiles.length) throw new Error(`No .dex files to bundle in: ${dexDir}`);

  const targetDexFiles = await collectFilesRecursive(targetDexDir, '.dex');

  let totalClasses = 0;
  for (const dexFile of dexFiles) {
    totalClasses += await countClassesInDex(dexFile);
  }

  if (dexFiles.length > 0) {
    for (const dexFile of targetDexFiles) {
      totalClasses += await countClassesInDex(dexFile);
    }
  }

  const entryFile  = path.basename(dexFiles[0]); // primary dex
  const metaNoSig: Omit<DexsBundleMeta, 'signature'> = {
    version:    DEXS_BUNDLE_VERSION,
    namePOC:    cfg.namePOC,
    authorPOC:  cfg.authorPOC,
    entryFile,
    entryPoint: cfg.entryClass,
    method:     cfg.entryMethod,
    classes:    totalClasses,
    dexes:      dexFiles.length,
    date:       new Date().toISOString(),
  };

  const signature: string = computeBundleSignature(metaNoSig, cfg.bundleSecret);
  const meta: DexsBundleMeta = { ...metaNoSig, signature };

  const bundlePath = path.join(artifactsDir, `${cfg.pkg}.dexs`);
  await writeDexsZip(bundlePath, dexFiles, targetDexFiles, meta);

  output.appendLine(`Bundle: ${bundlePath}`);
  output.appendLine(`  Classes: ${totalClasses}  DEX files: ${dexFiles.length}`);
  output.appendLine(`  Signature: ${signature}`);
  return bundlePath;
}

/**
 * Writes a minimal ZIP containing config.json + all dex files.
 * Uses store (no compression) for DEX to keep it fast and predictable.
 */
async function writeDexsZip(
  dest: string,
  dexFiles: string[],
  targetDexFiles: string[],
  meta: DexsBundleMeta,
): Promise<void> {
  const entries: Array<{ name: string; data: Buffer }> = [];

  // config.json first
  entries.push({
    name: 'config.json',
    data: Buffer.from(JSON.stringify(meta, null, 2), 'utf8'),
  });

  // payload DEX files
  for (const dexFile of dexFiles) {
    entries.push({
      name: path.basename(dexFile),
      data: await fsp.readFile(dexFile),
    });
  }

  // target DEX files
  for (const dexFile of targetDexFiles) {
    entries.push({
      name: path.basename(dexFile),
      data: await fsp.readFile(dexFile),
    });
  }

  const parts: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc       = crc32(entry.data);

    // Local file header
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);  // signature
    localHeader.writeUInt16LE(20, 4);           // version needed
    localHeader.writeUInt16LE(0, 6);            // flags
    localHeader.writeUInt16LE(0, 8);            // compression: stored
    localHeader.writeUInt16LE(0, 10);           // mod time
    localHeader.writeUInt16LE(0, 12);           // mod date
    localHeader.writeUInt32LE(crc, 14);         // CRC-32
    localHeader.writeUInt32LE(entry.data.length, 18); // compressed size
    localHeader.writeUInt32LE(entry.data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26);  // name length
    localHeader.writeUInt16LE(0, 28);                 // extra length
    nameBytes.copy(localHeader, 30);

    // Central directory record
    const cdRecord = Buffer.alloc(46 + nameBytes.length);
    cdRecord.writeUInt32LE(0x02014b50, 0);  // signature
    cdRecord.writeUInt16LE(20, 4);          // version made by
    cdRecord.writeUInt16LE(20, 6);          // version needed
    cdRecord.writeUInt16LE(0, 8);           // flags
    cdRecord.writeUInt16LE(0, 10);          // compression
    cdRecord.writeUInt16LE(0, 12);          // mod time
    cdRecord.writeUInt16LE(0, 14);          // mod date
    cdRecord.writeUInt32LE(crc, 16);        // CRC-32
    cdRecord.writeUInt32LE(entry.data.length, 20); // compressed size
    cdRecord.writeUInt32LE(entry.data.length, 24); // uncompressed size
    cdRecord.writeUInt16LE(nameBytes.length, 28);  // name length
    cdRecord.writeUInt16LE(0, 30);                 // extra length
    cdRecord.writeUInt16LE(0, 32);                 // comment length
    cdRecord.writeUInt16LE(0, 34);                 // disk start
    cdRecord.writeUInt16LE(0, 36);                 // internal attr
    cdRecord.writeUInt32LE(0, 38);                 // external attr
    cdRecord.writeUInt32LE(offset, 42);            // local header offset
    nameBytes.copy(cdRecord, 46);

    parts.push(localHeader, entry.data);
    centralDir.push(cdRecord);
    offset += localHeader.length + entry.data.length;
  }

  const cdBuf     = Buffer.concat(centralDir);
  const eocd      = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                   // disk number
  eocd.writeUInt16LE(0, 6);                   // disk with CD
  eocd.writeUInt16LE(entries.length, 8);      // entries on disk
  eocd.writeUInt16LE(entries.length, 10);     // total entries
  eocd.writeUInt32LE(cdBuf.length, 12);       // CD size
  eocd.writeUInt32LE(offset, 16);             // CD offset
  eocd.writeUInt16LE(0, 20);                  // comment length

  await fsp.writeFile(dest, Buffer.concat([...parts, cdBuf, eocd]));
}

/** Simple CRC-32 implementation (enough for ZIP) */
function crc32(buf: Buffer): number {
  const table = makeCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let _crcTable: Uint32Array | null = null;
function makeCrcTable(): Uint32Array {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    _crcTable[n] = c;
  }
  return _crcTable;
}

// ---------------------------------------------------------------------------
// Prepare target (APK / APKM / APKS / XAPK → target.jar via dex2jar)
// ---------------------------------------------------------------------------

async function prepareTarget(root: string, cfg: ProjectConfig, apkPath: string): Promise<string> {
  output.appendLine(`Preparing target from: ${apkPath}`);

  const tmpDir = path.join(root, 'tools', 'target-tmp');
  await fsp.rm(tmpDir,  { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });

  const ext = path.extname(apkPath).toLowerCase();

  let dexFiles: string[];

  if (['.apkm', '.apks', '.xapk'].includes(ext)) {
    // These are ZIP archives containing multiple APKs; extract inner APKs then their DEX files
    output.appendLine('Extracting split APK package...');
    const apkList = await extractZip(apkPath, tmpDir, n => n.endsWith('.apk'), false);
    output.appendLine(`  Found ${apkList.length} APK(s) in split package.`);

    const dexTmp = path.join(root, 'libs', 'dex-target');
    await fsp.mkdir(dexTmp, { recursive: true });

    for (const apk of apkList) {
      await extractZip(apk, dexTmp, n => n.endsWith('.dex'), true);
    }
    dexFiles = await collectFilesRecursive(dexTmp, '.dex');
  } else {
    // Plain APK
    output.appendLine('Extracting DEX files from APK...');
    const dexTmp = path.join(root, 'libs', 'dex-target');
    await fsp.mkdir(dexTmp, { recursive: true });
    await extractZip(apkPath, dexTmp, n => n.endsWith('.dex'), true);
    dexFiles = await collectFilesRecursive(dexTmp, '.dex');
  }

  if (!dexFiles.length) throw new Error('No .dex files found in the provided package.');
  output.appendLine(`Found ${dexFiles.length} DEX file(s). Converting to JAR via dex2jar...`);

  const dex2jarScript = await downloadAndResolveDex2jar(root, cfg);
  const libsDir       = path.join(root, 'libs');
  await fsp.mkdir(libsDir, { recursive: true });

  const targetJar = path.join(libsDir, 'target.jar');
  await fsp.rm(targetJar, { force: true }).catch(() => undefined);

  // dex2jar accepts multiple dex files; merge them into a single output jar
  if (dexFiles.length === 1) {
    await runProcess(dex2jarScript, [dexFiles[0], '-o', targetJar, '--force'], root);
  } else {
    // Convert each DEX separately then merge via `jar`
    const partJars: string[] = [];
    for (let i = 0; i < dexFiles.length; i++) {
      const partJar = path.join(tmpDir, `part_${i}.jar`);
      await runProcess(dex2jarScript, [dexFiles[i], '-o', partJar, '--force'], root);
      if (await exists(partJar)) partJars.push(partJar);
    }

    if (!partJars.length) throw new Error('dex2jar produced no output.');

    if (partJars.length === 1) {
      await fsp.copyFile(partJars[0], targetJar);
    } else {
      // Merge: extract all part jars into a staging dir, then repack
      const mergeDir = path.join(tmpDir, 'merge');
      await fsp.mkdir(mergeDir, { recursive: true });

      for (const partJar of partJars) {
        await extractZip(partJar, mergeDir, n => !n.startsWith('META-INF/'), false);
      }

      const jar = resolveJavaBin(cfg, 'jar');
      await runProcess(jar, ['cf', targetJar, '-C', mergeDir, '.'], root);
    }
  }

  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);

  output.appendLine(`target.jar written to: ${targetJar}`);
  return targetJar;
}

// ---------------------------------------------------------------------------
// ADB helpers
// ---------------------------------------------------------------------------

async function adbPush(root: string, cfg: ProjectConfig, localPath: string): Promise<void> {
  const adb        = resolveAdb(cfg);
  const remotePath = cfg.deployPath.trim() || '/sdcard/Android/data/com.thr0ttlin.dexrunner/files/DEXLab/';

  // Ensure remote directory exists
  await runProcess(adb, adbArgs(cfg, 'shell', 'mkdir', '-p', remotePath), root);
  await runProcess(adb, adbArgs(cfg, 'push', localPath, remotePath), root);
  output.appendLine(`Pushed to device: ${remotePath}${path.basename(localPath)}`);
}

async function adbBroadcast(
  root: string,
  cfg: ProjectConfig,
  action: string,
  extras: Record<string, string>,
): Promise<void> {
  const adb  = resolveAdb(cfg);
  const args: string[] = ['shell', 'am', 'broadcast', '-a', action, '-n',
    `${DEXRUNNER_PKG}/.DEXLabReceiver`];

  for (const [key, value] of Object.entries(extras)) {
    args.push('--es', key, value);
  }

  await runProcess(adb, adbArgs(cfg, ...args), root);
}

// ---------------------------------------------------------------------------
// GitHub release helper: find latest DexRunner APK download URL
// ---------------------------------------------------------------------------

async function fetchLatestDexRunnerApkUrl(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      DEXRUNNER_RELEASE_API,
      { headers: { 'User-Agent': 'DEXLab-VSCode', 'Accept': 'application/vnd.github+json' } },
      (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            const asset = (json.assets as any[]).find((a: any) =>
              typeof a.name === 'string' && a.name.endsWith('.apk'));
            if (!asset) {
              reject(new Error('No APK asset found in the latest DexRunner release.'));
            } else {
              resolve(asset.browser_download_url as string);
            }
          } catch (e) {
            reject(new Error(`Failed to parse GitHub API response: ${e}`));
          }
        });
      },
    );
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// High-level command implementations
// ---------------------------------------------------------------------------

async function buildCommand(uri?: vscode.Uri) {
  try {
    ensureOutputVisible();
    const ctx = await resolveProjectContext(uri);
    await buildProject(ctx.root, ctx.config);
    vscode.window.showInformationMessage('DEXLab: build finished successfully.');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function cleanCommand(uri?: vscode.Uri) {
  try {
    ensureOutputVisible();
    const ctx = await resolveProjectContext(uri);
    await cleanBuild(ctx.root);
    vscode.window.showInformationMessage('DEXLab: build directory cleaned.');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function downloadBaksmaliCommand(uri?: vscode.Uri) {
  try {
    ensureOutputVisible();
    const ctx = await resolveProjectContext(uri);
    await fsp.mkdir(path.join(ctx.root, 'tools'), { recursive: true });
    const jar = await downloadBaksmali(ctx.root, ctx.config);
    output.appendLine(`baksmali: ${jar}`);
    vscode.window.showInformationMessage('DEXLab: baksmali downloaded.');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function downloadDex2jarCommand(uri?: vscode.Uri) {
  try {
    ensureOutputVisible();
    const ctx    = await resolveProjectContext(uri);
    await fsp.mkdir(path.join(ctx.root, 'tools'), { recursive: true });
    const script = await downloadAndResolveDex2jar(ctx.root, ctx.config);
    output.appendLine(`dex2jar: ${script}`);
    vscode.window.showInformationMessage('DEXLab: dex2jar downloaded.');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function disassembleCommand(uri?: vscode.Uri) {
  try {
    ensureOutputVisible();
    const ctx = await resolveProjectContext(uri);
    await disassembleDexFiles(ctx.root, ctx.config);
    vscode.window.showInformationMessage('DEXLab: dex disassembly finished.');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function prepareTargetCommand(uri?: vscode.Uri) {
  try {
    ensureOutputVisible();
    const ctx = await resolveProjectContext(uri);

    let apkPath = ctx.config.targetApk.trim();

    if (!apkPath) {
      const chosen = await vscode.window.showOpenDialog({
        canSelectFolders: false,
        canSelectFiles:   true,
        canSelectMany:    false,
        filters:          { 'APK packages': ['apk', 'apkm', 'apks', 'xapk'] },
        openLabel:        'Select target APK / APKM / APKS / XAPK',
      });
      if (!chosen || !chosen.length) return;
      apkPath = chosen[0].fsPath;
    }

    if (!(await exists(apkPath))) throw new Error(`Target package not found: ${apkPath}`);

    await fsp.mkdir(path.join(ctx.root, 'tools'), { recursive: true });
    await prepareTarget(ctx.root, ctx.config, apkPath);
    vscode.window.showInformationMessage('DEXLab: target.jar ready in libs/.');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function bundleCommand(uri?: vscode.Uri) {
  try {
    ensureOutputVisible();
    const ctx        = await resolveProjectContext(uri);
    const bundlePath = await packDexsBundle(ctx.root, ctx.config);
    vscode.window.showInformationMessage(`DEXLab: bundle created → ${path.basename(bundlePath)}`);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function deployCommand(uri?: vscode.Uri) {
  try {
    ensureOutputVisible();
    const ctx        = await resolveProjectContext(uri);
    const bundlePath = path.join(ctx.root, 'build', `${ctx.config.pkg}.dexs`);

    if (!(await exists(bundlePath))) {
      throw new Error(`Bundle not found: ${bundlePath}. Run "DEXLab: Bundle" first.`);
    }

    await adbPush(ctx.root, ctx.config, bundlePath);

    // Broadcast LOAD_BUNDLE so DexRunner knows a new bundle was pushed
    const remotePath = (ctx.config.deployPath.trim() || '/sdcard/Android/data/com.thr0ttlin.dexrunner/files/DEXLab/') +
      path.basename(bundlePath);
    await adbBroadcast(ctx.root, ctx.config, BROADCAST_ACTION_LOAD, {
      bundle_path: remotePath,
      signature:   await readBundleSignature(bundlePath),
    });

    vscode.window.showInformationMessage('DEXLab: bundle deployed to device.');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function runOnDeviceCommand(uri?: vscode.Uri) {
  try {
    ensureOutputVisible();
    const ctx        = await resolveProjectContext(uri);
    const bundlePath = path.join(ctx.root, 'build', `${ctx.config.pkg}.dexs`);
    const remotePath = (ctx.config.deployPath.trim() || '/sdcard/Android/data/com.thr0ttlin.dexrunner/files/DEXLab/') +
      path.basename(bundlePath);

    await adbBroadcast(ctx.root, ctx.config, BROADCAST_ACTION_RUN, {
      bundle_path:  remotePath,
      entry_class:  ctx.config.entryClass,
      entry_method: ctx.config.entryMethod,
      signature:    await readBundleSignature(bundlePath).catch(() => ''),
    });

    vscode.window.showInformationMessage('DEXLab: run broadcast sent.');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function buildAndRunCommand(uri?: vscode.Uri) {
  try{
    ensureOutputVisible();
    const ctx = await resolveProjectContext(uri);
    await buildProject(ctx.root, ctx.config);
    const bundlePath = await packDexsBundle(ctx.root, ctx.config);

    vscode.window.showInformationMessage(`DEXLab: bundle created -> ${path.basename(bundlePath)}`);

    if (!(await exists(bundlePath))) {
      throw new Error(`Bundle not found: ${bundlePath}. Run "DEXLab: Bundle" first.`);
    }

    await adbPush(ctx.root, ctx.config, bundlePath);

    // Broadcast LOAD_BUNDLE so DexRunner knows a new bundle was pushed
    const remotePath = (ctx.config.deployPath.trim() || '/sdcard/Android/data/com.thr0ttlin.dexrunner/files/DEXLab/') +
      path.basename(bundlePath);
    await adbBroadcast(ctx.root, ctx.config, BROADCAST_ACTION_LOAD, {
      bundle_path: remotePath,
      signature:   await readBundleSignature(bundlePath),
    });
    vscode.window.showInformationMessage('DEXLab: bundle deployed to device.');

    await adbBroadcast(ctx.root, ctx.config, BROADCAST_ACTION_RUN, {
      bundle_path:  remotePath,
      entry_class:  ctx.config.entryClass,
      entry_method: ctx.config.entryMethod,
      signature:    await readBundleSignature(bundlePath).catch(() => ''),
    });
    vscode.window.showInformationMessage('DEXLab: run broadcast sent.');

  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function readBundleSignature(bundlePath: string): Promise<string> {
  try {
    const buf = await fsp.readFile(bundlePath);
    // Extract config.json from bundle (we know it's the first entry, stored, no compression)
    // Quick path: find "signature" field in the raw bytes
    const text = buf.toString('utf8', 0, Math.min(buf.length, 8192));
    const match = text.match(/"signature"\s*:\s*"([0-9a-f]{64})"/);
    return match?.[1] ?? '';
  } catch {
    return '';
  }
}

async function setSecretCommand(uri?: vscode.Uri) {
  try{
    const ctx = await resolveProjectContext(uri);
    await adbBroadcast(ctx.root, ctx.config, BROADCAST_ACTION_SET_SECRET, {
      secret: ctx.config.bundleSecret,
    });

    vscode.window.showInformationMessage('DEXLab: secret has been sent to DexRunner.');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function installDexRunnerCommand(uri?: vscode.Uri) {
  try {
    ensureOutputVisible();
    const ctx = await resolveProjectContext(uri);

    output.appendLine('Fetching latest DexRunner release from GitHub...');
    const apkUrl = await fetchLatestDexRunnerApkUrl();
    output.appendLine(`Download URL: ${apkUrl}`);

    const tmpApk = path.join(ctx.root, 'tools', 'dexrunner-latest.apk');
    await fsp.mkdir(path.dirname(tmpApk), { recursive: true });
    await downloadFile(apkUrl, tmpApk);
    output.appendLine(`Downloaded: ${tmpApk}`);

    const adb = resolveAdb(ctx.config);

    // -r = reinstall keeping data, -d = allow version downgrade
    output.appendLine('Installing DexRunner on device...');
    await runProcess(adb, adbArgs(ctx.config, 'install', '-r', '-d', tmpApk), ctx.root);

    await adbBroadcast(ctx.root, ctx.config, BROADCAST_ACTION_SET_SECRET, {
      secret: ctx.config.bundleSecret,
    });

    await fsp.rm(tmpApk, { force: true }).catch(() => undefined);
    vscode.window.showInformationMessage('DEXLab: DexRunner installed/updated on device.');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Template workspace creation
// ---------------------------------------------------------------------------

async function createTemplateWorkspace() {
  await createTemplate(null);
}

async function createTemplateByTargetWorkspace() {
  // Ask for target APK first so we can populate targetApk in config
  const chosen = await vscode.window.showOpenDialog({
    canSelectFolders: false,
    canSelectFiles:   true,
    canSelectMany:    false,
    filters:          { 'APK packages': ['apk', 'apkm', 'apks', 'xapk'] },
    openLabel:        'Select target APK / APKM / APKS / XAPK',
  });

  if (!chosen || !chosen.length) return;
  await createTemplate(chosen[0].fsPath);
}

async function createTemplate(targetApkPath: string | null) {
  try {
    const folderName = await vscode.window.showInputBox({
      title:          'DEXLab: Create template workspace',
      prompt:         'Workspace folder name',
      value:          'DEXLabTemplate',
      ignoreFocusOut: true,
    });
    if (!folderName) return;

    const parent = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles:   false,
      canSelectMany:    false,
      openLabel:        'Choose parent folder',
    });
    if (!parent || !parent.length) return;

    const root = path.join(parent[0].fsPath, folderName);
    if (await exists(root)) throw new Error(`Folder already exists: ${root}`);

    await Promise.all([
      fsp.mkdir(path.join(root, 'src', 'java', 'payload'), { recursive: true }),
      fsp.mkdir(path.join(root, 'libs'),                   { recursive: true }),
      fsp.mkdir(path.join(root, '.vscode'),                { recursive: true }),
      fsp.mkdir(path.join(root, 'tools'),         { recursive: true }),
    ]);

    const bundleSecret = generateSecret();

    const config: ProjectConfig = {
      pkg:              'payload',
      sourceRoot:       'src/java',
      javaVersion:      '21',
      androidSdkVersion:'36',
      androidSdkRoot:   '',
      javaHome:         '',
      baksmaliUrl:      DEFAULT_BAKSMALI_URL,
      dex2jarUrl:       DEFAULT_DEX2JAR_URL,
      targetApk:        targetApkPath ?? '',
      deployPath:       '/data/local/tmp/DEXLab/',
      adbSerial:        '',
      namePOC:          folderName,
      authorPOC:        'thr0ttlin',
      entryClass:       'payload.Payload',
      entryMethod:      'run',
      bundleSecret,
    };

    const payloadJava = `package payload;

import android.content.Context;
import android.widget.Toast;

public class Payload {
    /**
     * Entrypoint for your DEX payload.
     * @param ctx Android Context
     */
    public static void run(Context ctx) {
        Toast.makeText(ctx, "Hello From Dex", Toast.LENGTH_LONG).show();

        /**
         * All output from System.out / System.err is captured by DexRunner's
         * Once the payload has executed, open the View Log (in DexRunner) and you will see the entries highlighted in purple.
        */
        System.out.println("Info From Dex");
        System.err.println("Error From Dex");
    }
}
`;

    const gitignore = `build/
*.dex
*.class
*.jar
*.dexs
.DS_Store
Thumbs.db
`;

    const sdkJar = '${ANDROID_SDK_ROOT}/platforms/android-36/android.jar';
    const settings = JSON.stringify({
      'java.project.referencedLibraries': [
        sdkJar,
        '${workspaceFolder}/libs/*.jar',
      ],
    }, null, 4);

    const readme = [
      `# ${folderName}`,
      '',
      'DEXLab workspace for building and deploying Android DEX payloads.',
      '',
      '## Structure',
      '- `dexlab.config.json` — project configuration',
      '- `src/java/payload/Payload.java` — entry point',
      '- `libs/` — optional dependencies (target.jar goes here)',
      '- `build/payload.dexs` — packaged bundle',
      '',
      '## Context menu commands on `dexlab.config.json` (submenu DEXLab)',
      '| Command | Action |',
      '|---------|--------|',
      '| Build and Run on Device | Build a signed `.dexs` bundle and run on device |',
      '| Build | Compile Java → JAR → DEX |',
      '| Bundle | Pack DEX files into `.dexs` bundle |',
      '| Disassemble | Baksmali decompile build/dex |',
      '| Prepare Target | Convert APK to target.jar |',
      '| Deploy | ADB push + LOAD broadcast |',
      '| Run on Device | ADB RUN broadcast |',
      '| Set Secret | Send Sign-Secret to DexRunner |',
      '| Install DexRunner | Download + install latest DexRunner APK |',
      '| Download baksmali | Fetch baksmali JAR |',
      '| Download dex2jar | Fetch dex2jar tools |',
      '| Clean | Remove build/ directory |',
      '',
      '## .dexs bundle format',
      'ZIP archive with `.dexs` extension containing:',
      '- `config.json` - metadata + HMAC-SHA256 signature',
      '- `payload.dex` - compiled DEX file',
      '- `classes.dex`, `classes2.dex`, … - target DEX files',
      '',
      '## Signature verification',
      `The bundle is signed with HMAC-SHA256. Secret is stored in \`bundleSecret\` in ${CONFIG_FILE}.`,
      '',
    ].join('\n');

    await writeJsonFile(path.join(root, CONFIG_FILE), config);
    await fsp.writeFile(path.join(root, '.vscode', 'settings.json'), settings, 'utf8');
    await fsp.writeFile(path.join(root, 'src', 'java', 'payload', 'Payload.java'), payloadJava, 'utf8');
    await fsp.writeFile(path.join(root, '.gitignore'), gitignore, 'utf8');
    await fsp.writeFile(path.join(root, 'README.md'), readme, 'utf8');

    // If a target APK was provided, prepare it immediately
    if (targetApkPath) {
      ensureOutputVisible();
      output.appendLine('Preparing target JAR from provided APK...');
      try {
        await prepareTarget(root, config, targetApkPath);
        vscode.window.showInformationMessage('DEXLab: target.jar ready in libs/.');
      } catch (err) {
        showError(`Workspace created but target preparation failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    const openNow = await vscode.window.showQuickPick(['Open now', 'Later'], {
      title:          'DEXLab: Open the new workspace?',
      ignoreFocusOut: true,
    });

    if (openNow === 'Open now') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), false);
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}
