using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using HarmonyLib;
using Verse;

namespace ModMixer.Bridge
{
    // Single background-thread TCP client. Connects to ModMixer's monitor
    // server on 127.0.0.1:13371 and exchanges newline-delimited JSON.
    //
    // Reconnect loop with backoff so RimWorld doesn't care whether ModMixer
    // is running first.
    public sealed class BridgeClient
    {
        private const string Host = "127.0.0.1";
        private const int Port = 13371;
        private const int InitialBackoffMs = 500;
        private const int MaxBackoffMs = 5000;

        private readonly ConcurrentQueue<string> outbox = new ConcurrentQueue<string>();
        private readonly ManualResetEventSlim outboxSignal = new ManualResetEventSlim(false);
        private readonly Thread thread;
        private volatile bool stopping;
        private volatile bool connected;

        public bool Connected => connected;

        // Fired (on the bridge background thread) every time we (re)connect
        // and have just sent the bridge_hello. Channels listen to push their
        // initial state so the UI doesn't have to wait for the next periodic
        // tick.
        public event Action OnConnected;

        public BridgeClient()
        {
            thread = new Thread(RunLoop)
            {
                IsBackground = true,
                Name = "ModMixerBridgeClient",
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
                    backoff = InitialBackoffMs;

                    SendHello(stream);
                    OnConnected?.Invoke();

                    PumpOutbox(client, stream);
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
                .K("type").S("bridge_hello")
                .K("protocol").N(1)
                .K("rimworldVersion").S(SafeRimWorldVersion())
                .K("bridgeVersion").S("0.1.0")
                .K("startedAt").N(BridgeMod.StartedAtMs)
                .EndObj()
                .ToString();
            WriteLine(stream, json);
        }

        // Drain outbox, blocking on the signal. Throws on socket error so the
        // outer loop reconnects.
        private void PumpOutbox(TcpClient client, NetworkStream stream)
        {
            while (!stopping)
            {
                outboxSignal.Wait(1000);
                outboxSignal.Reset();
                while (outbox.TryDequeue(out var line))
                {
                    WriteLine(stream, line);
                }
                if (!IsAlive(client)) throw new IOException("peer gone");
            }
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

        private static string SafeRimWorldVersion()
        {
            try
            {
                // VersionControl lives in RimWorld.* on most builds; reflect
                // to avoid a hard reference and any 1.5/1.6 surface drift.
                // CurrentVersionString is a property in 1.6, a field on older
                // builds — probe both shapes.
                var t = AccessTools.TypeByName("RimWorld.VersionControl")
                        ?? AccessTools.TypeByName("Verse.VersionControl");
                if (t != null)
                {
                    foreach (var name in new[] { "CurrentVersionStringWithRev", "CurrentVersionString" })
                    {
                        var pg = AccessTools.PropertyGetter(t, name);
                        if (pg != null) return (pg.Invoke(null, null) as string) ?? "?";
                        var f = AccessTools.Field(t, name);
                        if (f != null) return (f.GetValue(null) as string) ?? "?";
                    }
                }
            }
            catch { }
            return "?";
        }
    }
}
