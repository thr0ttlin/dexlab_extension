<h1 align="center">
    <img src="https://raw.githubusercontent.com/thr0ttlin/dexlab_extension/main/resources/icon.png" height="100px" width="100px"><br>
    DEXLab
</h1>

DEXLab is a VS Code extension for building Java-based Android payloads into DEX files, packaging them into signed `.dexs` bundles, and deploying them to a connected Android device - all from inside the editor.

Designed for rapid prototyping, proof-of-concept payloads, and Android security research, where creating a full Android Studio project for every test case would be unnecessary overhead.

Works in tandem with **[DexRunner](https://github.com/thr0ttlin/dexrunner)** - an Android app that receives, verifies, and executes `.dexs` bundles on the target device.

---

## Features

- Create a ready-to-use payload workspace from a template
- Create a workspace pre-loaded with a **target APK converted to `target.jar`** - supports APK, APKM, APKS, XAPK via dex2jar
- Configure the entire project from a single `dexlab.config.json`
- Build pipeline: Java -> `.class` -> `.jar` -> `.dex`
- Pack DEX output into a signed **`.dexs` bundle** (ZIP + `config.json` + HMAC-SHA256 signature)
- Disassemble DEX back to smali via `baksmali`
- Push bundle to device via `adb push` to the app's private external directory - no storage permissions needed on any Android version
- Trigger load and run via ADB broadcast
- Provision HMAC signing secret to DexRunner in one command
- Download and install the latest **DexRunner APK** directly from GitHub releases
- All build and device commands in the Explorer context menu - right-click `dexlab.config.json`

---

## Workflow

### 1. Create a workspace

Open the Command Palette (`Ctrl+Shift+P`) and run one of:

| Command | Description |
|---------|-------------|
| `DEXLab: Create Template Workspace` | Blank payload project |
| `DEXLab: Create Template Workspace from Target APK` | Blank project + target APK converted to `target.jar` in `libs/` |

### 2. Write your payload

```java
// src/java/payload/Payload.java
package payload;

import android.content.Context;
import android.widget.Toast;

public class Payload {
    public static void run(Context ctx) {
        Toast.makeText(ctx, "Hello from DEX", Toast.LENGTH_LONG).show();

        // Standard output is captured by DexRunner and shown in its in-app log
        System.out.println("Info From Dex");
        System.err.println("Error From Dex");
    }
}
```

### 3. Build, bundle, deploy - from the context menu

Right-click `dexlab.config.json` in the Explorer and pick a **DEXLab** command:

| Command | Action |
|---------|--------|
| **Build and Run on Device** | Build a signed `.dexs` bundle and run on device |
| **Build** | Compile Java -> JAR -> DEX |
| **Bundle (.dexs)** | Pack DEX files into a signed `.dexs` bundle |
| **Disassemble DEX** | Baksmali decompile `build/dex/` -> `build/smali/` |
| **Prepare Target** | Convert APK / APKM / APKS / XAPK -> `libs/target.jar` |
| **Deploy to Device** | `adb push` bundle + send LOAD broadcast to DexRunner |
| **Run on Device** | Send RUN broadcast to DexRunner |
| **Set Secret** | Send Sign-Secret to DexRunner |
| **Install / Update DexRunner** | Download latest DexRunner APK and `adb install` it |
| **Download baksmali** | Fetch baksmali JAR |
| **Download dex2jar** | Fetch dex2jar tools |
| **Clean** | Delete the `build/` directory |

---

## Project Structure

```
MyPOC/
├── dexlab.config.json     <- project config
├── README.md
├── .gitignore
├── libs/
│   └── target.jar         <- optional: classes from the target APK
└── src/
    └── java/
        └── payload/
            └── Payload.java
```

Build output:

```
build/
├── classes/               <- compiled .class files
├── dex/                   <- .dex files from d8
├── tools/                 <- baksmali, dex2jar (downloaded on demand)
├── smali/                 <- baksmali output
└── payload.dexs           <- final signed bundle
```

---

## Build Pipeline

```
Java sources
    │  javac
    ▼
.class files
    │  jar
    ▼
payload.jar
    │  d8
    ▼
classes.dex
    │  DEXLab pack + HMAC-SHA256 sign
    ▼
payload.dexs  (ZIP: config.json + *.dex)
    │  adb push  ->  /data/local/tmp/DEXLab/
    │  broadcast LOAD_BUNDLE
    │  broadcast RUN_BUNDLE
    ▼
DexRunner on device
```

---

## .dexs Bundle Format

A `.dexs` file is a ZIP archive:

```
payload.dexs
├── config.json    <- namePOC, entryPoint, method, classes, dexes, date, signature
├── classes.dex
└── classes2.dex   <- present if multidex
```

The `signature` field is HMAC-SHA256 over the other `config.json` fields using `bundleSecret` from your `dexlab.config.json`. DexRunner verifies this on load and shows a green or grey indicator in its UI.

---

## First-Time Setup on a New Device

If DexRunner is installed manually, and not with the **Install / Update DexRunner on Device** command, then you need to specify the secret key for signing once by calling the **Send Sign-Secret to DexRunner** command.

After that, **Deploy to Device** or **Build and Run on Device** handles everything in one step.

---

## Configuration Reference

All fields in `dexlab.config.json` are optional and fall back to sensible defaults:

```jsonc
{
  "pkg":               "payload",          // output filename base (payload.jar, payload.dexs)
  "sourceRoot":        "src/java",         // root of Java sources
  "javaVersion":       "21",               // --release passed to javac
  "androidSdkVersion": "36",               // android-XX platform for android.jar and d8
  "androidSdkRoot":    "",                 // override ANDROID_SDK_ROOT / ANDROID_HOME
  "javaHome":          "",                 // override JAVA_HOME (uses PATH if empty)
  "baksmaliUrl":       "https://...",      // URL to download baksmali fat JAR
  "dex2jarUrl":        "https://...",      // URL to download dex-tools ZIP
  "targetApk":         "",                 // path to APK for Prepare Target command
  "namePOC":           "MyPOC",            // readable name shown in DexRunner UI
  "authorPOC":         "AuthorPOC",        // readable author shown in DexRunner UI
  "entryClass":        "payload.Payload",  // class to invoke
  "entryMethod":       "run",              // method to invoke
  "bundleSecret":      "<generated>",      // HMAC-SHA256 key - generated once per project
  "deployPath":        "/sdcard/Android/data/com.thr0ttlin.dexrunner/files/DEXLab/",
  "adbSerial":         ""                  // target device serial (empty = first connected)
}
```

---

## Requirements

- VS Code 1.85+
- JDK 11+ (`javac`, `jar`)
- Android SDK with `android.jar` and `d8` (`build-tools`)
- `adb` in PATH or resolvable via `androidSdkRoot` (for Deploy / Run / Install commands)
- [Language Support for Java™ by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.java) - recommended for class navigation in `target.jar`

---

## Environment Variables

If `androidSdkRoot` and `javaHome` are not set in the config, DEXLab falls back to `ANDROID_SDK_ROOT` / `ANDROID_HOME` and `java` / `javac` / `jar` from `PATH`.

---

## Build the Extension

```bash
npm install
npx @vscode/vsce package
```

---

## Disclaimer

This extension compiles and deploys executable code to Android devices.  
Intended **only for security research and testing** on devices and environments you own and control.