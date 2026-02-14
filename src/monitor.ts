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
    let watchdogTimer: NodeJS.Timeout | null = null;
    let lastMessageAt: number | null = null;
    let handledMessages = 0;
    let client: DWClient | null = null;
    let connectionClosed = false;

    // Watchdog to detect stuck connection (30 min without messages)
    const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000;
    const WATCHDOG_CHECK_MS = 60 * 1000; // Check every minute

    const closeConnection = async () => {
      if (connectionClosed) return;
      connectionClosed = true;

      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
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

      client = new DWClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        debug: config.debug || false,
        keepAlive: true,
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

      // Start heartbeat monitoring
      heartbeat = setInterval(() => {
        const uptimeMs = Date.now() - startedAt;
        const minutesSinceLastMessage = lastMessageAt
          ? Math.floor((Date.now() - lastMessageAt) / 60000)
          : null;

        const logData = {
          connectionId: connectionId.slice(0, 8),
          reconnectAttempts,
          messagesHandled: handledMessages,
          uptimeMs,
          ...(minutesSinceLastMessage !== null && minutesSinceLastMessage > 30
            ? { minutesSinceLastMessage }
            : {}),
        };

        if (minutesSinceLastMessage && minutesSinceLastMessage > 30) {
          log?.warn?.(
            `[${accountId}] ⚠️ Heartbeat: no messages in ${minutesSinceLastMessage} minutes (${JSON.stringify(logData)})`
          );
        } else {
          log?.debug?.(
            `[${accountId}] Heartbeat: ${handledMessages} messages, uptime ${Math.floor(uptimeMs / 1000)}s`
          );
        }
      }, heartbeatSeconds * 1000);

      // Start watchdog timer to detect zombie connections
      watchdogTimer = setInterval(() => {
        if (!lastMessageAt) return;

        const timeSinceLastMessage = Date.now() - lastMessageAt;
        if (timeSinceLastMessage > MESSAGE_TIMEOUT_MS) {
          const minutesSinceLastMessage = Math.floor(timeSinceLastMessage / 60000);
          log?.warn?.(
            `[${accountId}] Watchdog: No messages in ${minutesSinceLastMessage} minutes - forcing reconnect`
          );
          void closeConnection();
        }
      }, WATCHDOG_CHECK_MS);

      // Wait for abort signal
      await new Promise<void>((resolve) => {
        if (stopRequested()) {
          resolve();
          return;
        }
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
