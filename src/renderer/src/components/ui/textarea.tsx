// Adapted from shadcn/ui (new-york-v4) for Fluxy's compact desktop controls.
import * as React from 'react'
import { cn } from '@/lib/utils'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
    return (
        <textarea
            data-slot="textarea"
            className={cn(
                'min-h-16 w-full min-w-0 resize-y rounded-[5px] border border-input bg-field px-[7px] py-[5px] text-[1rem] text-foreground transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/15 disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-destructive',
                className
            )}
            {...props}
        />
    )
}

export { Textarea }
