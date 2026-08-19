import {
  createModels,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type Models,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import {
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { OPENAI_CODEX_PROVIDER, PROVIDER_DISPLAY_NAME } from './constants.ts'
import { safeLlmError } from './errors.ts'
import { toPiContext } from './context.ts'
import { toStreamChunks } from './stream.ts'
import type { DshPiCredentialStore } from './auth/credential-store.ts'

export interface OpenAICodexAdapterOptions {
  readonly credentials: DshPiCredentialStore
  readonly timeoutMs: number
  readonly resolveAttachments?: () => AttachmentStore | undefined
  readonly onReplayDegrade?: (reason: string) => void
}

/** One-route DSH adapter using Pi's installed OAuth provider unchanged. */
export class OpenAICodexAdapter extends LlmAdapter {
  readonly models: Models
  private readonly operations = new Set<AbortController>()
  private disposed = false

  constructor(private readonly options: OpenAICodexAdapterOptions) {
    super()
    const models = createModels({ credentials: options.credentials })
    models.setProvider(openaiCodexProvider())
    this.models = models
  }

  override providerInfo(provider: string): LlmProviderInfo {
    this.assertProvider(provider)
    return { id: provider, name: PROVIDER_DISPLAY_NAME }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.assertProvider(provider)
    return Promise.resolve(this.models.getModels(provider).map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
    })))
  }

  override resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.assertProvider(provider)
    if (signal?.aborted) return Promise.reject(new LlmError('OpenAI Codex model lookup was cancelled', 'ABORTED'))
    const model = this.model(modelId)
    const efforts = model.reasoning ? getSupportedThinkingLevels(model) : []
    return Promise.resolve({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
      context: { contextWindow: model.contextWindow },
      ...(efforts.length === 0 ? {} : {
        reasoning: {
          efforts: efforts.map(effort => ({ id: ReasoningEffortId(effort), name: title(effort) })),
        },
      }),
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.disposed) throw new LlmError('OpenAI Codex adapter is disposed', 'UNAVAILABLE')
    this.assertProvider(options.provider)
    if (options.stop !== undefined) throw new LlmError('OpenAI Codex does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    const model = this.model(options.model)
    const reasoning = resolveReasoning(model, options.reasoningEffort)
    const containsImage = options.messages.some(message => contentHasImage(message.content))
    if (containsImage && !model.input.includes('image')) {
      throw new LlmError(`OpenAI Codex model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
    }
    const attachments = containsImage ? this.options.resolveAttachments?.() : undefined
    if (containsImage && attachments === undefined) {
      throw new LlmError('OpenAI Codex image input requires the DSH attachment service', 'UNSUPPORTED_CONTENT')
    }

    const operation = new AbortController()
    this.operations.add(operation)
    const timeout = setTimeout(() => { operation.abort() }, this.options.timeoutMs)
    timeout.unref?.()
    const signal = options.signal === undefined
      ? operation.signal
      : AbortSignal.any([options.signal, operation.signal])
    try {
      const context = attachments === undefined
        ? toPiContext(options, undefined, this.options.onReplayDegrade)
        : await toPiContext(options, attachments, this.options.onReplayDegrade)
      const events = this.models.streamSimple(model, context, {
        ...(reasoning === undefined || reasoning === 'off' ? {} : { reasoning }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
        maxRetries: 0,
        transport: 'sse',
        timeoutMs: this.options.timeoutMs,
        signal,
      })
      const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const item = await iterator.next()
          if (item.done) {
            exhausted = true
            return
          }
          yield item.value
        }
      } finally {
        if (!exhausted) {
          operation.abort()
          try { await iterator.return?.(undefined) } catch {}
        }
      }
    } catch (error: unknown) {
      throw safeLlmError(error, options.signal?.aborted === true)
    } finally {
      clearTimeout(timeout)
      operation.abort()
      this.operations.delete(operation)
    }
  }

  /** Abort every live model operation during Cordis disposal. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const operation of this.operations) operation.abort()
    this.operations.clear()
  }

  private model(id: string): Model<Api> {
    const model = this.models.getModel(OPENAI_CODEX_PROVIDER, id)
    if (model === undefined) throw new LlmError(`OpenAI Codex has no installed model "${id}"`, 'UNKNOWN_MODEL')
    return model
  }

  private assertProvider(provider: string): void {
    if (provider !== OPENAI_CODEX_PROVIDER) throw new LlmError(`OpenAI Codex adapter does not own provider "${provider}"`, 'NO_ADAPTER')
  }
}

function resolveReasoning(model: Model<Api>, requested: ReasoningEffortIdType | undefined): ModelThinkingLevel | undefined {
  if (requested === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(value => value === requested)) return requested as ModelThinkingLevel
  throw new LlmError(`OpenAI Codex model "${model.id}" does not support reasoning effort "${requested}"`, 'UNSUPPORTED_REASONING_EFFORT')
}

function title(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}
