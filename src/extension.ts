import * as vscode from 'vscode';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { spawn } from 'child_process';

const CONFIG_FILE = 'dexlab.config.json';
const DEFAULT_BAKSMALI_URL = 'https://github.com/baksmali/smali/releases/download/3.0.9/baksmali-3.0.9-fat-release.jar';

interface ProjectConfig {
  pkg: string;
  sourceRoot: string;
  javaVersion: string;
  androidSdkVersion: string;
  androidSdkRoot: string;
  javaHome: string;
  baksmaliUrl: string;
}

interface ProjectContext {
  root: string;
  configPath: string;
  config: ProjectConfig;
}

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('DEXLab');

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('dexlab.createTemplate', createTemplateWorkspace),
    vscode.commands.registerCommand('dexlab.build', (uri?: vscode.Uri) => buildCommand(uri)),
    vscode.commands.registerCommand('dexlab.clean', (uri?: vscode.Uri) => cleanCommand(uri)),
    vscode.commands.registerCommand('dexlab.downloadBaksmali', (uri?: vscode.Uri) => downloadBaksmaliCommand(uri)),
    vscode.commands.registerCommand('dexlab.disassemble', (uri?: vscode.Uri) => disassembleCommand(uri))
  );
}

export function deactivate() {}

function defaultConfig(): ProjectConfig {
  return {
    pkg: 'payload',
    sourceRoot: 'src/java',
    javaVersion: '21',
    androidSdkVersion: '36',
    androidSdkRoot: '',
    javaHome: '',
    baksmaliUrl: DEFAULT_BAKSMALI_URL,
  };
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
    pkg: pickString(raw, ['pkg'], base.pkg),
    sourceRoot: pickString(raw, ['sourceRoot', 'source_root', 'src', 'src_linux', 'src_win'], base.sourceRoot),
    javaVersion: pickString(raw, ['javaVersion', 'java_version'], base.javaVersion),
    androidSdkVersion: pickString(raw, ['androidSdkVersion', 'android_sdk_version'], base.androidSdkVersion),
    androidSdkRoot: pickString(raw, ['androidSdkRoot', 'android_sdk_root'], base.androidSdkRoot),
    javaHome: pickString(raw, ['javaHome', 'java_home'], base.javaHome),
    baksmaliUrl: pickString(raw, ['baksmaliUrl', 'url_baksmali_jar'], base.baksmaliUrl),
  };
}

function ensureOutputVisible() {
  output.show(true);
}

function showError(message: string) {
  output.appendLine(`ERROR: ${message}`);
  void vscode.window.showErrorMessage(message);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T = any>(p: string): Promise<T> {
  const raw = await fsp.readFile(p, 'utf8');
  return JSON.parse(raw) as T;
}

async function writeJsonFile(p: string, value: unknown): Promise<void> {
  await fsp.writeFile(p, JSON.stringify(value, null, 2) + os.EOL, 'utf8');
}

async function findProjectRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, CONFIG_FILE);
    if (await exists(candidate)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
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
    if (!folder) {
      throw new Error('Open a workspace first, or run the command from the config file context menu.');
    }
    startDir = folder.uri.fsPath;
  }

  const root = await findProjectRoot(startDir);
  if (!root) {
    throw new Error(`Cannot find ${CONFIG_FILE} above: ${startDir}`);
  }

  const configPath = path.join(root, CONFIG_FILE);
  const raw = await readJsonFile(configPath).catch(() => ({}));
  const config = normalizeConfig(raw);

  return { root, configPath, config };
}

async function ensureBuildDirs(root: string): Promise<void> {
  await Promise.all([
    fsp.mkdir(path.join(root, 'build'), { recursive: true }),
    fsp.mkdir(path.join(root, 'build', 'classes'), { recursive: true }),
    fsp.mkdir(path.join(root, 'build', 'dex'), { recursive: true }),
    fsp.mkdir(path.join(root, 'build', 'artifacts'), { recursive: true }),
    fsp.mkdir(path.join(root, 'build', 'tools'), { recursive: true }),
    fsp.mkdir(path.join(root, 'build', 'smali'), { recursive: true }),
  ]);
}

async function cleanBuild(root: string): Promise<void> {
  await fsp.rm(path.join(root, 'build'), { recursive: true, force: true });
}

async function collectFilesRecursive(dir: string, extension: string): Promise<string[]> {
  const result: string[] = [];
  if (!(await exists(dir))) {
    return result;
  }

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

function quoteArgFilePath(p: string): string {
  return `"${p}"`;
}

function runProcess(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    output.appendLine('');
    output.appendLine(`> ${command} ${args.join(' ')}`);

    const shell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(command);
    const child = spawn(command, args, {
      cwd,
      shell,
      env: process.env,
    });

    child.stdout.on('data', (d) => output.append(d.toString()));
    child.stderr.on('data', (d) => output.append(d.toString()));

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

function resolveJavaBin(cfg: ProjectConfig, tool: 'java' | 'javac' | 'jar'): string {
  const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
  if (cfg.javaHome.trim()) {
    return path.join(cfg.javaHome.trim(), 'bin', exe);
  }
  return exe;
}

function parseVersionParts(v: string): number[] {
  return v.split(/[._-]/).map((x) => Number.parseInt(x, 10)).filter((n) => Number.isFinite(n));
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) {
      return bv - av;
    }
  }

  return b.localeCompare(a);
}

async function resolveSdkRoot(cfg: ProjectConfig): Promise<string> {
  if (cfg.androidSdkRoot.trim()) {
    return cfg.androidSdkRoot.trim();
  }

  const envRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (!envRoot) {
    throw new Error('ANDROID_SDK_ROOT / ANDROID_HOME is not set, and androidSdkRoot is empty in dexlab.config.json.');
  }

  return envRoot;
}

async function resolveAndroidJar(cfg: ProjectConfig): Promise<string> {
  const sdkRoot = await resolveSdkRoot(cfg);
  const androidJar = path.join(sdkRoot, 'platforms', `android-${cfg.androidSdkVersion}`, 'android.jar');
  if (!(await exists(androidJar))) {
    throw new Error(`android.jar not found: ${androidJar}`);
  }
  return androidJar;
}

async function resolveLatestBuildToolsVersion(sdkRoot: string): Promise<string> {
  const buildToolsDir = path.join(sdkRoot, 'build-tools');
  const entries = await fsp.readdir(buildToolsDir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
  const versions = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (versions.length === 0) {
    throw new Error(`No Android build-tools found in: ${buildToolsDir}`);
  }
  versions.sort(compareVersionsDesc);
  return versions[0];
}

async function resolveD8(cfg: ProjectConfig): Promise<string> {
  const sdkRoot = await resolveSdkRoot(cfg);
  const version = await resolveLatestBuildToolsVersion(sdkRoot);
  const exe = process.platform === 'win32' ? 'd8.bat' : 'd8';
  const d8 = path.join(sdkRoot, 'build-tools', version, exe);
  if (!(await exists(d8))) {
    throw new Error(`d8 not found: ${d8}`);
  }
  return d8;
}

async function compileJava(root: string, cfg: ProjectConfig): Promise<string> {
  const sourceRoot = path.join(root, cfg.sourceRoot);
  if (!(await exists(sourceRoot))) {
    throw new Error(`Source root not found: ${sourceRoot}`);
  }

  const javaFiles = await collectFilesRecursive(sourceRoot, '.java');
  if (javaFiles.length === 0) {
    throw new Error(`No Java files found under: ${sourceRoot}`);
  }

  const androidJar = await resolveAndroidJar(cfg);
  const libsDir = path.join(root, 'libs');
  const externalJars = await collectFilesRecursive(libsDir, '.jar');

  const classesDir = path.join(root, 'build', 'classes');
  const toolsDir = path.join(root, 'build', 'tools');
  await fsp.mkdir(classesDir, { recursive: true });
  await fsp.mkdir(toolsDir, { recursive: true });

  const sourceListFile = path.join(toolsDir, 'javac-sources.txt');
  const sourceList = javaFiles.map(quoteArgFilePath).join(os.EOL);
  await fsp.writeFile(sourceListFile, sourceList, 'utf8');

  const classpath = [androidJar, ...externalJars].join(path.delimiter);
  const javac = resolveJavaBin(cfg, 'javac');

  await runProcess(
    javac,
    [
      '--release', cfg.javaVersion,
      '-encoding', 'UTF-8',
      '-classpath', classpath,
      '-d', classesDir,
      `@${sourceListFile}`,
    ],
    root,
  );

  return classesDir;
}

async function packageJar(root: string, cfg: ProjectConfig): Promise<string> {
  const classesDir = path.join(root, 'build', 'classes');
  if (!(await exists(classesDir))) {
    throw new Error('Classes directory does not exist yet.');
  }

  const artifactsDir = path.join(root, 'build', 'artifacts');
  await fsp.mkdir(artifactsDir, { recursive: true });

  const jarPath = path.join(artifactsDir, `${cfg.pkg}.jar`);
  await fsp.rm(jarPath, { force: true }).catch(() => undefined);

  const jar = resolveJavaBin(cfg, 'jar');
  await runProcess(jar, ['cf', jarPath, '-C', classesDir, '.'], root);

  return jarPath;
}

async function convertJarToDex(root: string, cfg: ProjectConfig, jarPath: string): Promise<string> {
  const d8 = await resolveD8(cfg);
  const androidJar = await resolveAndroidJar(cfg);

  const dexDir = path.join(root, 'build', 'dex');
  await fsp.rm(dexDir, { recursive: true, force: true });
  await fsp.mkdir(dexDir, { recursive: true });

  await runProcess(
    d8,
    ['--output', dexDir, '--classpath', androidJar, jarPath],
    root,
  );

  return dexDir;
}

async function buildProject(root: string, cfg: ProjectConfig): Promise<void> {
  output.appendLine(`Building project at: ${root}`);
  await fsp.rm(path.join(root, 'build'), { recursive: true, force: true }).catch(() => undefined);
  await ensureBuildDirs(root);

  await compileJava(root, cfg);
  const jarPath = await packageJar(root, cfg);
  const dexDir = await convertJarToDex(root, cfg, jarPath);

  output.appendLine(`Jar: ${jarPath}`);
  output.appendLine(`Dex: ${dexDir}`);
}

async function downloadFile(url: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  async function fetchUrl(currentUrl: string, redirects: number): Promise<void> {
    if (redirects > 5) {
      throw new Error('Too many redirects while downloading baksmali.');
    }

    const lib = currentUrl.startsWith('https:') ? https : http;

    await new Promise<void>((resolve, reject) => {
      const req = lib.get(currentUrl, (res) => {
        const code = res.statusCode ?? 0;

        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          res.resume();
          resolve(fetchUrl(nextUrl, redirects + 1));
          return;
        }

        if (code >= 400) {
          res.resume();
          reject(new Error(`Download failed with HTTP ${code}`));
          return;
        }

        const file = fs.createWriteStream(dest);
        res.pipe(file);

        file.on('finish', () => {
          file.close(() => resolve());
        });

        file.on('error', reject);
      });

      req.on('error', reject);
    });
  }

  await fetchUrl(url, 0);
}

async function downloadBaksmali(root: string, cfg: ProjectConfig): Promise<string> {
  const baksmaliJar = path.join(root, 'build', 'tools', 'baksmali.jar');
  if (await exists(baksmaliJar)) {
    return baksmaliJar;
  }

  await downloadFile(cfg.baksmaliUrl, baksmaliJar);
  return baksmaliJar;
}

async function disassembleDexFiles(root: string, cfg: ProjectConfig): Promise<void> {
  const baksmaliJar = await downloadBaksmali(root, cfg);
  const androidJar = await resolveAndroidJar(cfg);
  const java = resolveJavaBin(cfg, 'java');

  const dexDir = path.join(root, 'build', 'dex');
  const smaliDir = path.join(root, 'build', 'smali');
  await fsp.rm(smaliDir, { recursive: true, force: true });
  await fsp.mkdir(smaliDir, { recursive: true });

  const dexFiles = await collectFilesRecursive(dexDir, '.dex');
  if (dexFiles.length === 0) {
    throw new Error(`No dex files found in: ${dexDir}`);
  }

  for (const dexFile of dexFiles) {
    const outDir = path.join(smaliDir, path.basename(dexFile, '.dex'));
    await fsp.rm(outDir, { recursive: true, force: true });
    await fsp.mkdir(outDir, { recursive: true });

    await runProcess(
      java,
      ['-jar', baksmaliJar, 'disassemble', dexFile, '--output', outDir, '--classpath', androidJar],
      root,
    );
  }
}

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
    const pathToJar = await downloadBaksmali(ctx.root, ctx.config);
    output.appendLine(`baksmali: ${pathToJar}`);
    vscode.window.showInformationMessage('DEXLab: baksmali downloaded.');
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

async function createTemplateWorkspace() {
  try {
    const folderName = await vscode.window.showInputBox({
      title: 'DEXLab: Create template workspace',
      prompt: 'Workspace folder name',
      value: 'DEXLabTemplate',
      ignoreFocusOut: true,
    });

    if (!folderName) {
      return;
    }

    const parent = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Choose parent folder',
    });

    if (!parent || parent.length === 0) {
      return;
    }

    const root = path.join(parent[0].fsPath, folderName);
    if (await exists(root)) {
      throw new Error(`Folder already exists: ${root}`);
    }

    await Promise.all([
      fsp.mkdir(path.join(root, 'src', 'java', 'payload'), { recursive: true }),
      fsp.mkdir(path.join(root, 'libs'), { recursive: true }),
      fsp.mkdir(path.join(root, '.vscode'), { recursive: true }),
    ]);

    const config = {
      pkg: 'payload',
      sourceRoot: 'src/java',
      javaVersion: '21',
      androidSdkVersion: '36',
      androidSdkRoot: '',
      javaHome: '',
      baksmaliUrl: DEFAULT_BAKSMALI_URL,
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
    }
}
`;

    const gitignore = `build/
*.dex
*.class
*.jar
.DS_Store
Thumbs.db
`;

    const settings = `{
    "java.project.referencedLibraries": [
        "$\{ANDROID_SDK_ROOT\}/platforms/android-36/android.jar",
        "$\{workspaceFolder\}/libs/*.jar"
    ]
}`;

    const readme = [
      '# DEXLab Template',
      '',
      'This workspace is intended for writing Java payloads that will be compiled into DEX and loaded by DexRunner.',
      'This workspace contains a minimal payload project for DEXLab.',
      '',
      '## Structure',
      '- `dexlab.config.json`',
      '- `src/java/payload/Payload.java`',
      '- `libs/` for optional dependencies',
      '',
      '## Default entrypoint',
      '- class: payload.Payload',
      '- method: run',
      '',
      '## Build',
      'Use the DEXLab commands from the Explorer context menu on `dexlab.config.json`.',
      ''
    ].join('\n');

    await writeJsonFile(path.join(root, CONFIG_FILE), config);
    await fsp.writeFile(path.join(root, '.vscode', 'settings.json'), settings, 'utf8');
    await fsp.writeFile(path.join(root, 'src', 'java', 'payload', 'Payload.java'), payloadJava, 'utf8');
    await fsp.writeFile(path.join(root, '.gitignore'), gitignore, 'utf8');
    await fsp.writeFile(path.join(root, 'README.md'), readme, 'utf8');

    const openNow = await vscode.window.showQuickPick(['Open now', 'Later'], {
      title: 'DEXLab: Open the new workspace?',
      ignoreFocusOut: true,
    });

    if (openNow === 'Open now') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), false);
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}
