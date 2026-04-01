/**
 * Copilot Chat interception via VS Code Language Model API prototype patching.
 *
 * The insight: vscode.lm.selectChatModels() returns model objects that share
 * a prototype. If we patch `sendRequest` on that prototype, it intercepts
 * ALL calls — including those made internally by Copilot Chat — transparently.
 *
 * No UX change, no proxy, no cert issues. The user types in Copilot Chat
 * normally and we capture everything.
 */
import * as vscode from 'vscode';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

let originalSendRequest: AnyFn | null = null;
let patchedTarget: object | null = null;
let patchLocation: 'prototype' | 'instance' | null = null;
let interceptCount = 0;
let sendFn: ((payload: Record<string, unknown>) => void) | null = null;
let logFn: (msg: string) => void = () => {};

/**
 * Attempt to patch the LanguageModelChat.sendRequest method at the prototype level.
 * Returns true if the patch was applied successfully.
 */
export async function startLmIntercept(
  send: (payload: Record<string, unknown>) => void,
  logger: (msg: string) => void,
): Promise<boolean> {
  sendFn = send;
  logFn = logger;

  try {
    if (typeof vscode.lm?.selectChatModels !== 'function') {
      logger('[lm-intercept] vscode.lm.selectChatModels not available');
      return false;
    }

    // Wait briefly for Copilot to register its models
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length === 0) {
      logger('[lm-intercept] No Copilot models found — will retry after delay');
      return false;
    }

    const model = models[0];
    const proto = Object.getPrototypeOf(model);

    // --- Diagnostic: examine the model structure ---
    logger(`[lm-intercept] Model: id=${model.id}, type=${typeof model}, constructor=${model.constructor?.name ?? 'none'}`);
    logger(`[lm-intercept] Model own keys: ${Object.getOwnPropertyNames(model).join(', ')}`);

    if (proto && proto !== Object.prototype) {
      logger(`[lm-intercept] Proto constructor: ${proto.constructor?.name ?? 'anonymous'}`);
      logger(`[lm-intercept] Proto own keys: ${Object.getOwnPropertyNames(proto).join(', ')}`);
    } else {
      logger('[lm-intercept] No meaningful prototype (plain object)');
    }

    // Check where sendRequest lives
    const instanceDesc = Object.getOwnPropertyDescriptor(model, 'sendRequest');
    const protoDesc = proto ? Object.getOwnPropertyDescriptor(proto, 'sendRequest') : undefined;

    logger(
      `[lm-intercept] sendRequest location: ` +
      `instance=${!!instanceDesc}(configurable=${instanceDesc?.configurable},writable=${instanceDesc?.writable},isAccessor=${!!instanceDesc?.get}) ` +
      `proto=${!!protoDesc}(configurable=${protoDesc?.configurable},writable=${protoDesc?.writable},isAccessor=${!!protoDesc?.get})`,
    );

    // Strategy 1: Patch the prototype (affects ALL model instances across ALL extensions)
    if (protoDesc && !protoDesc.get) {
      const canPatch = protoDesc.configurable || protoDesc.writable;
      if (canPatch) {
        return applyPatch(proto, protoDesc, 'prototype', logger);
      }
      logger('[lm-intercept] Proto sendRequest exists but is not patchable');
    }

    // Strategy 2: If sendRequest is on the instance, patch the instance
    // This only catches OUR model objects, not Copilot Chat's — but it's a diagnostic signal
    if (instanceDesc && !instanceDesc.get) {
      const canPatch = instanceDesc.configurable || instanceDesc.writable;
      if (canPatch) {
        logger('[lm-intercept] WARNING: Patching instance only — will NOT intercept Copilot Chat (diagnostic only)');
        return applyPatch(model, instanceDesc, 'instance', logger);
      }
    }

    // Strategy 3: Try patching via getter/setter if sendRequest is an accessor
    const desc = instanceDesc ?? protoDesc;
    const target = instanceDesc ? model : proto;
    if (desc?.get && desc.configurable) {
      logger('[lm-intercept] sendRequest is an accessor property — patching getter');
      return applyAccessorPatch(target, desc, target === proto ? 'prototype' : 'instance', logger);
    }

    logger('[lm-intercept] Could not find a patchable sendRequest — all strategies exhausted');
    return false;
  } catch (err) {
    logger(`[lm-intercept] Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function applyPatch(
  target: object,
  desc: PropertyDescriptor,
  location: 'prototype' | 'instance',
  logger: (msg: string) => void,
): boolean {
  originalSendRequest = desc.value as AnyFn;
  patchedTarget = target;
  patchLocation = location;

  const patched = createPatchedSendRequest(originalSendRequest);

  try {
    if (desc.writable) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (target as any).sendRequest = patched;
    } else if (desc.configurable) {
      Object.defineProperty(target, 'sendRequest', {
        value: patched,
        writable: true,
        configurable: true,
        enumerable: desc.enumerable,
      });
    }
    logger(`[lm-intercept] Patched sendRequest on ${location} — interception ACTIVE`);
    return true;
  } catch (err) {
    logger(`[lm-intercept] Failed to apply ${location} patch: ${err instanceof Error ? err.message : String(err)}`);
    originalSendRequest = null;
    patchedTarget = null;
    patchLocation = null;
    return false;
  }
}

function applyAccessorPatch(
  target: object,
  desc: PropertyDescriptor,
  location: 'prototype' | 'instance',
  logger: (msg: string) => void,
): boolean {
  const originalGet = desc.get!;
  patchedTarget = target;
  patchLocation = location;

  // We'll wrap the getter to return a patched function each time
  try {
    Object.defineProperty(target, 'sendRequest', {
      get() {
        const originalFn = originalGet.call(this) as AnyFn;
        if (!originalSendRequest) {
          originalSendRequest = originalFn;
        }
        return createPatchedSendRequest(originalFn);
      },
      set: desc.set,
      configurable: true,
      enumerable: desc.enumerable,
    });
    logger(`[lm-intercept] Patched sendRequest accessor on ${location} — interception ACTIVE`);
    return true;
  } catch (err) {
    logger(`[lm-intercept] Failed to apply accessor patch: ${err instanceof Error ? err.message : String(err)}`);
    patchedTarget = null;
    patchLocation = null;
    return false;
  }
}

function createPatchedSendRequest(original: AnyFn): AnyFn {
  return function patchedSendRequest(
    this: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    options?: vscode.LanguageModelChatRequestOptions,
    token?: vscode.CancellationToken,
  ) {
    interceptCount++;
    const interceptNum = interceptCount;
    const modelId = this?.id ?? 'unknown';

    logFn(`[lm-intercept] #${interceptNum} sendRequest intercepted! model=${modelId}, messages=${messages?.length ?? 0}`);

    // Capture the prompt
    const promptParts: string[] = [];
    try {
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          const role = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user'
            : msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant'
            : 'system';
          const text = extractMessageText(msg);
          promptParts.push(`[${role}] ${text}`);

          // Log first 300 chars of each message
          const preview = text.length > 300 ? text.slice(0, 300) + '...' : text;
          logFn(`[lm-intercept] #${interceptNum}   ${role}: ${preview}`);
        }
      }
    } catch (err) {
      logFn(`[lm-intercept] #${interceptNum} Error extracting prompt: ${err}`);
    }

    // Call original
    const result = original.call(this, messages, options, token);
    const prompt = promptParts.join('\n');
    const startTime = Date.now();

    // Wrap the response to capture completion tokens
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as Promise<vscode.LanguageModelChatResponse>).then(
        (response) => wrapResponse(response, modelId, prompt, startTime, interceptNum),
        (err: unknown) => {
          logFn(`[lm-intercept] #${interceptNum} Request failed: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        },
      );
    }

    return result;
  };
}

function wrapResponse(
  response: vscode.LanguageModelChatResponse,
  modelId: string,
  prompt: string,
  startTime: number,
  interceptNum: number,
): vscode.LanguageModelChatResponse {
  const originalText = response.text;
  const capturedParts: string[] = [];

  const wrappedText: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      const iterator = originalText[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<string>> {
          const result = await iterator.next();
          if (!result.done && result.value) {
            capturedParts.push(result.value);
          }
          if (result.done) {
            // Stream complete — flush to Argus
            const completion = capturedParts.join('');
            const durationMs = Date.now() - startTime;
            logFn(
              `[lm-intercept] #${interceptNum} Response complete: model=${modelId}, ` +
              `completion=${completion.length} chars, ${durationMs}ms`,
            );

            if (sendFn) {
              sendFn({
                session_id: `copilot-lm-${new Date().toISOString().slice(0, 10)}`,
                model_id: modelId,
                request_type: 'chat',
                prompt: prompt.slice(0, 50_000),
                completion: completion.slice(0, 100_000),
                duration_ms: durationMs,
                transport: 'vscode-lm-api',
                domain: 'api.individual.githubcopilot.com',
                method: 'POST',
                path: '/chat/completions',
                status_code: 200,
              });
            }
          }
          return result;
        },
      };
    },
  };

  // Return a response object with the wrapped text stream
  // Spread original properties, then override text
  const wrapped = Object.create(Object.getPrototypeOf(response));
  Object.assign(wrapped, response);
  Object.defineProperty(wrapped, 'text', {
    value: wrappedText,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  return wrapped;
}

/** Extract text content from a LanguageModelChatMessage, handling both string and part[] formats. */
function extractMessageText(msg: vscode.LanguageModelChatMessage): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content = (msg as any).content ?? (msg as any).text ?? (msg as any).value;

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          return String(p.value ?? p.text ?? p.content ?? '');
        }
        return String(part);
      })
      .join('');
  }

  // Try toString
  return String(content ?? '');
}

/** Restore the original sendRequest and clean up. */
export function stopLmIntercept(): void {
  if (originalSendRequest && patchedTarget) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (patchedTarget as any).sendRequest = originalSendRequest;
      logFn(`[lm-intercept] Restored original sendRequest on ${patchLocation}`);
    } catch {
      logFn('[lm-intercept] Failed to restore original sendRequest');
    }
  }
  originalSendRequest = null;
  patchedTarget = null;
  patchLocation = null;
  sendFn = null;
}

/** Get interception stats. */
export function getLmInterceptStats(): {
  active: boolean;
  interceptCount: number;
  patchLocation: string | null;
} {
  return {
    active: originalSendRequest !== null,
    interceptCount,
    patchLocation,
  };
}
