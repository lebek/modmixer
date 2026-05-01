# Vendored ilspycmd

Per-platform self-contained `ilspycmd` binaries from
[icsharpcode/ILSpy](https://github.com/icsharpcode/ILSpy). Used by the index
engine to decompile RimWorld's managed assemblies on first launch.

The runtime resolver picks `<platform>-<arch>/ilspycmd[.exe]` from this dir
when packaged (`process.resourcesPath/ilspycmd/...`), falling back to the
user's `~/.dotnet/tools/ilspycmd` when running from source.

## Expected layout

```
resources/ilspycmd/
  win32-x64/ilspycmd.exe
  darwin-x64/ilspycmd
  darwin-arm64/ilspycmd
  linux-x64/ilspycmd            # optional; not currently packaged
```

Binaries are NOT committed — fetch them with `scripts/fetch-ilspycmd.mjs`
during release builds. The script grabs the latest self-contained build for
the current host platform.

## How to produce the binaries

ICSharpCode publishes a `dotnet tool` package, not native binaries. To get a
self-contained executable, build from source on each platform:

```sh
git clone https://github.com/icsharpcode/ILSpy.git
cd ILSpy/ICSharpCode.ILSpyCmd
dotnet publish -c Release -r win-x64    --self-contained -p:PublishSingleFile=true -p:PublishTrimmed=true
dotnet publish -c Release -r osx-x64    --self-contained -p:PublishSingleFile=true -p:PublishTrimmed=true
dotnet publish -c Release -r osx-arm64  --self-contained -p:PublishSingleFile=true -p:PublishTrimmed=true
dotnet publish -c Release -r linux-x64  --self-contained -p:PublishSingleFile=true -p:PublishTrimmed=true
```

Output lands at `bin/Release/net*/<rid>/publish/ilspycmd[.exe]` (~30-50 MB
per platform). Drop into the matching `resources/ilspycmd/<platform>-<arch>/`
directory before running `npm run make` / `npm run publish`.

In CI, run the publish step on each platform and let the matrix produce the
right binary for the current host. macOS notarization will sign the bundled
binary as part of the dmg flow if it's listed in `extraResource`.
