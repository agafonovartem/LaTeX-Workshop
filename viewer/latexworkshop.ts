import { getNativeView, prepareNativeWorker, isIOS } from './components/nativeview.js'
import { configureNativeResolution, installNativeWheelScrolling } from './components/nativeinput.js'
import { patchViewerUI, registerKeyBind, registerPersistentState, repositionAnnotation } from './components/gui.js'
import * as utils from './components/utils.js'

import type { PdfjsEventName, PDFViewerApplicationType, PDFViewerApplicationOptionsType } from './components/interface.js'
import { doneRefresh, restoreState } from './components/refresh.js'
import { initUploadState, setParams, uploadState } from './components/state.js'
import { initConnect, send } from './components/connection.js'
import { registerSyncTeX } from './components/synctex.js'

declare const pdfjsLib: { OutputScale: object }
declare const PDFViewerApplication: PDFViewerApplicationType
declare const PDFViewerApplicationOptions: PDFViewerApplicationOptionsType

// The 'webviewerloaded' event is fired just before the initialization of PDF.js.
// We can set PDFViewerApplicationOptions at the time.
// - https://github.com/mozilla/pdf.js/wiki/Third-party-viewer-usage#initialization-promise
// - https://github.com/mozilla/pdf.js/pull/10318
const webViewerLoaded = new Promise<void>((resolve) => {
    document.addEventListener('webviewerloaded', () => resolve() )

    // https://github.com/James-Yu/LaTeX-Workshop/pull/4220#issuecomment-2034520751
    try {
        parent.document.addEventListener('webviewerloaded', () => resolve() )
    } catch(_) { /* do nothing */ }
})

// For the details of the initialization of PDF.js,
// see https://github.com/mozilla/pdf.js/wiki/Third-party-viewer-usage
// We should use only the promises provided by PDF.js here, not the ones defined by us,
// to avoid deadlock.
async function getViewerEventBus() {
    await webViewerLoaded
    await PDFViewerApplication.initializedPromise
    return PDFViewerApplication.eventBus
}

function onPDFViewerEvent(event: PdfjsEventName, cb: (evt?: any) => unknown, option?: { once: boolean }): { dispose: () => void } {
    const cb0 = (evt?: unknown) => {
        cb(evt)
        if (option?.once) { PDFViewerApplication.eventBus.off(event, cb0) }
    }
    void getViewerEventBus().then(eventBus => eventBus.on(event, cb0))
    return { dispose: () => PDFViewerApplication.eventBus.off(event, cb0) }
}

async function initialization() {
    await prepareNativeWorker()
    document.title = utils.parseURL().docTitle

    const params = await utils.getParams()
    const configureViewerOptions = () => {
        const color = utils.isPrefersColorSchemeDark(params.codeColorTheme) ? params.color.dark : params.color.light
        const options: Record<string, unknown> = {
            annotationEditorMode: -1,
            disablePreferences: true,
            enableScripting: false,
            // The following paths are requested from ./build/cmaps/, ./build/standard_fonts/, and ./build/wasm/
            cMapUrl: '../cmaps/',
            standardFontDataUrl: '../standard_fonts/',
            wasmUrl: '../wasm/',
            sidebarViewOnLoad: 0,
            workerSrc: './build/pdf.worker.mjs',
            forcePageColors: true,
            ...color
        }
        const native = getNativeView()
        if (native) {
            Object.assign(options, {
                defaultUrl: native.pdfUrl, workerSrc: native.workerSrc,
                cMapUrl: native.cMapUrl, standardFontDataUrl: native.standardFontDataUrl,
                wasmUrl: native.wasmUrl, imageResourcesPath: native.imageResourcesPath
            })
        }
        if (isIOS()) {
            options.maxCanvasPixels = 16 * 1024 * 1024
            configureNativeResolution(pdfjsLib.OutputScale)
            if (native) { installNativeWheelScrolling(document.getElementById('viewerContainer')!) }
        }
        PDFViewerApplicationOptions.setAll(options)
    }
    document.addEventListener('webviewerloaded', configureViewerOptions)
    try { parent.document.addEventListener('webviewerloaded', configureViewerOptions) } catch (_) { /* Cross-origin browser iframe. */ }

    initConnect()
    await patchViewerUI()
    registerKeyBind()
}

await initialization()
onPDFViewerEvent('documentloaded', () => {
    void setParams()
    initUploadState()
    void getViewerEventBus().then(eventbus => {
        const events: PdfjsEventName[] = ['scalechanged', 'zoomin', 'zoomout', 'zoomreset', 'scrollmodechanged', 'spreadmodechanged', 'pagenumberchanged']
        events.forEach(event => {
            eventbus.on(event, () => { uploadState() })
        })
    })
}, { once: true })
onPDFViewerEvent('pagesinit', () => {
    void restoreState()
    registerSyncTeX()
    registerPersistentState()
})
onPDFViewerEvent('pagesloaded', () => {
    void restoreState()
        .then(() => uploadState())
        .then(() => send({ type: 'loaded', pdfFileUri: utils.parseURL().pdfFileUri }))
    repositionAnnotation()
    doneRefresh()
})

// @ts-expect-error Must import viewer.mjs here, otherwise some config won't work. #4096
await import('../../viewer/viewer.mjs')
