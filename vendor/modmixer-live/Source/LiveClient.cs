using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace ModMixer.Live
{
    // Single background-thread TCP client. Connects to ModMixer's live
    // server on 127.0.0.1:13372 and exchanges newline-delimited JSON — in
    // both directions, unlike the bridge, which only writes.
    //
    // Reconnect loop with backoff so RimWorld doesn't care whether ModMixer
    // is running first. One exception: a server_reject (protocol mismatch)
    // stops reconnect attempts for the rest of this game launch — hammering
    // a server that already said "no" helps nobody.
    public sealed class LiveClient
    {
        private const string Host = "127.0.0.1";
        private const int Port = 13372;
        private const int InitialBackoffMs = 500;
        private const int MaxBackoffMs = 5000;

        private readonly ConcurrentQueue<string> outbox = new ConcurrentQueue<string>();
        private readonly ManualResetEventSlim outboxSignal = new ManualResetEventSlim(false);
        private readonly Thread thread;
        private volatile bool stopping;
        private volatile bool connected;
        private volatile bool everConnected;

        // Parsed inbound messages, drained by LiveBehaviour.Update on the
        // main thread. server_reject is handled here and never enqueued.
        public readonly ConcurrentQueue<JsonValue> Inbox = new ConcurrentQueue<JsonValue>();

        // Non-null once the server has rejected us (protocol mismatch). The
        // chat window shows this verbatim.
        public volatile string RejectedReason;

        public bool Connected => connected;

        // True once any connection to the app has succeeded this launch.
        // Gates the standalone-subscriber nudge in LiveBehaviour.
        public bool EverConnected => everConnected;

        // Inbound line assembly. We buffer bytes, not chars: a UTF-8 code
        // point split across two reads must not be decoded until its line
        // completes.
        private readonly byte[] readBuf = new byte[8192];
        private byte[] lineBuf = new byte[1024];
        private int lineLen;

        public LiveClient()
        {
            thread = new Thread(RunLoop)
            {
                IsBackground = true,
                Name = "ModmixerLiveClient",
            };
        }

        public void Start() => thread.Start();

        public void Stop()
        {
            stopping = true;
            outboxSignal.Set();
        }

        public void Send(string line)
        {
            outbox.Enqueue(line);
            outboxSignal.Set();
        }

        private void RunLoop()
        {
            int backoff = InitialBackoffMs;
            while (!stopping)
            {
                TcpClient client = null;
                NetworkStream stream = null;
                try
                {
                    client = new TcpClient { NoDelay = true };
                    var ar = client.BeginConnect(Host, Port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(2000))
                    {
                        try { client.Close(); } catch { }
                        throw new TimeoutException();
                    }
                    client.EndConnect(ar);
                    stream = client.GetStream();
                    connected = true;
                    everConnected = true;
                    backoff = InitialBackoffMs;
                    lineLen = 0; // discard any partial line from a dead connection

                    SendHello(stream);
                    Pump(client, stream);
                }
                catch
                {
                    // expected when ModMixer isn't running yet.
                }
                finally
                {
                    connected = false;
                    try { stream?.Dispose(); } catch { }
                    try { client?.Close(); } catch { }
                }

                if (stopping) break;
                Sleep(backoff);
                backoff = Math.Min(backoff * 2, MaxBackoffMs);
            }
        }

        private void SendHello(NetworkStream stream)
        {
            var json = new Json()
                .Obj()
                .K("type").S("live_hello")
                .K("protocol").N(1)
                .K("liveVersion").S(LiveMod.LiveVersion)
                .K("gameStartedAt").N(LiveMod.StartedAtMs)
                .EndObj()
                .ToString();
            WriteLine(stream, json);
        }

        // Drain outbox and read inbound lines. The wait is shorter than the
        // bridge's 1000ms because inbound commands should feel snappy.
        // Throws on socket error so the outer loop reconnects.
        private void Pump(TcpClient client, NetworkStream stream)
        {
            while (!stopping)
            {
                outboxSignal.Wait(100);
                outboxSignal.Reset();
                string line;
                while (outbox.TryDequeue(out line))
                {
                    WriteLine(stream, line);
                }
                ReadAvailable(stream);
                if (!IsAlive(client)) throw new IOException("peer gone");
            }
        }

        // Non-blocking: only consumes what the socket already has, so the
        // pump never stalls the outbox behind a slow peer.
        private void ReadAvailable(NetworkStream stream)
        {
            while (!stopping && stream.DataAvailable)
            {
                int n = stream.Read(readBuf, 0, readBuf.Length);
                if (n <= 0) throw new IOException("peer closed");
                for (int i = 0; i < n; i++)
                {
                    byte b = readBuf[i];
                    if (b == (byte)'\n')
                    {
                        if (lineLen > 0) HandleLine(Encoding.UTF8.GetString(lineBuf, 0, lineLen));
                        lineLen = 0;
                        continue;
                    }
                    if (b == (byte)'\r') continue;
                    if (lineLen == lineBuf.Length) Array.Resize(ref lineBuf, lineBuf.Length * 2);
                    lineBuf[lineLen++] = b;
                }
            }
        }

        private void HandleLine(string line)
        {
            JsonValue msg;
            try { msg = JsonParser.Parse(line); }
            catch { msg = null; } // Parse shouldn't throw, but this thread must not die
            if (msg == null) return; // malformed line — drop it, don't disconnect

            if (msg["type"]?.AsString() == "server_reject")
            {
                RejectedReason = msg["reason"]?.AsString() ?? "Modmixer rejected this Live version.";
                // No reconnect until the next game launch; the server will
                // keep saying no.
                stopping = true;
                return;
            }
            Inbox.Enqueue(msg);
        }

        private static bool IsAlive(TcpClient client)
        {
            try
            {
                var sock = client.Client;
                if (sock == null || !sock.Connected) return false;
                if (sock.Poll(0, SelectMode.SelectRead) && sock.Available == 0)
                    return false;
                return true;
            }
            catch { return false; }
        }

        private static void WriteLine(NetworkStream stream, string line)
        {
            var bytes = Encoding.UTF8.GetBytes(line + "\n");
            stream.Write(bytes, 0, bytes.Length);
        }

        private static void Sleep(int ms)
        {
            try { Thread.Sleep(ms); } catch (ThreadInterruptedException) { }
        }
    }
}
