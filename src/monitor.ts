import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { DingTalkConfig } from "./config-schema.js";
import { handleDingTalkMessage } from "./channel.js";
import {
  computeBackoff,
  DEFAULT_HEARTBEAT_SECONDS,
  newConnectionId,
  resolveReconnectPolicy,
  sleepWithAbort,
  type ReconnectPolicy,
} from "./reconnect.js";

export type DingTalkMonitorOpts = {
  cfg: OpenClawConfig;
  accountId: string;
  config: DingTalkConfig;
  abortSignal?: AbortSignal;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  reconnectPolicy?: Partial<ReconnectPolicy>;
  heartbeatSeconds?: number;
};

type ConnectionStatus = {
  running: boolean;
  connected: boolean;
  reconnectAttempts: number;
  lastConnectedAt: number | null;
  lastDisconnect: {
    at: number;
    error: string;
  } | null;
  lastMessageAt: number | null;
  lastError: string | null;
};

// Message deduplication cache
const messageCache = new Map<string, number>();
const MESSAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isMessageProcessed(dedupKey: string): boolean {
  const timestamp = messageCache.get(dedupKey);
  if (!timestamp) return false;
  const age = Date.now() - timestamp;
  if (age > MESSAGE_CACHE_TTL_MS) {
    messageCache.delete(dedupKey);
    return false;
  }
  return true;
}

function markMessageProcessed(dedupKey: string): void {
  messageCache.set(dedupKey, Date.now());
  // Cleanup old entries
  if (messageCache.size > 1000) {
    const now = Date.now();
    for (const [key, timestamp] of messageCache.entries()) {
      if (now - timestamp > MESSAGE_CACHE_TTL_MS) {
        messageCache.delete(key);
      }
    }
  }
}

/**
 * Monitor DingTalk Stream connection with robust reconnection management
 */
export async function monitorDingTalkStream(opts: DingTalkMonitorOpts): Promise<void> {
  const { cfg, accountId, config, abortSignal, log } = opts;
  const reconnectPolicy = resolveReconnectPolicy(opts.reconnectPolicy);
  const heartbeatSeconds = opts.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;

  const status: ConnectionStatus = {
    running: true,
    connected: false,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    lastDisconnect: null,
    lastMessageAt: null,
    lastError: null,
  };

  let reconnectAttempts = 0;
  let sigintStop = false;

  const handleSigint = () => {
    sigintStop = true;
  };
  process.once("SIGINT", handleSigint);

  const stopRequested = () => abortSignal?.aborted === true || sigintStop;

  while (true) {
    if (stopRequested()) {
      log?.info?.(`[${accountId}] Stop requested, breaking reconnection loop`);
      break;
    }

    const connectionId = newConnectionId();
    const startedAt = Date.now();
    let heartbeat: NodeJS.Timeout | null = null;
    let lastMessageAt: number | null = null;
    let handledMessages = 0;
    let client: DWClient | null = null;
    let connectionClosed = false;

    let forceReconnect: ((reason: string) => void) | null = null;

    const closeConnection = async () => {
      if (connectionClosed) return;
      connectionClosed = true;

      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }

      if (client) {
        try {
          // DWClient has disconnect method but it's not exposed, so we just null it
          client = null;
        } catch (err) {
          log?.debug?.(`[${accountId}] Client cleanup failed: ${String(err)}`);
        }
      }
    };

    try {
      log?.info?.(`[${accountId}] Creating DingTalk Stream client (connection ${connectionId.slice(0, 8)})`);

      // Validate required config
      if (!config.clientId || !config.clientSecret) {
        throw new Error('DingTalk clientId and clientSecret are required');
      }

      // Note: dingtalk-stream has a critical bug where socket.terminate() 
      // in heartbeat timeout handler doesn't trigger 'close' event, breaking
      // the library's autoReconnect mechanism. We disable library keepAlive
      // and implement our own ping/pong with proper reconnection.
      client = new DWClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        debug: config.debug || false,
        keepAlive: false, // Disabled: we handle ping/pong ourselves
      });

      // Register message callback
      client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
        const messageId = res.headers?.messageId;
        log?.info?.(`[${accountId}] 📨 Received callback from DingTalk Stream (messageId=${messageId || 'unknown'})`);
        
        try {
          handledMessages += 1;
          lastMessageAt = Date.now();
          status.lastMessageAt = lastMessageAt;

          if (messageId) {
            client?.socketCallBackResponse(messageId, { success: true });
          }

          const data = JSON.parse(res.data);
          const dedupKey = data.msgId || messageId;
          
          log?.info?.(`[${accountId}] 📋 Message data parsed - dedupKey=${dedupKey}, conversationType=${data.conversationType || 'unknown'}, senderNick=${data.senderNick || 'unknown'}`);

          if (dedupKey && isMessageProcessed(dedupKey)) {
            log?.debug?.(`[${accountId}] Skipping duplicate message: ${dedupKey}`);
            return;
          }
          if (dedupKey) {
            markMessageProcessed(dedupKey);
          }

          log?.info?.(`[${accountId}] 🚀 Dispatching message to handleDingTalkMessage`);
          await handleDingTalkMessage({
            cfg,
            accountId,
            data,
            sessionWebhook: data.sessionWebhook,
            log,
            dingtalkConfig: config as any, // Config validated above, clientId/clientSecret guaranteed to exist
          });
          log?.info?.(`[${accountId}] ✅ Message handled successfully (dedupKey=${dedupKey})`);
        } catch (error: any) {
          log?.error?.(`[${accountId}] ❌ Error processing message: ${error.message}, stack: ${error.stack}`);
        }
      });

      // Connect to DingTalk Stream
      log?.info?.(`[${accountId}] 🔌 Attempting to connect to DingTalk Stream (clientId=${config.clientId?.slice(0, 8)}...)`);
      await client.connect();

      status.connected = true;
      status.lastConnectedAt = Date.now();
      status.lastError = null;
      log?.info?.(`[${accountId}] ✅ DingTalk Stream connected successfully (connection ${connectionId.slice(0, 8)})`);
      log?.info?.(`[${accountId}] 👂 Listening for messages on TOPIC_ROBOT...`);

      // Start heartbeat with real ping/pong detection
      let pongReceived = true; // Start as true for first check
      const PING_INTERVAL_MS = heartbeatSeconds * 1000; // 30s between pings
      const PONG_TIMEOUT_MS = 10_000; // 10s to receive pong back

      // Listen for pong responses on the underlying WebSocket
      const setupPongListener = () => {
        const ws = (client as any)?.socket;
        if (ws && typeof ws.on === 'function') {
          ws.on('pong', () => {
            pongReceived = true;
            log?.info?.(`[${accountId}] 🏓 Pong received`);
          });

          // Add error and close event listeners for debugging
          ws.on('error', (err: any) => {
            log?.error?.(`[${accountId}] 🔴 WebSocket error: ${err.message}`);
          });

          ws.on('close', (code: number, reason: string) => {
            log?.warn?.(`[${accountId}] 🔌 WebSocket closed: code=${code}, reason=${reason || 'none'}`);
          });

          log?.info?.(`[${accountId}] 🏓 Ping/pong listener attached to WebSocket`);
        } else {
          log?.warn?.(`[${accountId}] ⚠️ Could not access underlying WebSocket for ping/pong`);
        }
      };

      // Attach pong listener after a short delay (WebSocket needs time to initialize)
      setTimeout(setupPongListener, 1000);

      heartbeat = setInterval(() => {
        const uptimeMs = Date.now() - startedAt;
        const minutesSinceLastMessage = lastMessageAt
          ? Math.floor((Date.now() - lastMessageAt) / 60000)
          : null;

        // Check if client object is still valid
        if (!client) {
          log?.error?.(`[${accountId}] 💔 Heartbeat: client is null - forcing reconnect`);
          if (forceReconnect) forceReconnect('Client object became null');
          return;
        }

        // Check previous ping got a pong back
        if (!pongReceived) {
          log?.warn?.(`[${accountId}] 💀 Heartbeat: No pong received - zombie connection detected, forcing reconnect`);
          if (forceReconnect) forceReconnect('Ping/pong timeout: no pong received');
          return;
        }

        // Check if we haven't received any messages for too long (possible message channel issue)
        // Only check after we've received at least one message
        const MESSAGE_IDLE_THRESHOLD_MINUTES = 15;
        if (lastMessageAt && minutesSinceLastMessage !== null && minutesSinceLastMessage >= MESSAGE_IDLE_THRESHOLD_MINUTES) {
          log?.warn?.(`[${accountId}] 📭 No messages received for ${minutesSinceLastMessage} minutes - possible message channel issue, forcing reconnect`);
          if (forceReconnect) forceReconnect(`No messages for ${minutesSinceLastMessage} minutes`);
          return;
        }

        // Send new ping
        const ws = (client as any)?.socket;
        if (ws && typeof ws.ping === 'function' && ws.readyState === 1) {
          pongReceived = false; // Will be set to true when pong comes back
          ws.ping('', true);
          log?.info?.(`[${accountId}] 🏓 Ping sent`);
        } else {
          log?.warn?.(`[${accountId}] 💀 Heartbeat: WebSocket not available or not open (readyState=${ws?.readyState}) - forcing reconnect`);
          if (forceReconnect) forceReconnect('WebSocket not available or closed');
          return;
        }

        log?.info?.(
          `[${accountId}] 💓 Heartbeat OK: ${handledMessages} msgs, uptime ${Math.floor(uptimeMs / 1000)}s${minutesSinceLastMessage !== null ? `, last msg ${minutesSinceLastMessage}m ago` : ''}`
        );
      }, PING_INTERVAL_MS);

      // Wait for abort signal or forced reconnection
      await new Promise<void>((resolve, reject) => {
        if (stopRequested()) {
          resolve();
          return;
        }
        
        // Set up forced reconnection handler
        forceReconnect = (reason: string) => {
          log?.warn?.(`[${accountId}] 💥 Forced reconnection: ${reason}`);
          reject(new Error(reason));
        };
        
        const onAbort = () => {
          log?.info?.(`[${accountId}] Abort signal received`);
          resolve();
        };
        abortSignal?.addEventListener("abort", onAbort, { once: true });
      });

      // Clean shutdown
      await closeConnection();
      log?.info?.(`[${accountId}] Connection closed gracefully`);

      // Check if we should reset reconnect attempts after healthy uptime
      const uptimeMs = Date.now() - startedAt;
      if (uptimeMs > heartbeatSeconds * 1000) {
        log?.info?.(
          `[${accountId}] Healthy uptime (${Math.floor(uptimeMs / 1000)}s), resetting reconnect counter`
        );
        reconnectAttempts = 0;
      }

      break; // Exit loop on clean shutdown
    } catch (error: any) {
      // Connection failed
      const errorMsg = error.message || String(error);
      status.connected = false;
      status.lastError = errorMsg;
      status.lastDisconnect = {
        at: Date.now(),
        error: errorMsg,
      };

      log?.error?.(`[${accountId}] ❌ Connection failed: ${errorMsg}`);
      log?.error?.(`[${accountId}] 📊 Connection stats - uptime: ${Math.floor((Date.now() - startedAt) / 1000)}s, messages handled: ${handledMessages}, last message: ${lastMessageAt ? new Date(lastMessageAt).toISOString() : 'never'}`);

      await closeConnection();
      log?.info?.(`[${accountId}] 🔌 Connection closed after failure`);

      if (stopRequested()) {
        log?.info?.(`[${accountId}] ⏹️ Stop requested, exiting after error`);
        break;
      }

      // Check uptime for health reset
      const uptimeMs = Date.now() - startedAt;
      if (uptimeMs > heartbeatSeconds * 1000) {
        log?.info?.(
          `[${accountId}] ✅ Had healthy uptime (${Math.floor(uptimeMs / 1000)}s) before failure, resetting reconnect counter`
        );
        reconnectAttempts = 0;
      }

      reconnectAttempts += 1;
      status.reconnectAttempts = reconnectAttempts;

      log?.warn?.(`[${accountId}] 🔄 Reconnection attempt ${reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} - last error: ${errorMsg}`);

      // Check max attempts
      if (reconnectPolicy.maxAttempts > 0 && reconnectAttempts >= reconnectPolicy.maxAttempts) {
        log?.error?.(
          `[${accountId}] 🛑 Max reconnection attempts reached (${reconnectAttempts}/${reconnectPolicy.maxAttempts}), stopping`
        );
        break;
      }

      // Compute exponential backoff delay
      const delay = computeBackoff(reconnectPolicy, reconnectAttempts);
      log?.info?.(
        `[${accountId}] ⏳ Retry ${reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} in ${Math.floor(delay / 1000)}s... (backoff policy: base=${reconnectPolicy.baseDelayMs}ms, max=${reconnectPolicy.maxDelayMs}ms)`
      );

      // Sleep with abort check
      try {
        await sleepWithAbort(delay, abortSignal);
        log?.info?.(`[${accountId}] ⏰ Backoff completed, attempting reconnection...`);
      } catch {
        log?.info?.(`[${accountId}] ⏹️ Sleep interrupted, exiting reconnection loop`);
        break;
      }
    }
  }

  status.running = false;
  status.connected = false;
  process.removeListener("SIGINT", handleSigint);

  log?.info?.(`[${accountId}] DingTalk Stream monitor stopped`);
}
