'use client';
import { authFetch } from "@/lib/auth/client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Sparkles, CheckCircle2, Trash2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { PageLoading } from '@/components/ui/page-loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';
import { AiKnowledgeCard } from './ai-knowledge';
import { AI_PROVIDER_DEFAULT_MODEL, AI_PROVIDER_MODELS, OTHER_MODEL, modelChoice } from '@/lib/ai/defaults';
import type { AiProvider } from '@/lib/ai/types';
import { isOpenRouterBaseUrl, OPENROUTER_BASE_URL, OPENROUTER_FREE_MODEL, type OpenRouterModel } from '@/lib/ai/openrouter';
import type { AccountMember } from '@/types';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import { useTranslations } from 'next-intl';
import { SettingsBlock, SettingsGroup } from "./settings-row";

const MASKED_KEY = '••••••••••••••••';

// Radix Select can't use an empty-string item value, so the "leave
// unassigned" choice gets a sentinel that maps to null in the payload.
const HANDOFF_QUEUE = '__queue__';

const PROVIDER_LABEL: Record<Exclude<AiProvider, 'openai_compatible'>, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
  openai_compatible: 'your-api-key',
  gemini: '',
};

export function AiConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.aiConfig');
  const confirm = useConfirm();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // The last "Test connection" answer, shown in words under the button.
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  // The model picker shows "Other…" (free text) for an unlisted id, or when chosen.
  const [otherModel, setOtherModel] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [savedProvider, setSavedProvider] = useState<AiProvider | null>(null);
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai);
  const [baseUrl, setBaseUrl] = useState('');
  const [savedBaseUrl, setSavedBaseUrl] = useState('');
  const [freeModels, setFreeModels] = useState<OpenRouterModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [catalogAvailable, setCatalogAvailable] = useState(true);
  const openRouter = provider === 'openai_compatible' && isOpenRouterBaseUrl(baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  // Stage 2: the Instagram switch, shown only when the workspace uses Instagram.
  const [instagramAutoReply, setInstagramAutoReply] = useState(false);
  const { data: channels } = useWorkspaceChannels();
  const instagramChannel = channels?.channels.instagram;
  const showInstagram = Boolean(instagramChannel?.enabled) || instagramAutoReply;
  const instagramConnected = instagramChannel?.connection !== undefined && instagramChannel.connection !== 'none';
  const anyAutoReply = autoReplyEnabled || instagramAutoReply;
  const [maxPerConversation, setMaxPerConversation] = useState(3);
  // Empty string = leave unassigned (shared queue).
  const [handoffAgentId, setHandoffAgentId] = useState('');
  const [members, setMembers] = useState<AccountMember[]>([]);

  // Guard keyed on the account (not a bare boolean) so an in-place
  // account switch — ownership transfer, multi-account membership —
  // refetches instead of showing the previous account's config. Mirrors
  // the loadedAccountIdRef pattern in whatsapp-config.tsx.
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch('/api/ai/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setProvider(data.provider);
        setSavedProvider(data.provider);
        setModel(data.model);
        setOtherModel(false);
        setBaseUrl(data.base_url ?? '');
        setSavedBaseUrl(data.base_url ?? '');
        setSystemPrompt(data.system_prompt ?? '');
        setIsActive(data.is_active);
        setAutoReplyEnabled(data.auto_reply_enabled);
        setInstagramAutoReply(data.instagram_auto_reply_enabled === true);
        setMaxPerConversation(data.auto_reply_max_per_conversation ?? 3);
        setHandoffAgentId(data.handoff_agent_id ?? '');
        setHasStoredKey(Boolean(data.has_key));
        setApiKey(data.has_key ? MASKED_KEY : '');
        setKeyEdited(false);
        setHasStoredEmbeddingsKey(Boolean(data.has_embeddings_key));
        setEmbeddingsKey(data.has_embeddings_key ? MASKED_KEY : '');
        setEmbeddingsKeyEdited(false);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
    // Members populate the handoff-target picker. Best-effort — on an
    // older deployment without the endpoint the picker just shows the
    // queue option.
    void fetchAccountMembers().then(setMembers);
  }, [accountId, fetchConfig]);

  // Swap the model default when the provider changes, unless the user
  // typed a custom model.
  const handleProviderChange = (next: AiProvider) => {
    setProvider(next);
    const isListedModel = Object.values(AI_PROVIDER_MODELS).some((list) => list.includes(model)) ||
      Object.values(AI_PROVIDER_DEFAULT_MODEL).includes(model) || model.trim() === '';
    if (isListedModel) {
      setModel(next === 'openai_compatible' ? '' : AI_PROVIDER_DEFAULT_MODEL[next]);
      setOtherModel(false);
    }
    setTestResult(null);
    const keyAvailable = next === savedProvider && hasStoredKey;
    setApiKey(keyAvailable && next !== 'gemini' ? MASKED_KEY : '');
    setKeyEdited(false);
  };

  useEffect(() => {
    if (!openRouter || !canEdit) return;
    let cancelled = false;
    setModelsLoading(true);
    setFreeModels([]);
    void authFetch('/api/ai/openrouter-models').then(async (response) => {
      const data = await response.json();
      if (cancelled) return;
      setFreeModels(response.ok && Array.isArray(data.models) ? data.models : []);
      setCatalogAvailable(response.ok && data.available === true);
    }).catch(() => {
      if (!cancelled) setCatalogAvailable(false);
    }).finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [openRouter, canEdit, accountId]);

  const selectProvider = (next: string) => {
    if (next === 'openrouter') {
      handleProviderChange('openai_compatible');
      setBaseUrl(OPENROUTER_BASE_URL);
      setModel(OPENROUTER_FREE_MODEL);
      setApiKey(savedProvider === 'openai_compatible' && isOpenRouterBaseUrl(savedBaseUrl) && hasStoredKey ? MASKED_KEY : '');
    } else {
      handleProviderChange(next as AiProvider);
      if (next === 'openai_compatible') setBaseUrl('');
    }
    setShowKey(false);
  };

  const keyPayload = () => (provider !== 'gemini' && keyEdited ? apiKey.trim() : undefined);

  // undefined = leave unchanged; '' typed = null (clear); text = set.
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited ? embeddingsKey.trim() || null : undefined;

  const buildBody = () => ({
    provider,
    model: model.trim(),
    base_url: provider === 'openai_compatible' ? baseUrl.trim() : null,
    api_key: keyPayload(),
    embeddings_api_key: embeddingsKeyPayload(),
    system_prompt: systemPrompt.trim() || null,
    is_active: isActive,
    auto_reply_enabled: autoReplyEnabled,
    instagram_auto_reply_enabled: instagramAutoReply,
    auto_reply_max_per_conversation: maxPerConversation,
    handoff_agent_id: handoffAgentId || null,
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await authFetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          base_url: provider === 'openai_compatible' ? baseUrl.trim() : null,
          api_key: keyPayload(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      setTestResult(res.ok
        ? { ok: true, message: t('testSuccess') }
        : { ok: false, message: data.error ?? t('testRejected') });
    } catch {
      setTestResult({ ok: false, message: t('testNetworkError') });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!model.trim()) {
      toast.error(t('missingModel'));
      return;
    }
    if (provider === 'openai_compatible' && !baseUrl.trim()) {
      toast.error(t('missingBaseUrl'));
      return;
    }
    if (provider !== 'gemini' && !keyEdited && (provider !== savedProvider || !hasStoredKey ||
      (provider === 'openai_compatible' && baseUrl.trim().replace(/\/+$/, '') !== savedBaseUrl.trim().replace(/\/+$/, '')))) {
      toast.error(t('missingApiKey'));
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        await fetchConfig();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    const ok = await confirm({
      title: t('removeConfirmTitle'),
      body: t('removeConfirmBody'),
      confirmLabel: t('removeConfirmAction'),
      destructive: true,
    });
    if (!ok) return;
    setRemoving(true);
    try {
      const res = await authFetch('/api/ai/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setSavedProvider(null);
        setBaseUrl('');
        setHasStoredKey(false);
        setApiKey('');
        setKeyEdited(false);
        setIsActive(false);
        setAutoReplyEnabled(false);
        setSystemPrompt('');
        setHandoffAgentId('');
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div role="status" aria-label={t('loading')}>
        <PageLoading rows={5} />
      </div>
    );
  }

  const disabled = !canEdit || saving;
  const modelList = AI_PROVIDER_MODELS[provider];
  const modelPick = otherModel || modelList.length === 0 ? OTHER_MODEL : modelChoice(provider, model);
  // The key itself never comes back to the browser; only whether one is stored.
  const connected = configured && savedProvider === provider && (provider === 'gemini' || hasStoredKey);
  const testButton = (
    <Button variant="outline" onClick={handleTest} disabled={disabled || testing} className="min-h-11 sm:min-h-9">
      {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
      {t('testConnection')}
    </Button>
  );

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <SettingsGroup title={<><Sparkles className="h-4 w-4 text-primary" /> {t('connectStep')}</>} footer={provider === 'gemini' ? t('geminiSecurityNotice') : t('encryptionNotice')}>
          <SettingsBlock className="space-y-4">
            <p className="text-sm font-medium text-muted-foreground" role="status">
              {connected ? t('connectedKeySaved') : t('notConnected')}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ai-provider">{t('provider')}</Label>
                <Select
                  value={openRouter ? 'openrouter' : provider}
                  onValueChange={(v) => { if (v) selectProvider(v); }}
                  disabled={disabled}
                >
                  <SelectTrigger id="ai-provider">
                    <SelectValue>{openRouter ? 'OpenRouter — free models' : provider === 'openai_compatible' ? t('providerOpenAiCompatible') : PROVIDER_LABEL[provider]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">{PROVIDER_LABEL.openai}</SelectItem>
                    <SelectItem value="anthropic">
                      {PROVIDER_LABEL.anthropic}
                    </SelectItem>
                    <SelectItem value="gemini">{PROVIDER_LABEL.gemini}</SelectItem>
                    <SelectItem value="openrouter">OpenRouter — free models</SelectItem>
                    <SelectItem value="openai_compatible">
                      {t('providerOpenAiCompatible')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor={modelList.length ? 'ai-model-pick' : 'ai-model'}>{t('model')}</Label>
                {modelList.length > 0 && (
                  <Select
                    value={modelPick}
                    onValueChange={(v) => {
                      if (!v) return;
                      if (v === OTHER_MODEL) { setOtherModel(true); return; }
                      setOtherModel(false);
                      setModel(v);
                    }}
                    disabled={disabled}
                  >
                    <SelectTrigger id="ai-model-pick">
                      <SelectValue>
                        {modelPick === OTHER_MODEL ? t('otherModel') : modelPick === modelList[0] ? t('recommendedModel', { model: modelPick }) : modelPick}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {modelList.map((id, i) => (
                        <SelectItem key={id} value={id}>{i === 0 ? t('recommendedModel', { model: id }) : id}</SelectItem>
                      ))}
                      <SelectItem value={OTHER_MODEL}>{t('otherModel')}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                {modelPick === OTHER_MODEL && (
                  <Input
                    id="ai-model"
                    aria-label={t('modelId')}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={AI_PROVIDER_DEFAULT_MODEL[provider]}
                    disabled={disabled}
                  />
                )}
                {openRouter && (
                  <div className="space-y-2">
                    <Label htmlFor="ai-free-model">{t('freeModels')}</Label>
                    <Select value={model || OPENROUTER_FREE_MODEL} onValueChange={(v) => { if (v) setModel(v); }} disabled={disabled || modelsLoading}>
                      <SelectTrigger id="ai-free-model">
                        <SelectValue>
                          {model === OPENROUTER_FREE_MODEL || !model ? t('automaticFreeModel') : freeModels.find((item) => item.id === model)?.name ?? model}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={OPENROUTER_FREE_MODEL}>{t('automaticFreeModel')}</SelectItem>
                        {model && model !== OPENROUTER_FREE_MODEL && !freeModels.some((item) => item.id === model) && <SelectItem value={model}>{model}</SelectItem>}
                        {freeModels.filter((item) => item.id !== OPENROUTER_FREE_MODEL).map((item) => (
                          <SelectItem key={item.id} value={item.id}>{item.name} ({item.id})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{modelsLoading ? t('loadingFreeModels') : !catalogAvailable ? t('freeModelsUnavailable') : t('openRouterHint')}</p>
                  </div>
                )}
              </div>

              {provider === 'openai_compatible' && (
                <div className="space-y-2">
                  <Label htmlFor="ai-base-url">{t('baseUrl')}</Label>
                  <Input
                    id="ai-base-url"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.example.com/v1"
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">{t('baseUrlHint')}</p>
                </div>
              )}
            </div>

            {provider === 'gemini' ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 p-3">
                <p className="flex-1 text-sm text-muted-foreground">{t('geminiEnvHint')}</p>
                {testButton}
              </div>
            ) : <div className="space-y-2">
              <Label htmlFor="ai-key">{t('apiKey')}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="ai-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setKeyEdited(true);
                    }}
                    onFocus={() => {
                      if (!keyEdited && hasStoredKey) {
                        setApiKey('');
                        setKeyEdited(true);
                      }
                    }}
                    placeholder={KEY_PLACEHOLDER[provider]}
                    className="pr-11 sm:pr-9"
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    aria-label={showKey ? t('hideKey') : t('showKey')}
                    aria-pressed={showKey}
                    className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-foreground sm:size-9"
                  >
                    {showKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                {testButton}
              </div>
            </div>}

            {testResult && (
              <p role="status" className={testResult.ok ? 'text-sm text-emerald-700 dark:text-emerald-400' : 'text-sm text-destructive'}>
                {testResult.ok ? testResult.message : t('testFailed', { reason: testResult.message })}
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="ai-embeddings-key">
                {t('embeddingsKey')}{' '}
                <span className="font-normal text-muted-foreground">
                  {t('optionalSemanticSearch')}
                </span>
              </Label>
              <Input
                id="ai-embeddings-key"
                type="password"
                value={embeddingsKey}
                onChange={(e) => {
                  setEmbeddingsKey(e.target.value);
                  setEmbeddingsKeyEdited(true);
                }}
                onFocus={() => {
                  if (!embeddingsKeyEdited && hasStoredEmbeddingsKey) {
                    setEmbeddingsKey('');
                    setEmbeddingsKeyEdited(true);
                  }
                }}
                placeholder="sk-... (OpenAI)"
                disabled={disabled}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                {t('embeddingsHint', {
                  sameKeyText: provider === 'openai' ? t('sameKeyText') : '',
                })}
              </p>
            </div>
          </SettingsBlock>
        </SettingsGroup>

        <SettingsGroup title={t('behaviour')} footer={t('behaviourDesc')}>
          <SettingsBlock className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-prompt">{t('businessContext')}</Label>
              <Textarea
                id="ai-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t('promptPlaceholder')}
                rows={5}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('enableAssistant')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('enableAssistantDesc')}
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('autoReply')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('autoReplyDesc')}
                </p>
              </div>
              <Switch
                checked={autoReplyEnabled}
                onCheckedChange={setAutoReplyEnabled}
                disabled={disabled || !isActive}
              />
            </div>

            {showInstagram && (
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t('instagram.autoReply')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {instagramConnected || instagramAutoReply ? t('instagram.autoReplyHelp') : t('instagram.unavailable')}
                  </p>
                </div>
                {/* Turning it off always works; turning it on needs the assistant on and a connected account. */}
                <Switch
                  checked={instagramAutoReply}
                  onCheckedChange={setInstagramAutoReply}
                  aria-label={t('instagram.autoReply')}
                  disabled={disabled || (!instagramAutoReply && (!isActive || !instagramConnected))}
                />
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-max">{t('maxAutoReplies')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('maxAutoRepliesDesc')}
                </p>
              </div>
              <Input
                id="ai-max"
                type="number"
                min={1}
                max={20}
                value={maxPerConversation}
                onChange={(e) =>
                  setMaxPerConversation(
                    Math.min(20, Math.max(1, Number(e.target.value) || 1)),
                  )
                }
                disabled={disabled || !anyAutoReply}
                className="w-20"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-handoff">{t('handoffTo')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('handoffToDesc')}
              </p>
              <Select
                value={handoffAgentId || HANDOFF_QUEUE}
                onValueChange={(v) =>
                  setHandoffAgentId(!v || v === HANDOFF_QUEUE ? '' : v)
                }
                disabled={disabled || !anyAutoReply}
              >
                <SelectTrigger id="ai-handoff">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={HANDOFF_QUEUE}>
                    {t('handoffQueue')}
                  </SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {memberLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </SettingsBlock>
        </SettingsGroup>

        <AiKnowledgeCard
          accountId={accountId}
          canEdit={canEdit}
          hasEmbeddingsKey={
            embeddingsKeyEdited
              ? embeddingsKey.trim().length > 0
              : hasStoredEmbeddingsKey
          }
        />

        <div className="flex items-center justify-between">
          {configured ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="min-h-11 text-destructive hover:text-destructive sm:min-h-9"
            >
              {removing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t('remove')}
            </Button>
          ) : (
            <span />
          )}

          <Button onClick={handleSave} disabled={disabled} className="min-h-11 sm:min-h-9">
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
