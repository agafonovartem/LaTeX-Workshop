/** Scroll the PDF itself instead of forwarding the gesture to the outer editor. */
export function installNativeWheelScrolling(container: HTMLElement): void {
    container.addEventListener('wheel', event => {
        if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) { return }
        if (!event.deltaX && !event.deltaY) { return }
        const target = event.target instanceof Element ? event.target : null
        for (let node = target; node && node !== container; node = node.parentElement) {
            const style = getComputedStyle(node)
            if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1
                || /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) { return }
        }
        const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1
        let left = event.deltaX * factor
        let top = event.deltaY * factor
        if (event.shiftKey && !left) { left = top; top = 0 }
        event.preventDefault()
        event.stopPropagation()
        container.scrollBy({ left, top, behavior: 'instant' })
    }, { passive: false })
}

export function configureNativeResolution(outputScale: object, ratio = () => globalThis.devicePixelRatio || 1): void {
    Object.defineProperty(outputScale, 'pixelRatio', { configurable: true, get: () => Math.max(3, ratio()) })
}
