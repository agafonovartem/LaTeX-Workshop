import type { PanelRequest } from '../../types/latex-workshop-protocol-types/index'

export interface INativePdfView {
    pdfFileUri: string,
    pdfUrl: string,
    workerSrc: string,
    cMapUrl: string,
    standardFontDataUrl: string,
    wasmUrl: string,
    imageResourcesPath: string,
    ready: Promise<string>,
    reloadPDF(): Promise<string>,
    packet(data: string): void,
    panel(message: PanelRequest): void
}

export function getNativeView(): INativePdfView | undefined {
    return (globalThis as typeof globalThis & { lwNativeView?: INativePdfView }).lwNativeView
}

export async function prepareNativeWorker(): Promise<void> {
    const native = getNativeView()
    if (!native) { return }
    await native.ready
    // VS Code webviews cannot load a worker via a cross-origin import wrapper.
    const response = await fetch(native.workerSrc, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) { throw new Error('Worker resource HTTP ' + response.status) }
    native.workerSrc = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'text/javascript' }))
}

export function isIOS(): boolean {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}
