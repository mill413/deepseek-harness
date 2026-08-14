import type { Context } from '@deepseek-ai/cordis'
import CredentialProvider, {
  credentialRef,
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'

export const OPENAI_COMPATIBLE_PROVIDER = 'openai-compatible'

const TENANT_API_KEY = credentialRef('DISTRIBUTED_TENANT_OPENAI_API_KEY')

interface TenantCredentialConfig {
  apiKey: string | null
}

/** Read-only operation-local credential seam backed by one tenant snapshot. */
class TenantCredentialProvider extends CredentialProvider {
  constructor(ctx: Context, private readonly config: TenantCredentialConfig) {
    super(ctx)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (ref !== TENANT_API_KEY || this.config.apiKey === null) return Promise.resolve(undefined)
    return Promise.resolve({ value: this.config.apiKey, source: 'tenant-postgresql' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = ref === TENANT_API_KEY && this.config.apiKey !== null
    return Promise.resolve({
      configured,
      ...(configured ? { source: 'tenant-postgresql' } : {}),
      writable: false,
    })
  }

  override set(): Promise<void> {
    return Promise.reject(new Error('tenant credentials are managed by the distributed model configuration API'))
  }

  override unset(): Promise<void> {
    return Promise.reject(new Error('tenant credentials are managed by the distributed model configuration API'))
  }
}

export interface Config {
  baseUrl: string
  model: string
  apiKey: string | null
}

export const name = 'distributed-openai-compatible'
export const inject = ['llm']

/** Mount the upstream pi-ai adapter as one tenant-scoped Chat Completions route. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(TenantCredentialProvider, { apiKey: config.apiKey })
  await ctx.plugin(LlmPiAi, {
    providers: {
      [OPENAI_COMPATIBLE_PROVIDER]: {
        displayName: 'OpenAI-compatible Chat Completions',
        ...(config.apiKey === null ? {} : { apiKeyEnv: TENANT_API_KEY }),
        api: 'openai-completions',
        baseURL: config.baseUrl,
        models: [{ id: config.model, name: config.model }],
      },
    },
  })
}
