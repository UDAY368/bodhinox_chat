'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Upload, Trash2, Mail, CircleAlert } from 'lucide-react';

import { createClient } from '@/lib/data/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { SETTINGS_ROW_HAIRLINE, SettingsBlock, SettingsGroup, SettingsMoreMenu, SettingsRow, SettingsSwitchRow } from './settings-row';
import { useLocale, useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';
import { useSettingsDraft } from './settings-draft';
import { saveLocale, syncLocale } from '@/lib/i18n/locale-client';
import { APP_LOCALES, type AppLocale } from '@/lib/i18n/locales';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

// The server performs the authoritative validation and verified email change.
/** The language menu's "use the workspace language" choice (null). */
const INHERIT = '__workspace__';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ProfileForm() {
  const t = useTranslations('Settings.profile');
  const { user, profile, refreshProfile } = useAuth();
  const db = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [saving, setSaving] = useState(false);
  const [emailChangePending, setEmailChangePending] = useState(false);
  const [pendingEmail, setPendingEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  // The member's own interface language (null follows the workspace default).
  const tLang = useTranslations('SettingsRedesign.languages');
  const tProfile = useTranslations('SettingsRedesign.profile');
  const router = useRouter();
  const shownLocale = useLocale();
  const [language, setLanguage] = useState<AppLocale | null>(null);
  const [savedLanguage, setSavedLanguage] = useState<AppLocale | null>(null);
  const [workspaceLanguage, setWorkspaceLanguage] = useState<AppLocale | null>(null);
  useEffect(() => {
    let live = true;
    void syncLocale().then((state) => {
      if (!live || !state) return;
      setLanguage(state.language);
      setSavedLanguage(state.language);
      setWorkspaceLanguage(state.workspace_language);
    });
    return () => { live = false; };
  }, []);
  const emailChanged =
    !!profile && email.trim().toLowerCase() !== profile.email.toLowerCase();

  // Seed form state once the profile loads.
  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? '');
    setEmail(profile.email ?? '');
  }, [profile]);

  // Cleanup object URLs to avoid leaks.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const profileDirty =
    !!profile &&
    (fullName.trim() !== (profile.full_name ?? '') ||
      email.trim().toLowerCase() !== (profile.email ?? '').toLowerCase() ||
      pendingAvatar !== null ||
      removeAvatar);
  const dirty = profileDirty || language !== savedLanguage;

  const currentAvatar =
    previewUrl ?? (!removeAvatar ? (profile?.avatar_url ?? null) : null);

  const initial = (fullName || profile?.full_name || profile?.email || 'U')
    .charAt(0)
    .toUpperCase();

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so the same file can be re-picked
    if (!file) return;

    if (!ALLOWED_MIME.has(file.type)) {
      toast.error(t('unsupportedImage'), {
        description: t('unsupportedImageDesc'),
      });
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast.error(t('imageTooLarge'), {
        description: t('imageTooLargeDesc'),
      });
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingAvatar(file);
    setPreviewUrl(URL.createObjectURL(file));
    setRemoveAvatar(false);
  };

  const onRemoveAvatar = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingAvatar(null);
    setPreviewUrl(null);
    setRemoveAvatar(true);
  };

  const onSubmit = async (e?: React.FormEvent): Promise<boolean> => {
    e?.preventDefault();
    if (!user || !profile) return false;
    if (language !== savedLanguage) {
      try {
        const state = await saveLocale(language);
        setSavedLanguage(state.language);
        if (!profileDirty) toast.success(t('profileSaved'));
        if (state.effective !== shownLocale) router.refresh();
      } catch {
        toast.error(tProfile('languageFailed'));
        return false;
      }
    }
    if (!profileDirty) return true;

    const trimmedName = fullName.trim();
    if (!trimmedName) {
      toast.error(t('nameRequired'));
      return false;
    }
    const trimmedEmail = email.trim();
    if (!EMAIL_RE.test(trimmedEmail)) {
      toast.error(t('invalidEmail'));
      return false;
    }
    if (emailChanged && !currentPassword) {
      toast.error('Enter your current password to change your email');
      return false;
    }

    setSaving(true);
    try {
      let nextAvatarUrl: string | null = profile.avatar_url ?? null;

      // Upload a newly-staged image, if any.
      if (pendingAvatar) {
        const ext = pendingAvatar.name.split('.').pop()?.toLowerCase() || 'png';
        const path = `${user.id}/avatar-${Date.now()}.${ext}`;
        const { error: uploadError } = await db.storage
          .from('avatars')
          .upload(path, pendingAvatar, {
            cacheControl: '3600',
            upsert: true,
            contentType: pendingAvatar.type,
          });
        if (uploadError) {
          throw new Error(t('uploadFailed', { message: uploadError.message }));
        }
        const {
          data: { publicUrl },
        } = db.storage.from('avatars').getPublicUrl(path);
        nextAvatarUrl = publicUrl;
      } else if (removeAvatar) {
        nextAvatarUrl = null;
      }

      if (trimmedName !== profile.full_name) {
        const result = await db.auth.updateUser({
          data: { full_name: trimmedName },
        });
        if (result.error) throw new Error(result.error.message);
      }
      // Persist the profile projection and avatar after the identity name update.
      const { error: updateError } = await db
        .from('profiles')
        .update({
          full_name: trimmedName,
          avatar_url: nextAvatarUrl,
        })
        .eq('user_id', user.id);
      if (updateError) {
        throw new Error(t('saveFailed', { message: updateError.message }));
      }

      // Reauthenticate, verify the new address, then atomically change identity/profile and revoke sessions.
      let emailSent = false;
      if (trimmedEmail.toLowerCase() !== profile.email.toLowerCase()) {
        const { error: emailError } = await db.auth.updateUser({
          email: trimmedEmail,
          currentPassword,
          mfaCode: mfaCode || undefined,
        });
        if (emailError) {
          // Partial success: name/avatar saved but email didn't.
          toast.success(t('profileSaved'));
          toast.error(t('emailChangeFailed', { message: emailError.message }));
          setSaving(false);
          await refreshProfile();
          return false;
        }
        emailSent = true;
        setPendingEmail(trimmedEmail);
        setCurrentPassword('');
        setMfaCode('');
      }

      setEmailChangePending(emailSent);
      setPendingAvatar(null);
      setPreviewUrl(null);
      setRemoveAvatar(false);
      await refreshProfile();

      toast.success(
        emailSent ? t('profileSavedEmailCheck') : t('profileSaved')
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('unknownError');
      toast.error(msg);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const discard = useCallback(() => {
    setFullName(profile?.full_name ?? '');
    setEmail(profile?.email ?? '');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingAvatar(null);
    setPreviewUrl(null);
    setRemoveAvatar(false);
    setCurrentPassword('');
    setMfaCode('');
    setLanguage(savedLanguage);
  }, [profile, previewUrl, savedLanguage]);

  // The page's Unsaved changes bar saves and discards this form.
  useSettingsDraft('profile', { dirty, saving, save: () => onSubmit(), discard });

  const joined = user?.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '—';
  const inheritLabel = workspaceLanguage
    ? tProfile('languageWorkspace', { language: tLang(workspaceLanguage) })
    : tProfile('languageDefault');

  return (
    <section className="animate-in fade-in-50 max-w-2xl duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <form onSubmit={onSubmit} className="space-y-8">
        {/* Photo: one action (change), removing it sits in the group's more menu. */}
        <SettingsGroup>
          <div className={`${SETTINGS_ROW_HAIRLINE} flex min-h-11 items-center gap-4 px-4 py-3`}>
            <Avatar size="lg" className="size-14 shrink-0">
              {currentAvatar ? (
                <AvatarImage
                  src={currentAvatar}
                  alt={fullName || t('avatarAlt')}
                />
              ) : null}
              <AvatarFallback className="bg-primary/10 text-primary text-base">
                {initial}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{fullName || profile?.email || '—'}</p>
              <p className="text-muted-foreground text-xs">{t('photoHint')}</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={onPickFile}
            />
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={saving}
              >
                <Upload className="size-4" />
                <span className="hidden sm:inline">{currentAvatar ? t('changePhoto') : t('uploadPhoto')}</span>
                <span className="sr-only sm:hidden">{currentAvatar ? t('changePhoto') : t('uploadPhoto')}</span>
              </Button>
              <SettingsMoreMenu
                actions={[{ label: t('remove'), icon: Trash2, destructive: true, disabled: saving, hidden: !currentAvatar, onSelect: onRemoveAvatar }]}
              />
            </div>
          </div>
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow label={t('displayName')} htmlFor="profile-full-name">
            <Input
              id="profile-full-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={t('fullNamePlaceholder')}
              maxLength={120}
              disabled={saving}
              required
            />
          </SettingsRow>
          <SettingsRow label={t('email')} htmlFor="profile-email">
            <Input
              id="profile-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={saving}
              required
            />
          </SettingsRow>
          {emailChangePending && (
            <SettingsBlock>
              <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <Mail className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Check {pendingEmail} for a confirmation link. Your current
                  email stays active until confirmation. Confirming signs out
                  every device.
                </span>
              </p>
            </SettingsBlock>
          )}
          {emailChanged && (
            <>
              <SettingsRow label="Current password" htmlFor="email-current-password">
                <PasswordInput
                  id="email-current-password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  disabled={saving}
                  required
                />
              </SettingsRow>
              <SettingsRow label="Authenticator or recovery code (if enabled)" htmlFor="email-mfa-code">
                <Input
                  id="email-mfa-code"
                  autoComplete="one-time-code"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  disabled={saving}
                />
              </SettingsRow>
            </>
          )}
        </SettingsGroup>

        {/* Interface language: the member's own, else the workspace default. */}
        <SettingsGroup footer={tProfile('languageHint')}>
          <SettingsRow label={tProfile('language')} htmlFor="profile-language">
            <Select
              value={language ?? INHERIT}
              disabled={saving}
              onValueChange={(v) => setLanguage((!v || v === INHERIT ? null : v) as AppLocale | null)}
            >
              <SelectTrigger id="profile-language" className="min-h-11 w-full sm:min-h-9">
                <SelectValue>{(v: string) => (v === INHERIT ? inheritLabel : tLang(v as AppLocale))}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>{inheritLabel}</SelectItem>
                {APP_LOCALES.map((code) => <SelectItem key={code} value={code}>{tLang(code)}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsGroup>

        {/* Read-only account details. */}
        <SettingsGroup title={t('accountDetails')}>
          <GroupedListRow title={t('role')} trailing={<span className="font-mono">{profile?.role ?? 'user'}</span>} />
          <GroupedListRow title={t('joined')} trailing={joined} />
          <SettingsSwitchRow title={t('userId')} description={<span className="font-mono break-all">{user?.id ?? '—'}</span>} control={null} />
        </SettingsGroup>

        {!profile && (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <CircleAlert className="size-4" />
            {t('loading')}
          </p>
        )}

        {/* Saving and discarding happen from the page's Unsaved changes bar;
            this hidden button keeps Enter-to-save inside the form. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden disabled={saving || !dirty || !profile}>
          {t('saveChanges')}
        </button>
      </form>
    </section>
  );
}
