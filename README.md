<h1 align="center">
    <img src="https://raw.githubusercontent.com/thr0ttlin/dexlab_extension/main/resources/icon.png" height="100px" width="100px">
    </a> <br>DEXLab
</h1>

DEXLab is a lightweight VS Code extension for building Java-based Android payloads into DEX files and managing a small, project-local build workflow from inside the editor.

It is designed for rapid prototyping, proof-of-concept payloads, and Android research workflows where creating a full Android Studio project for every test case would be unnecessary.

<h2> Features </h2>

- Create a ready-to-use payload workspace template
- Configuring project from a root-level `dexlab.config.json`
- Build Java sources into:
  - `.class`
  - `.jar`
  - `.dex`
- Disassemble DEX output into smali (by `baksmali`)
- Run commands from the Explorer context menu by right-clicking `dexlab.config.json`


<h2> Project Workflow </h2>

A typical DEXLab project looks like this:

```text
DEXLabTemplate/
├─ dexlab.config.json
├─ README.md
├─ .gitignore
├─ libs/
└─ src/
   └─ java/
      └─ payload/
         └─ Payload.java
```


<h2> Build Pipeline </h2>

```
Java Classes --javac--> JAR --d8--> DEX [ --baksmali--> Smali ]
```

<h4> The build pipeline is intentionally simple: </h4>

1. Compile Java sources with javac
2. Package compiled classes into a .jar
3. Convert the JAR into .dex with d8
4. Optionally disassemble the DEX with baksmali


<h4> Build artifacts are written to: </h4>

```text
build/
├─ classes/
├─ dex/
├─ artifacts/
├─ tools/
└─ smali/
```

<h2> Requirements for DEX building </h2>

* VS Code (Recomended: Language Support for Java(TM) by Red Hat)
* JDK 11+
* Android SDK (need `android.jar` and `d8`)
* Configring your `dexlab.config.json` (if needed)


<h2> Environment Variables </h2>

DEXLab can use either configuration values from dexlab.config.json or environment variables (ANDROID_SDK_ROOT or ANDROID_HOME).

If javaHome is not set in the config file, DEXLab will use java, javac, and jar from PATH.


<h2> Build Extension </h2>

```
npm install
npx @vscode/vsce package
```