import { NextResponse } from 'next/server'
import { createClient } from '@/lib/data/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { orderNumbers } from '@/lib/whatsapp/sender-config'
import { getT } from '@/lib/i18n/translate'
import { mediaProxyHeaders } from '@/lib/media/proxy-response-headers'

const t = getT('Api')

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: t('media.idRequired') },
        { status: 400 }
      )
    }

    const db = await createClient()

    const {
      data: { user },
      error: authError,
    } = await db.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: t('common.unauthorized') },
        { status: 401 }
      )
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await db
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: t('common.profileNotLinked') },
        { status: 403 },
      )
    }

    // The workspace's numbers, default first. Meta hands a media id only to
    // the WABA it arrived on, so a workspace with numbers in several WABAs
    // (each with its own token) tries each distinct token in turn.
    const { data: rows, error: configError } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
    const configs = orderNumbers(
      ((Array.isArray(rows) ? rows : rows ? [rows] : []) as { id?: string; is_default?: boolean | null; created_at?: string | null; access_token?: string | null }[])
        .filter((row) => !!row.access_token)
    )

    if (configError || configs.length === 0) {
      return NextResponse.json(
        { error: t('common.whatsappNotConfigured') },
        { status: 400 }
      )
    }

    const tokens = [...new Set(configs.map((row) => decrypt(row.access_token!)))]
    let accessToken = ''
    let mediaInfo: Awaited<ReturnType<typeof getMediaUrl>> | null = null
    let lastError: unknown = null
    for (const token of tokens) {
      try {
        mediaInfo = await getMediaUrl({ mediaId, accessToken: token })
        accessToken = token
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!mediaInfo) throw lastError

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        ...mediaProxyHeaders(mediaId, contentType || mediaInfo.mimeType),
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: t('media.fetchFailed') },
      { status: 500 }
    )
  }
}
