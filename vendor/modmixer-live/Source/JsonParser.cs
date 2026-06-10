using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace ModMixer.Live
{
    public enum JsonKind { Object, Array, String, Number, Bool, Null }

    // Parsed JSON node. Accessors are forgiving by design: wrong-kind access
    // returns the caller's fallback instead of throwing, and the object
    // indexer returns null for missing members — so protocol handlers can
    // chain msg["key"]?.AsString() without defensive ceremony.
    public sealed class JsonValue
    {
        private static readonly List<JsonValue> NoItems = new List<JsonValue>();

        public JsonKind Kind { get; private set; }

        private Dictionary<string, JsonValue> members;
        private List<JsonValue> items;
        private string str;
        private double num;
        private bool flag;

        private JsonValue() { }

        internal static JsonValue NewObject(Dictionary<string, JsonValue> members)
            => new JsonValue { Kind = JsonKind.Object, members = members };

        internal static JsonValue NewArray(List<JsonValue> items)
            => new JsonValue { Kind = JsonKind.Array, items = items };

        internal static JsonValue NewString(string s)
            => new JsonValue { Kind = JsonKind.String, str = s };

        internal static JsonValue NewNumber(double n)
            => new JsonValue { Kind = JsonKind.Number, num = n };

        internal static JsonValue NewBool(bool b)
            => new JsonValue { Kind = JsonKind.Bool, flag = b };

        internal static JsonValue NewNull()
            => new JsonValue { Kind = JsonKind.Null };

        // Object member access; null when not an object or the member is
        // missing.
        public JsonValue this[string key]
        {
            get
            {
                if (Kind != JsonKind.Object || key == null) return null;
                JsonValue v;
                return members.TryGetValue(key, out v) ? v : null;
            }
        }

        // Array elements; an empty (shared, do-not-mutate) list when not an
        // array, so foreach never needs a null check.
        public List<JsonValue> Items => Kind == JsonKind.Array ? items : NoItems;

        public string AsString(string fallback = null)
            => Kind == JsonKind.String ? str : fallback;

        public double AsDouble(double fallback = 0)
            => Kind == JsonKind.Number ? num : fallback;

        public bool AsBool(bool fallback = false)
            => Kind == JsonKind.Bool ? flag : fallback;
    }

    // Minimal recursive-descent JSON parser: objects, arrays, strings with
    // \u escapes, numbers as double, true/false/null. Internally it throws
    // FormatException on bad input, but nothing escapes Parse — malformed
    // wire lines come back as null and the caller drops them.
    public static class JsonParser
    {
        // Stack-depth guard: a hostile/buggy peer must not be able to
        // overflow the socket thread's stack with "[[[[[…".
        private const int MaxDepth = 64;

        public static JsonValue Parse(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            try
            {
                int pos = 0;
                var v = ParseValue(text, ref pos, 0);
                SkipWs(text, ref pos);
                // Trailing junk after the value means the line wasn't JSON.
                return pos == text.Length ? v : null;
            }
            catch
            {
                return null;
            }
        }

        private static JsonValue ParseValue(string s, ref int pos, int depth)
        {
            if (depth > MaxDepth) throw new FormatException("too deep");
            SkipWs(s, ref pos);
            switch (Peek(s, pos))
            {
                case '{': return ParseObject(s, ref pos, depth);
                case '[': return ParseArray(s, ref pos, depth);
                case '"': return JsonValue.NewString(ParseString(s, ref pos));
                case 't': Expect(s, ref pos, "true"); return JsonValue.NewBool(true);
                case 'f': Expect(s, ref pos, "false"); return JsonValue.NewBool(false);
                case 'n': Expect(s, ref pos, "null"); return JsonValue.NewNull();
                default: return JsonValue.NewNumber(ParseNumber(s, ref pos));
            }
        }

        private static JsonValue ParseObject(string s, ref int pos, int depth)
        {
            pos++; // '{'
            var members = new Dictionary<string, JsonValue>();
            SkipWs(s, ref pos);
            if (Peek(s, pos) == '}') { pos++; return JsonValue.NewObject(members); }
            while (true)
            {
                SkipWs(s, ref pos);
                if (Peek(s, pos) != '"') throw new FormatException("expected key");
                string key = ParseString(s, ref pos);
                SkipWs(s, ref pos);
                if (Peek(s, pos) != ':') throw new FormatException("expected ':'");
                pos++;
                members[key] = ParseValue(s, ref pos, depth + 1); // last duplicate key wins
                SkipWs(s, ref pos);
                char c = Peek(s, pos);
                pos++;
                if (c == ',') continue;
                if (c == '}') return JsonValue.NewObject(members);
                throw new FormatException("expected ',' or '}'");
            }
        }

        private static JsonValue ParseArray(string s, ref int pos, int depth)
        {
            pos++; // '['
            var items = new List<JsonValue>();
            SkipWs(s, ref pos);
            if (Peek(s, pos) == ']') { pos++; return JsonValue.NewArray(items); }
            while (true)
            {
                items.Add(ParseValue(s, ref pos, depth + 1));
                SkipWs(s, ref pos);
                char c = Peek(s, pos);
                pos++;
                if (c == ',') continue;
                if (c == ']') return JsonValue.NewArray(items);
                throw new FormatException("expected ',' or ']'");
            }
        }

        private static string ParseString(string s, ref int pos)
        {
            pos++; // opening quote
            var sb = new StringBuilder();
            while (true)
            {
                char c = Peek(s, pos);
                pos++;
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                char e = Peek(s, pos);
                pos++;
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u':
                        if (pos + 4 > s.Length) throw new FormatException("bad \\u");
                        // Surrogate pairs arrive as two \u escapes and pair up
                        // naturally in the output string.
                        sb.Append((char)ushort.Parse(
                            s.Substring(pos, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        pos += 4;
                        break;
                    default: throw new FormatException("bad escape");
                }
            }
        }

        private static double ParseNumber(string s, ref int pos)
        {
            int start = pos;
            while (pos < s.Length)
            {
                char c = s[pos];
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E')
                    pos++;
                else
                    break;
            }
            if (pos == start) throw new FormatException("expected value");
            double v;
            if (!double.TryParse(s.Substring(start, pos - start),
                    NumberStyles.Float, CultureInfo.InvariantCulture, out v))
                throw new FormatException("bad number");
            return v;
        }

        private static char Peek(string s, int pos)
        {
            if (pos >= s.Length) throw new FormatException("unexpected end");
            return s[pos];
        }

        private static void Expect(string s, ref int pos, string literal)
        {
            if (pos + literal.Length > s.Length
                || string.CompareOrdinal(s, pos, literal, 0, literal.Length) != 0)
                throw new FormatException("bad literal");
            pos += literal.Length;
        }

        private static void SkipWs(string s, ref int pos)
        {
            while (pos < s.Length)
            {
                char c = s[pos];
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++;
                else break;
            }
        }
    }
}
