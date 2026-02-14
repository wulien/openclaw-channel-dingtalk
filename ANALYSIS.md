# 钉钉流式卡片问题分析

## 问题现象

1. **重复消息**：同样的回复会有一个卡片全部显示出来，然后还有一个会显示流式输出
2. **一直转圈圈**：最后还会出现一直转圈圈的消息提示，实际上已经没有消息了

## 根本原因

### 1. 重复消息问题（卡片 + Markdown）

**位置**：`src/channel.ts` 的 `sendMessage` 函数（790-836行）

**问题代码**：
```typescript
if (messageType === 'card' && options.accountId) {
  const targetKey = `${options.accountId}:${conversationId}`;
  const activeCardId = activeCardsByTarget.get(targetKey);
  if (activeCardId) {
    const activeCard = aiCardInstances.get(activeCardId);
    if (activeCard && !isCardInTerminalState(activeCard.state)) {
      try {
        await streamAICard(activeCard, text, false, log);
        return { ok: true };
      } catch (err: any) {
        // ⚠️ 问题：失败后继续执行，没有 return
        log?.warn?.(`[DingTalk] AI Card streaming failed, fallback to markdown: ${err.message}`);
        activeCard.state = AICardStatus.FAILED;
        activeCard.lastUpdated = Date.now();
      }
    }
  }
}

// ⚠️ 问题：这里会继续执行，发送普通消息
// Fallback to markdown mode
if (options.sessionWebhook) {
  await sendBySession(config, options.sessionWebhook, text, options);
  return { ok: true };
}
```

**原因分析**：
- 当 `streamAICard` 失败时，catch 块标记卡片为 FAILED，但没有 return
- 代码继续执行到 "Fallback to markdown mode"，发送普通 markdown 消息
- 结果：同一内容既有流式卡片（可能部分成功）又有普通消息

### 2. 一直转圈圈问题（卡片未关闭）

**位置**：`src/channel.ts` 的消息处理逻辑（1050-1110行）

**问题流程**：
1. `deliver` 回调被多次调用（流式输出）
2. 每次调用都通过 `sendMessage` 更新卡片
3. 如果某次更新失败但异常被吞掉
4. 最后的 `finishAICard` 可能也失败
5. 卡片一直处于 `PROCESSING` 或 `INPUTING` 状态 → 转圈圈

**相关代码**：
```typescript
const { queuedFinal } = await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
  ctx,
  cfg,
  dispatcherOptions: {
    deliver: async (payload: any) => {
      try {
        const textToSend = payload.markdown || payload.text;
        if (!textToSend) return;

        lastCardContent = textToSend;
        // ⚠️ 如果这里失败，lastCardContent 可能不正确
        await sendMessage(dingtalkConfig, to, textToSend, { ... });
      } catch (err: any) {
        log?.error?.(`[DingTalk] Reply failed: ${err.message}`);
        throw err; // 抛出异常，但卡片状态可能未更新
      }
    },
  },
});

// Finalize AI card
if (useCardMode && currentAICard) {
  try {
    // ⚠️ 如果 lastCardContent 为空或不正确，可能跳过 finalization
    if (hasLastCardContent || hasQueuedFinalString) {
      const finalContent = hasLastCardContent ? lastCardContent : (queuedFinal as string);
      await finishAICard(currentAICard, finalContent, log);
    }
  } catch (err: any) {
    // ⚠️ finalization 失败，卡片可能未正确关闭
    log?.debug?.(`[DingTalk] AI Card finalization failed: ${err.message}`);
  }
}
```

### 3. 卡片复用逻辑问题

**位置**：`src/channel.ts` 的卡片创建逻辑（1010-1032行）

**问题代码**：
```typescript
if (useCardMode) {
  const targetKey = `${accountId}:${to}`;
  const existingCardId = activeCardsByTarget.get(targetKey);
  const existingCard = existingCardId ? aiCardInstances.get(existingCardId) : undefined;

  // ⚠️ 如果前一个卡片状态未正确更新，这里会复用它
  if (existingCard && !isCardInTerminalState(existingCard.state)) {
    currentAICard = existingCard;
    log?.debug?.('[DingTalk] Reusing existing active AI card for this conversation.');
  } else {
    // Create a new AI card
    const aiCard = await createAICard(dingtalkConfig, to, data, accountId, log);
    if (aiCard) {
      currentAICard = aiCard;
    }
  }
}
```

**原因分析**：
- 如果前一个卡片由于异常未正确关闭（状态仍是 PROCESSING/INPUTING）
- 新消息会复用这个卡片
- 导致新内容追加到旧卡片，内容混乱

## 修复方案

### 方案1：防止卡片模式回退到 markdown（修复重复消息）

**修改 `sendMessage` 函数**：

```typescript
async function sendMessage(
  config: DingTalkConfig,
  conversationId: string,
  text: string,
  options: SendMessageOptions & { sessionWebhook?: string; accountId?: string } = {}
): Promise<{ ok: boolean; error?: string; data?: AxiosResponse }> {
  try {
    const messageType = config.messageType || 'markdown';
    const log = options.log || getLogger();

    if (messageType === 'card' && options.accountId) {
      const targetKey = `${options.accountId}:${conversationId}`;
      const activeCardId = activeCardsByTarget.get(targetKey);
      if (activeCardId) {
        const activeCard = aiCardInstances.get(activeCardId);
        if (activeCard && !isCardInTerminalState(activeCard.state)) {
          try {
            await streamAICard(activeCard, text, false, log);
            return { ok: true };
          } catch (err: any) {
            // 🔧 修复：卡片模式失败时直接返回错误，不要回退到 markdown
            log?.error?.(`[DingTalk] AI Card streaming failed: ${err.message}`);
            activeCard.state = AICardStatus.FAILED;
            activeCard.lastUpdated = Date.now();
            return { ok: false, error: err.message }; // ✅ 直接返回，不再继续
          }
        } else {
          activeCardsByTarget.delete(targetKey);
        }
      }
      
      // 🔧 如果没有找到活跃卡片，说明配置有误，返回错误而不是回退
      log?.warn?.('[DingTalk] Card mode enabled but no active card found');
      return { ok: false, error: 'No active card found in card mode' };
    }

    // Fallback to markdown mode (仅当 messageType !== 'card' 时才到达这里)
    if (options.sessionWebhook) {
      await sendBySession(config, options.sessionWebhook, text, options);
      return { ok: true };
    }

    const result = await sendProactiveTextOrMarkdown(config, conversationId, text, options);
    return { ok: true, data: result };
  } catch (err: any) {
    options.log?.error?.(`[DingTalk] Send message failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
```

### 方案2：确保卡片总是被正确关闭（修复转圈圈）

**在消息处理结束时强制关闭卡片**：

```typescript
// Finalize AI card
if (useCardMode && currentAICard) {
  try {
    // Helper function to check if a value is a non-empty string
    const isNonEmptyString = (value: any): boolean =>
      typeof value === 'string' && value.trim().length > 0;

    // Validate that we have actual content before finalization
    const hasLastCardContent = isNonEmptyString(lastCardContent);
    const hasQueuedFinalString = isNonEmptyString(queuedFinal);

    if (hasLastCardContent || hasQueuedFinalString) {
      const finalContent = hasLastCardContent ? lastCardContent : (queuedFinal as string);
      await finishAICard(currentAICard, finalContent, log);
    } else {
      // 🔧 修复：即使没有内容，也要关闭卡片
      log?.debug?.(
        '[DingTalk] No textual content, closing card with empty state'
      );
      try {
        // 发送一个空的 finalize 来关闭流式通道
        await streamAICard(currentAICard, '处理完成', true, log);
      } catch (finalizeErr: any) {
        log?.warn?.(`[DingTalk] Failed to close empty card: ${finalizeErr.message}`);
      }
      // ✅ 无论如何都要更新状态
      currentAICard.state = AICardStatus.FINISHED;
      currentAICard.lastUpdated = Date.now();
    }
  } catch (err: any) {
    log?.error?.(`[DingTalk] AI Card finalization failed: ${err.message}`);
    // 🔧 修复：确保即使失败也更新状态
    try {
      currentAICard.state = AICardStatus.FAILED;
      currentAICard.lastUpdated = Date.now();
      // ✅ 从活跃卡片映射中移除
      const targetKey = `${accountId}:${to}`;
      activeCardsByTarget.delete(targetKey);
    } catch (stateErr: any) {
      log?.debug?.(`[DingTalk] Failed to update card state to FAILED: ${stateErr.message}`);
    }
  }
}
```

### 方案3：创建新卡片前强制关闭旧卡片（修复卡片复用混乱）

**修改卡片创建逻辑**：

```typescript
if (useCardMode) {
  // Try to reuse an existing active AI card for this target, if available
  const targetKey = `${accountId}:${to}`;
  const existingCardId = activeCardsByTarget.get(targetKey);
  const existingCard = existingCardId ? aiCardInstances.get(existingCardId) : undefined;

  // 🔧 修复：检查现有卡片的状态和时间
  if (existingCard) {
    const cardAge = Date.now() - existingCard.createdAt;
    const isStale = cardAge > 5 * 60 * 1000; // 5分钟超时
    
    if (!isCardInTerminalState(existingCard.state)) {
      if (isStale) {
        // ✅ 旧卡片超时，强制关闭
        log?.warn?.(`[DingTalk] Stale card detected (age=${cardAge}ms), forcing close`);
        try {
          await streamAICard(existingCard, '超时关闭', true, log);
        } catch (err: any) {
          log?.debug?.(`[DingTalk] Failed to close stale card: ${err.message}`);
        }
        existingCard.state = AICardStatus.FAILED;
        existingCard.lastUpdated = Date.now();
        activeCardsByTarget.delete(targetKey);
      } else {
        // ✅ 卡片有效，复用
        currentAICard = existingCard;
        log?.debug?.('[DingTalk] Reusing existing active AI card for this conversation.');
      }
    } else {
      // ✅ 卡片已终止，清理映射
      activeCardsByTarget.delete(targetKey);
    }
  }

  // Create a new AI card if we don't have a valid one
  if (!currentAICard) {
    const aiCard = await createAICard(dingtalkConfig, to, data, accountId, log);
    if (aiCard) {
      currentAICard = aiCard;
    } else {
      log?.warn?.('[DingTalk] Failed to create AI card, fallback to text/markdown.');
    }
  }
}
```

### 方案4：添加更好的错误处理和日志

**在 deliver 回调中添加更好的错误处理**：

```typescript
const { queuedFinal } = await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
  ctx,
  cfg,
  dispatcherOptions: {
    responsePrefix: '',
    deliver: async (payload: any) => {
      try {
        const textToSend = payload.markdown || payload.text;
        if (!textToSend) return;

        // 🔧 只在卡片模式下更新 lastCardContent
        if (useCardMode && currentAICard) {
          lastCardContent = textToSend;
          // ✅ 直接调用 streamAICard，不通过 sendMessage
          try {
            await streamAICard(currentAICard, textToSend, false, log);
          } catch (streamErr: any) {
            log?.error?.(`[DingTalk] Stream update failed: ${streamErr.message}`);
            // 标记卡片失败，但不抛出异常
            currentAICard.state = AICardStatus.FAILED;
            currentAICard.lastUpdated = Date.now();
          }
        } else {
          // ✅ 非卡片模式，正常发送
          lastCardContent = textToSend;
          await sendMessage(dingtalkConfig, to, textToSend, {
            sessionWebhook,
            atUserId: !isDirect ? senderId : null,
            log,
            accountId,
          });
        }
      } catch (err: any) {
        log?.error?.(`[DingTalk] Reply failed: ${err.message}`);
        // 🔧 如果是卡片模式，标记失败
        if (useCardMode && currentAICard) {
          currentAICard.state = AICardStatus.FAILED;
          currentAICard.lastUpdated = Date.now();
        }
        throw err;
      }
    },
  },
});
```

## 测试建议

1. **测试正常流程**：发送消息，验证只有一个流式卡片，没有重复的 markdown 消息
2. **测试异常流程**：模拟网络错误，验证卡片正确关闭，不会一直转圈圈
3. **测试快速连续消息**：快速发送多条消息，验证卡片正确创建和关闭，不会复用错误的卡片
4. **测试超时场景**：发送消息后等待很久再发送下一条，验证旧卡片被正确清理

## 总结

主要修复点：
1. ✅ 卡片模式失败时不要回退到 markdown，直接返回错误
2. ✅ 在所有情况下（包括异常）都确保卡片状态更新为终止状态
3. ✅ 创建新卡片前检查并清理旧卡片
4. ✅ 在 deliver 回调中直接调用 streamAICard，而不是通过 sendMessage
5. ✅ 添加超时检测，防止卡片长时间停留在非终止状态
