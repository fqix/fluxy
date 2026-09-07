import { Button } from '@/components/ui/button'
import { useEffect, useRef } from 'react'
import { X, Settings2 } from 'lucide-react'
export function ToolWindow({
    title,
    close,
    children
}: {
    title: string
    close: () => void
    children: React.ReactNode
}) {
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const previous = document.activeElement as HTMLElement
        ref.current?.focus()
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation()
                close()
            }
            if (e.key === 'Tab') {
                const items = ref.current?.querySelectorAll<HTMLElement>(
                    'button, input, select, textarea, [tabindex="0"]'
                )
                if (!items?.length) return
                const first = items[0],
                    last = items[items.length - 1]
                if (
                    e.shiftKey &&
                    (document.activeElement === first || document.activeElement === ref.current)
                ) {
                    e.preventDefault()
                    last.focus()
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault()
                    first.focus()
                }
            }
        }
        document.addEventListener('keydown', handler)
        return () => {
            document.removeEventListener('keydown', handler)
            previous?.focus()
        }
    }, [close])
    return (
        <div className="modal-scrim">
            <div
                ref={ref}
                className="tool-window"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                tabIndex={-1}
            >
                <header>
                    <span className="tool-title">
                        <Settings2 size={15} />
                        {title}
                    </span>
                    <Button aria-label="Close dialog" onClick={close}>
                        <X size={16} />
                    </Button>
                </header>
                {children}
            </div>
        </div>
    )
}
