import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDiagnostics,
  extractSymbolFromMessage,
  formatHints,
  type BuildErrorHint,
} from '../build-error-hints-core.js';

describe('parseDiagnostics', () => {
  it('parses a CS1061 line with a trailing csproj suffix', () => {
    const stdout = [
      '  Determining projects to restore...',
      '  Restored C:\\Users\\peter\\Source\\Foo.csproj (in 329 ms).',
      "C:\\Users\\peter\\Source\\Mod.cs(41,47): error CS1061: 'Pawn' does not contain a definition for 'IsWorldPawn' and no accessible extension method 'IsWorldPawn' accepting a first argument of type 'Pawn' could be found (are you missing a using directive or an assembly reference?) [C:\\Users\\peter\\Source\\Foo.csproj]",
      'Build FAILED.',
    ].join('\n');
    const out = parseDiagnostics(stdout);
    assert.equal(out.length, 1);
    assert.equal(out[0].code, 'CS1061');
    assert.equal(out[0].file, 'C:\\Users\\peter\\Source\\Mod.cs');
    assert.equal(out[0].line, 41);
    assert.match(out[0].message, /IsWorldPawn/);
  });

  it('skips warning lines and the build summary', () => {
    const stdout = [
      'C:\\Foo.cs(10,5): warning CS0168: variable not used',
      'Build FAILED.',
      '    0 Warning(s)',
      '    0 Error(s)',
    ].join('\n');
    assert.deepEqual(parseDiagnostics(stdout), []);
  });

  it('parses an error line with no leading file location', () => {
    // dotnet emits some build-graph errors with no source location.
    const stdout = 'error CS5001: Program does not contain a static Main method';
    const out = parseDiagnostics(stdout);
    assert.equal(out.length, 1);
    assert.equal(out[0].code, 'CS5001');
    assert.equal(out[0].file, undefined);
    assert.equal(out[0].line, undefined);
  });
});

describe('extractSymbolFromMessage', () => {
  it('extracts the type name from CS0246', () => {
    const out = extractSymbolFromMessage(
      'CS0246',
      "The type or namespace name 'Harmony' could not be found (are you missing a using directive or an assembly reference?)",
    );
    assert.deepEqual(out, ['Harmony']);
  });

  it('strips generic arity from CS0246', () => {
    const out = extractSymbolFromMessage(
      'CS0246',
      "The type or namespace name 'List<>' could not be found (are you missing a using directive or an assembly reference?)",
    );
    assert.deepEqual(out, ['List']);
  });

  it('extracts the missing identifier from CS0103', () => {
    const out = extractSymbolFromMessage(
      'CS0103',
      "The name 'Find' does not exist in the current context",
    );
    assert.deepEqual(out, ['Find']);
  });

  it('extracts the extension method from CS1061', () => {
    const out = extractSymbolFromMessage(
      'CS1061',
      "'Pawn' does not contain a definition for 'IsWorldPawn' and no accessible extension method 'IsWorldPawn' accepting a first argument of type 'Pawn' could be found (are you missing a using directive or an assembly reference?)",
    );
    assert.deepEqual(out, ['IsWorldPawn']);
  });

  it('extracts the member name from CS1061 even without the extension-method clause', () => {
    // Older message form — still useful for the agent.
    const out = extractSymbolFromMessage(
      'CS1061',
      "'Pawn' does not contain a definition for 'IsWorldPawn'",
    );
    assert.deepEqual(out, ['IsWorldPawn']);
  });

  it('returns null for unhandled codes', () => {
    assert.equal(
      extractSymbolFromMessage('CS5001', 'whatever'),
      null,
    );
  });
});

describe('formatHints', () => {
  it('renders nothing when there are no hints', () => {
    assert.equal(formatHints([]), '');
  });

  it('renders a single-candidate hint with the using directive', () => {
    const hints: BuildErrorHint[] = [
      {
        code: 'CS1061',
        file: 'Source\\Mod.cs',
        line: 41,
        symbol: 'IsWorldPawn',
        candidates: [
          {
            fqn: 'RimWorld.Planet.WorldPawnsUtility.IsWorldPawn',
            shortName: 'IsWorldPawn',
            kind: 'method',
            namespace: 'RimWorld.Planet',
            enclosingType: 'RimWorld.Planet.WorldPawnsUtility',
            parentFqn: 'RimWorld.Planet.WorldPawnsUtility',
            filePath: 'mock.cs',
            startLine: 1,
            endLine: 5,
            signature: 'public static bool IsWorldPawn(this Pawn p)',
            isExtensionMethod: true,
          },
        ],
      },
    ];
    const out = formatHints(hints);
    assert.match(out, /using RimWorld\.Planet;/);
    assert.match(out, /IsWorldPawn/);
    assert.match(out, /extension method/);
    assert.match(out, /Source\\Mod\.cs\(41\)/);
  });

  it('lists each candidate when a name is ambiguous', () => {
    const hints: BuildErrorHint[] = [
      {
        code: 'CS0246',
        symbol: 'Foo',
        candidates: [
          {
            fqn: 'A.Foo',
            shortName: 'Foo',
            kind: 'class',
            namespace: 'A',
            enclosingType: null,
            parentFqn: 'A',
            filePath: 'a.cs',
            startLine: 1,
            endLine: 1,
            signature: null,
            isExtensionMethod: false,
          },
          {
            fqn: 'B.Foo',
            shortName: 'Foo',
            kind: 'class',
            namespace: 'B',
            enclosingType: null,
            parentFqn: 'B',
            filePath: 'b.cs',
            startLine: 1,
            endLine: 1,
            signature: null,
            isExtensionMethod: false,
          },
        ],
      },
    ];
    const out = formatHints(hints);
    assert.match(out, /multiple candidates/);
    assert.match(out, /using A;/);
    assert.match(out, /using B;/);
  });
});
