## Any class with a static Texture2D field needs [StaticConstructorOnStartup] or RimWorld warns

RimWorld's startup runs a reflection scan over all loaded types looking for static `Texture2D` / `Material` / `Shader` fields. Any class that has one but lacks `[StaticConstructorOnStartup]` fires the warning:

```
Type Foo probably needs a StaticConstructorOnStartup attribute, because it has a field _tex of type Texture2D. All assets must be loaded in the main thread.
```

Fix: add `[StaticConstructorOnStartup]` to the class. You do NOT need an actual static constructor — the attribute alone silences the warning. Loading the texture lazily on first use (via `ContentFinder<Texture2D>.Get` inside a method) is still fine; the attribute just signals "I'm aware this class participates in main-thread asset loading" and gives RimWorld permission to invoke any static initializers during startup on the main thread.

*Why it's tricky:* lazy-load patterns suppress no errors at runtime (your code works) but produce a startup warning per class, polluting the log. The warning attribution lands on `[RimWorld]` even though the offending type is yours — easy to misclassify as "not my problem."
