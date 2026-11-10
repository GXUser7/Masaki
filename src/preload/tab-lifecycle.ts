import { contextBridge, ipcRenderer } from 'electron'

// Сессионный preload работает и в iframe. Не импортировать в guest: sandbox не умеет общие chunks.
function installTabLifecycle(report: (protectedFromSleep: boolean) => void): void {
  let dirty = false
  const streams = new Set<MediaStream>()
  const peers = new Set<RTCPeerConnection>()
  let last: boolean | undefined
  const update = (): void => {
    for (const stream of streams) if (!stream.getTracks().some((track) => track.readyState === 'live')) streams.delete(stream)
    for (const peer of peers) if (peer.signalingState === 'closed') peers.delete(peer)
    const value = dirty || streams.size > 0 || peers.size > 0
    if (value !== last) { last = value; report(value) }
  }
  window.addEventListener('input', (event) => { if (event.isTrusted) { dirty = true; update() } }, true)
  window.addEventListener('change', (event) => { if (event.isTrusted) { dirty = true; update() } }, true)
  const devices = navigator.mediaDevices
  if (devices) for (const name of ['getUserMedia', 'getDisplayMedia'] as const) {
    const original = devices[name]
    if (!original) continue
    devices[name] = async function (options?: MediaStreamConstraints & DisplayMediaStreamOptions): Promise<MediaStream> {
      const stream = await original.call(this, options)
      streams.add(stream)
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', update)
        const stop = track.stop
        track.stop = function (): void { stop.call(this); update() }
      }
      update()
      return stream
    }
  }
  if (window.RTCPeerConnection) window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
    construct(target, args) {
      const peer = new target(...args)
      peers.add(peer)
      peer.addEventListener('signalingstatechange', update)
      update()
      return peer
    }
  })
  update()
}

contextBridge.executeInMainWorld({
  func: installTabLifecycle,
  args: [(protectedFromSleep: boolean): void => ipcRenderer.send('tab-memory:protect', protectedFromSleep)]
})
