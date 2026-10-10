/**
 * Ключи доступа Masaki в мире страницы: подменяет navigator.credentials.create/get для publicKey
 * и отдаёт запрос главному процессу через bridge (функция изолированного мира, её пробрасывает
 * contextBridge). Функция сериализуется (contextBridge.executeInMainWorld), поэтому всё нужное —
 * внутри неё: никаких импортов и ссылок наружу.
 *
 * Двоичные данные через мост идут строками base64url. Ответ превращается в объекты с прототипами
 * PublicKeyCredential и AuthenticatorAttestationResponse / AuthenticatorAssertionResponse —
 * так их принимают и библиотеки сайтов (instanceof, toJSON, getTransports, getPublicKey…).
 */
export function installPasskeys(bridge: (op: string, json: string) => Promise<string>): void {
  const PKC = window.PublicKeyCredential
  const Container = window.CredentialsContainer
  if (!PKC || !Container || !window.isSecureContext) return
  const proto = Container.prototype
  const origCreate = proto.create
  const origGet = proto.get

  const enc = (bs: unknown): string => {
    let u: Uint8Array
    if (bs instanceof ArrayBuffer) u = new Uint8Array(bs)
    else if (ArrayBuffer.isView(bs)) u = new Uint8Array(bs.buffer, bs.byteOffset, bs.byteLength)
    else throw new TypeError("Failed to execute: value is not of type '(ArrayBuffer or ArrayBufferView)'.")
    let s = ''
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i])
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const dec = (s: string): ArrayBuffer => {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    const u = new Uint8Array(b.length)
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i)
    return u.buffer
  }
  type Desc = { type?: string; id: unknown; transports?: string[] }
  const descs = (list: unknown): { type?: string; id: string }[] =>
    Array.isArray(list) ? (list as Desc[]).map((d) => ({ type: d.type, id: enc(d.id) })) : []
  const define = (o: object, props: Record<string, unknown>): void => {
    for (const k of Object.keys(props)) Object.defineProperty(o, k, { value: props[k], enumerable: true, configurable: true })
  }

  type Wire = {
    id: string
    rawId: string
    authenticatorAttachment: string
    clientExtensionResults: Record<string, unknown>
    response: Record<string, string | number | string[] | null>
  }
  const build = (create: boolean, c: Wire): PublicKeyCredential => {
    const r = c.response
    const resp = Object.create(create ? AuthenticatorAttestationResponse.prototype : AuthenticatorAssertionResponse.prototype) as object
    define(resp, { clientDataJSON: dec(r.clientDataJSON as string) })
    let json: Record<string, unknown>
    if (create) {
      const authData = dec(r.authenticatorData as string)
      const spki = r.publicKey ? dec(r.publicKey as string) : null
      const transports = (r.transports as string[]).slice()
      define(resp, {
        attestationObject: dec(r.attestationObject as string),
        getTransports: () => transports.slice(),
        getAuthenticatorData: () => authData.slice(0),
        getPublicKey: () => (spki ? spki.slice(0) : null),
        getPublicKeyAlgorithm: () => r.publicKeyAlgorithm
      })
      json = {
        clientDataJSON: r.clientDataJSON,
        attestationObject: r.attestationObject,
        authenticatorData: r.authenticatorData,
        transports,
        publicKey: r.publicKey,
        publicKeyAlgorithm: r.publicKeyAlgorithm
      }
    } else {
      define(resp, {
        authenticatorData: dec(r.authenticatorData as string),
        signature: dec(r.signature as string),
        userHandle: r.userHandle ? dec(r.userHandle as string) : null
      })
      json = { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle ?? undefined }
    }
    const cred = Object.create(PKC.prototype) as PublicKeyCredential
    const ext = c.clientExtensionResults ?? {}
    define(cred, {
      id: c.id,
      rawId: dec(c.rawId),
      type: 'public-key',
      authenticatorAttachment: c.authenticatorAttachment,
      response: resp,
      getClientExtensionResults: () => JSON.parse(JSON.stringify(ext)),
      toJSON: () => ({ id: c.id, rawId: c.rawId, type: 'public-key', authenticatorAttachment: c.authenticatorAttachment, clientExtensionResults: ext, response: json })
    })
    return cred
  }

  let seq = 0
  const run = (
    op: 'create' | 'get',
    payload: Record<string, unknown>,
    options: CredentialCreationOptions | CredentialRequestOptions,
    orig: (o: unknown) => Promise<Credential | null>,
    self: CredentialsContainer
  ): Promise<Credential | null> =>
    new Promise((resolve, reject) => {
      const signal = options.signal
      const aborted = (): unknown => signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
      if (signal?.aborted) return reject(aborted())
      const id = ++seq + '-' + Math.random().toString(36).slice(2, 10)
      let done = false
      const onAbort = (): void => {
        if (done) return
        done = true
        void bridge('abort', JSON.stringify({ id })).catch(() => undefined)
        reject(aborted())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      bridge(op, JSON.stringify({ id, ...payload })).then(
        (text) => {
          if (done) return
          done = true
          signal?.removeEventListener('abort', onAbort)
          const r = JSON.parse(text) as { ok?: boolean; fallback?: boolean; name?: string; message?: string; cred?: Wire }
          // «Ключ безопасности…» — запрос уходит встроенному WebAuthn как есть.
          if (r.fallback) return resolve(orig.call(self, options))
          if (!r.ok || !r.cred) {
            return reject(r.name === 'TypeError' ? new TypeError(r.message) : new DOMException(r.message ?? '', r.name ?? 'NotAllowedError'))
          }
          resolve(build(op === 'create', r.cred))
        },
        () => {
          if (done) return
          done = true
          reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'))
        }
      )
    })

  const create = function (this: CredentialsContainer, options?: CredentialCreationOptions): Promise<Credential | null> {
    const pk = options?.publicKey
    if (!options || !pk) return origCreate.call(this, options)
    // «Тихое» создание ключа после входа паролем пока не поддерживаем — как отказ пользователя.
    if ((options as { mediation?: string }).mediation === 'conditional') {
      return Promise.reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'))
    }
    let payload: Record<string, unknown>
    try {
      const sel = pk.authenticatorSelection
      payload = {
        publicKey: {
          rp: { id: pk.rp?.id, name: pk.rp?.name },
          user: { id: enc(pk.user?.id), name: pk.user?.name, displayName: pk.user?.displayName },
          challenge: enc(pk.challenge),
          pubKeyCredParams: (pk.pubKeyCredParams ?? []).map((p) => ({ type: p.type, alg: p.alg })),
          timeout: pk.timeout,
          excludeCredentials: descs(pk.excludeCredentials),
          authenticatorSelection: sel
            ? { authenticatorAttachment: sel.authenticatorAttachment, residentKey: sel.residentKey, userVerification: sel.userVerification }
            : undefined,
          attestation: pk.attestation,
          extensions: { credProps: !!(pk.extensions as { credProps?: boolean } | undefined)?.credProps }
        }
      }
    } catch (e) {
      return Promise.reject(e)
    }
    return run('create', payload, options, origCreate as (o: unknown) => Promise<Credential | null>, this)
  }

  const get = function (this: CredentialsContainer, options?: CredentialRequestOptions): Promise<Credential | null> {
    const pk = options?.publicKey
    if (!options || !pk) return origGet.call(this, options)
    let payload: Record<string, unknown>
    try {
      payload = {
        mediation: options.mediation,
        publicKey: {
          challenge: enc(pk.challenge),
          timeout: pk.timeout,
          rpId: pk.rpId,
          allowCredentials: descs(pk.allowCredentials),
          userVerification: pk.userVerification
        }
      }
    } catch (e) {
      return Promise.reject(e)
    }
    return run('get', payload, options, origGet as (o: unknown) => Promise<Credential | null>, this)
  }

  const method = (o: object, name: string, fn: unknown): void => {
    Object.defineProperty(o, name, { value: fn, writable: true, configurable: true, enumerable: false })
  }
  method(proto, 'create', create)
  method(proto, 'get', get)
  // Сайты показывают «Создать ключ доступа» и вход по ключу в автозаполнении, только если платформа это умеет.
  method(PKC, 'isUserVerifyingPlatformAuthenticatorAvailable', () => Promise.resolve(true))
  method(PKC, 'isConditionalMediationAvailable', () => Promise.resolve(true))
  const caps = (PKC as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities
  if (caps) {
    method(PKC, 'getClientCapabilities', () =>
      caps
        .call(PKC)
        .catch(() => ({}))
        .then((c) => ({
          ...c,
          conditionalCreate: false,
          conditionalGet: true,
          hybridTransport: false,
          passkeyPlatformAuthenticator: true,
          userVerifyingPlatformAuthenticator: true
        }))
    )
  }
}
