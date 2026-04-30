using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace ModMixer.Bridge
{
    // Tiny hand-rolled JSON writer. RimWorld doesn't ship Newtonsoft and
    // System.Text.Json isn't on net472, so this is the cheapest path that
    // keeps payload shapes identical to what the TS protocol expects.
    public sealed class Json
    {
        private readonly StringBuilder sb = new StringBuilder(256);
        // After writing a value, the next sibling needs a leading comma. After
        // a key (K) or an opening brace, it does not.
        private bool needComma;

        public Json Obj()
        {
            Comma();
            sb.Append('{');
            needComma = false;
            return this;
        }

        public Json EndObj()
        {
            sb.Append('}');
            needComma = true;
            return this;
        }

        public Json Arr()
        {
            Comma();
            sb.Append('[');
            needComma = false;
            return this;
        }

        public Json EndArr()
        {
            sb.Append(']');
            needComma = true;
            return this;
        }

        public Json K(string key)
        {
            Comma();
            sb.Append('"');
            EscapeInto(sb, key);
            sb.Append("\":");
            needComma = false;
            return this;
        }

        public Json S(string value)
        {
            Comma();
            if (value == null) { sb.Append("null"); }
            else
            {
                sb.Append('"');
                EscapeInto(sb, value);
                sb.Append('"');
            }
            needComma = true;
            return this;
        }

        public Json N(int value)
        {
            Comma();
            sb.Append(value.ToString(CultureInfo.InvariantCulture));
            needComma = true;
            return this;
        }

        public Json N(long value)
        {
            Comma();
            sb.Append(value.ToString(CultureInfo.InvariantCulture));
            needComma = true;
            return this;
        }

        public Json N(double value)
        {
            Comma();
            sb.Append(value.ToString("0.###", CultureInfo.InvariantCulture));
            needComma = true;
            return this;
        }

        public Json B(bool value)
        {
            Comma();
            sb.Append(value ? "true" : "false");
            needComma = true;
            return this;
        }

        public Json Strs(IEnumerable<string> values)
        {
            Arr();
            foreach (var v in values) S(v);
            EndArr();
            return this;
        }

        public override string ToString() => sb.ToString();

        private void Comma()
        {
            if (needComma) sb.Append(',');
        }

        private static void EscapeInto(StringBuilder b, string s)
        {
            if (s == null) return;
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                switch (c)
                {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    case '\b': b.Append("\\b"); break;
                    case '\f': b.Append("\\f"); break;
                    default:
                        if (c < 0x20)
                            b.AppendFormat(CultureInfo.InvariantCulture, "\\u{0:X4}", (int)c);
                        else
                            b.Append(c);
                        break;
                }
            }
        }
    }
}
